import { Client, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  AuthenticatedSessionReference,
  ContentLockPlanBindings,
  DestructiveReauthenticationLease,
  ExactReplayAuthorizer,
  GlobalProductMutationRequest,
  InstallationMutationEpoch,
  InstanceResetRequest,
  NewCommandAuthorizer,
  SubjectProductMutationRequest,
  UnitOfWorkContentScope,
  UnitOfWorkRequest,
  UnitOfWorkScope,
} from '@/application/coordination'
import { CoordinationError } from '@/application/coordination'
import {
  createContentLockPlanPort,
  createContentLockProjectionFactory,
} from '@/platform/application-coordination/content-lock-plan'
import {
  createInstallationMutationEpoch,
  installationMutationEpochMatches,
} from '@/platform/application-coordination/lifecycle-values'
import {
  PostgresUnitOfWork,
  type ScopedTransactionClient,
} from '@/platform/application-coordination/postgres-unit-of-work'
import {
  createPlatformPrelockedSessionIntentFactory,
  createPlatformPrelockedSessionPort,
  prelockedOperationForRequest,
  resolvePlatformPrelockedSession,
} from '@/platform/application-coordination/prelocked-session'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb } from '@/platform/db/client'
import { DatabaseRuntime } from '@/platform/db/database-runtime'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'

type ReadGateways = {
  backendPid(): Promise<number>
  count(owner: 'a' | 'b'): Promise<number>
  localModes(): Promise<{
    readonly deletionMode: string
    readonly userCreationMode: string
  }>
}

type VerifiedContentScope = Extract<UnitOfWorkContentScope, { readonly kind: 'verified' }>

type WriteGateways = ReadGateways & {
  attestCurrentContent(content: VerifiedContentScope): Promise<void>
  classifyCommand(
    commandId: string,
    stableIntentHash: string,
  ): Promise<
    | { readonly kind: 'exact-replay'; readonly result: string }
    | { readonly kind: 'new-command' }
  >
  insert(owner: 'a' | 'b', id: string): Promise<void>
  insertAfterDelay(owner: 'a' | 'b', id: string): Promise<void>
  recordReceipt(
    commandId: string,
    stableIntentHash: string,
    result: string,
  ): Promise<void>
  rotateEpoch(): Promise<void>
  waitIndefinitely(): Promise<void>
}

let database: DisposableIntegrationDatabase
let runtime: DatabaseRuntime
let inspector: Client
let unitOfWork: PostgresUnitOfWork<ReadGateways, WriteGateways>

const session = {} as AuthenticatedSessionReference
const destructiveLease = {} as DestructiveReauthenticationLease<'instance-reset'>
const methodologyFactory = createContentLockProjectionFactory('methodology-target')
const releasePair = [
  { kind: 'methodology' as const, id: 'methodology-development', version: '1' },
  { kind: 'template' as const, id: 'template-development', version: '1' },
]

function stableIntentHash(commandId: string): string {
  return `intent:${commandId}`
}

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function currentAdvisoryWaiterPids(): Promise<ReadonlySet<number>> {
  const result = await inspector.query<{ pid: number }>(
    `SELECT pid
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND wait_event_type = 'Lock'
       AND wait_event = 'advisory'`,
  )
  return new Set(result.rows.map(({ pid }) => pid))
}

