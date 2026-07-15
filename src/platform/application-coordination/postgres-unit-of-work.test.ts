import { EventEmitter } from 'node:events'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type {
  AuthenticatedSessionReference,
  ContentLockPlanBindings,
  ExactReplayAuthorizer,
  GlobalProductMutationRequest,
  NewCommandAuthorizer,
  SubjectExportRequest,
  SubjectProductMutationRequest,
  UnitOfWorkScope,
} from '@/application/coordination'
import type { CanonicalValue } from '@/shared/canonical-json'
import {
  createContentLockPlanPort,
  createContentLockProjectionFactory,
} from './content-lock-plan'
import { createInstallationMutationEpoch } from './lifecycle-values'
import { PostgresUnitOfWork, type ScopedTransactionClient } from './postgres-unit-of-work'

type TranscriptEntry = {
  readonly text: string
  readonly values: readonly unknown[]
}

type FakeClient = {
  readonly client: PoolClient
  readonly release: ReturnType<typeof vi.fn>
  readonly transcript: TranscriptEntry[]
}

type QueryHook = (
  text: string,
  values: readonly unknown[],
) => Promise<QueryResult<QueryResultRow>> | undefined

function queryResult<Row extends QueryResultRow>(
  rows: readonly Row[] = [],
  command = 'SELECT',
): QueryResult<Row> {
  return {
    command,
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows: [...rows],
  }
}

function fakeClient(hook?: QueryHook): FakeClient {
  const transcript: TranscriptEntry[] = []
  const release = vi.fn()
  const query = (async (text: string, values: readonly unknown[] = []) => {
    transcript.push({ text, values })
    const hooked = hook?.(text, values)
    if (hooked) return hooked
    if (text.includes('pg_advisory_unlock')) return queryResult([{ unlocked: true }])
    if (text === 'SELECT identity') return queryResult([{ authority: 'current' }])
    if (text === 'SELECT read-value') return queryResult([{ value: 'read' }])
    if (text.startsWith('BEGIN')) return queryResult([], 'BEGIN')
    if (text === 'COMMIT') return queryResult([], 'COMMIT')
    if (text === 'ROLLBACK') return queryResult([], 'ROLLBACK')
    return queryResult()
  }) as PoolClient['query']
  const client = Object.assign(new EventEmitter(), { query, release })
  return {
    client: client as unknown as PoolClient,
    release,
    transcript,
  }
}

type ReadGateways = {
  read(): Promise<string>
}

type WriteGateways = ReadGateways & {
  abortTransaction(): Promise<void>
  anonymousBlock(): Promise<void>
  authorizeExactReplay(storedResult: CanonicalValue): Promise<void>
  authorizeNewCommand(): Promise<void>
  caseExpression(): Promise<void>
  callProcedure(): Promise<void>
  createTemporaryTable(): Promise<void>
  dblinkMutation(): Promise<void>
  endAfterBackslashLiteral(): Promise<void>
  endTransaction(): Promise<void>
  executePreparedMutation(): Promise<void>
  explainPreparedMutation(): Promise<void>
  fastNoQuery(): Promise<void>
  lockTable(): Promise<void>
  largeObjectWrite(): Promise<void>
  pauseBeforeWrite(): Promise<void>
  prepareMutation(): Promise<void>
  queryWithAccessorText(): Promise<void>
  queryWithCallbackConfig(): Promise<void>
  queryWithSubmittable(): Promise<void>
  write(): Promise<void>
  writeWithoutGuard(): Promise<void>
  releaseCoordinationLocks(): Promise<void>
  setSessionState(): Promise<void>
  setRandomSeed(): Promise<void>
  startDetached(): Promise<void>
  unicodeEscapedUnlock(): Promise<void>
}

type GatewayTestHooks = {
  readonly beforeWrite?: () => Promise<void>
}

