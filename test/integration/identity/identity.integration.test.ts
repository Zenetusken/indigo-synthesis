import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { count, eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getProductionIdentityAuthMutationPort } from '@/composition/identity-auth-mutations'
import {
  createOwnerFromWebWithBootstrapCode,
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
import {
  type CheckedSignOutActionBinding,
  checkedSignOutActionBindingHeader,
  identityActionBindingHeader,
} from '@/modules/identity/application/action-binding'
import {
  type AuthenticatedActor,
  deriveIdentityRole,
  OwnerAuthorizationError,
} from '@/modules/identity/application/actor'
import type { OwnerBootstrapError } from '@/modules/identity/bootstrap/owner-bootstrap'
import {
  issueCheckedSignOutActionBinding,
  issueEmailSignInActionBinding,
  issueOwnerBootstrapActionBinding,
} from '@/modules/identity/infrastructure/action-binding'
import {
  readIdentitySession,
  resetAuthForTests,
} from '@/modules/identity/infrastructure/auth'
import { credentialEmailLockDigest } from '@/modules/identity/infrastructure/credential-digests'
import {
  CredentialLifecycleCapacityError,
  credentialLifecycleConnectionLimit,
  credentialLifecycleSubmittedEmailQueueLimit,
  credentialLifecycleTrustedQueueLimit,
  withCredentialLifecycleLocks,
  withSubmittedEmailCredentialLifecycleLocks,
} from '@/modules/identity/infrastructure/credential-lifecycle-lock'
import { getInstallationOwnerUserId } from '@/modules/identity/infrastructure/installation'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { createScopedWebRecoveryRateLimitGateway } from '@/modules/identity/infrastructure/web-recovery-rate-limit'
import {
  handleAuthGet,
  handleAuthPost,
  handleAuthRequest,
} from '@/modules/identity/server/auth-handler'
import {
  emailSignInMutationCommandView,
  type IdentityAuthMutationPort,
} from '@/modules/identity/server/auth-mutation-port'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import {
  account,
  auditEvents,
  installationState,
  session,
  user,
  verification,
  webRecoveryRateLimitBuckets,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

const execFile = promisify(execFileCallback)

type BootstrapIdentity = {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly password: string
}

type AuthResponseBody = {
  readonly token?: string | null
  readonly user?: {
    readonly id: string
    readonly name: string
    readonly email: string
  }
}

type CheckedSignOutFixture = {
  readonly actionBinding: CheckedSignOutActionBinding
  readonly cookie: string
  readonly sessionId: string
  readonly userId: string
}

type CapturedOutcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly error: unknown }

const bootstrapCandidates = [
  {
    name: 'First Owner',
    email: 'first-owner@example.test',
    password: 'first-owner-password',
  },
  {
    name: 'Second Owner',
    email: 'second-owner@example.test',
    password: 'second-owner-password',
  },
] as const

let integrationDatabase: DisposableIntegrationDatabase | undefined
let owner: BootstrapIdentity
let localMember: BootstrapIdentity
let bootstrapCode: string
let bootstrapSecretsDirectory: string

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function captureOutcome<T>(promise: Promise<T>): Promise<CapturedOutcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (error: unknown) => ({ status: 'rejected', error }),
  )
}

function responseCookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .filter((value): value is string => value !== undefined)
    .join('; ')
}

async function authRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const [installation] = await getDb()
    .select({ epoch: installationState.productMutationEpoch })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
  if (!installation) throw new Error('Sign-in installation fixture is missing.')
  const actionBinding = issueEmailSignInActionBinding({
    expectedEpoch: installation.epoch,
  })

  return authRequestWithBinding(path, body, actionBinding)
}

function authRequestWithBinding(
  path: string,
  body: Record<string, unknown>,
  actionBinding: string | null,
): Promise<Response> {
  const origin = getServerConfig().appOrigin
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin,
  }
  if (actionBinding !== null) headers[identityActionBindingHeader] = actionBinding

  return handleAuthPost(
    new Request(`${origin}/api/auth${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    getProductionIdentityAuthMutationPort(),
  )
}

function checkedSignOutRequest(fixture: CheckedSignOutFixture): Request {
  const origin = getServerConfig().appOrigin
  return new Request(`${origin}/api/auth/sign-out`, {
    method: 'POST',
    headers: {
      cookie: fixture.cookie,
      origin,
      [checkedSignOutActionBindingHeader]: fixture.actionBinding,
    },
  })
}

async function checkedSignOutFixture(
  identity: BootstrapIdentity,
  options?: { readonly sessionExpiresAt?: Date },
): Promise<CheckedSignOutFixture> {
  await getDb().delete(webRecoveryRateLimitBuckets)
  const response = await authRequest('/sign-in/email', {
    email: identity.email,
    password: identity.password,
  })
  expect(response.status).toBe(200)
  const [createdSession] = await getDb()
    .select({
      expiresAt: session.expiresAt,
      id: session.id,
      userId: session.userId,
    })
    .from(session)
    .where(eq(session.userId, identity.id))
    .orderBy(sql`${session.createdAt} DESC`)
    .limit(1)
  const [installation] = await getDb()
    .select({ epoch: installationState.productMutationEpoch })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
  if (!createdSession || !installation) {
    throw new Error('Checked sign-out fixture was not persisted.')
  }
  const sessionExpiresAt = options?.sessionExpiresAt ?? createdSession.expiresAt
  if (options?.sessionExpiresAt) {
    await getDb()
      .update(session)
      .set({ expiresAt: sessionExpiresAt })
      .where(eq(session.id, createdSession.id))
  }
  return {
    actionBinding: issueCheckedSignOutActionBinding({
      expectedEpoch: installation.epoch,
      sessionId: createdSession.id,
      actorUserId: createdSession.userId,
      sessionExpiresAt,
    }),
    cookie: responseCookieHeader(response),
    sessionId: createdSession.id,
    userId: createdSession.userId,
  }
}

async function waitForAdvisoryWait(input: {
  readonly applicationName: string
  readonly description: string
  readonly expected?: number
}): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await getDb().execute<{ waiting: number }>(sql`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${input.applicationName}
        AND wait_event = 'advisory'
    `)
    if (Number(result.rows[0]?.waiting ?? 0) >= (input.expected ?? 1)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${input.description}.`)
}

function waitForControlAdvisoryWait(expected = 1): Promise<void> {
  return waitForAdvisoryWait({
    applicationName: 'indigo-synthesis:control',
    description: 'the control-session advisory-lock barrier',
    expected,
  })
}

function providerMutationPort(
  handler: (request: Request) => Promise<Response>,
): IdentityAuthMutationPort {
  return {
    emailSignIn: (command) =>
      handler(emailSignInMutationCommandView(command).providerRequest),
    checkedSignOut: ({ request }) => handler(request),
  }
}

async function runBootstrapCli(arguments_: readonly string[]) {
  return execFile(
    'bash',
    [
      'scripts/run-external-host-command.sh',
      'scripts/identity/bootstrap-owner.ts',
      ...arguments_,
    ],
    { cwd: process.cwd(), env: process.env },
  )
}

async function runBootstrapCliDirect(arguments_: readonly string[]) {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('INDIGO_EXTERNAL_HOST_LOCK_')) delete environment[name]
  }
  return execFile(
    process.execPath,
    ['--import', 'tsx', 'scripts/identity/bootstrap-owner.ts', ...arguments_],
    {
      cwd: process.cwd(),
      env: environment,
    },
  )
}

async function parseAuthResponse(response: Response): Promise<AuthResponseBody> {
  return (await response.json()) as AuthResponseBody
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'identity',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()
  bootstrapSecretsDirectory = await mkdtemp(join(tmpdir(), 'indigo-owner-bootstrap-'))
  await chmod(bootstrapSecretsDirectory, 0o700)
})

