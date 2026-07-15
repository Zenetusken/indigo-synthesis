import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { and, count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getProductionIdentityAuthMutationPort } from '@/composition/identity-auth-mutations'
import { identityActionBindingHeader } from '@/modules/identity/application/action-binding'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/modules/identity/bootstrap/owner-bootstrap'
import { issueEmailSignInActionBinding } from '@/modules/identity/infrastructure/action-binding'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { withSubmittedEmailCredentialLifecycleLocks } from '@/modules/identity/infrastructure/credential-lifecycle-lock'
import { createScopedIdentityMutationGateway } from '@/modules/identity/infrastructure/scoped-mutation-auth'
import { admitWebRecoveryAttempt } from '@/modules/identity/infrastructure/web-recovery-rate-limit'
import {
  issueOwnerRecovery,
  redeemOwnerRecovery,
  redeemOwnerRecoveryWeb,
} from '@/modules/identity/recovery/owner-recovery'
import { handleAuthPost, handleAuthRequest } from '@/modules/identity/server/auth-handler'
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
  auditEvents,
  installationState,
  session,
  user,
  verification,
  webRecoveryRateLimitBuckets,
} from '@/platform/db/schema'

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
        AND application_name = 'indigo-synthesis:control'
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
  const request = createAuthRequest(path, body)
  const [installation] = await getDb()
    .select({ epoch: installationState.productMutationEpoch })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
  if (!installation) throw new Error('Sign-in installation fixture is missing.')
  request.headers.set(
    identityActionBindingHeader,
    issueEmailSignInActionBinding({ expectedEpoch: installation.epoch }),
  )
  return handleAuthPost(request, getProductionIdentityAuthMutationPort())
}