async function newAdvisoryWaiterPids(
  excludedPids: ReadonlySet<number>,
  expectedCount: number,
): Promise<readonly number[]> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await inspector.query<{ pid: number }>(
      `SELECT pid
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'
       ORDER BY pid`,
    )
    const newPids = result.rows
      .map(({ pid }) => pid)
      .filter((pid) => !excludedPids.has(pid))
    if (newPids.length >= expectedCount) {
      return newPids
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${expectedCount} advisory-lock waiter(s).`)
}

async function waitForBackendExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await inspector.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND pid = $1
       ) AS present`,
      [pid],
    )
    if (result.rows[0]?.present === false) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for PostgreSQL backend ${pid} to exit.`)
}

async function waitForActiveQuery(pid: number, fragment: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await inspector.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid = $1
           AND state = 'active'
           AND query LIKE '%' || $2 || '%'
       ) AS active`,
      [pid, fragment],
    )
    if (result.rows[0]?.active === true) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for backend ${pid} to run ${fragment}.`)
}

async function currentEpoch() {
  const result = await inspector.query<{ epoch: string }>(
    `SELECT product_mutation_epoch::text AS epoch
     FROM installation_state WHERE singleton = 1`,
  )
  return createInstallationMutationEpoch(result.rows[0]?.epoch)
}

function gatewayContext(
  client: ScopedTransactionClient,
  request: UnitOfWorkRequest,
  requireWriteAuthorized: () => void,
  exactReplayAuthorizer: ExactReplayAuthorizer | null,
  newCommandAuthorizer: NewCommandAuthorizer | null,
) {
  const table = (owner: 'a' | 'b') =>
    owner === 'a' ? 'uow_test_owner_a' : 'uow_test_owner_b'
  let identityRechecked = false
  let classification:
    | {
        readonly commandId: string
        readonly kind: 'exact-replay' | 'new-command'
        readonly stableIntentHash: string
      }
    | undefined
  const boundCommandId =
    request.content.kind === 'verified' ? request.content.bindings.formOrCommandId : null
  const backendPid = async (): Promise<number> => {
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    const pid = result.rows[0]?.pid
    if (!pid) throw new Error('missing backend pid')
    return pid
  }
  const count = async (owner: 'a' | 'b'): Promise<number> => {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table(owner)}`,
    )
    return result.rows[0]?.count ?? -1
  }
  const localModes = async () => {
    const result = await client.query<{
      deletion_mode: string
      user_creation_mode: string
    }>(
      `SELECT current_setting('indigo.deletion_mode', true) AS deletion_mode,
              current_setting('indigo.user_creation_mode', true) AS user_creation_mode`,
    )
    return {
      deletionMode: result.rows[0]?.deletion_mode ?? '',
      userCreationMode: result.rows[0]?.user_creation_mode ?? '',
    }
  }
  return {
    recheckIdentity: async () => {
      const result = await client.query<{
        deletion_mode: string
        epoch: string
        user_creation_mode: string
      }>(
        `SELECT product_mutation_epoch::text AS epoch,
                current_setting('indigo.deletion_mode', true) AS deletion_mode,
                current_setting('indigo.user_creation_mode', true) AS user_creation_mode
         FROM installation_state WHERE singleton = 1`,
      )
      if (
        (result.rows[0]?.deletion_mode ?? '') !== '' ||
        (result.rows[0]?.user_creation_mode ?? '') !== ''
      ) {
        throw new Error('request-derived privilege preceded the Identity recheck')
      }
      if (
        !installationMutationEpochMatches(request.expectedEpoch, result.rows[0]?.epoch)
      ) {
        throw new CoordinationError('product-mutation.epoch-changed')
      }
      identityRechecked = true
    },
    readGateways: { backendPid, count, localModes },
    writeGateways: {
      backendPid,
      count,
      localModes,
      async attestCurrentContent(content: VerifiedContentScope) {
        if (!identityRechecked) throw new Error('content attested before Identity')
        const result = await client.query<{
          methodology_version: string
          template_version: string
        }>(
          `SELECT methodology_version::text AS methodology_version,
                  template_version::text AS template_version
           FROM uow_test_content_source
           WHERE singleton = 1`,
        )
        const source = result.rows[0]
        if (!source) throw new Error('missing current content source')
        content.attestor.assertCurrentLockedContentSet([
          methodologyFactory.createTransactionProjection(content.transactionScope, [
            { ...releasePair[0], version: source.methodology_version },
            { ...releasePair[1], version: source.template_version },
          ]),
        ])
      },
      async classifyCommand(commandId: string, stableIntentHash: string) {
        if (!identityRechecked) throw new Error('receipt classified before Identity')
        if (boundCommandId === null || commandId !== boundCommandId) {
          throw new Error('command receipt does not match the request binding')
        }
        if (classification) throw new Error('command receipt was already classified')
        const result = await client.query<{
          result: string
          stable_intent_hash: string
        }>(
          `SELECT stable_intent_hash, result
           FROM uow_test_receipt WHERE command_id = $1`,
          [commandId],
        )
        const stored = result.rows[0]
        if (!stored) {
          if (!newCommandAuthorizer) throw new Error('missing new-command authorizer')
          newCommandAuthorizer.authorizeNewCommand()
          classification = { commandId, kind: 'new-command', stableIntentHash }
          return { kind: 'new-command' as const }
        }
        if (stored.stable_intent_hash !== stableIntentHash) {
          throw new Error('command receipt stable intent conflicts')
        }
        if (!exactReplayAuthorizer) throw new Error('missing replay authorizer')
        exactReplayAuthorizer.authorizeExactReplay(stored.result)
        classification = { commandId, kind: 'exact-replay', stableIntentHash }
        return { kind: 'exact-replay' as const, result: stored.result }
      },
      async insert(owner: 'a' | 'b', id: string) {
        requireWriteAuthorized()
        await client.query(`INSERT INTO ${table(owner)} (id) VALUES ($1)`, [id])
      },
      async insertAfterDelay(owner: 'a' | 'b', id: string) {
        requireWriteAuthorized()
        await client.query(
          `INSERT INTO ${table(owner)} (id)
           SELECT $1 FROM (SELECT pg_sleep(0.05)) AS delayed`,
          [id],
        )
      },
      async recordReceipt(commandId: string, stableIntentHash: string, result: string) {
        if (
          classification?.kind !== 'new-command' ||
          classification.commandId !== boundCommandId ||
          commandId !== boundCommandId ||
          classification.stableIntentHash !== stableIntentHash
        ) {
          throw new Error('command receipt does not match its new-command classification')
        }
        requireWriteAuthorized()
        await client.query(
          `INSERT INTO uow_test_receipt (command_id, stable_intent_hash, result)
           VALUES ($1, $2, $3)`,
          [commandId, stableIntentHash, result],
        )
      },
      async rotateEpoch() {
        requireWriteAuthorized()
        await client.query(
          `UPDATE installation_state
           SET product_mutation_epoch = gen_random_uuid()
          WHERE singleton = 1`,
        )
      },
      async waitIndefinitely() {
        await client.query('SELECT pg_sleep(600)')
      },
    },
  }
}

function createUnitOfWork() {
  return new PostgresUnitOfWork<ReadGateways, WriteGateways>({
    acquireOrdinary: (options) => runtime.acquireOrdinary(options),
    resolvePrelockedSession: (lease, request) =>
      resolvePlatformPrelockedSession(lease, prelockedOperationForRequest(request)),
    createGatewayContext: ({
      client,
      exactReplayAuthorizer,
      newCommandAuthorizer,
      request,
      requireWriteAuthorized,
    }) =>
      gatewayContext(
        client,
        request,
        requireWriteAuthorized,
        exactReplayAuthorizer,
        newCommandAuthorizer,
      ),
    lockTimeoutMs: 2_000,
  })
}

