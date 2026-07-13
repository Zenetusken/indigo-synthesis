import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AuthenticatedActor,
  deriveIdentityRole,
  OwnerAuthorizationError,
} from '@/modules/identity/application/actor'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
  type OwnerBootstrapError,
} from '@/modules/identity/bootstrap/owner-bootstrap'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
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
import {
  handleAuthGet,
  handleAuthPost,
  handleAuthRequest,
} from '@/modules/identity/server/auth-handler'
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

async function authRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const origin = getServerConfig().appOrigin

  return handleAuthPost(
    new Request(`${origin}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify(body),
    }),
  )
}

async function runBootstrapCli(arguments_: readonly string[]) {
  return execFile(
    process.execPath,
    ['--import', 'tsx', 'scripts/identity/bootstrap-owner.ts', ...arguments_],
    { cwd: process.cwd(), env: process.env },
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
    await expect(
      createOwnerWithBootstrapCode({
        ...input,
        code: issued.code,
        now: new Date('2026-07-11T12:05:00.001Z'),
      }),
    ).rejects.toMatchObject({ code: 'owner-bootstrap.capability-invalid' })

    const [userCount] = await getDb().select({ value: count() }).from(user)
    const [installation] = await getDb()
      .select()
      .from(installationState)
      .where(eq(installationState.singleton, 1))
    expect(userCount?.value).toBe(0)
    expect(installation).toMatchObject({ ownerUserId: null, bootstrapClosedAt: null })
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

  it('serializes concurrent use of one capability exactly once', async () => {
    const outcomes = await Promise.allSettled(
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

    owner = {
      ...winningCandidate,
      id: successfulOutcome.value.id,
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
      readonly session?: { readonly token?: string }
      readonly user?: { readonly id?: string }
    }
    expect(sessionResponse.status).toBe(200)
    expect(sessionBody.user?.id).toBe(owner.id)
    expect(sessionBody.session?.token).toBeUndefined()

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
        async (providerRequest) => {
          providerBody = (await providerRequest.json()) as Record<string, unknown>
          return Response.json(
            { token: 'must-not-escape', user: { id: 'must-not-exist' } },
            { status: 200, headers: { 'set-cookie': 'must-not-escape=1' } },
          )
        },
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
          AND application_name = 'indigo-credential-lifecycle'
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
          AND application_name = 'indigo-credential-lifecycle'
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

    process.env.DATABASE_URL = 'not-a-postgresql-url'
    resetServerConfigForTests()
    try {
      for (let attempt = 0; attempt < credentialLifecycleConnectionLimit; attempt += 1) {
        await expect(
          withCredentialLifecycleLocks([owner.id], async () => 'unreachable'),
        ).rejects.toThrow()
      }
    } finally {
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