function gatewayContext(
  client: ScopedTransactionClient,
  requireWriteAuthorized: () => void,
  exactReplayAuthorizer: ExactReplayAuthorizer | null,
  newCommandAuthorizer: NewCommandAuthorizer | null,
  hooks: GatewayTestHooks = {},
) {
  const read = async (): Promise<string> => {
    const result = await client.query<{ value: string }>('SELECT read-value')
    return result.rows[0]?.value ?? 'missing'
  }
  return {
    recheckIdentity: async () => {
      await client.query('SELECT identity')
    },
    readGateways: { read },
    writeGateways: {
      read,
      async abortTransaction() {
        await client.query('ABORT WORK')
      },
      async anonymousBlock() {
        await client.query('DO $$ BEGIN PERFORM pg_advisory_unlock_all(); END $$')
      },
      async authorizeExactReplay(storedResult: CanonicalValue) {
        await client.query('SELECT exact-receipt')
        if (!exactReplayAuthorizer) throw new Error('missing exact replay authorizer')
        exactReplayAuthorizer.authorizeExactReplay(storedResult)
      },
      async authorizeNewCommand() {
        await client.query('SELECT command-receipt')
        if (!newCommandAuthorizer) throw new Error('missing new command authorizer')
        newCommandAuthorizer.authorizeNewCommand()
      },
      async caseExpression() {
        await client.query("SELECT CASE WHEN true THEN 'ok' ELSE 'no' END")
      },
      async callProcedure() {
        await client.query('CALL retained_procedure()')
      },
      async createTemporaryTable() {
        await client.query('SELECT 1 INTO LOCAL TEMPORARY TABLE retained_state')
      },
      async dblinkMutation() {
        await client.query(
          "SELECT dblink_exec('foreign', 'INSERT INTO escaped VALUES (1)')",
        )
      },
      async endAfterBackslashLiteral() {
        await client.query(String.raw`SELECT '\'; END`)
      },
      async endTransaction() {
        await client.query('END WORK')
      },
      async executePreparedMutation() {
        await client.query('EXECUTE retained_mutation')
      },
      async explainPreparedMutation() {
        await client.query('EXPLAIN (ANALYZE true) EXECUTE retained_mutation')
      },
      async fastNoQuery() {},
      async lockTable() {
        await client.query('LOCK TABLE owner_projection IN ACCESS EXCLUSIVE MODE')
      },
      async largeObjectWrite() {
        await client.query("SELECT lowrite(lo_open(1, 131072), 'payload'::bytea)")
      },
      async pauseBeforeWrite() {
        await hooks.beforeWrite?.()
        requireWriteAuthorized()
        await client.query('INSERT delayed-write')
      },
      async prepareMutation() {
        await client.query('PREPARE retained_mutation AS INSERT prepared-write')
      },
      async queryWithAccessorText() {
        await client.query({
          get text() {
            throw new Error('the SQL text getter must not be invoked')
          },
        } as never)
      },
      async queryWithCallbackConfig() {
        await client.query({
          callback() {
            throw new Error('a query-config callback must not be dispatched')
          },
          text: 'SELECT read-value',
        } as never)
      },
      async queryWithSubmittable() {
        await client.query({
          submit() {
            throw new Error('a submittable must not receive the raw connection')
          },
          text: 'SELECT read-value',
        } as never)
      },
      async write() {
        requireWriteAuthorized()
        await client.query('SELECT owner-row FOR UPDATE')
        await client.query('INSERT write-value')
      },
      async writeWithoutGuard() {
        await client.query('INSERT unguarded-write')
      },
      async releaseCoordinationLocks() {
        await client.query(
          'SELECT "pg_advisory_unlock_all" /* outer /* nested */ gap */ ()',
        )
      },
      async setSessionState() {
        await client.query('SET search_path TO pg_catalog')
      },
      async setRandomSeed() {
        await client.query('SELECT setseed(0.25)')
      },
      async startDetached() {
        requireWriteAuthorized()
        await client.query('SELECT detached')
      },
      async unicodeEscapedUnlock() {
        await client.query(String.raw`SELECT U&"pg\005fadvisory\005funlock\005fall"()`)
      },
    },
  }
}

function unitOfWork(database: FakeClient, hooks: GatewayTestHooks = {}) {
  return new PostgresUnitOfWork<ReadGateways, WriteGateways>({
    acquireOrdinary: async () => database.client,
    resolvePrelockedSession: () => {
      throw new Error('test did not expect a prelocked session')
    },
    createGatewayContext: ({
      client,
      exactReplayAuthorizer,
      newCommandAuthorizer,
      requireWriteAuthorized,
    }) =>
      gatewayContext(
        client,
        requireWriteAuthorized,
        exactReplayAuthorizer,
        newCommandAuthorizer,
        hooks,
      ),
    lockTimeoutMs: 20,
    detachedDrainTimeoutMs: 20,
    queryTimeoutMs: 100,
  })
}

const expectedEpoch = createInstallationMutationEpoch(
  '123e4567-e89b-42d3-a456-426614174000',
)
const session = {} as AuthenticatedSessionReference
const methodologyFactory = createContentLockProjectionFactory('methodology-target')
const releasePair = [
  { kind: 'methodology' as const, id: 'methodology-development', version: '1' },
  { kind: 'template' as const, id: 'template-development', version: '1' },
]

function exportRequest(): SubjectExportRequest {
  return {
    operation: 'subject-export',
    authority: {
      kind: 'authenticated-session',
      actorUserId: 'actor-1',
      expectedRole: 'owner',
      session,
    },
    session: { kind: 'ordinary' },
    expectedEpoch,
    productFence: 'shared',
    subjectLock: { subjectUserId: 'subject-1', mode: 'shared' },
    content: { kind: 'none' },
    mode: { isolation: 'repeatable-read', access: 'read-only' },
  }
}

function planBindings(): ContentLockPlanBindings & { readonly shape: 'none' } {
  return {
    shape: 'none',
    purpose: 'global-product-mutation',
    actorAccountId: 'actor-1',
    subjectId: null,
    formOrCommandId: 'command-1',
    sourceEntityIds: [],
    expectedEpoch,
    expectedGeneration: null,
  }
}