function contentBindings<Shape extends 'current-publication.initial' | 'none'>(input: {
  readonly actorAccountId?: string
  readonly commandId: string
  readonly shape: Shape
  readonly subjectId: string | null
  readonly expectedEpoch: InstallationMutationEpoch
  readonly purpose?: string
}): ContentLockPlanBindings & { readonly shape: Shape } {
  return {
    shape: input.shape,
    purpose:
      input.purpose ??
      (input.shape === 'none' ? 'subject-product-mutation' : input.shape),
    actorAccountId: input.actorAccountId ?? 'actor-1',
    subjectId: input.subjectId,
    formOrCommandId: input.commandId,
    sourceEntityIds: [],
    expectedEpoch: input.expectedEpoch,
    expectedGeneration: null,
  }
}

async function runSubject<Result>(input: {
  readonly callback: (scope: UnitOfWorkScope<WriteGateways>) => Promise<Result>
  readonly commandId: string
  readonly epoch: InstallationMutationEpoch
  readonly signal?: AbortSignal
  readonly stableIntentHash?: string
  readonly subjectId: string
}): Promise<Result> {
  const planPort = createContentLockPlanPort({
    authSecret: 'integration-auth-secret-with-at-least-thirty-two-bytes',
    resolveActorAccountId: async () => 'actor-1',
  })
  const bindings = contentBindings({
    commandId: input.commandId,
    expectedEpoch: input.epoch,
    shape: 'none',
    subjectId: input.subjectId,
  })
  const envelope = await planPort.withIssuanceScope(bindings, async ({ seal }) =>
    seal([]),
  )
  return planPort.withVerifiedContentLockPlan(
    planPort.prepareEnvelope(envelope),
    bindings,
    (plan) => {
      const request: SubjectProductMutationRequest = {
        operation: 'subject-product-mutation',
        authority: {
          kind: 'authenticated-session',
          actorUserId: 'actor-1',
          expectedRole: 'owner',
          session,
        },
        session: { kind: 'ordinary' },
        workflowPurpose: bindings.purpose,
        expectedEpoch: input.epoch,
        signal: input.signal,
        productFence: 'shared',
        subjectLock: { subjectUserId: input.subjectId, mode: 'exclusive' },
        content: { kind: 'verified', plan, bindings },
        mode: { isolation: 'read-committed', access: 'read-write' },
      }
      return unitOfWork.run(request, async (scope) => {
        const classification = await scope.gateways.classifyCommand(
          input.commandId,
          input.stableIntentHash ?? stableIntentHash(input.commandId),
        )
        if (classification.kind !== 'new-command') {
          throw new Error('ordinary subject helper unexpectedly replayed a receipt')
        }
        return input.callback(scope)
      })
    },
  )
}

async function runGlobal<Result>(input: {
  readonly callback: (scope: UnitOfWorkScope<WriteGateways>) => Promise<Result>
  readonly commandId: string
  readonly epoch: InstallationMutationEpoch
}): Promise<Result> {
  const planPort = createContentLockPlanPort({
    authSecret: 'integration-auth-secret-with-at-least-thirty-two-bytes',
    resolveActorAccountId: async () => 'actor-1',
  })
  const bindings = contentBindings({
    commandId: input.commandId,
    expectedEpoch: input.epoch,
    purpose: 'global-product-mutation',
    shape: 'none',
    subjectId: null,
  })
  const envelope = await planPort.withIssuanceScope(bindings, async ({ seal }) =>
    seal([]),
  )
  return planPort.withVerifiedContentLockPlan(
    planPort.prepareEnvelope(envelope),
    bindings,
    (plan) => {
      const request: GlobalProductMutationRequest = {
        operation: 'global-product-mutation',
        authority: {
          kind: 'authenticated-session',
          actorUserId: 'actor-1',
          expectedRole: 'owner',
          session,
        },
        session: { kind: 'ordinary' },
        workflowPurpose: bindings.purpose,
        expectedEpoch: input.epoch,
        productFence: 'shared',
        subjectLock: null,
        content: { kind: 'verified', plan, bindings },
        mode: { isolation: 'read-committed', access: 'read-write' },
      }
      return unitOfWork.run(request, async (scope) => {
        const classification = await scope.gateways.classifyCommand(
          input.commandId,
          stableIntentHash(input.commandId),
        )
        if (classification.kind !== 'new-command') {
          throw new Error('ordinary global helper unexpectedly replayed a receipt')
        }
        return input.callback(scope)
      })
    },
  )
}

async function runInitialPublication<Result>(input: {
  readonly afterIssuance?: () => Promise<void>
  readonly automaticClassification?: boolean
  readonly callback: (scope: UnitOfWorkScope<WriteGateways>) => Promise<Result>
  readonly commandId: string
  readonly epoch: InstallationMutationEpoch
  readonly stableIntentHash?: string
  readonly subjectId: string
}): Promise<Result> {
  const planPort = createContentLockPlanPort({
    authSecret: 'integration-auth-secret-with-at-least-thirty-two-bytes',
    resolveActorAccountId: async () => 'actor-1',
  })
  const bindings = contentBindings({
    commandId: input.commandId,
    expectedEpoch: input.epoch,
    shape: 'current-publication.initial',
    subjectId: input.subjectId,
  })
  const envelope = await planPort.withIssuanceScope(bindings, async ({ scope, seal }) =>
    seal([methodologyFactory.createIssuanceProjection(scope, releasePair)]),
  )
  await input.afterIssuance?.()
  return planPort.withVerifiedContentLockPlan(
    planPort.prepareEnvelope(envelope),
    bindings,
    (plan) => {
      const request: SubjectProductMutationRequest = {
        operation: 'current-publication.initial',
        authority: {
          kind: 'authenticated-session',
          actorUserId: 'actor-1',
          expectedRole: 'owner',
          session,
        },
        session: { kind: 'ordinary' },
        workflowPurpose: bindings.purpose,
        expectedEpoch: input.epoch,
        productFence: 'shared',
        subjectLock: { subjectUserId: input.subjectId, mode: 'exclusive' },
        content: { kind: 'verified', plan, bindings },
        mode: { isolation: 'read-committed', access: 'read-write' },
      }
      return unitOfWork.run(request, async (scope) => {
        if (input.automaticClassification !== false) {
          const classification = await scope.gateways.classifyCommand(
            input.commandId,
            input.stableIntentHash ?? stableIntentHash(input.commandId),
          )
          if (classification.kind !== 'new-command') {
            throw new Error('new-publication helper unexpectedly replayed a receipt')
          }
        }
        return input.callback(scope)
      })
    },
  )
}

