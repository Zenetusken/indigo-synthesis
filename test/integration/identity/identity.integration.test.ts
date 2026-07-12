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
import { getInstallationOwnerUserId } from '@/modules/identity/infrastructure/installation'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { handleAuthPost } from '@/modules/identity/server/auth-handler'
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

    expect(response.ok).toBe(false)
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
    expect(responseBody.token).toEqual(expect.any(String))

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
    expect(responseBody.token).toEqual(expect.any(String))
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
})