function serializedProviderPort(
  handler: (request: Request) => Promise<Response>,
): IdentityAuthMutationPort {
  return {
    emailSignIn: (command) => {
      const { credentialEmail, providerRequest } = emailSignInMutationCommandView(command)
      return withSubmittedEmailCredentialLifecycleLocks({
        email: credentialEmail,
        resolveAccountUserIds: async () => {
          const records = await getDb()
            .select({ id: user.id })
            .from(user)
            .where(sql`lower(${user.email}) = ${credentialEmail}`)
          return records.map(({ id }) => id)
        },
        callback: () => handler(providerRequest),
      })
    },
    checkedSignOut: ({ request }) => handler(request),
  }
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

beforeEach(async () => {
  resetAuthForTests()
  await getDb().delete(webRecoveryRateLimitBuckets)
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
  it('commits one redacted host audit when owner-recovery issuance is rejected', async () => {
    const [before] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'owner-recovery-rejected'))

    await expect(
      issueOwnerRecovery({
        ownerEmail: 'not-the-installed-owner@example.test',
        ttlMinutes: 15,
      }),
    ).rejects.toMatchObject({ code: 'owner-recovery.owner-mismatch' })

    const rejected = await getDb()
      .select({
        subjectUserId: auditEvents.subjectUserId,
        entityId: auditEvents.entityId,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'owner-recovery-rejected'))
    expect(rejected).toHaveLength(Number(before?.value ?? 0) + 1)
    expect(rejected.at(-1)).toEqual({
      subjectUserId: ownerUserId,
      entityId: null,
      metadata: { channel: 'host-local-cli', outcome: 'rejected' },
    })
    expect(JSON.stringify(rejected.at(-1))).not.toContain(
      'not-the-installed-owner@example.test',
    )
  })

  it('invalidates every outstanding recovery code when the auth secret rotates', async () => {
    const issued = await issueOwnerRecovery({ ownerEmail: owner.email, ttlMinutes: 15 })
    const originalSecret = process.env.BETTER_AUTH_SECRET
    process.env.BETTER_AUTH_SECRET = 'rotated-owner-recovery-secret-1234567890'
    resetServerConfigForTests()
    resetAuthForTests()

    try {
      await expect(
        redeemOwnerRecovery({
          ownerEmail: owner.email,
          code: issued.code,
          newPassword: owner.recoveredPassword,
        }),
      ).rejects.toMatchObject({ code: 'owner-recovery.code-invalid' })
    } finally {
      if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
      else process.env.BETTER_AUTH_SECRET = originalSecret
      resetServerConfigForTests()
      resetAuthForTests()
    }

    const [pending] = await getDb()
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.id, issued.recoveryId))
    expect(pending?.id).toBe(issued.recoveryId)
    await getDb().delete(verification).where(eq(verification.id, issued.recoveryId))
  })

  it('rejects an oversized web replacement without hashing it into the credential', async () => {
    const issued = await issueOwnerRecovery({
      ownerEmail: owner.email,
      ttlMinutes: 15,
    })
    const oversizedPassword = 'x'.repeat(256_000)

    await expect(
      redeemOwnerRecoveryWeb({
        ownerEmail: owner.email,
        code: issued.code,
        newPassword: oversizedPassword,
        requestContext: { channel: 'web', clientAddress: '198.51.100.82' },
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      message: 'The email, code, or password was not accepted.',
    })

    const [pending] = await getDb()
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.id, issued.recoveryId))
    expect(pending?.id).toBe(issued.recoveryId)
    expect(
      (
        await authRequest('/sign-in/email', {
          email: owner.email,
          password: owner.originalPassword,
        })
      ).status,
    ).toBe(200)
    await getDb().delete(verification).where(eq(verification.id, issued.recoveryId))
  })

  it('serializes wrong-email web recovery on the installed owner account lock', async () => {
    const signInHandled = deferred<Response>()
    const releaseSignInLock = deferred<void>()
    const signInPromise = handleAuthRequest(
      createAuthRequest('/sign-in/email', {
        email: owner.email,
        password: owner.originalPassword,
      }),
      serializedProviderPort(async (request) => {
        try {
          const response = await createScopedIdentityMutationGateway(getDb()).signInEmail(
            request,
          )
          signInHandled.resolve(response)
          await releaseSignInLock.promise
          return response
        } catch (error) {
          signInHandled.reject(error)
          throw error
        }
      }),
    )
    const signInResponse = await signInHandled.promise
    expect(signInResponse.status).toBe(200)

    const recoveryPromise = redeemOwnerRecoveryWeb({
      ownerEmail: 'wrong-owner@example.test',
      code: 'wrong-owner-recovery-code',
      newPassword: 'wrong-owner-recovery-password',
      requestContext: { channel: 'web', clientAddress: '198.51.100.81' },
    })
    try {
      await waitForBlockedCredentialLock()
    } finally {
      releaseSignInLock.resolve(undefined)
    }

    const completedSignIn = await signInPromise
    expect(completedSignIn.status).toBe(signInResponse.status)
    expect(completedSignIn.headers.get('set-cookie')).toBe(
      signInResponse.headers.get('set-cookie'),
    )
    expect(await completedSignIn.json()).not.toHaveProperty('token')
    await expect(recoveryPromise).resolves.toEqual({
      kind: 'rejected',
      message: 'The email, code, or password was not accepted.',
    })
  })

  it('expires and consumes an elapsed recovery code without changing the credential', async () => {
    const issuedAt = new Date('2026-07-11T12:00:00.000Z')
    const issued = await issueOwnerRecovery({
      ownerEmail: owner.email,
      ttlMinutes: 5,
      now: issuedAt,
    })
    const [rejectionsBefore] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'owner-recovery-rejected'))

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
    const rejected = await getDb()
      .select({
        subjectUserId: auditEvents.subjectUserId,
        entityId: auditEvents.entityId,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'owner-recovery-rejected'))
    expect(pendingCount?.value).toBe(0)
    expect(rejected).toHaveLength(Number(rejectionsBefore?.value ?? 0) + 1)
    expect(rejected.at(-1)).toEqual({
      subjectUserId: ownerUserId,
      entityId: issued.recoveryId,
      metadata: { channel: 'host-local-cli', outcome: 'rejected' },
    })

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
      serializedProviderPort(async (request) => {
        try {
          const response = await createScopedIdentityMutationGateway(getDb()).signInEmail(
            request,
          )
          signInHandled.resolve(response)
          await releaseSignInLock.promise
          return response
        } catch (error) {
          signInHandled.reject(error)
          throw error
        }
      }),
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

    const completedSignIn = await signInPromise
    expect(completedSignIn.status).toBe(signInResponse.status)
    expect(completedSignIn.headers.get('set-cookie')).toBe(
      signInResponse.headers.get('set-cookie'),
    )
    expect(await completedSignIn.json()).not.toHaveProperty('token')
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
    expect(
      recoveryAudits.every(
        (event) =>
          typeof event.metadata === 'object' &&
          event.metadata !== null &&
          'outcome' in event.metadata,
      ),
    ).toBe(true)
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

  it('redeems on the web with uniform failure, minimized audit, and a CLI flood escape', async () => {
    const webPassword = 'web-recovered-owner-password'
    const issuedAt = new Date('2026-07-13T15:00:00.000Z')
    const issued = await issueOwnerRecovery({
      ownerEmail: owner.email,
      ttlMinutes: 15,
      now: issuedAt,
    })
    const requestContext = {
      channel: 'web',
      clientAddress: '198.51.100.77',
    } as const

    const rejected = await redeemOwnerRecoveryWeb({
      ownerEmail: owner.email,
      code: `${issued.code}-wrong`,
      newPassword: webPassword,
      requestContext,
      now: issuedAt,
    })
    expect(rejected).toEqual({
      kind: 'rejected',
      message: 'The email, code, or password was not accepted.',
    })

    const redeemed = await redeemOwnerRecoveryWeb({
      ownerEmail: owner.email,
      code: issued.code,
      newPassword: webPassword,
      requestContext,
      now: new Date(issuedAt.getTime() + 1),
    })
    expect(redeemed).toMatchObject({ kind: 'redeemed', ownerUserId })
    expect(
      (
        await authRequest('/sign-in/email', {
          email: owner.email,
          password: owner.recoveredPassword,
        })
      ).ok,
    ).toBe(false)
    expect(
      (
        await authRequest('/sign-in/email', {
          email: owner.email,
          password: webPassword,
        })
      ).status,
    ).toBe(200)

    const webAudits = await getDb()
      .select({
        eventType: auditEvents.eventType,
        entityId: auditEvents.entityId,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, 'owner-recovery'),
          eq(auditEvents.subjectUserId, ownerUserId),
        ),
      )
    const webEvents = webAudits.filter(
      (event) =>
        (event.metadata as { channel?: string }).channel === 'web' &&
        event.entityId === issued.recoveryId,
    )
    expect(webEvents.map((event) => event.eventType)).toEqual([
      'owner-recovery-rejected',
      'owner-recovery-redeemed',
    ])
    const serializedWebAudit = JSON.stringify(webEvents)
    expect(serializedWebAudit).toContain('198.51.100.0/24')
    expect(serializedWebAudit).not.toContain(requestContext.clientAddress)
    expect(serializedWebAudit).not.toContain(issued.code)
    expect(serializedWebAudit).not.toContain(webPassword)

    const cliEscape = await issueOwnerRecovery({
      ownerEmail: owner.email,
      ttlMinutes: 15,
      now: new Date(issuedAt.getTime() + 60_001),
    })
    const floodStart = new Date(issuedAt.getTime() + 60_002)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        admitWebRecoveryAttempt({
          purpose: 'owner-recovery',
          email: owner.email,
          clientAddress: requestContext.clientAddress,
          now: new Date(floodStart.getTime() + attempt),
        }),
      ).resolves.toEqual({ admitted: true })
    }
    await expect(
      admitWebRecoveryAttempt({
        purpose: 'owner-recovery',
        email: owner.email,
        clientAddress: requestContext.clientAddress,
        now: new Date(floodStart.getTime() + 5),
      }),
    ).resolves.toMatchObject({ admitted: false })

    const cliPassword = 'cli-escape-owner-password'
    await expect(
      redeemOwnerRecovery({
        ownerEmail: owner.email,
        code: cliEscape.code,
        newPassword: cliPassword,
        now: new Date(floodStart.getTime() + 6),
      }),
    ).resolves.toMatchObject({ ownerUserId })
    expect(
      (
        await authRequest('/sign-in/email', {
          email: owner.email,
          password: cliPassword,
        })
      ).status,
    ).toBe(200)
  })
})