async function runReset<Result>(input: {
  readonly callback: (gateways: WriteGateways) => Promise<Result>
  readonly epoch: InstallationMutationEpoch
}): Promise<Result> {
  const prelockedPort = createPlatformPrelockedSessionPort()
  const intent = createPlatformPrelockedSessionIntentFactory().instanceReset(
    async (options) => {
      const client = await runtime.acquireTrustedControl(options)
      return {
        client,
        close: async (destroyError) => {
          client.release(destroyError())
        },
      }
    },
  )
  return prelockedPort.withPrelockedSessionLease(intent, async (lease) => {
    const request: InstanceResetRequest = {
      operation: 'instance-reset',
      authority: {
        kind: 'authenticated-destructive',
        actorUserId: 'actor-1',
        expectedRole: 'owner',
        session,
        purpose: 'instance-reset',
        targetUserId: null,
        reauthenticationLease: destructiveLease,
      },
      session: { kind: 'prelocked', lease },
      expectedEpoch: input.epoch,
      productFence: 'exclusive',
      subjectLock: null,
      content: { kind: 'none' },
      mode: { isolation: 'serializable', access: 'read-write' },
    }
    return unitOfWork.run(request, async ({ gateways }) => input.callback(gateways))
  })
}

beforeAll(async () => {
  database = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'coordination_uow',
  })
  await database.create()
  database.activateDatabaseUrl()
  resetServerConfigForTests()
  await closeDb()
  await migrateDatabase()
  await closeDb()

  inspector = new Client({ connectionString: database.databaseUrl })
  await inspector.connect()
  await inspector.query('CREATE TABLE uow_test_owner_a (id text PRIMARY KEY)')
  await inspector.query('CREATE TABLE uow_test_owner_b (id text PRIMARY KEY)')
  await inspector.query(
    `CREATE TABLE uow_test_receipt (
       command_id text PRIMARY KEY,
       stable_intent_hash text NOT NULL,
       result text NOT NULL
     )`,
  )
  await inspector.query(
    `CREATE TABLE uow_test_content_source (
       singleton integer PRIMARY KEY CHECK (singleton = 1),
       methodology_version integer NOT NULL,
       template_version integer NOT NULL
     )`,
  )
  runtime = new DatabaseRuntime({ connectionString: database.databaseUrl, poolMax: 10 })
  unitOfWork = createUnitOfWork()
})

beforeEach(async () => {
  await inspector.query(
    'TRUNCATE uow_test_owner_a, uow_test_owner_b, uow_test_receipt, uow_test_content_source',
  )
  await inspector.query(
    `INSERT INTO uow_test_content_source
       (singleton, methodology_version, template_version)
     VALUES (1, 1, 1)`,
  )
  await inspector.query(
    'UPDATE installation_state SET product_mutation_epoch = gen_random_uuid() WHERE singleton = 1',
  )
})

afterAll(async () => {
  await runtime?.close()
  await inspector?.end()
  await closeDb()
  database?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await database?.cleanup()
})