async function withWriteRequest<Result>(
  uow: PostgresUnitOfWork<ReadGateways, WriteGateways>,
  callback: (gateways: WriteGateways) => Promise<Result>,
): Promise<Result> {
  const content = createContentLockPlanPort({
    authSecret: 'test-auth-secret-with-at-least-thirty-two-bytes',
    resolveActorAccountId: async () => 'actor-1',
  })
  const bindings = planBindings()
  const envelope = await content.withIssuanceScope(bindings, async ({ seal }) => seal([]))
  return content.withVerifiedContentLockPlan(
    content.prepareEnvelope(envelope),
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
        expectedEpoch,
        productFence: 'shared',
        subjectLock: null,
        content: { kind: 'verified', plan, bindings },
        mode: { isolation: 'read-committed', access: 'read-write' },
      }
      return uow.run(request, async ({ gateways }) => {
        await gateways.authorizeNewCommand()
        return callback(gateways)
      })
    },
  )
}

async function withInitialPublication<Result>(
  uow: PostgresUnitOfWork<ReadGateways, WriteGateways>,
  callback: (scope: UnitOfWorkScope<WriteGateways>) => Promise<Result>,
  options: { readonly classification?: 'new' | 'deferred' } = {},
): Promise<Result> {
  const content = createContentLockPlanPort({
    authSecret: 'test-auth-secret-with-at-least-thirty-two-bytes',
    resolveActorAccountId: async () => 'actor-1',
  })
  const bindings: ContentLockPlanBindings & {
    readonly shape: 'current-publication.initial'
  } = {
    ...planBindings(),
    shape: 'current-publication.initial',
    purpose: 'current-publication.initial',
    subjectId: 'subject-1',
  }
  const envelope = await content.withIssuanceScope(bindings, async ({ scope, seal }) =>
    seal([methodologyFactory.createIssuanceProjection(scope, releasePair)]),
  )
  return content.withVerifiedContentLockPlan(
    content.prepareEnvelope(envelope),
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
        expectedEpoch,
        productFence: 'shared',
        subjectLock: { subjectUserId: 'subject-1', mode: 'exclusive' },
        content: { kind: 'verified', plan, bindings },
        mode: { isolation: 'read-committed', access: 'read-write' },
      }
      return uow.run(request, async (scope) => {
        if ((options.classification ?? 'new') === 'new') {
          await scope.gateways.authorizeNewCommand()
        }
        return callback(scope)
      })
    },
  )
}

