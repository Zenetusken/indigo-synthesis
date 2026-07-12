import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { and, count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/modules/identity/bootstrap/owner-bootstrap'
import { getAuth, resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import {
  issueOwnerRecovery,
  redeemOwnerRecovery,
} from '@/modules/identity/recovery/owner-recovery'
import { handleAuthPost, handleAuthRequest } from '@/modules/identity/server/auth-handler'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import { auditEvents, session, user, verification } from '@/platform/db/schema'

const execFile = promisify(execFileCallback)
const owner = {
  name: 'Recovery Owner',
  email: 'recovery-owner@example.test',
  originalPassword: 'original-owner-password',
  racedPassword: 'race-recovered-owner-password',
  recoveredPassword: 'recovered-owner-password',
} as const

let integrationDatabase: DisposableIntegrationDatabase | undefined
let ownerUserId: string
let secretsDirectory: string

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function waitForBlockedCredentialLock(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await getDb().execute<{ waiting: number }>(sql`
      SELECT (
        count(*) FILTER (WHERE wait_event = 'advisory')
      )::integer AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = 'indigo-credential-lifecycle'
    `)
    if (Number(result.rows[0]?.waiting ?? 0) >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Recovery did not block on the sign-in credential lock.')
}

async function authRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return handleAuthPost(createAuthRequest(path, body))
}

function createAuthRequest(path: string, body: Record<string, unknown>): Request {
  const origin = getServerConfig().appOrigin
  return new Request(`${origin}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  })
}

async function runRecoveryCli(arguments_: readonly string[]) {
  return execFile(
    process.execPath,
    ['--import', 'tsx', 'scripts/identity/recover-owner.ts', ...arguments_],
    {
      cwd: process.cwd(),
      env: process.env,
    },
  )
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'owner_recovery',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const createdOwner = await createOwnerWithBootstrapCode({
    name: owner.name,
    email: owner.email,
    password: owner.originalPassword,
    code: bootstrap.code,
  })
  ownerUserId = createdOwner.id

  secretsDirectory = await mkdtemp(join(tmpdir(), 'indigo-owner-recovery-'))
  await chmod(secretsDirectory, 0o700)
})

afterAll(async () => {
  resetAuthForTests()
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
  if (secretsDirectory) await rm(secretsDirectory, { recursive: true, force: true })
})

describe('host-local owner recovery', () => {
  it('expires and consumes an elapsed recovery code without changing the credential', async () => {
    const issuedAt = new Date('2026-07-11T12:00:00.000Z')
    const issued = await issueOwnerRecovery({
      ownerEmail: owner.email,
      ttlMinutes: 5,
      now: issuedAt,
    })

    await expect(
      redeemOwnerRecovery({
        ownerEmail: owner.email,
        code: issued.code,
        newPassword: owner.recoveredPassword,
        now: new Date('2026-07-11T12:05:00.001Z'),
      }),
    ).rejects.toMatchObject({
      code: 'owner-recovery.code-invalid',
    })

    const [pendingCount] = await getDb().select({ value: count() }).from(verification)
    expect(pendingCount?.value).toBe(0)

    const stillAuthenticates = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.originalPassword,
    })
    expect(stillAuthenticates.status).toBe(200)
  })

  it('serializes old-password sign-in through recovery and revokes its new session', async () => {
    const issued = await issueOwnerRecovery({
      ownerEmail: owner.email,
      ttlMinutes: 15,
    })
    const [sessionsBeforeSignIn] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, ownerUserId))
    const signInHandled = deferred<Response>()
    const releaseSignInLock = deferred<void>()
    const signInPromise = handleAuthRequest(
      createAuthRequest('/sign-in/email', {
        email: owner.email,
        password: owner.originalPassword,
      }),
      async (request) => {
        try {
          const response = await getAuth().handler(request)
          signInHandled.resolve(response)
          await releaseSignInLock.promise
          return response
        } catch (error) {
          signInHandled.reject(error)
          throw error
        }
      },
    )

    const signInResponse = await signInHandled.promise
    expect(signInResponse.status).toBe(200)
    const [sessionDuringSignIn] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, ownerUserId))
    expect(sessionDuringSignIn?.value).toBeGreaterThan(sessionsBeforeSignIn?.value ?? 0)

    const recoveryPromise = redeemOwnerRecovery({
      ownerEmail: owner.email,
      code: issued.code,
      newPassword: owner.racedPassword,
    })
    try {
      await waitForBlockedCredentialLock()
    } finally {
      releaseSignInLock.resolve(undefined)
    }

    await expect(signInPromise).resolves.toBe(signInResponse)
    const recovery = await recoveryPromise
    expect(recovery).toMatchObject({
      ownerUserId,
    })
    expect(recovery.revokedSessionCount).toBeGreaterThan(0)
    const [sessionsAfterRecovery] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, ownerUserId))
    expect(sessionsAfterRecovery?.value).toBe(0)

    const oldCredential = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.originalPassword,
    })
    const recoveredCredential = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.racedPassword,
    })
    expect(oldCredential.ok).toBe(false)
    expect(recoveredCredential.status).toBe(200)
  })

  it('issues through owner-only storage and redeems once without printing secrets', async () => {
    const codeFile = join(secretsDirectory, 'owner-recovery-code')
    const passwordFile = join(secretsDirectory, 'new-owner-password')
    await writeFile(passwordFile, `${owner.recoveredPassword}\n`, { mode: 0o600 })

    const issuedProcess = await runRecoveryCli([
      'issue',
      '--owner-email',
      owner.email,
      '--code-file',
      codeFile,
      '--ttl-minutes',
      '15',
    ])
    const code = (await readFile(codeFile, 'utf8')).trim()
    const codeMetadata = await stat(codeFile)
    expect(code).toMatch(/^indigo_r1_[A-Za-z0-9_-]{43}$/)
    expect(codeMetadata.mode & 0o077).toBe(0)
    expect(`${issuedProcess.stdout}${issuedProcess.stderr}`).not.toContain(code)
    expect(`${issuedProcess.stdout}${issuedProcess.stderr}`).not.toContain(
      owner.recoveredPassword,
    )

    const [stored] = await getDb()
      .select({ value: verification.value })
      .from(verification)
    expect(stored?.value).not.toContain(code)

    await expect(
      redeemOwnerRecovery({
        ownerEmail: owner.email,
        code: `${code}-wrong`,
        newPassword: owner.recoveredPassword,
      }),
    ).rejects.toMatchObject({
      code: 'owner-recovery.code-invalid',
    })

    const [sessionsBefore] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, ownerUserId))
    expect(sessionsBefore?.value).toBeGreaterThan(0)

    const redeemedProcess = await runRecoveryCli([
      'redeem',
      '--owner-email',
      owner.email,
      '--code-file',
      codeFile,
      '--password-file',
      passwordFile,
    ])
    expect(`${redeemedProcess.stdout}${redeemedProcess.stderr}`).not.toContain(code)
    expect(`${redeemedProcess.stdout}${redeemedProcess.stderr}`).not.toContain(
      owner.recoveredPassword,
    )
    await expect(stat(codeFile)).rejects.toMatchObject({ code: 'ENOENT' })

    const [sessionsAfter] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, ownerUserId))
    const [pendingAfter] = await getDb().select({ value: count() }).from(verification)
    expect(sessionsAfter?.value).toBe(0)
    expect(pendingAfter?.value).toBe(0)

    const originalCredential = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.originalPassword,
    })
    const racedCredential = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.racedPassword,
    })
    const newCredential = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.recoveredPassword,
    })
    expect(originalCredential.ok).toBe(false)
    expect(racedCredential.ok).toBe(false)
    expect(newCredential.status).toBe(200)

    await expect(
      redeemOwnerRecovery({
        ownerEmail: owner.email,
        code,
        newPassword: 'another-secure-password',
      }),
    ).rejects.toMatchObject({
      code: 'owner-recovery.code-invalid',
    })

    const recoveryAudits = await getDb()
      .select({ type: auditEvents.eventType, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.subjectUserId, ownerUserId),
          eq(auditEvents.entityType, 'owner-recovery'),
        ),
      )
    expect(recoveryAudits.some((event) => event.type === 'owner-recovery-issued')).toBe(
      true,
    )
    expect(recoveryAudits.some((event) => event.type === 'owner-recovery-redeemed')).toBe(
      true,
    )
    const serializedAudit = JSON.stringify(recoveryAudits)
    expect(serializedAudit).not.toContain(code)
    expect(serializedAudit).not.toContain(owner.originalPassword)
    expect(serializedAudit).not.toContain(owner.racedPassword)
    expect(serializedAudit).not.toContain(owner.recoveredPassword)

    const [ownerStillPresent] = await getDb()
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, ownerUserId))
    expect(ownerStillPresent?.id).toBe(ownerUserId)
  })
})