describe('PostgreSQL UnitOfWork integration', () => {
  it('commits two owner gateways on one backend and rolls both back after failure', async () => {
    const epoch = await currentEpoch()
    const pids = await runSubject({
      commandId: 'atomic-commit',
      epoch,
      subjectId: 'subject-atomic',
      callback: async ({ gateways }) => {
        const first = await gateways.backendPid()
        await gateways.insert('a', 'commit-a')
        const second = await gateways.backendPid()
        await gateways.insert('b', 'commit-b')
        return [first, second]
      },
    })
    expect(pids[0]).toBe(pids[1])
    expect(await inspector.query('SELECT id FROM uow_test_owner_a')).toMatchObject({
      rows: [{ id: 'commit-a' }],
    })
    expect(await inspector.query('SELECT id FROM uow_test_owner_b')).toMatchObject({
      rows: [{ id: 'commit-b' }],
    })

    const original = new Error('post-write failure')
    await expect(
      runSubject({
        commandId: 'atomic-rollback',
        epoch,
        subjectId: 'subject-atomic',
        callback: async ({ gateways }) => {
          await gateways.insert('a', 'rollback-a')
          await gateways.insert('b', 'rollback-b')
          throw original
        },
      }),
    ).rejects.toBe(original)
    expect(
      await inspector.query(
        `SELECT count(*)::int AS count FROM uow_test_owner_a
         WHERE id = 'rollback-a'`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] })
    expect(
      await inspector.query(
        `SELECT count(*)::int AS count FROM uow_test_owner_b
         WHERE id = 'rollback-b'`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] })
  })

  it('serializes the same subject while different subjects overlap', async () => {
    const epoch = await currentEpoch()
    const releaseFirst = deferred()
    const firstEntered = deferred()
    let secondEntered = false
    const first = runSubject({
      commandId: 'same-first',
      epoch,
      subjectId: 'same-subject',
      callback: async ({ gateways }) => {
        await gateways.insert('a', 'same-first')
        firstEntered.resolve()
        await releaseFirst.promise
      },
    })
    await firstEntered.promise
    const existingWaiters = await currentAdvisoryWaiterPids()
    const second = runSubject({
      commandId: 'same-second',
      epoch,
      subjectId: 'same-subject',
      callback: async ({ gateways }) => {
        secondEntered = true
        expect(await gateways.count('a')).toBe(1)
      },
    })
    const [secondWaiterPid] = await newAdvisoryWaiterPids(existingWaiters, 1)
    expect(secondWaiterPid).toBeTypeOf('number')
    expect(secondEntered).toBe(false)
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(secondEntered).toBe(true)

    const releaseDifferent = deferred()
    const entered = new Set<string>()
    const runDifferent = (subjectId: string) =>
      runSubject({
        commandId: `different-${subjectId}`,
        epoch,
        subjectId,
        callback: async () => {
          entered.add(subjectId)
          if (entered.size === 2) releaseDifferent.resolve()
          await releaseDifferent.promise
        },
      })
    await Promise.all([runDifferent('subject-a'), runDifferent('subject-b')])
    expect(entered).toEqual(new Set(['subject-a', 'subject-b']))
  })

  it('allows compatible global and subject work to overlap and fences reset on both', async () => {
    const epoch = await currentEpoch()
    const releaseSubject = deferred()
    const releaseGlobal = deferred()
    const subjectEntered = deferred()
    const globalEntered = deferred()
    let resetEntered = false

    const subject = runSubject({
      commandId: 'compatible-subject',
      epoch,
      subjectId: 'subject-compatible-global',
      callback: async () => {
        subjectEntered.resolve()
        await releaseSubject.promise
      },
    })
    const global = runGlobal({
      commandId: 'compatible-global',
      epoch,
      callback: async () => {
        globalEntered.resolve()
        await releaseGlobal.promise
      },
    })

    try {
      await Promise.all([subjectEntered.promise, globalEntered.promise])
      const existingWaiters = await currentAdvisoryWaiterPids()
      const reset = runReset({
        epoch,
        callback: async () => {
          resetEntered = true
        },
      })
      const [resetWaiterPid] = await newAdvisoryWaiterPids(existingWaiters, 1)
      if (!resetWaiterPid) throw new Error('missing reset advisory waiter')
      expect(resetEntered).toBe(false)

      releaseSubject.resolve()
      await subject
      expect((await currentAdvisoryWaiterPids()).has(resetWaiterPid)).toBe(true)
      expect(resetEntered).toBe(false)

      releaseGlobal.resolve()
      await global
      await reset
      expect(resetEntered).toBe(true)
    } finally {
      releaseSubject.resolve()
      releaseGlobal.resolve()
    }
  })

  it('queues an exclusive reset ahead of a later shared writer without barging', async () => {
    const epoch = await currentEpoch()
    const releaseWriter = deferred()
    const writerEntered = deferred()
    const resetEntered = deferred()
    const releaseReset = deferred()
    const entryOrder: string[] = []
    let laterWriterEntered = false
    const writer = runSubject({
      commandId: 'writer-first',
      epoch,
      subjectId: 'subject-reset-race',
      callback: async ({ gateways }) => {
        await gateways.insert('a', 'winner')
        writerEntered.resolve()
        await releaseWriter.promise
      },
    })
    await writerEntered.promise
    const waitersBeforeReset = await currentAdvisoryWaiterPids()
    const reset = runReset({
      epoch,
      callback: async (gateways) => {
        entryOrder.push('reset')
        resetEntered.resolve()
        const count = await gateways.count('a')
        await releaseReset.promise
        return count
      },
    })
    const [resetWaiterPid] = await newAdvisoryWaiterPids(waitersBeforeReset, 1)
    if (!resetWaiterPid) throw new Error('missing reset advisory waiter')
    const waitersBeforeLaterWriter = new Set([...waitersBeforeReset, resetWaiterPid])
    const laterWriter = runSubject({
      commandId: 'writer-after-exclusive-waiter',
      epoch,
      subjectId: 'subject-after-reset-waiter',
      callback: async () => {
        laterWriterEntered = true
        entryOrder.push('later-writer')
      },
    })
    const [laterWriterWaiterPid] = await newAdvisoryWaiterPids(
      waitersBeforeLaterWriter,
      1,
    )
    expect(laterWriterWaiterPid).toBeTypeOf('number')
    expect(laterWriterWaiterPid).not.toBe(resetWaiterPid)
    expect(entryOrder).toEqual([])
    releaseWriter.resolve()
    await writer
    await resetEntered.promise
    expect(laterWriterEntered).toBe(false)
    expect(entryOrder).toEqual(['reset'])
    releaseReset.resolve()
    await expect(reset).resolves.toBe(1)
    await laterWriter
    expect(entryOrder).toEqual(['reset', 'later-writer'])
  })

  it('rejects a stale writer after reset rotates the epoch and touches no owner row', async () => {
    const epoch = await currentEpoch()
    const releaseReset = deferred()
    const resetEntered = deferred()
    const reset = runReset({
      epoch,
      callback: async (gateways) => {
        await gateways.rotateEpoch()
        resetEntered.resolve()
        await releaseReset.promise
      },
    })
    await resetEntered.promise
    const existingWaiters = await currentAdvisoryWaiterPids()
    const writer = runSubject({
      commandId: 'stale-after-reset',
      epoch,
      subjectId: 'subject-stale',
      callback: async ({ gateways }) => {
        await gateways.insert('a', 'must-not-exist')
      },
    })
    const [writerWaiterPid] = await newAdvisoryWaiterPids(existingWaiters, 1)
    expect(writerWaiterPid).toBeTypeOf('number')
    releaseReset.resolve()
    await reset
    await expect(writer).rejects.toMatchObject({
      code: 'product-mutation.epoch-changed',
    })
    expect(
      await inspector.query(
        `SELECT count(*)::int AS count FROM uow_test_owner_a
         WHERE id = 'must-not-exist'`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] })
  })

  it.each(
    releasePair,
  )('rejects publication when the locked $kind member is revoked while queued', async (blockedRelease) => {
    const epoch = await currentEpoch()
    const blocker = new Client({ connectionString: database.databaseUrl })
    await blocker.connect()
    let transactionOpen = false
    try {
      await blocker.query('BEGIN')
      transactionOpen = true
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${blockedRelease.kind}:${blockedRelease.id}:${blockedRelease.version}`,
      ])
      const existingWaiters = await currentAdvisoryWaiterPids()
      let entered = false
      const publication = runInitialPublication({
        commandId: `publication-${blockedRelease.kind}`,
        epoch,
        subjectId: `subject-${blockedRelease.kind}`,
        callback: async ({ content, gateways }) => {
          if (content.kind !== 'verified') throw new Error('verified scope missing')
          await gateways.attestCurrentContent(content)
          entered = true
        },
      })
      const [publicationWaiterPid] = await newAdvisoryWaiterPids(existingWaiters, 1)
      expect(publicationWaiterPid).toBeTypeOf('number')
      expect(entered).toBe(false)
      const versionColumn =
        blockedRelease.kind === 'methodology' ? 'methodology_version' : 'template_version'
      await blocker.query(
        `UPDATE uow_test_content_source SET ${versionColumn} = 2 WHERE singleton = 1`,
      )
      await blocker.query('COMMIT')
      transactionOpen = false
      await expect(publication).rejects.toMatchObject({
        code: 'content-lock-plan.stale',
      })
      expect(entered).toBe(false)
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end().catch(() => undefined)
    }
  })

  it('rejects a freshly rederived stale owner set before any mutation', async () => {
    const epoch = await currentEpoch()
    await expect(
      runInitialPublication({
        afterIssuance: async () => {
          await inspector.query(
            'UPDATE uow_test_content_source SET template_version = 2 WHERE singleton = 1',
          )
        },
        commandId: 'stale-owner-set',
        epoch,
        subjectId: 'subject-stale-owner-set',
        callback: async ({ content, gateways }) => {
          if (content.kind !== 'verified') throw new Error('verified scope missing')
          await gateways.attestCurrentContent(content)
          await gateways.insert('a', 'must-not-write-stale-content')
        },
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.stale' })
    expect(
      await inspector.query(
        `SELECT count(*)::int AS count FROM uow_test_owner_a
         WHERE id = 'must-not-write-stale-content'`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] })
  })

  it('binds receipt order and admits stale-source replay but not a stale new command', async () => {
    const epoch = await currentEpoch()
    const replayIntent = stableIntentHash('exact-replay')
    await inspector.query(
      `INSERT INTO uow_test_receipt (command_id, stable_intent_hash, result)
       VALUES ('exact-replay', $1, 'persisted-receipt-result')`,
      [replayIntent],
    )

    const result = await runInitialPublication({
      afterIssuance: async () => {
        await inspector.query(
          'UPDATE uow_test_content_source SET template_version = 2 WHERE singleton = 1',
        )
      },
      automaticClassification: false,
      commandId: 'exact-replay',
      epoch,
      subjectId: 'subject-exact-replay',
      callback: async ({ gateways }) => {
        const classification = await gateways.classifyCommand(
          'exact-replay',
          replayIntent,
        )
        if (classification.kind !== 'exact-replay') {
          throw new Error('stored receipt was not replayed')
        }
        return classification.result
      },
    })
    expect(result).toBe('persisted-receipt-result')
    expect(
      await inspector.query(
        `SELECT template_version FROM uow_test_content_source WHERE singleton = 1`,
      ),
    ).toMatchObject({ rows: [{ template_version: 2 }] })
    expect(
      await inspector.query(
        `SELECT count(*)::int AS count
         FROM uow_test_owner_a`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] })
    expect(
      await inspector.query(
        `SELECT stable_intent_hash, result
         FROM uow_test_receipt
         WHERE command_id = 'exact-replay'`,
      ),
    ).toMatchObject({
      rows: [
        {
          stable_intent_hash: replayIntent,
          result: 'persisted-receipt-result',
        },
      ],
    })

    await expect(
      runInitialPublication({
        automaticClassification: false,
        commandId: 'exact-replay',
        epoch,
        subjectId: 'subject-exact-replay',
        callback: async ({ gateways }) => {
          const classification = await gateways.classifyCommand(
            'exact-replay',
            replayIntent,
          )
          if (classification.kind !== 'exact-replay') {
            throw new Error('stored receipt was not replayed')
          }
          return `${classification.result}-fabricated`
        },
      }),
    ).rejects.toMatchObject({ code: 'uow.scope-revoked' })

    await expect(
      runInitialPublication({
        automaticClassification: false,
        commandId: 'exact-replay',
        epoch,
        subjectId: 'subject-exact-replay',
        callback: async ({ gateways }) => {
          await gateways.classifyCommand('exact-replay', 'conflicting-intent')
          return 'must not classify'
        },
      }),
    ).rejects.toThrow('command receipt stable intent conflicts')

    await expect(
      runInitialPublication({
        automaticClassification: false,
        commandId: 'exact-replay',
        epoch,
        subjectId: 'subject-exact-replay',
        callback: async ({ gateways }) => {
          await gateways.classifyCommand('another-command', replayIntent)
          return 'must not classify another request'
        },
      }),
    ).rejects.toThrow('command receipt does not match the request binding')

    await expect(
      runInitialPublication({
        commandId: 'new-command',
        epoch,
        subjectId: 'subject-new-command',
        callback: async ({ content, gateways }) => {
          if (content.kind !== 'verified') throw new Error('verified scope missing')
          await gateways.attestCurrentContent(content)
          await gateways.insert('a', 'must-not-write-stale-new-command')
          await gateways.recordReceipt(
            'new-command',
            stableIntentHash('new-command'),
            'must-not-persist',
          )
        },
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.stale' })
    expect(
      await inspector.query(
        `SELECT count(*)::int AS count
         FROM uow_test_owner_a
         WHERE id = 'must-not-write-stale-new-command'`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] })
    expect(
      await inspector.query(
        `SELECT count(*)::int AS count
         FROM uow_test_receipt
         WHERE command_id = 'new-command'`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] })

    await inspector.query(
      'UPDATE uow_test_content_source SET template_version = 1 WHERE singleton = 1',
    )
    const newIntent = stableIntentHash('new-command')
    const newResult = await runInitialPublication({
      commandId: 'new-command',
      epoch,
      stableIntentHash: newIntent,
      subjectId: 'subject-new-command',
      callback: async ({ content, gateways }) => {
        if (content.kind !== 'verified') throw new Error('verified scope missing')
        await gateways.attestCurrentContent(content)
        await gateways.insert('a', 'fresh-new-command')
        await gateways.recordReceipt('new-command', newIntent, 'new-result')
        return 'new-result'
      },
    })
    expect(newResult).toBe('new-result')
    expect(
      await inspector.query(
        `SELECT stable_intent_hash, result FROM uow_test_receipt
         WHERE command_id = 'new-command'`,
      ),
    ).toMatchObject({
      rows: [{ stable_intent_hash: newIntent, result: 'new-result' }],
    })
    expect(
      await inspector.query(
        `SELECT id FROM uow_test_owner_a WHERE id = 'fresh-new-command'`,
      ),
    ).toMatchObject({ rows: [{ id: 'fresh-new-command' }] })
  })

  it('rolls back and drains detached PostgreSQL work before destroying its backend', async () => {
    const epoch = await currentEpoch()
    await expect(
      runSubject({
        commandId: 'detached-real-query',
        epoch,
        subjectId: 'subject-detached',
        callback: async ({ gateways }) => {
          void gateways.insertAfterDelay('a', 'detached-row')
        },
      }),
    ).rejects.toMatchObject({ code: 'uow.detached-work' })
    expect(
      await inspector.query(
        `SELECT count(*)::int AS count FROM uow_test_owner_a
         WHERE id = 'detached-row'`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] })
  })

  it('treats PostgreSQL false COMMIT as an aborted transaction', async () => {
    const epoch = await currentEpoch()
    await inspector.query(`INSERT INTO uow_test_owner_a (id) VALUES ('duplicate')`)

    await expect(
      runSubject({
        commandId: 'false-commit',
        epoch,
        subjectId: 'subject-false-commit',
        callback: async ({ gateways }) => {
          try {
            await gateways.insert('a', 'duplicate')
          } catch {
            // PostgreSQL keeps the transaction aborted even when workflow code catches this.
          }
          return 'must not report success'
        },
      }),
    ).rejects.toMatchObject({ code: 'uow.transaction-aborted' })
    expect(
      await inspector.query(
        `SELECT count(*)::int AS count FROM uow_test_owner_a WHERE id = 'duplicate'`,
      ),
    ).toMatchObject({ rows: [{ count: 1 }] })
  })

  it('revokes retained real gateways and releases every advisory lock', async () => {
    const epoch = await currentEpoch()
    let retained: WriteGateways | undefined
    const backendPid = await runSubject({
      commandId: 'retained-gateway',
      epoch,
      subjectId: 'subject-retained',
      callback: async ({ gateways }) => {
        retained = gateways
        return gateways.backendPid()
      },
    })
    const closed = retained
    if (!closed) throw new Error('real gateway was not retained')
    expect(() => closed.count('a')).toThrow(
      expect.objectContaining({ code: 'uow.scope-revoked' }),
    )
    expect(
      await inspector.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'`,
        [backendPid],
      ),
    ).toMatchObject({ rows: [{ count: 0 }] })
  })

  it('maps a terminated backend to connection loss and admits a replacement UoW', async () => {
    const epoch = await currentEpoch()
    const capturedPid = deferred()
    let backendPid = 0
    const operation = runSubject({
      commandId: 'connection-loss',
      epoch,
      subjectId: 'subject-connection-loss',
      callback: async ({ gateways }) => {
        backendPid = await gateways.backendPid()
        capturedPid.resolve()
        await gateways.waitIndefinitely()
      },
    })
    const outcome = operation.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await capturedPid.promise
    await waitForActiveQuery(backendPid, 'pg_sleep(600)')
    await inspector.query('SELECT pg_terminate_backend($1)', [backendPid])
    await expect(outcome).resolves.toMatchObject({
      ok: false,
      error: { code: 'uow.connection-lost' },
    })
    await waitForBackendExit(backendPid)
    await expect(
      runSubject({
        commandId: 'connection-replacement',
        epoch,
        subjectId: 'subject-connection-replacement',
        callback: async ({ gateways }) => gateways.count('a'),
      }),
    ).resolves.toBe(0)
  })

  it('retires a prelocked control backend lost between UoWs and frees reserved admission', async () => {
    const epoch = await currentEpoch()
    const prelockedPort = createPlatformPrelockedSessionPort()
    const betweenTransactions = deferred()
    const releaseOuterCallback = deferred()
    let backendPid = 0
    const intent = createPlatformPrelockedSessionIntentFactory().instanceReset(
      async (options) => {
        const client = await runtime.acquireTrustedControl(options)
        return {
          client,
          close: async (destroyError) => {
            client.release(destroyError())
          },
        }
      },
    )
    const operation = prelockedPort.withPrelockedSessionLease(intent, async (lease) => {
      const request: InstanceResetRequest = {
        operation: 'instance-reset',
        authority: {
          kind: 'authenticated-destructive',
          actorUserId: 'actor-1',
          expectedRole: 'owner',
          session,
          purpose: 'instance-reset',
          targetUserId: null,
          reauthenticationLease: destructiveLease,
        },
        session: { kind: 'prelocked', lease },
        expectedEpoch: epoch,
        productFence: 'exclusive',
        subjectLock: null,
        content: { kind: 'none' },
        mode: { isolation: 'serializable', access: 'read-write' },
      }
      backendPid = await unitOfWork.run(request, async ({ gateways }) =>
        gateways.backendPid(),
      )
      betweenTransactions.resolve()
      await releaseOuterCallback.promise
      return 'must not succeed'
    })
    const outcome = operation.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    await betweenTransactions.promise
    expect(prelockedPort.activeLeaseScopeCount()).toBe(1)
    expect(runtime.snapshot().pools.control.admission.active).toBe(1)
    await inspector.query('SELECT pg_terminate_backend($1)', [backendPid])
    await expect(outcome).resolves.toMatchObject({
      ok: false,
      error: { code: 'uow.connection-lost' },
    })
    await waitForBackendExit(backendPid)
    expect(prelockedPort.activeLeaseScopeCount()).toBe(0)
    expect(runtime.snapshot().pools.control.admission.active).toBe(0)
    releaseOuterCallback.resolve()

    await expect(
      runReset({
        epoch,
        callback: async (gateways) => gateways.count('a'),
      }),
    ).resolves.toBe(0)
  })

  it('scopes request-derived mutation modes to commit and rollback on one reserved backend', async () => {
    const epoch = await currentEpoch()
    const prelockedPort = createPlatformPrelockedSessionPort()
    let controlClient: PoolClient | undefined
    const intent = createPlatformPrelockedSessionIntentFactory().instanceReset(
      async (options) => {
        const client = await runtime.acquireTrustedControl(options)
        controlClient = client
        await client.query(
          "SELECT set_config('indigo.user_creation_mode', 'owner-admin', false), set_config('indigo.deletion_mode', 'trainee-data', false)",
        )
        return {
          client,
          close: async (destroyError) => {
            client.release(destroyError())
          },
        }
      },
    )

    await prelockedPort.withPrelockedSessionLease(intent, async (lease) => {
      const request = (): InstanceResetRequest => ({
        operation: 'instance-reset',
        authority: {
          kind: 'authenticated-destructive',
          actorUserId: 'actor-1',
          expectedRole: 'owner',
          session,
          purpose: 'instance-reset',
          targetUserId: null,
          reauthenticationLease: destructiveLease,
        },
        session: { kind: 'prelocked', lease },
        expectedEpoch: epoch,
        productFence: 'exclusive',
        subjectLock: null,
        content: { kind: 'none' },
        mode: { isolation: 'serializable', access: 'read-write' },
      })

      await expect(
        unitOfWork.run(request(), async ({ gateways }) => gateways.localModes()),
      ).resolves.toEqual({
        deletionMode: 'instance-reset',
        userCreationMode: '',
      })
      if (!controlClient) throw new Error('missing reserved control client')
      const afterCommit = await controlClient.query<{
        deletion_mode: string | null
        user_creation_mode: string | null
      }>(
        `SELECT current_setting('indigo.deletion_mode', true) AS deletion_mode,
                current_setting('indigo.user_creation_mode', true) AS user_creation_mode`,
      )
      expect(afterCommit.rows[0]?.deletion_mode ?? '').toBe('')
      expect(afterCommit.rows[0]?.user_creation_mode ?? '').toBe('')

      await expect(
        unitOfWork.run(request(), async ({ gateways }) => {
          expect(await gateways.localModes()).toEqual({
            deletionMode: 'instance-reset',
            userCreationMode: '',
          })
          throw new Error('force rollback')
        }),
      ).rejects.toThrow('force rollback')
      const afterRollback = await controlClient.query<{
        deletion_mode: string | null
        user_creation_mode: string | null
      }>(
        `SELECT current_setting('indigo.deletion_mode', true) AS deletion_mode,
                current_setting('indigo.user_creation_mode', true) AS user_creation_mode`,
      )
      expect(afterRollback.rows[0]?.deletion_mode ?? '').toBe('')
      expect(afterRollback.rows[0]?.user_creation_mode ?? '').toBe('')
    })

    expect(prelockedPort.activeLeaseScopeCount()).toBe(0)
  })

  it('cancels a blocked advisory waiter and retires its physical backend', async () => {
    const epoch = await currentEpoch()
    const blocker = new Client({ connectionString: database.databaseUrl })
    await blocker.connect()
    let lockHeld = false
    try {
      await blocker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        'subject-cancelled',
      ])
      lockHeld = true
      const existingWaiters = await currentAdvisoryWaiterPids()
      const controller = new AbortController()
      const operation = runSubject({
        callback: async () => 'must not enter',
        commandId: 'cancelled-waiter',
        epoch,
        signal: controller.signal,
        subjectId: 'subject-cancelled',
      })
      const outcome = operation.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const [waiterPid] = await newAdvisoryWaiterPids(existingWaiters, 1)
      if (!waiterPid) throw new Error('missing advisory waiter pid')
      controller.abort()
      await expect(outcome).resolves.toMatchObject({
        ok: false,
        error: { code: 'uow.cancelled' },
      })
      await waitForBackendExit(waiterPid)
    } finally {
      if (lockHeld) {
        await blocker
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
            'subject-cancelled',
          ])
          .catch(() => undefined)
      }
      await blocker.end().catch(() => undefined)
    }
  })
})