describe('PostgresUnitOfWork', () => {
  it('locks in canonical order before BEGIN and makes Identity the first transaction query', async () => {
    const database = fakeClient()
    const uow = unitOfWork(database)
    const resultValue = { committed: true }

    const result = await withWriteRequest(uow, async (gateways) => {
      expect(await gateways.read()).toBe('read')
      await gateways.write()
      return resultValue
    })

    expect(result).toBe(resultValue)
    const beginIndex = database.transcript.findIndex(({ text }) =>
      text.startsWith('BEGIN'),
    )
    const commitIndex = database.transcript.findIndex(({ text }) => text === 'COMMIT')
    const lockEntries = database.transcript.filter(({ text }) =>
      /pg_advisory_lock(?:_shared)?\(/.test(text),
    )
    expect(lockEntries.map(({ values }) => values[0])).toEqual([
      'indigo:credential-lifecycle:instance-fence',
      'indigo:credential-lifecycle:account:actor-1',
      'indigo:product-mutation-fence',
    ])
    expect(
      lockEntries.every((entry) => database.transcript.indexOf(entry) < beginIndex),
    ).toBe(true)
    for (const entry of lockEntries) {
      const lockIndex = database.transcript.indexOf(entry)
      expect(database.transcript[lockIndex - 1]?.text).toBe(
        "SELECT set_config('lock_timeout', $1, false)",
      )
    }
    expect(database.transcript[beginIndex]?.text).toBe(
      'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    )
    expect(database.transcript[beginIndex + 1]?.text).toBe('SELECT identity')
    expect(commitIndex).toBeGreaterThan(beginIndex)
    expect(
      database.transcript
        .filter(({ text }) => text.includes('pg_advisory_unlock'))
        .map(({ values }) => values[0]),
    ).toEqual([
      'indigo:product-mutation-fence',
      'indigo:credential-lifecycle:account:actor-1',
      'indigo:credential-lifecycle:instance-fence',
    ])
    expect(database.release).toHaveBeenCalledWith()
  })

  it('orders credential, product, subject, content, and owner-row locks before DML', async () => {
    const database = fakeClient()

    await expect(
      withInitialPublication(unitOfWork(database), async ({ gateways, content }) => {
        if (content.kind !== 'verified') throw new Error('missing verified content')
        content.attestor.assertCurrentLockedContentSet([
          methodologyFactory.createTransactionProjection(
            content.transactionScope,
            releasePair,
          ),
        ])
        await gateways.write()
        return 'committed'
      }),
    ).resolves.toBe('committed')

    const lockEntries = database.transcript.filter(({ text }) =>
      /pg_advisory_lock(?:_shared)?\(/.test(text),
    )
    expect(lockEntries.map(({ values }) => values[0])).toEqual([
      'indigo:credential-lifecycle:instance-fence',
      'indigo:credential-lifecycle:account:actor-1',
      'indigo:product-mutation-fence',
      'subject-1',
      'methodology:methodology-development:1',
      'template:template-development:1',
    ])
    const beginIndex = database.transcript.findIndex(({ text }) =>
      text.startsWith('BEGIN'),
    )
    const identityIndex = database.transcript.findIndex(
      ({ text }) => text === 'SELECT identity',
    )
    const classificationIndex = database.transcript.findIndex(
      ({ text }) => text === 'SELECT command-receipt',
    )
    const ownerRowIndex = database.transcript.findIndex(
      ({ text }) => text === 'SELECT owner-row FOR UPDATE',
    )
    const writeIndex = database.transcript.findIndex(
      ({ text }) => text === 'INSERT write-value',
    )
    expect(
      lockEntries.every((entry) => database.transcript.indexOf(entry) < beginIndex),
    ).toBe(true)
    expect(identityIndex).toBe(beginIndex + 1)
    expect(classificationIndex).toBeGreaterThan(identityIndex)
    expect(ownerRowIndex).toBeGreaterThan(classificationIndex)
    expect(writeIndex).toBeGreaterThan(ownerRowIndex)
  })

  it('preserves callback error identity, rolls back, and revokes retained gateways', async () => {
    const database = fakeClient()
    const uow = unitOfWork(database)
    const original = new Error('workflow failed')
    let retained: WriteGateways | undefined

    await expect(
      withWriteRequest(uow, async (gateways) => {
        retained = gateways
        await gateways.write()
        throw original
      }),
    ).rejects.toBe(original)

    expect(database.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(true)
    expect(database.transcript.some(({ text }) => text === 'COMMIT')).toBe(false)
    const revoked = retained
    if (!revoked) throw new Error('gateway was not retained')
    expect(() => revoked.write()).toThrowError(
      expect.objectContaining({ code: 'uow.scope-revoked' }),
    )
    expect(database.release).toHaveBeenCalledWith()
  })

  it('rolls back detached query work and destroys the session after it drains', async () => {
    let finishDetached: () => void = () => undefined
    let markDetachedStarted: () => void = () => undefined
    const detachedStarted = new Promise<void>((resolve) => {
      markDetachedStarted = resolve
    })
    const detached = new Promise<QueryResult<QueryResultRow>>((resolve) => {
      finishDetached = () => resolve(queryResult())
    })
    const database = fakeClient((text) => {
      if (text !== 'SELECT detached') return undefined
      markDetachedStarted()
      return detached
    })
    const uow = unitOfWork(database)

    const result = withWriteRequest(uow, async (gateways) => {
      void gateways.startDetached()
      return 'must roll back'
    })
    const outcome = result.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await detachedStarted
    finishDetached()

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      error: { code: 'uow.detached-work' },
    })
    expect(database.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(true)
    expect(database.transcript.some(({ text }) => text === 'COMMIT')).toBe(false)
    expect(database.release).toHaveBeenCalledWith(expect.any(Error))
  })

  it('tracks a detached gateway before its first query and through an ignored catch chain', async () => {
    let releaseBeforeWrite: () => void = () => undefined
    let markBeforeWriteStarted: () => void = () => undefined
    const beforeWriteStarted = new Promise<void>((resolve) => {
      markBeforeWriteStarted = resolve
    })
    const beforeWrite = new Promise<void>((resolve) => {
      releaseBeforeWrite = resolve
    })
    const delayedDatabase = fakeClient()
    const delayedResult = withWriteRequest(
      unitOfWork(delayedDatabase, {
        beforeWrite: async () => {
          markBeforeWriteStarted()
          await beforeWrite
        },
      }),
      async (gateways) => {
        expect(Object.getPrototypeOf(gateways)).toBeNull()
        expect(Object.isFrozen(gateways)).toBe(true)
        const descriptor = Object.getOwnPropertyDescriptor(gateways, 'pauseBeforeWrite')
        if (typeof descriptor?.value !== 'function') {
          throw new Error('tracked gateway descriptor missing')
        }
        void descriptor.value()
        return 'detached'
      },
    )
    const delayedOutcome = delayedResult.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await beforeWriteStarted
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseBeforeWrite()
    await expect(delayedOutcome).resolves.toMatchObject({
      ok: false,
      error: { code: 'uow.detached-work' },
    })
    expect(
      delayedDatabase.transcript.some(({ text }) => text === 'INSERT delayed-write'),
    ).toBe(false)
    expect(delayedDatabase.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(true)
    expect(delayedDatabase.release).toHaveBeenCalledWith(expect.any(Error))

    const fastDatabase = fakeClient()
    await expect(
      withWriteRequest(unitOfWork(fastDatabase), async (gateways) => {
        void gateways.fastNoQuery().catch(() => undefined)
        return 'unobserved'
      }),
    ).rejects.toMatchObject({ code: 'uow.detached-work' })
    expect(fastDatabase.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(true)
    expect(fastDatabase.release).toHaveBeenCalledWith(expect.any(Error))
  })

  it('requires successful content attestation before DML and before commit', async () => {
    for (const mode of ['early-write', 'missing', 'caught-stale'] as const) {
      const database = fakeClient()
      await expect(
        withInitialPublication(unitOfWork(database), async ({ gateways, content }) => {
          if (content.kind !== 'verified') throw new Error('missing verified content')
          if (mode === 'early-write') {
            await gateways.write()
          } else if (mode === 'caught-stale') {
            const stale = methodologyFactory.createTransactionProjection(
              content.transactionScope,
              [releasePair[0], { ...releasePair[1], version: '2' }],
            )
            try {
              content.attestor.assertCurrentLockedContentSet([stale])
            } catch {
              // Catching the stale proof cannot grant write or commit authority.
            }
          }
          return 'must not commit'
        }),
      ).rejects.toMatchObject({ code: 'content-lock-plan.stale' })
      expect(database.transcript.some(({ text }) => text === 'INSERT write-value')).toBe(
        false,
      )
      expect(database.transcript.some(({ text }) => text === 'COMMIT')).toBe(false)
    }

    const database = fakeClient()
    await expect(
      withInitialPublication(unitOfWork(database), async ({ gateways, content }) => {
        if (content.kind !== 'verified') throw new Error('missing verified content')
        const current = methodologyFactory.createTransactionProjection(
          content.transactionScope,
          releasePair,
        )
        content.attestor.assertCurrentLockedContentSet([current])
        await gateways.write()
        return 'committed'
      }),
    ).resolves.toBe('committed')
    expect(database.transcript.some(({ text }) => text === 'INSERT write-value')).toBe(
      true,
    )
    expect(database.transcript.some(({ text }) => text === 'COMMIT')).toBe(true)
  })

  it('requires new-command classification before attestation and guards unwrapped DML', async () => {
    const unclassifiedDatabase = fakeClient()
    let attestationError: unknown
    await expect(
      withInitialPublication(
        unitOfWork(unclassifiedDatabase),
        async ({ gateways, content }) => {
          if (content.kind !== 'verified') throw new Error('missing verified content')
          const current = methodologyFactory.createTransactionProjection(
            content.transactionScope,
            releasePair,
          )
          try {
            content.attestor.assertCurrentLockedContentSet([current])
          } catch (error) {
            attestationError = error
          }
          await gateways.writeWithoutGuard()
          return 'must not commit'
        },
        { classification: 'deferred' },
      ),
    ).rejects.toMatchObject({ code: 'content-lock-plan.stale' })
    expect(attestationError).toMatchObject({ code: 'uow.scope-revoked' })
    expect(
      unclassifiedDatabase.transcript.some(
        ({ text }) => text === 'INSERT unguarded-write',
      ),
    ).toBe(false)

    const unattestedDatabase = fakeClient()
    await expect(
      withInitialPublication(unitOfWork(unattestedDatabase), async ({ gateways }) => {
        await gateways.writeWithoutGuard()
        return 'must not commit'
      }),
    ).rejects.toMatchObject({ code: 'content-lock-plan.stale' })
    expect(
      unattestedDatabase.transcript.some(({ text }) => text === 'INSERT unguarded-write'),
    ).toBe(false)

    const authorizedDatabase = fakeClient()
    await expect(
      withInitialPublication(
        unitOfWork(authorizedDatabase),
        async ({ gateways, content }) => {
          if (content.kind !== 'verified') throw new Error('missing verified content')
          content.attestor.assertCurrentLockedContentSet([
            methodologyFactory.createTransactionProjection(
              content.transactionScope,
              releasePair,
            ),
          ])
          await gateways.writeWithoutGuard()
          return 'committed'
        },
      ),
    ).resolves.toBe('committed')
    expect(
      authorizedDatabase.transcript.some(({ text }) => text === 'INSERT unguarded-write'),
    ).toBe(true)
  })

  it('keeps connection and advisory-lock control outside owner gateways', async () => {
    const database = fakeClient()

    await expect(
      withWriteRequest(unitOfWork(database), async (gateways) => {
        await gateways.releaseCoordinationLocks()
        return 'must not commit'
      }),
    ).rejects.toThrow('Connection and lock control belongs to UnitOfWork.')

    expect(
      database.transcript.some(({ text }) => text.includes('pg_advisory_unlock_all')),
    ).toBe(false)
    expect(database.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(true)
    expect(
      database.transcript
        .filter(({ text }) => text.includes('pg_advisory_unlock'))
        .map(({ values }) => values[0]),
    ).toEqual([
      'indigo:product-mutation-fence',
      'indigo:credential-lifecycle:account:actor-1',
      'indigo:credential-lifecycle:instance-fence',
    ])
  })

  it('rejects transaction aliases and persistent session state without false-matching CASE END', async () => {
    const caseDatabase = fakeClient()
    await expect(
      withWriteRequest(unitOfWork(caseDatabase), async (gateways) => {
        await gateways.caseExpression()
        return 'committed'
      }),
    ).resolves.toBe('committed')
    expect(caseDatabase.transcript.some(({ text }) => text.includes('CASE WHEN'))).toBe(
      true,
    )

    const forbidden: readonly [
      label: string,
      invoke: (gateways: WriteGateways) => Promise<void>,
      message: string,
    ][] = [
      ['END', (gateways) => gateways.endTransaction(), 'Transaction control'],
      ['ABORT', (gateways) => gateways.abortTransaction(), 'Transaction control'],
      [
        'plain-string boundary',
        (gateways) => gateways.endAfterBackslashLiteral(),
        'Transaction control',
      ],
      ['SET', (gateways) => gateways.setSessionState(), 'Connection and lock control'],
      [
        'DO block',
        (gateways) => gateways.anonymousBlock(),
        'Connection and lock control',
      ],
      ['CALL', (gateways) => gateways.callProcedure(), 'Connection and lock control'],
      [
        'PREPARE',
        (gateways) => gateways.prepareMutation(),
        'Connection and lock control',
      ],
      [
        'EXECUTE',
        (gateways) => gateways.executePreparedMutation(),
        'Connection and lock control',
      ],
      [
        'EXPLAIN ANALYZE EXECUTE',
        (gateways) => gateways.explainPreparedMutation(),
        'Connection and lock control',
      ],
      ['setseed', (gateways) => gateways.setRandomSeed(), 'Connection and lock control'],
      [
        'SELECT INTO TEMP',
        (gateways) => gateways.createTemporaryTable(),
        'Connection and lock control',
      ],
      ['dblink', (gateways) => gateways.dblinkMutation(), 'Connection and lock control'],
      ['LOCK TABLE', (gateways) => gateways.lockTable(), 'Connection and lock control'],
      [
        'large-object write',
        (gateways) => gateways.largeObjectWrite(),
        'Connection and lock control',
      ],
    ]

    for (const [label, invoke, message] of forbidden) {
      const database = fakeClient()
      await expect(
        withWriteRequest(unitOfWork(database), async (gateways) => {
          await invoke(gateways)
          return `must reject ${label}`
        }),
      ).rejects.toThrow(message)
      expect(database.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(true)
      expect(
        database.transcript.some(({ text }) =>
          /EXPLAIN\s+\(ANALYZE\s+true\)\s+EXECUTE|SELECT\s+setseed/i.test(text),
        ),
      ).toBe(false)
    }
  })

  it('rejects unstable query configs and unsupported quoted identifiers before dispatch', async () => {
    for (const invoke of [
      (gateways: WriteGateways) => gateways.queryWithAccessorText(),
      (gateways: WriteGateways) => gateways.queryWithCallbackConfig(),
      (gateways: WriteGateways) => gateways.queryWithSubmittable(),
    ]) {
      const database = fakeClient()
      await expect(
        withWriteRequest(unitOfWork(database), async (gateways) => {
          await invoke(gateways)
          return 'must not commit'
        }),
      ).rejects.toThrow('Scoped transaction queries must expose stable SQL text.')
      expect(database.transcript.some(({ text }) => text === 'SELECT read-value')).toBe(
        false,
      )
    }

    const unicodeDatabase = fakeClient()
    await expect(
      withWriteRequest(unitOfWork(unicodeDatabase), async (gateways) => {
        await gateways.unicodeEscapedUnlock()
        return 'must not commit'
      }),
    ).rejects.toThrow('unsupported quoted identifier')
    expect(unicodeDatabase.transcript.some(({ text }) => text.includes('005f'))).toBe(
      false,
    )
  })

  it('commits an exact replay without fresh attestation but never grants replay DML', async () => {
    const replayDatabase = fakeClient()
    const storedResult = { publicationId: 'persisted-publication' }
    const result = await withInitialPublication(
      unitOfWork(replayDatabase),
      async ({ gateways }) => {
        await gateways.authorizeExactReplay(storedResult)
        return storedResult
      },
      { classification: 'deferred' },
    )
    expect(result).toBe(storedResult)
    expect(
      replayDatabase.transcript.some(({ text }) => text === 'SELECT exact-receipt'),
    ).toBe(true)
    expect(
      replayDatabase.transcript.some(
        ({ text }) => text.startsWith('INSERT') || text.includes('FOR UPDATE'),
      ),
    ).toBe(false)
    expect(replayDatabase.transcript.some(({ text }) => text === 'COMMIT')).toBe(true)

    const fabricatedDatabase = fakeClient()
    await expect(
      withInitialPublication(
        unitOfWork(fabricatedDatabase),
        async ({ gateways }) => {
          await gateways.authorizeExactReplay(storedResult)
          return { ...storedResult }
        },
        { classification: 'deferred' },
      ),
    ).rejects.toMatchObject({ code: 'uow.scope-revoked' })
    expect(fabricatedDatabase.transcript.some(({ text }) => text === 'COMMIT')).toBe(
      false,
    )
    expect(fabricatedDatabase.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(
      true,
    )

    const mutatedDatabase = fakeClient()
    const mutableStoredResult = { publicationId: 'persisted-publication' }
    await expect(
      withInitialPublication(
        unitOfWork(mutatedDatabase),
        async ({ gateways }) => {
          await gateways.authorizeExactReplay(mutableStoredResult)
          mutableStoredResult.publicationId = 'fabricated-publication'
          return mutableStoredResult
        },
        { classification: 'deferred' },
      ),
    ).rejects.toMatchObject({ code: 'uow.scope-revoked' })
    expect(mutatedDatabase.transcript.some(({ text }) => text === 'COMMIT')).toBe(false)

    const writeDatabase = fakeClient()
    await expect(
      withInitialPublication(
        unitOfWork(writeDatabase),
        async ({ gateways }) => {
          await gateways.authorizeExactReplay(storedResult)
          await gateways.write()
          return 'must not commit'
        },
        { classification: 'deferred' },
      ),
    ).rejects.toMatchObject({ code: 'content-lock-plan.stale' })
    expect(
      writeDatabase.transcript.some(({ text }) => text === 'INSERT write-value'),
    ).toBe(false)
    expect(writeDatabase.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(true)

    const priorWriteDatabase = fakeClient()
    await expect(
      withWriteRequest(unitOfWork(priorWriteDatabase), async (gateways) => {
        await gateways.write()
        await gateways.authorizeExactReplay(storedResult)
        return 'must not convert a write into replay'
      }),
    ).rejects.toMatchObject({ code: 'uow.scope-revoked' })
    expect(
      priorWriteDatabase.transcript.some(({ text }) => text === 'INSERT write-value'),
    ).toBe(true)
    expect(priorWriteDatabase.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(
      true,
    )

    const earlyDatabase = fakeClient()
    const earlyUow = new PostgresUnitOfWork<ReadGateways, WriteGateways>({
      acquireOrdinary: async () => earlyDatabase.client,
      resolvePrelockedSession: () => {
        throw new Error('unexpected prelocked session')
      },
      createGatewayContext: (input) => {
        input.exactReplayAuthorizer?.authorizeExactReplay(storedResult)
        return gatewayContext(
          input.client,
          input.requireWriteAuthorized,
          input.exactReplayAuthorizer,
          input.newCommandAuthorizer,
        )
      },
    })
    await expect(
      withWriteRequest(earlyUow, async () => 'must not enter'),
    ).rejects.toMatchObject({ code: 'uow.scope-revoked' })
    expect(earlyDatabase.transcript.some(({ text }) => text === 'SELECT identity')).toBe(
      false,
    )
  })

  it('unlocks only acquired locks after a server lock timeout', async () => {
    let lockCount = 0
    const timeout = Object.assign(new Error('lock timeout'), { code: '55P03' })
    const database = fakeClient((text) => {
      if (!/pg_advisory_lock(?:_shared)?\(/.test(text)) return undefined
      lockCount += 1
      return lockCount === 2 ? Promise.reject(timeout) : Promise.resolve(queryResult())
    })

    await expect(
      unitOfWork(database).run(exportRequest(), async () => 'never'),
    ).rejects.toMatchObject({ code: 'uow.lock-timeout' })
    expect(database.transcript.some(({ text }) => text.startsWith('BEGIN'))).toBe(false)
    expect(
      database.transcript
        .filter(({ text }) => text.includes('pg_advisory_unlock'))
        .map(({ values }) => values[0]),
    ).toEqual(['indigo:credential-lifecycle:instance-fence'])
    expect(database.release).toHaveBeenCalledWith()
  })

  it('rejects a false COMMIT command and retires the session', async () => {
    const database = fakeClient((text) =>
      text === 'COMMIT' ? Promise.resolve(queryResult([], 'ROLLBACK')) : undefined,
    )
    await expect(
      withWriteRequest(unitOfWork(database), async () => 'false commit'),
    ).rejects.toMatchObject({ code: 'uow.transaction-aborted' })
    expect(database.release).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'uow.transaction-aborted' }),
    )
  })

  it('maps query and emitted connection loss, skips SQL cleanup, and retires', async () => {
    const connectionFailure = Object.assign(new Error('connection terminated'), {
      code: '08006',
    })
    const queryDatabase = fakeClient((text) =>
      text === 'SELECT read-value' ? Promise.reject(connectionFailure) : undefined,
    )
    await expect(
      unitOfWork(queryDatabase).run(exportRequest(), async ({ gateways }) =>
        gateways.read(),
      ),
    ).rejects.toMatchObject({ code: 'uow.connection-lost' })
    const failedQueryIndex = queryDatabase.transcript.findIndex(
      ({ text }) => text === 'SELECT read-value',
    )
    expect(
      queryDatabase.transcript
        .slice(failedQueryIndex + 1)
        .some(({ text }) =>
          /ROLLBACK|pg_advisory_unlock|RESET (?:lock|statement)_timeout/.test(text),
        ),
    ).toBe(false)
    expect(queryDatabase.release).toHaveBeenCalledWith(expect.any(Error))

    let markPending: () => void = () => undefined
    const pendingStarted = new Promise<void>((resolve) => {
      markPending = resolve
    })
    const emittedDatabase = fakeClient((text) => {
      if (text !== 'SELECT read-value') return undefined
      markPending()
      return new Promise<QueryResult<QueryResultRow>>(() => undefined)
    })
    const emittedResult = unitOfWork(emittedDatabase).run(
      exportRequest(),
      async ({ gateways }) => gateways.read(),
    )
    const emittedOutcome = emittedResult.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await pendingStarted
    ;(emittedDatabase.client as unknown as EventEmitter).emit('error', connectionFailure)
    await expect(emittedOutcome).resolves.toMatchObject({
      ok: false,
      error: { code: 'uow.connection-lost' },
    })
    expect(emittedDatabase.release).toHaveBeenCalledWith(expect.any(Error))
  })

  it('retires a client that emits a late error during successful lock cleanup', async () => {
    const connectionFailure = Object.assign(
      new Error('connection became untrustworthy'),
      {
        code: '08006',
      },
    )
    let emitted = false
    let database: FakeClient
    database = fakeClient((text) => {
      if (!emitted && text.includes('pg_advisory_unlock')) {
        emitted = true
        ;(database.client as unknown as EventEmitter).emit('error', connectionFailure)
      }
      return undefined
    })

    await expect(
      withWriteRequest(unitOfWork(database), async () => 'commit is known'),
    ).resolves.toBe('commit is known')
    expect(database.release).toHaveBeenCalledWith(connectionFailure)
  })

  it('exposes no writer at runtime in read-only mode and rejects nested coordination', async () => {
    const database = fakeClient()
    const uow = unitOfWork(database)

    await uow.run(exportRequest(), async ({ gateways }) => {
      expect(Object.keys(gateways)).toEqual(['read'])
      expect(await gateways.read()).toBe('read')
      await expect(uow.run(exportRequest(), async () => 'nested')).rejects.toMatchObject({
        code: 'uow.nested',
      })
    })

    expect(database.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        }),
      ]),
    )
  })

  it('rejects forged request-union cross-products before database admission', () => {
    const exportDatabase = fakeClient()
    const forgedExport = {
      ...exportRequest(),
      mode: { isolation: 'read-committed', access: 'read-write' },
    } as unknown as SubjectExportRequest
    expect(() =>
      unitOfWork(exportDatabase).run(forgedExport, async ({ gateways }) => {
        await (gateways as unknown as WriteGateways).writeWithoutGuard()
        return 'must not enter'
      }),
    ).toThrow('closed runtime matrix')
    expect(exportDatabase.transcript).toEqual([])
    expect(exportDatabase.release).not.toHaveBeenCalled()

    const productDatabase = fakeClient()
    const forgedProduct = {
      operation: 'global-product-mutation',
      authority: {
        kind: 'authenticated-session',
        actorUserId: 'actor-1',
        expectedRole: 'owner',
        session,
      },
      session: { kind: 'ordinary' },
      workflowPurpose: 'global-product-mutation',
      expectedEpoch,
      productFence: 'shared',
      subjectLock: null,
      content: { kind: 'none' },
      mode: { isolation: 'read-committed', access: 'read-write' },
    } as unknown as GlobalProductMutationRequest
    expect(() =>
      unitOfWork(productDatabase).run(forgedProduct, async ({ gateways }) => {
        await gateways.writeWithoutGuard()
        return 'must not enter'
      }),
    ).toThrow('closed runtime matrix')
    expect(productDatabase.transcript).toEqual([])
    expect(productDatabase.release).not.toHaveBeenCalled()
  })

  it('maps BEGIN and COMMIT uncertainty and destroys rather than pools the client', async () => {
    const beginFailure = new Error('begin failed')
    const beginDatabase = fakeClient((text) =>
      text.startsWith('BEGIN') ? Promise.reject(beginFailure) : undefined,
    )
    await expect(
      withWriteRequest(unitOfWork(beginDatabase), async () => 'never'),
    ).rejects.toMatchObject({ code: 'uow.begin-failed' })
    expect(beginDatabase.release).toHaveBeenCalledWith(beginFailure)

    const commitFailure = new Error('commit outcome unknown')
    const commitDatabase = fakeClient((text) =>
      text === 'COMMIT' ? Promise.reject(commitFailure) : undefined,
    )
    await expect(
      withWriteRequest(unitOfWork(commitDatabase), async () => 'uncertain'),
    ).rejects.toMatchObject({ code: 'uow.commit-outcome-unknown' })
    expect(commitDatabase.release).toHaveBeenCalledWith(commitFailure)
  })

  it('cancels while waiting for a lock without beginning a transaction', async () => {
    let blockLock = true
    const database = fakeClient((text) => {
      if (blockLock && /pg_advisory_lock(?:_shared)?\(/.test(text)) {
        blockLock = false
        return new Promise(() => undefined)
      }
      return undefined
    })
    const controller = new AbortController()
    const request = { ...exportRequest(), signal: controller.signal }
    const result = unitOfWork(database).run(request, async () => 'never')
    setTimeout(() => controller.abort(), 2)

    await expect(result).rejects.toMatchObject({ code: 'uow.cancelled' })
    expect(database.transcript.some(({ text }) => text.startsWith('BEGIN'))).toBe(false)
    expect(database.release).toHaveBeenCalledWith(expect.any(Error))
  })

  it('fails closed when Identity performs no first transactional query', async () => {
    const database = fakeClient()
    const uow = new PostgresUnitOfWork<ReadGateways, WriteGateways>({
      acquireOrdinary: async () => database.client,
      resolvePrelockedSession: () => {
        throw new Error('unexpected prelocked session')
      },
      createGatewayContext: ({
        client,
        exactReplayAuthorizer,
        newCommandAuthorizer,
        requireWriteAuthorized,
      }) => {
        const context = gatewayContext(
          client,
          requireWriteAuthorized,
          exactReplayAuthorizer,
          newCommandAuthorizer,
        )
        return { ...context, recheckIdentity: async () => undefined }
      },
    })

    await expect(uow.run(exportRequest(), async () => 'never')).rejects.toMatchObject({
      code: 'identity.authority-stale',
    })
    expect(database.transcript.some(({ text }) => text === 'ROLLBACK')).toBe(true)
  })
})