beforeEach(() => {
  resetAuthForTests()
})

afterAll(async () => {
  resetAuthForTests()
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
  if (bootstrapSecretsDirectory) {
    await rm(bootstrapSecretsDirectory, { recursive: true, force: true })
  }
})

describe('identity database boundary', () => {
  it('denies generic Better Auth signup even while the installation is open', async () => {
    const response = await authRequest('/sign-up/email', {
      name: 'Remote First Visitor',
      email: 'remote-first-visitor@example.test',
      password: 'remote-first-visitor-password',
    })
    const [userCount] = await getDb().select({ value: count() }).from(user)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: 'Not found.' })
    expect(userCount?.value).toBe(0)
  })

  it.each([
    undefined,
    'legacy-implicit-bootstrap',
  ])('rejects direct user creation with unauthorized mode %s', async (mode) => {
    const insertUser = async () => {
      const values = {
        id: newUuidV7(),
        name: 'Unauthorized Direct User',
        email: `${mode ?? 'missing'}@example.test`,
        emailVerified: false,
      }
      if (!mode) return getDb().insert(user).values(values)
      return getDb().transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT set_config('indigo.user_creation_mode', ${mode}, true)`,
        )
        return transaction.insert(user).values(values)
      })
    }

    await expect(insertUser()).rejects.toBeDefined()
    const [userCount] = await getDb().select({ value: count() }).from(user)
    expect(userCount?.value).toBe(0)
  })

  it('rejects invalid and expired capabilities without claiming the installation', async () => {
    const issuedAt = new Date('2026-07-11T12:00:00.000Z')
    const issued = await issueOwnerBootstrap({ ttlMinutes: 5, now: issuedAt })
    const input = {
      ...bootstrapCandidates[0],
      code: `indigo_b1_${'x'.repeat(43)}`,
      now: issuedAt,
    }

    await expect(createOwnerWithBootstrapCode(input)).rejects.toMatchObject({
      code: 'owner-bootstrap.capability-invalid',
    })
    const [openInstallation] = await getDb()
      .select({ epoch: installationState.productMutationEpoch })
      .from(installationState)
      .where(eq(installationState.singleton, 1))
    if (!openInstallation) throw new Error('Open installation fixture is missing.')
    const backdatedBinding = issueOwnerBootstrapActionBinding(
      { expectedEpoch: openInstallation.epoch },
      issuedAt,
    )
    const forgedWebInput = {
      ...bootstrapCandidates[0],
      code: issued.code,
      actionBinding: backdatedBinding,
      now: issuedAt,
    }
    await expect(
      createOwnerFromWebWithBootstrapCode(forgedWebInput),
    ).rejects.toMatchObject({ code: 'owner-bootstrap.capability-invalid' })
    await expect(
      createOwnerWithBootstrapCode({
        ...input,
        code: issued.code,
        now: new Date('2026-07-11T12:05:00.001Z'),
      }),
    ).rejects.toMatchObject({ code: 'owner-bootstrap.capability-invalid' })

    const fresh = await issueOwnerBootstrap({ ttlMinutes: 5 })
    const staleBinding = issueOwnerBootstrapActionBinding({
      expectedEpoch: newUuidV7(),
    })
    await expect(
      createOwnerFromWebWithBootstrapCode({
        ...bootstrapCandidates[0],
        code: fresh.code,
        actionBinding: staleBinding,
      }),
    ).rejects.toMatchObject({ code: 'owner-bootstrap.action-binding-invalid' })

    const [userCount] = await getDb().select({ value: count() }).from(user)
    const [installation] = await getDb()
      .select()
      .from(installationState)
      .where(eq(installationState.singleton, 1))
    expect(userCount?.value).toBe(0)
    expect(installation).toMatchObject({ ownerUserId: null, bootstrapClosedAt: null })
  })

  it('rejects an old redemption after replacement issuance commits first', async () => {
    const original = await issueOwnerBootstrap({ ttlMinutes: 15 })
    const candidate = bootstrapCandidates[0]
    const emailLockKey = `indigo:credential-lifecycle:email:${credentialEmailLockDigest(candidate.email)}`
    const blocker = new Client({ connectionString: getServerConfig().databaseUrl })
    await blocker.connect()
    await blocker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      emailLockKey,
    ])

    let lockHeld = true
    let redemption:
      | Promise<CapturedOutcome<Awaited<ReturnType<typeof createOwnerWithBootstrapCode>>>>
      | undefined
    try {
      redemption = captureOutcome(
        createOwnerWithBootstrapCode({ ...candidate, code: original.code }),
      )
      await waitForAdvisoryWait({
        applicationName: 'indigo-synthesis:control',
        description: 'the old bootstrap redemption to reach its email lock',
      })

      const replacement = await issueOwnerBootstrap({ ttlMinutes: 15 })
      expect(replacement.capabilityId).not.toBe(original.capabilityId)
      const [visibleReplacement] = await getDb()
        .select({ id: verification.id })
        .from(verification)
        .where(eq(verification.identifier, 'indigo:owner-bootstrap'))
      expect(visibleReplacement?.id).toBe(replacement.capabilityId)

      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        emailLockKey,
      ])
      lockHeld = false
      const redemptionOutcome = await redemption
      expect(redemptionOutcome.status).toBe('rejected')
      if (redemptionOutcome.status !== 'rejected') {
        throw new Error('A redemption of the replaced bootstrap code succeeded.')
      }
      expect(redemptionOutcome.error).toMatchObject({
        code: 'owner-bootstrap.capability-invalid',
      })

      const [userCount] = await getDb().select({ value: count() }).from(user)
      const [accountCount] = await getDb().select({ value: count() }).from(account)
      const [installation] = await getDb()
        .select()
        .from(installationState)
        .where(eq(installationState.singleton, 1))
      expect(userCount?.value).toBe(0)
      expect(accountCount?.value).toBe(0)
      expect(installation).toMatchObject({
        ownerUserId: null,
        bootstrapClosedAt: null,
      })
    } finally {
      if (lockHeld) {
        await blocker
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [emailLockKey])
          .catch(() => undefined)
      }
      await blocker.end().catch(() => undefined)
      await redemption?.catch(() => undefined)
    }
  })

  it('issues a host-only capability without printing or storing the secret', async () => {
    const codeFile = join(bootstrapSecretsDirectory, 'owner-bootstrap-code')
    const issuedProcess = await runBootstrapCli([
      'issue',
      '--code-file',
      codeFile,
      '--ttl-minutes',
      '15',
    ])
    bootstrapCode = (await readFile(codeFile, 'utf8')).trim()
    const metadata = await stat(codeFile)
    const [stored] = await getDb()
      .select({ value: verification.value })
      .from(verification)
      .where(eq(verification.identifier, 'indigo:owner-bootstrap'))

    expect(bootstrapCode).toMatch(/^indigo_b1_[A-Za-z0-9_-]{43}$/)
    expect(metadata.mode & 0o777).toBe(0o600)
    expect(`${issuedProcess.stdout}${issuedProcess.stderr}`).not.toContain(bootstrapCode)
    expect(stored?.value).not.toContain(bootstrapCode)
  })

  it('refuses direct CLI invocation that bypasses the common external-host lock', async () => {
    const codeFile = join(bootstrapSecretsDirectory, 'unguarded-bootstrap-code')
    await expect(
      runBootstrapCliDirect(['issue', '--code-file', codeFile, '--ttl-minutes', '15']),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('run-external-host-command.sh'),
    })
    await expect(stat(codeFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back the owner, installation claim, and capability consumption on failure', async () => {
    await getDb().execute(
      sql.raw(`
      CREATE FUNCTION indigo_test_reject_bootstrap_credential()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'simulated bootstrap credential failure';
      END;
      $$
    `),
    )
    await getDb().execute(
      sql.raw(`
      CREATE TRIGGER indigo_test_reject_bootstrap_credential
      BEFORE INSERT ON account
      FOR EACH ROW
      EXECUTE FUNCTION indigo_test_reject_bootstrap_credential()
    `),
    )

    try {
      await expect(
        createOwnerWithBootstrapCode({
          ...bootstrapCandidates[0],
          code: bootstrapCode,
        }),
      ).rejects.toBeDefined()
    } finally {
      await getDb().execute(
        sql.raw('DROP TRIGGER indigo_test_reject_bootstrap_credential ON account'),
      )
      await getDb().execute(
        sql.raw('DROP FUNCTION indigo_test_reject_bootstrap_credential()'),
      )
    }

    const [userCount] = await getDb().select({ value: count() }).from(user)
    const [accountCount] = await getDb().select({ value: count() }).from(account)
    const [capabilityCount] = await getDb()
      .select({ value: count() })
      .from(verification)
      .where(eq(verification.identifier, 'indigo:owner-bootstrap'))
    const [installation] = await getDb()
      .select()
      .from(installationState)
      .where(eq(installationState.singleton, 1))

    expect(userCount?.value).toBe(0)
    expect(accountCount?.value).toBe(0)
    expect(capabilityCount?.value).toBe(1)
    expect(installation).toMatchObject({ ownerUserId: null, bootstrapClosedAt: null })
  })

  it('keeps the committed owner claim when redemption wins replacement issuance', async () => {
    const issuanceBarrierKey = 'identity-bootstrap-redemption-before-issuance'
    const blocker = new Client({ connectionString: getServerConfig().databaseUrl })
    await blocker.connect()
    await blocker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      issuanceBarrierKey,
    ])
    await getDb().execute(
      sql.raw(`
        CREATE FUNCTION indigo_test_block_bootstrap_issuance()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF current_setting('application_name', true) = 'indigo-synthesis:external-host' THEN
            PERFORM pg_advisory_xact_lock(
              hashtextextended('${issuanceBarrierKey}', 0)
            );
          END IF;
          RETURN NULL;
        END;
        $function$
      `),
    )
    await getDb().execute(
      sql.raw(`
        CREATE TRIGGER indigo_test_bootstrap_issuance_barrier
        BEFORE DELETE ON verification
        FOR EACH STATEMENT
        EXECUTE FUNCTION indigo_test_block_bootstrap_issuance()
      `),
    )

    let lockHeld = true
    let replacementIssuance:
      | Promise<CapturedOutcome<Awaited<ReturnType<typeof issueOwnerBootstrap>>>>
      | undefined
    let outcomes: PromiseSettledResult<
      Awaited<ReturnType<typeof createOwnerWithBootstrapCode>>
    >[] = []
    try {
      replacementIssuance = captureOutcome(issueOwnerBootstrap({ ttlMinutes: 15 }))
      await waitForAdvisoryWait({
        applicationName: 'indigo-synthesis:external-host',
        description: 'replacement issuance to reach its pre-write barrier',
      })

      outcomes = await Promise.allSettled(
        bootstrapCandidates.map((candidate) =>
          createOwnerWithBootstrapCode({ ...candidate, code: bootstrapCode }),
        ),
      )
      const successfulIndexes = outcomes
        .map((outcome, index) => (outcome.status === 'fulfilled' ? index : -1))
        .filter((index) => index >= 0)
      expect(successfulIndexes).toHaveLength(1)

      const successfulIndex = successfulIndexes[0]
      const successfulOutcome = outcomes[successfulIndex]
      const winningCandidate = bootstrapCandidates[successfulIndex]
      if (successfulOutcome?.status !== 'fulfilled' || !winningCandidate) {
        throw new Error('Concurrent bootstrap produced no successful owner.')
      }
      owner = { ...winningCandidate, id: successfulOutcome.value.id }

      const [claimedBeforeIssuanceResumes] = await getDb()
        .select({
          ownerUserId: installationState.ownerUserId,
          bootstrapClosedAt: installationState.bootstrapClosedAt,
        })
        .from(installationState)
        .where(eq(installationState.singleton, 1))
      expect(claimedBeforeIssuanceResumes?.ownerUserId).toBe(owner.id)
      expect(claimedBeforeIssuanceResumes?.bootstrapClosedAt).toBeInstanceOf(Date)

      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        issuanceBarrierKey,
      ])
      lockHeld = false
      const issuanceOutcome = await replacementIssuance
      expect(issuanceOutcome.status).toBe('rejected')
      if (issuanceOutcome.status !== 'rejected') {
        throw new Error('Replacement issuance overwrote a committed owner claim.')
      }

      const [userCount] = await getDb().select({ value: count() }).from(user)
      const [accountCount] = await getDb().select({ value: count() }).from(account)
      const [installation] = await getDb()
        .select()
        .from(installationState)
        .where(eq(installationState.singleton, 1))
      expect(userCount?.value).toBe(1)
      expect(accountCount?.value).toBe(1)
      expect(installation?.ownerUserId).toBe(owner.id)
      expect(await getInstallationOwnerUserId()).toBe(owner.id)
      expect(installation?.bootstrapClosedAt).toBeInstanceOf(Date)
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
      const [pendingCount] = await getDb()
        .select({ value: count() })
        .from(verification)
        .where(eq(verification.identifier, 'indigo:owner-bootstrap'))
      expect(pendingCount?.value).toBe(0)
    } finally {
      if (lockHeld) {
        await blocker
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
            issuanceBarrierKey,
          ])
          .catch(() => undefined)
      }
      await blocker.end().catch(() => undefined)
      await replacementIssuance?.catch(() => undefined)
      await getDb().execute(
        sql.raw(
          'DROP TRIGGER IF EXISTS indigo_test_bootstrap_issuance_barrier ON verification',
        ),
      )
      await getDb().execute(
        sql.raw('DROP FUNCTION IF EXISTS indigo_test_block_bootstrap_issuance()'),
      )
    }
  })

  it('rejects replay of the consumed capability', async () => {
    await expect(
      createOwnerWithBootstrapCode({
        name: 'Replay Owner',
        email: 'replay-owner@example.test',
        password: 'replay-owner-password',
        code: bootstrapCode,
      }),
    ).rejects.toMatchObject({
      code: 'owner-bootstrap.instance-closed',
    } satisfies Partial<OwnerBootstrapError>)

    const [userCount] = await getDb().select({ value: count() }).from(user)
    expect(userCount?.value).toBe(1)
  })

  it('refuses post-claim issuance and removes its reserved output file', async () => {
    const codeFile = join(bootstrapSecretsDirectory, 'closed-bootstrap-code')

    await expect(
      runBootstrapCli(['issue', '--code-file', codeFile, '--ttl-minutes', '15']),
    ).rejects.toBeDefined()
    await expect(stat(codeFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('authenticates the bootstrapped credential through Better Auth', async () => {
    const response = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.password,
    })
    const responseBody = await parseAuthResponse(response)

    expect(response.status).toBe(200)
    expect(responseBody.user?.id).toBe(owner.id)
    expect(responseBody.token).toBeUndefined()

    const cookies = response.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .filter((value): value is string => value !== undefined)
      .join('; ')
    expect(cookies).not.toBe('')
    const sessionResponse = await handleAuthGet(
      new Request(`${getServerConfig().appOrigin}/api/auth/get-session`, {
        headers: { cookie: cookies },
      }),
    )
    const sessionBody = (await sessionResponse.json()) as {
      readonly session?: { readonly id?: string; readonly token?: string }
      readonly user?: { readonly id?: string }
    }
    expect(sessionResponse.status).toBe(200)
    expect(sessionBody.user?.id).toBe(owner.id)
    expect(sessionBody.session?.token).toBeUndefined()
    expect(sessionBody.session?.id).toBeUndefined()

    const listSessions = await handleAuthGet(
      new Request(`${getServerConfig().appOrigin}/api/auth/list-sessions`, {
        headers: { cookie: cookies },
      }),
    )
    expect(listSessions.status).toBe(404)

    const [sessionCount] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, owner.id))

    expect(sessionCount?.value).toBe(1)
  })

  it('rejects every invalid sign-in binding uniformly before provider mutation', async () => {
    await getDb().delete(session).where(eq(session.userId, owner.id))
    await getDb().delete(webRecoveryRateLimitBuckets)
    const [installation] = await getDb()
      .select({ epoch: installationState.productMutationEpoch })
      .from(installationState)
      .where(eq(installationState.singleton, 1))
    if (!installation) throw new Error('Installation epoch is missing.')
    const fresh = issueEmailSignInActionBinding({
      expectedEpoch: installation.epoch,
    })
    const expired = issueEmailSignInActionBinding(
      { expectedEpoch: installation.epoch },
      new Date(Date.now() - 20 * 60 * 1_000),
    )
    const wrongPurpose = issueCheckedSignOutActionBinding({
      expectedEpoch: installation.epoch,
      sessionId: 'wrong-purpose-session',
      actorUserId: owner.id,
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    })
    const tampered = `${fresh.slice(0, -1)}${fresh.endsWith('A') ? 'B' : 'A'}`
    let canonicalBody: string | undefined

    for (const binding of [null, tampered, expired, wrongPurpose]) {
      const response = await authRequestWithBinding(
        '/sign-in/email',
        { email: owner.email, password: owner.password },
        binding,
      )
      const body = await response.text()
      canonicalBody ??= body
      expect(response.status).toBe(401)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.getSetCookie()).toEqual([])
      expect(body).toBe(canonicalBody)
    }

    const [sessionCount] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, owner.id))
    const [rateCount] = await getDb()
      .select({ value: count() })
      .from(webRecoveryRateLimitBuckets)
    expect(sessionCount?.value).toBe(0)
    expect(rateCount?.value).toBe(0)

    const accepted = await authRequestWithBinding(
      '/sign-in/email',
      { email: owner.email, password: owner.password },
      fresh,
    )
    expect(accepted.status).toBe(200)
  })

  it('does not let a stale sign-in page adopt an open or replacement installation', async () => {
    await getDb().delete(session).where(eq(session.userId, owner.id))
    await getDb().delete(webRecoveryRateLimitBuckets)
    const [before] = await getDb()
      .select({
        closedAt: installationState.bootstrapClosedAt,
        epoch: installationState.productMutationEpoch,
        ownerUserId: installationState.ownerUserId,
      })
      .from(installationState)
      .where(eq(installationState.singleton, 1))
    if (!before?.ownerUserId || !before.closedAt) {
      throw new Error('Claimed installation fixture is missing.')
    }
    const staleBinding = issueEmailSignInActionBinding({
      expectedEpoch: before.epoch,
    })
    const credentials = { email: owner.email, password: owner.password }

    try {
      const [opened] = await getDb()
        .update(installationState)
        .set({
          bootstrapClosedAt: null,
          ownerUserId: null,
          productMutationEpoch: sql`gen_random_uuid()`,
        })
        .where(eq(installationState.singleton, 1))
        .returning({ epoch: installationState.productMutationEpoch })
      if (!opened) throw new Error('Open installation transition failed.')

      const whileOpen = await authRequestWithBinding(
        '/sign-in/email',
        credentials,
        staleBinding,
      )
      expect(whileOpen.status).toBe(401)
      const canonicalBody = await whileOpen.text()

      await getDb()
        .update(installationState)
        .set({
          bootstrapClosedAt: new Date(),
          ownerUserId: before.ownerUserId,
        })
        .where(eq(installationState.singleton, 1))
      const afterReclaim = await authRequestWithBinding(
        '/sign-in/email',
        credentials,
        staleBinding,
      )
      expect(afterReclaim.status).toBe(401)
      expect(await afterReclaim.text()).toBe(canonicalBody)

      const [noSession] = await getDb()
        .select({ value: count() })
        .from(session)
        .where(eq(session.userId, owner.id))
      const [noRateMutation] = await getDb()
        .select({ value: count() })
        .from(webRecoveryRateLimitBuckets)
      expect(noSession?.value).toBe(0)
      expect(noRateMutation?.value).toBe(0)

      const freshBinding = issueEmailSignInActionBinding({
        expectedEpoch: opened.epoch,
      })
      const fresh = await authRequestWithBinding(
        '/sign-in/email',
        credentials,
        freshBinding,
      )
      expect(fresh.status).toBe(200)
    } finally {
      await getDb().delete(session).where(eq(session.userId, owner.id))
      await getDb()
        .update(installationState)
        .set({
          bootstrapClosedAt: before.closedAt,
          ownerUserId: before.ownerUserId,
          productMutationEpoch: before.epoch,
        })
        .where(eq(installationState.singleton, 1))
    }
  })

  it('keeps GET session reads fixed-expiry and leaves expired-row cleanup to Identity', async () => {
    await getDb().delete(session).where(eq(session.userId, owner.id))
    const signIn = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.password,
    })
    const cookies = signIn.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .filter((value): value is string => value !== undefined)
      .join('; ')
    const [created] = await getDb()
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, owner.id))
    if (!created) throw new Error('Sign-in did not create a session row.')

    const fixedUpdatedAt = new Date('2026-01-01T00:00:00.000Z')
    const fixedExpiresAt = new Date(Date.now() + 60 * 60 * 1_000)
    await getDb()
      .update(session)
      .set({ updatedAt: fixedUpdatedAt, expiresAt: fixedExpiresAt })
      .where(eq(session.id, created.id))

    const serverRead = await readIdentitySession(new Headers({ cookie: cookies }))
    const activeRead = await handleAuthGet(
      new Request(`${getServerConfig().appOrigin}/api/auth/get-session`, {
        headers: { cookie: cookies },
      }),
    )
    const [afterActiveRead] = await getDb()
      .select({ updatedAt: session.updatedAt, expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.id, created.id))

    expect(serverRead?.user.id).toBe(owner.id)
    expect(activeRead.status).toBe(200)
    expect(await activeRead.json()).not.toBeNull()
    expect(afterActiveRead).toEqual({
      updatedAt: fixedUpdatedAt,
      expiresAt: fixedExpiresAt,
    })

    const expiredAt = new Date(Date.now() - 60_000)
    await getDb()
      .update(session)
      .set({ expiresAt: expiredAt })
      .where(eq(session.id, created.id))
    const expiredServerRead = await readIdentitySession(new Headers({ cookie: cookies }))
    const expiredRead = await handleAuthGet(
      new Request(`${getServerConfig().appOrigin}/api/auth/get-session`, {
        headers: { cookie: cookies },
      }),
    )
    const [retainedExpired] = await getDb()
      .select({ id: session.id, expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.id, created.id))

    expect(expiredServerRead).toBeNull()
    expect(expiredRead.status).toBe(200)
    expect(await expiredRead.json()).toBeNull()
    expect(retainedExpired).toEqual({ id: created.id, expiresAt: expiredAt })

    const externalPost = await authRequest('/get-session', {})
    expect(externalPost.status).toBe(404)
  })

  it('deletes only one bounded expired-session page during sign-in', async () => {
    await getDb().delete(session).where(eq(session.userId, owner.id))
    await getDb().delete(webRecoveryRateLimitBuckets)
    const expiredAt = new Date(Date.now() - 60_000)
    await getDb()
      .insert(session)
      .values(
        Array.from({ length: 20 }, (_, index) => ({
          id: newUuidV7(),
          token: `expired-sign-in-cleanup-${index}-${newUuidV7()}`,
          expiresAt: expiredAt,
          userId: owner.id,
        })),
      )

    const response = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.password,
    })
    expect(response.status).toBe(200)
    const [remaining] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(sql`${session.userId} = ${owner.id} AND ${session.expiresAt} <= now()`)
    expect(remaining?.value).toBe(4)
    await getDb().delete(session).where(eq(session.userId, owner.id))
  })

  it('checks sign-out deletion and publishes cookie expiry only after commit', async () => {
    const fixture = await checkedSignOutFixture(owner)
    const lockKey = 'identity-sign-out-commit-barrier'
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey])
    await getDb().execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION indigo_test_block_sign_out_commit()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('${lockKey}', 0));
        RETURN OLD;
      END
      $function$
    `),
    )
    await getDb().execute(
      sql.raw(`
      CREATE CONSTRAINT TRIGGER indigo_test_sign_out_commit_barrier
      AFTER DELETE ON "session"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION indigo_test_block_sign_out_commit()
    `),
    )

    let settled = false
    const signOut = handleAuthPost(
      checkedSignOutRequest(fixture),
      getProductionIdentityAuthMutationPort(),
    ).finally(() => {
      settled = true
    })
    try {
      await waitForControlAdvisoryWait()
      expect(settled).toBe(false)
      const [visibleBeforeCommit] = await getDb()
        .select({ id: session.id })
        .from(session)
        .where(eq(session.id, fixture.sessionId))
      expect(visibleBeforeCommit?.id).toBe(fixture.sessionId)

      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      const response = await signOut
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect(
        response.headers.getSetCookie().some((cookie) => /Max-Age=0/i.test(cookie)),
      ).toBe(true)
      const [deleted] = await getDb()
        .select({ id: session.id })
        .from(session)
        .where(eq(session.id, fixture.sessionId))
      expect(deleted).toBeUndefined()
    } finally {
      await blocker
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
        .catch(() => undefined)
      await blocker.end()
      await signOut.catch(() => undefined)
      await getDb().execute(
        sql.raw(
          'DROP TRIGGER IF EXISTS indigo_test_sign_out_commit_barrier ON "session"',
        ),
      )
      await getDb().execute(
        sql.raw('DROP FUNCTION IF EXISTS indigo_test_block_sign_out_commit()'),
      )
    }
  })

  it('does not clear the cookie or report success when checked deletion fails', async () => {
    const fixture = await checkedSignOutFixture(owner)
    await getDb().execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION indigo_test_reject_sign_out_delete()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'injected checked sign-out delete failure';
      END
      $function$
    `),
    )
    await getDb().execute(
      sql.raw(`
      CREATE TRIGGER indigo_test_reject_sign_out_delete
      BEFORE DELETE ON "session"
      FOR EACH ROW
      EXECUTE FUNCTION indigo_test_reject_sign_out_delete()
    `),
    )

    try {
      await expect(
        handleAuthPost(
          checkedSignOutRequest(fixture),
          getProductionIdentityAuthMutationPort(),
        ),
      ).rejects.toBeDefined()
      const [retained] = await getDb()
        .select({ id: session.id })
        .from(session)
        .where(eq(session.id, fixture.sessionId))
      expect(retained?.id).toBe(fixture.sessionId)
    } finally {
      await getDb().execute(
        sql.raw('DROP TRIGGER IF EXISTS indigo_test_reject_sign_out_delete ON "session"'),
      )
      await getDb().execute(
        sql.raw('DROP FUNCTION IF EXISTS indigo_test_reject_sign_out_delete()'),
      )
      await getDb().delete(session).where(eq(session.id, fixture.sessionId))
    }
  })

  it('rejects a stale action binding and makes concurrent checked sign-out idempotent', async () => {
    const stale = await checkedSignOutFixture(owner)
    const staleRequest = checkedSignOutRequest(stale)
    staleRequest.headers.set(
      checkedSignOutActionBindingHeader,
      `${stale.actionBinding.slice(0, -1)}${stale.actionBinding.endsWith('a') ? 'b' : 'a'}`,
    )
    const rejected = await handleAuthPost(
      staleRequest,
      getProductionIdentityAuthMutationPort(),
    )
    expect(rejected.status).toBe(409)
    expect(rejected.headers.getSetCookie()).toEqual([])
    const [retained] = await getDb()
      .select({ id: session.id })
      .from(session)
      .where(eq(session.id, stale.sessionId))
    expect(retained?.id).toBe(stale.sessionId)
    await getDb().delete(session).where(eq(session.id, stale.sessionId))

    const concurrent = await checkedSignOutFixture(owner)
    const accountLockKey = `indigo:credential-lifecycle:account:${owner.id}`
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      accountLockKey,
    ])
    const signOuts = [
      handleAuthPost(
        checkedSignOutRequest(concurrent),
        getProductionIdentityAuthMutationPort(),
      ),
      handleAuthPost(
        checkedSignOutRequest(concurrent),
        getProductionIdentityAuthMutationPort(),
      ),
    ] as const
    try {
      // Both requests captured the present row before queuing on the account lock. The
      // second request must therefore accept the winner's delete only during its UoW recheck.
      await waitForControlAdvisoryWait(2)
      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        accountLockKey,
      ])
      const [first, second] = await Promise.all(signOuts)
      expect([first.status, second.status]).toEqual([200, 200])
      expect(await first.json()).toEqual({ success: true })
      expect(await second.json()).toEqual({ success: true })
      const [deleted] = await getDb()
        .select({ id: session.id })
        .from(session)
        .where(eq(session.id, concurrent.sessionId))
      expect(deleted).toBeUndefined()
    } finally {
      await blocker
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [accountLockKey])
        .catch(() => undefined)
      await blocker.end()
      await Promise.all(signOuts.map((pending) => pending.catch(() => undefined)))
    }
  })

  it('clears verified cookies for transactionally expired or already-absent sessions', async () => {
    const naturalExpiry = new Date(Date.now() + 500)
    const expired = await checkedSignOutFixture(owner, {
      sessionExpiresAt: naturalExpiry,
    })
    await new Promise((resolve) => setTimeout(resolve, 550))
    const expiredResponse = await handleAuthPost(
      checkedSignOutRequest(expired),
      getProductionIdentityAuthMutationPort(),
    )
    expect(expiredResponse.status).toBe(200)
    expect(await expiredResponse.json()).toEqual({ success: true })
    expect(expiredResponse.headers.getSetCookie().length).toBeGreaterThan(0)

    const absent = await checkedSignOutFixture(owner)
    await getDb().delete(session).where(eq(session.id, absent.sessionId))
    const absentResponse = await handleAuthPost(
      checkedSignOutRequest(absent),
      getProductionIdentityAuthMutationPort(),
    )
    expect(absentResponse.status).toBe(200)
    expect(await absentResponse.json()).toEqual({ success: true })
    expect(absentResponse.headers.getSetCookie().length).toBeGreaterThan(0)
  })

  it('does not let a stale-tab sign-out binding adopt a replacement installation epoch', async () => {
    const fixture = await checkedSignOutFixture(owner)
    const [before] = await getDb()
      .select({ epoch: installationState.productMutationEpoch })
      .from(installationState)
      .where(eq(installationState.singleton, 1))
    if (!before) throw new Error('Installation epoch is missing.')
    await getDb()
      .update(installationState)
      .set({ productMutationEpoch: sql`gen_random_uuid()` })
      .where(eq(installationState.singleton, 1))

    try {
      const response = await handleAuthPost(
        checkedSignOutRequest(fixture),
        getProductionIdentityAuthMutationPort(),
      )
      expect(response.status).toBe(409)
      expect(response.headers.getSetCookie()).toEqual([])
      const [retained] = await getDb()
        .select({ id: session.id })
        .from(session)
        .where(eq(session.id, fixture.sessionId))
      expect(retained?.id).toBe(fixture.sessionId)
    } finally {
      await getDb()
        .update(installationState)
        .set({ productMutationEpoch: before.epoch })
        .where(eq(installationState.singleton, 1))
      await getDb().delete(session).where(eq(session.id, fixture.sessionId))
    }
  })

  it('preserves origin rejection before checked sign-out capture or mutation', async () => {
    const fixture = await checkedSignOutFixture(owner)
    const request = checkedSignOutRequest(fixture)
    request.headers.set('origin', 'https://attacker.example')

    const response = await handleAuthPost(
      request,
      getProductionIdentityAuthMutationPort(),
    )
    expect(response.status).toBe(403)
    expect(response.headers.getSetCookie()).toEqual([])
    const [retained] = await getDb()
      .select({ id: session.id })
      .from(session)
      .where(eq(session.id, fixture.sessionId))
    expect(retained?.id).toBe(fixture.sessionId)
    await getDb().delete(session).where(eq(session.id, fixture.sessionId))
  })

  it('clears an old signed cookie after reset has opened the installation', async () => {
    const fixture = await checkedSignOutFixture(owner)
    const [before] = await getDb()
      .select({
        closedAt: installationState.bootstrapClosedAt,
        epoch: installationState.productMutationEpoch,
        ownerUserId: installationState.ownerUserId,
      })
      .from(installationState)
      .where(eq(installationState.singleton, 1))
    if (!before?.ownerUserId || !before.closedAt) {
      throw new Error('Claimed installation fixture is missing.')
    }
    await getDb().delete(session).where(eq(session.id, fixture.sessionId))
    await getDb()
      .update(installationState)
      .set({
        bootstrapClosedAt: null,
        ownerUserId: null,
        productMutationEpoch: sql`gen_random_uuid()`,
      })
      .where(eq(installationState.singleton, 1))

    try {
      const response = await handleAuthPost(
        checkedSignOutRequest(fixture),
        getProductionIdentityAuthMutationPort(),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect(response.headers.getSetCookie().length).toBeGreaterThan(0)
    } finally {
      await getDb()
        .update(installationState)
        .set({
          bootstrapClosedAt: before.closedAt,
          ownerUserId: before.ownerUserId,
          productMutationEpoch: before.epoch,
        })
        .where(eq(installationState.singleton, 1))
    }
  })

  it('keeps generic signup closed after bootstrap', async () => {
    const response = await authRequest('/sign-up/email', {
      name: 'Public Intruder',
      email: 'public-intruder@example.test',
      password: 'public-intruder-password',
    })
    const [userCount] = await getDb().select({ value: count() }).from(user)

    expect(response.ok).toBe(false)
    expect(userCount?.value).toBe(1)
  })

  it('records redacted bootstrap issuance and completion evidence', async () => {
    const events = await getDb()
      .select({ type: auditEvents.eventType, metadata: auditEvents.metadata })
      .from(auditEvents)
    const serialized = JSON.stringify(events)

    expect(events.some((event) => event.type === 'owner-bootstrap-issued')).toBe(true)
    expect(events.some((event) => event.type === 'owner-bootstrap-completed')).toBe(true)
    expect(serialized).not.toContain(bootstrapCode)
    expect(serialized).not.toContain(owner.password)
  })

  it('lets the database-confirmed owner create one controlled local user', async () => {
    const actor: AuthenticatedActor = {
      userId: owner.id,
      name: owner.name,
      email: owner.email,
      role: deriveIdentityRole(owner.id, owner.id),
    }
    const input = {
      name: 'Local Member',
      email: 'LOCAL-MEMBER@EXAMPLE.TEST',
      password: 'local-member-password',
    }
    const createdUser = await createLocalUserAsOwner(actor, input)

    localMember = {
      ...input,
      id: createdUser.id,
      email: input.email.toLowerCase(),
    }

    const [userCount] = await getDb().select({ value: count() }).from(user)
    const [installation] = await getDb()
      .select({ ownerUserId: installationState.ownerUserId })
      .from(installationState)
      .where(eq(installationState.singleton, 1))
    const modeResult = await getDb().execute<{ mode: string }>(
      sql`SELECT current_setting('indigo.user_creation_mode', true) AS mode`,
    )

    expect(createdUser.email).toBe(localMember.email)
    expect(userCount?.value).toBe(2)
    expect(installation?.ownerUserId).toBe(owner.id)
    expect(modeResult.rows[0]?.mode ?? '').toBe('')
  })

  it('authenticates the controlled local user as a credential account', async () => {
    const response = await authRequest('/sign-in/email', {
      email: localMember.email,
      password: localMember.password,
    })
    const responseBody = await parseAuthResponse(response)

    expect(response.status).toBe(200)
    expect(responseBody.user?.id).toBe(localMember.id)
    expect(responseBody.token).toBeUndefined()

    const credentials = await getDb()
      .select({
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
      })
      .from(account)
      .where(eq(account.providerId, 'credential'))
    expect(credentials).toHaveLength(2)
    expect(
      credentials.every(
        (credential) =>
          credential.accessToken === null &&
          credential.refreshToken === null &&
          credential.idToken === null,
      ),
    ).toBe(true)
  })

  it('snapshots the checked sign-out cookie before asynchronous capture', async () => {
    const first = await checkedSignOutFixture(owner)
    const second = await checkedSignOutFixture(owner)
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE')

    try {
      const mutableRequest = checkedSignOutRequest(first)
      const signOut = handleAuthPost(
        mutableRequest,
        getProductionIdentityAuthMutationPort(),
      )
      mutableRequest.headers.set('cookie', second.cookie)
      await blocker.query('COMMIT')

      const response = await signOut
      expect(response.status).toBe(200)
      const remaining = await getDb()
        .select({ id: session.id })
        .from(session)
        .where(sql`${session.id} IN (${first.sessionId}, ${second.sessionId})`)
      expect(remaining).toEqual([{ id: second.sessionId }])
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end()
      await getDb().delete(session).where(eq(session.id, second.sessionId))
    }
  })

  it('keeps provider credential mutation routes absent and leaves the password unchanged', async () => {
    const replacement = 'provider-route-replacement-password'
    const change = await authRequest('/change-password', {
      currentPassword: localMember.password,
      newPassword: replacement,
      revokeOtherSessions: true,
    })
    expect(change.status).toBe(404)
    expect(await change.json()).toEqual({ code: 'NOT_FOUND', message: 'Not found.' })

    expect(
      (
        await authRequest('/sign-in/email', {
          email: localMember.email,
          password: localMember.password,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await authRequest('/sign-in/email', {
          email: localMember.email,
          password: replacement,
        })
      ).status,
    ).toBe(401)
  })

  it('keeps sign-in rejection uniform and an active throttle transaction read-only', async () => {
    await getDb().delete(webRecoveryRateLimitBuckets)

    const knownFailure = await authRequest('/sign-in/email', {
      email: localMember.email,
      password: 'wrong-but-valid-password',
    })
    const unknownFailure = await authRequest('/sign-in/email', {
      email: 'unknown-member@example.test',
      password: 'wrong-but-valid-password',
    })

    expect(knownFailure.status).toBe(401)
    expect(unknownFailure.status).toBe(knownFailure.status)
    expect(unknownFailure.headers.get('content-type')).toBe(
      knownFailure.headers.get('content-type'),
    )
    expect(await unknownFailure.text()).toBe(await knownFailure.text())

    await getDb().delete(webRecoveryRateLimitBuckets)
    const floodedEmail = 'flooded-member@example.test'
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await authRequest('/sign-in/email', {
        email: floodedEmail,
        password: 'wrong-but-valid-password',
      })
      expect(response.status).toBe(401)
    }

    const beforeThrottle = await getDb()
      .select()
      .from(webRecoveryRateLimitBuckets)
      .orderBy(webRecoveryRateLimitBuckets.scope, webRecoveryRateLimitBuckets.bucketKey)
    const lockEntered = deferred<void>()
    const releaseLock = deferred<void>()
    const heldLock = withSubmittedEmailCredentialLifecycleLocks({
      email: floodedEmail,
      resolveAccountUserIds: async () => [],
      callback: async () => {
        lockEntered.resolve(undefined)
        await releaseLock.promise
      },
    })
    await lockEntered.promise

    let throttled: Response
    try {
      throttled = await Promise.race([
        authRequest('/sign-in/email', {
          email: floodedEmail,
          password: 'wrong-but-valid-password',
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('Throttled sign-in entered the lifecycle lock.')),
            1_000,
          ),
        ),
      ])
    } finally {
      releaseLock.resolve(undefined)
      await heldLock
    }
    const afterThrottle = await getDb()
      .select()
      .from(webRecoveryRateLimitBuckets)
      .orderBy(webRecoveryRateLimitBuckets.scope, webRecoveryRateLimitBuckets.bucketKey)

    expect(throttled.status).toBe(401)
    expect(await throttled.text()).toBe(
      JSON.stringify({
        kind: 'rejected',
        message: 'The email or password was not accepted.',
      }),
    )
    expect(afterThrottle).toEqual(beforeThrottle)
  })

  it('serializes concurrent first rate-bucket inserts by rows without lost attempts', async () => {
    async function admit(input: {
      readonly clientAddress: string
      readonly email: string
    }) {
      return getDb().transaction((transaction) =>
        createScopedWebRecoveryRateLimitGateway(transaction).admit({
          purpose: 'sign-in',
          ...input,
        }),
      )
    }

    await getDb().delete(webRecoveryRateLimitBuckets)
    await expect(
      Promise.all([
        admit({ clientAddress: '198.51.100.8', email: 'first-a@example.test' }),
        admit({ clientAddress: '198.51.100.8', email: 'first-b@example.test' }),
      ]),
    ).resolves.toEqual([{ admitted: true }, { admitted: true }])
    const sameAddress = await getDb()
      .select({
        attemptCount: webRecoveryRateLimitBuckets.attemptCount,
        scope: webRecoveryRateLimitBuckets.scope,
      })
      .from(webRecoveryRateLimitBuckets)
      .orderBy(webRecoveryRateLimitBuckets.scope, webRecoveryRateLimitBuckets.bucketKey)
    expect(sameAddress.filter(({ scope }) => scope === 'sign-in:address')).toEqual([
      { attemptCount: 2, scope: 'sign-in:address' },
    ])
    expect(sameAddress.filter(({ scope }) => scope === 'sign-in:email')).toEqual([
      { attemptCount: 1, scope: 'sign-in:email' },
      { attemptCount: 1, scope: 'sign-in:email' },
    ])

    await getDb().delete(webRecoveryRateLimitBuckets)
    await expect(
      Promise.all([
        admit({ clientAddress: '198.51.100.8', email: 'shared@example.test' }),
        admit({ clientAddress: '203.0.113.8', email: 'shared@example.test' }),
      ]),
    ).resolves.toEqual([{ admitted: true }, { admitted: true }])
    const sameEmail = await getDb()
      .select({
        attemptCount: webRecoveryRateLimitBuckets.attemptCount,
        scope: webRecoveryRateLimitBuckets.scope,
      })
      .from(webRecoveryRateLimitBuckets)
      .orderBy(webRecoveryRateLimitBuckets.scope, webRecoveryRateLimitBuckets.bucketKey)
    expect(sameEmail.filter(({ scope }) => scope === 'sign-in:address')).toEqual([
      { attemptCount: 1, scope: 'sign-in:address' },
      { attemptCount: 1, scope: 'sign-in:address' },
    ])
    expect(sameEmail.filter(({ scope }) => scope === 'sign-in:email')).toEqual([
      { attemptCount: 2, scope: 'sign-in:email' },
    ])
  })

  it('does zero rate-bucket DML when a queued dimension is already throttled', async () => {
    async function admit(clientAddress: string) {
      return getDb().transaction((transaction) =>
        createScopedWebRecoveryRateLimitGateway(transaction).admit({
          purpose: 'sign-in',
          email: 'stale-precheck@example.test',
          clientAddress,
          now: new Date('2026-07-15T12:00:00.000Z'),
        }),
      )
    }

    await getDb().delete(webRecoveryRateLimitBuckets)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(admit('198.51.100.1')).resolves.toEqual({ admitted: true })
    }
    const before = await getDb()
      .select()
      .from(webRecoveryRateLimitBuckets)
      .orderBy(webRecoveryRateLimitBuckets.scope, webRecoveryRateLimitBuckets.bucketKey)
    await getDb().execute(
      sql.raw(`
        CREATE TABLE indigo_test_rate_dml_log (id bigserial PRIMARY KEY);
        CREATE OR REPLACE FUNCTION indigo_test_log_rate_dml()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          INSERT INTO indigo_test_rate_dml_log DEFAULT VALUES;
          RETURN NULL;
        END
        $function$;
        CREATE TRIGGER indigo_test_log_rate_dml
        AFTER INSERT OR UPDATE OR DELETE ON web_recovery_rate_limit_bucket
        FOR EACH ROW EXECUTE FUNCTION indigo_test_log_rate_dml();
      `),
    )

    try {
      const rejected = await Promise.all(
        Array.from({ length: 8 }, (_, index) => admit(`203.0.113.${index + 1}`)),
      )
      expect(rejected).toEqual(
        Array.from({ length: 8 }, () => ({
          admitted: false,
          scope: 'sign-in:email',
        })),
      )
      const after = await getDb()
        .select()
        .from(webRecoveryRateLimitBuckets)
        .orderBy(webRecoveryRateLimitBuckets.scope, webRecoveryRateLimitBuckets.bucketKey)
      const dml = await getDb().execute<{ count: number }>(
        sql`SELECT count(*)::integer AS count FROM indigo_test_rate_dml_log`,
      )
      expect(after).toEqual(before)
      expect(dml.rows[0]?.count).toBe(0)
    } finally {
      await getDb().execute(
        sql.raw(`
          DROP TRIGGER IF EXISTS indigo_test_log_rate_dml
            ON web_recovery_rate_limit_bucket;
          DROP FUNCTION IF EXISTS indigo_test_log_rate_dml();
          DROP TABLE IF EXISTS indigo_test_rate_dml_log;
        `),
      )
    }
  })

  it('runs malformed sign-in input through one bounded dummy provider request', async () => {
    const origin = getServerConfig().appOrigin
    const cases = [
      {
        name: 'malformed email',
        body: JSON.stringify({
          email: 'not-an-email',
          password: 'wrong-but-valid-password',
        }),
        contentType: 'application/json',
      },
      {
        name: 'missing password',
        body: JSON.stringify({ email: localMember.email }),
        contentType: 'application/json',
      },
      {
        name: 'oversized password',
        body: JSON.stringify({ email: localMember.email, password: 'x'.repeat(256_000) }),
        contentType: 'application/json',
      },
      {
        name: 'malformed JSON',
        body: '{',
        contentType: 'application/json',
      },
    ] as const

    for (const testCase of cases) {
      await getDb().delete(webRecoveryRateLimitBuckets)
      let providerBody: Record<string, unknown> | undefined
      const response = await handleAuthRequest(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': testCase.contentType, origin },
          body: testCase.body,
        }),
        providerMutationPort(async (providerRequest) => {
          providerBody = (await providerRequest.json()) as Record<string, unknown>
          return Response.json(
            { token: 'must-not-escape', user: { id: 'must-not-exist' } },
            { status: 200, headers: { 'set-cookie': 'must-not-escape=1' } },
          )
        }),
      )

      expect(response.status, testCase.name).toBe(401)
      expect(await response.json(), testCase.name).toEqual({
        kind: 'rejected',
        message: 'The email or password was not accepted.',
      })
      expect(response.headers.get('set-cookie'), testCase.name).toBeNull()
      expect(providerBody?.email, testCase.name).toEqual(expect.any(String))
      expect(String(providerBody?.email).length, testCase.name).toBeGreaterThan(254)
      expect(providerBody?.password, testCase.name).toEqual(expect.any(String))
      expect(String(providerBody?.password).length, testCase.name).toBeLessThanOrEqual(
        128,
      )
      expect(JSON.stringify(providerBody), testCase.name).not.toContain('must-not-escape')
    }
  })

  it('rechecks ownership inside the transaction even if a member role is forged', async () => {
    const forgedActor: AuthenticatedActor = {
      userId: localMember.id,
      name: localMember.name,
      email: localMember.email,
      role: 'owner',
    }

    await expect(
      createLocalUserAsOwner(forgedActor, {
        name: 'Unauthorized Member',
        email: 'unauthorized-member@example.test',
        password: 'unauthorized-member-password',
      }),
    ).rejects.toBeInstanceOf(OwnerAuthorizationError)

    const [userCount] = await getDb().select({ value: count() }).from(user)
    expect(userCount?.value).toBe(2)
  })

  it('bounds first-burst lifecycle lock connections independently of the app pool', async () => {
    const releaseCallbacks = deferred<void>()
    const connectionLimitReached = deferred<void>()
    let enteredCallbacks = 0
    const burstSize = credentialLifecycleConnectionLimit * 3
    const requests = Array.from({ length: burstSize }, (_, index) =>
      withSubmittedEmailCredentialLifecycleLocks({
        email: `first-burst-${index}@example.test`,
        resolveAccountUserIds: async () => [],
        callback: async () => {
          enteredCallbacks += 1
          if (enteredCallbacks === credentialLifecycleConnectionLimit) {
            connectionLimitReached.resolve(undefined)
          }
          await releaseCallbacks.promise
        },
      }),
    )

    try {
      await connectionLimitReached.promise
      const lockConnections = await getDb().execute<{ active: number }>(sql`
        SELECT count(*)::integer AS active
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = 'indigo-synthesis:control'
      `)
      expect(Number(lockConnections.rows[0]?.active ?? 0)).toBe(
        credentialLifecycleConnectionLimit,
      )
      expect(enteredCallbacks).toBe(credentialLifecycleConnectionLimit)
    } finally {
      releaseCallbacks.resolve(undefined)
    }

    await expect(Promise.all(requests)).resolves.toHaveLength(burstSize)
    expect(enteredCallbacks).toBe(burstSize)
  })

  it('bounds submitted-email waiters, sheds uniformly, and prioritizes trusted recovery', async () => {
    await getDb().delete(webRecoveryRateLimitBuckets)
    const activeEntered = deferred<void>()
    const releaseActive = Array.from({ length: credentialLifecycleConnectionLimit }, () =>
      deferred<void>(),
    )
    let activeCount = 0
    const active = Array.from(
      { length: credentialLifecycleConnectionLimit },
      (_, index) =>
        withSubmittedEmailCredentialLifecycleLocks({
          email: `capacity-active-${index}@example.test`,
          resolveAccountUserIds: async () => [],
          callback: async () => {
            activeCount += 1
            if (activeCount === credentialLifecycleConnectionLimit) {
              activeEntered.resolve(undefined)
            }
            await releaseActive[index]?.promise
          },
        }),
    )
    await activeEntered.promise

    const enteredAfterRelease: string[] = []
    const queued = Array.from(
      { length: credentialLifecycleSubmittedEmailQueueLimit },
      (_, index) =>
        withSubmittedEmailCredentialLifecycleLocks({
          email: `capacity-queued-${index}@example.test`,
          resolveAccountUserIds: async () => [],
          callback: async () => {
            enteredAfterRelease.push('submitted-email')
          },
        }),
    )
    const trustedEntered = deferred<void>()
    const trusted = withCredentialLifecycleLocks([owner.id], async () => {
      enteredAfterRelease.push('trusted')
      trustedEntered.resolve(undefined)
    })

    try {
      const shed = await authRequest('/sign-in/email', {
        email: 'capacity-shed@example.test',
        password: 'capacity-shed-password',
      })
      expect(shed.status).toBe(401)
      expect(await shed.json()).toEqual({
        kind: 'rejected',
        message: 'The email or password was not accepted.',
      })
      releaseActive[0]?.resolve(undefined)
      await expect(trustedEntered.promise).resolves.toBeUndefined()
      expect(enteredAfterRelease[0]).toBe('trusted')
    } finally {
      for (const release of releaseActive) release.resolve(undefined)
      await expect(trusted).resolves.toBeUndefined()
      await expect(Promise.all([...active, ...queued])).resolves.toHaveLength(
        credentialLifecycleConnectionLimit + credentialLifecycleSubmittedEmailQueueLimit,
      )
    }
  })

  it('bounds authenticated account-scoped waiters without consuming another connection', async () => {
    const activeEntered = deferred<void>()
    const releaseActive = deferred<void>()
    let activeCount = 0
    const active = Array.from(
      { length: credentialLifecycleConnectionLimit },
      (_, index) =>
        withCredentialLifecycleLocks([`trusted-active-${index}`], async () => {
          activeCount += 1
          if (activeCount === credentialLifecycleConnectionLimit) {
            activeEntered.resolve(undefined)
          }
          await releaseActive.promise
        }),
    )
    await activeEntered.promise

    const queued = Array.from(
      { length: credentialLifecycleTrustedQueueLimit },
      (_, index) =>
        withCredentialLifecycleLocks([`trusted-queued-${index}`], async () => undefined),
    )
    try {
      await expect(
        withCredentialLifecycleLocks(['trusted-overflow'], async () => undefined),
      ).rejects.toBeInstanceOf(CredentialLifecycleCapacityError)
      const lockConnections = await getDb().execute<{ active: number }>(sql`
        SELECT count(*)::integer AS active
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = 'indigo-synthesis:control'
      `)
      expect(Number(lockConnections.rows[0]?.active ?? 0)).toBe(
        credentialLifecycleConnectionLimit,
      )
    } finally {
      releaseActive.resolve(undefined)
    }
    await expect(Promise.all([...active, ...queued])).resolves.toHaveLength(
      credentialLifecycleConnectionLimit + credentialLifecycleTrustedQueueLimit,
    )
  })

  it('does not consume lifecycle capacity when runtime configuration is invalid', async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new Error('Identity integration database URL is unavailable.')

    await closeDb()
    process.env.DATABASE_URL = 'not-a-postgresql-url'
    resetServerConfigForTests()
    try {
      for (let attempt = 0; attempt < credentialLifecycleConnectionLimit; attempt += 1) {
        await expect(
          withCredentialLifecycleLocks([owner.id], async () => 'unreachable'),
        ).rejects.toThrow()
      }
    } finally {
      await closeDb().catch(() => undefined)
      process.env.DATABASE_URL = databaseUrl
      resetServerConfigForTests()
    }

    await expect(
      Promise.race([
        withCredentialLifecycleLocks([owner.id], async () => 'recovered'),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('Invalid configuration leaked lifecycle capacity.')),
            1_000,
          ),
        ),
      ]),
    ).resolves.toBe('recovered')
  })
})
