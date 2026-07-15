import { createHmac } from 'node:crypto'
import { and, count, eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getProductionIdentityAuthMutationPort } from '@/composition/identity-auth-mutations'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
import { identityActionBindingHeader } from '@/modules/identity/application/action-binding'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import { issueEmailSignInActionBinding } from '@/modules/identity/infrastructure/action-binding'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { withSubmittedEmailCredentialLifecycleLocks } from '@/modules/identity/infrastructure/credential-lifecycle-lock'
import {
  createLocalUserAsOwner,
  createLocalUserWithOwnerReauthentication,
} from '@/modules/identity/infrastructure/local-users'
import { createScopedIdentityMutationGateway } from '@/modules/identity/infrastructure/scoped-mutation-auth'
import {
  admitWebRecoveryAttempt,
  isWebRecoveryAttemptThrottled,
} from '@/modules/identity/infrastructure/web-recovery-rate-limit'
import {
  issueMemberReset,
  type MemberResetError,
  redeemMemberReset,
} from '@/modules/identity/recovery/member-reset'
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
  memberResetStates,
  session,
  user,
  verification,
  webRecoveryRateLimitBuckets,
} from '@/platform/db/schema'

const ownerPassword = 'member-reset-owner-password'
const originalMemberPassword = 'member-reset-original-password'
const replacementMemberPassword = 'member-reset-replacement-password'
const requestContext = {
  channel: 'web',
  clientAddress: '203.0.113.91',
} as const

let integrationDatabase: DisposableIntegrationDatabase | undefined
let owner: AuthenticatedActor
let member: { readonly id: string; readonly email: string }

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
  throw new Error('Credential command did not block on the lifecycle lock.')
}

function createSignInRequest(email: string, password: string): Request {
  const origin = getServerConfig().appOrigin
  return new Request(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password }),
  })
}

async function signIn(email: string, password: string): Promise<Response> {
  const request = createSignInRequest(email, password)
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

function normalizedQueryText(query: unknown): string {
  if (typeof query === 'string') return query.replace(/\s+/g, ' ').trim()
  if (
    typeof query === 'object' &&
    query !== null &&
    'text' in query &&
    typeof query.text === 'string'
  ) {
    return query.text.replace(/\s+/g, ' ').trim()
  }
  return String(query)
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'member_reset',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const createdOwner = await createOwnerWithBootstrapCode({
    name: 'Member Reset Owner',
    email: 'member-reset-owner@example.test',
    password: ownerPassword,
    code: bootstrap.code,
  })
  owner = {
    userId: createdOwner.id,
    name: createdOwner.name,
    email: createdOwner.email,
    role: 'owner',
  }
  member = await createLocalUserAsOwner(owner, {
    name: 'Member Reset Trainee',
    email: 'member-reset-trainee@example.test',
    password: originalMemberPassword,
  })
})

afterAll(async () => {
  resetAuthForTests()
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe.sequential('owner-mediated member credential reset', () => {
  it('reserves fixed web budgets atomically and performs bounded cleanup only when admitted', async () => {
    await getDb().delete(webRecoveryRateLimitBuckets)
    const windowStart = new Date('2026-07-13T13:00:00.000Z')
    const email = 'rate-limited-member@example.test'
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        admitWebRecoveryAttempt({
          purpose: 'member-reset',
          email,
          clientAddress: requestContext.clientAddress,
          now: new Date(windowStart.getTime() + attempt),
        }),
      ).resolves.toEqual({ admitted: true })
    }

    const beforeThrottle = await getDb().select().from(webRecoveryRateLimitBuckets)
    const expectedBucketKeys = [
      ['member-reset:address', requestContext.clientAddress],
      ['member-reset:email', email],
    ].map(([scope, value]) =>
      createHmac('sha256', getServerConfig().authSecret)
        .update(`indigo-web-recovery-rate-v1\0${scope}\0${value}`, 'utf8')
        .digest('hex'),
    )
    expect(beforeThrottle.map((bucket) => bucket.bucketKey)).toEqual(
      expect.arrayContaining(expectedBucketKeys),
    )
    const throttled = await admitWebRecoveryAttempt({
      purpose: 'member-reset',
      email,
      clientAddress: requestContext.clientAddress,
      now: new Date(windowStart.getTime() + 5),
    })
    expect(throttled).toMatchObject({
      admitted: false,
      scope: 'member-reset:email',
    })
    expect(await getDb().select().from(webRecoveryRateLimitBuckets)).toEqual(
      beforeThrottle,
    )
    expect(JSON.stringify(beforeThrottle)).not.toContain(email)
    expect(JSON.stringify(beforeThrottle)).not.toContain(requestContext.clientAddress)

    await getDb().delete(webRecoveryRateLimitBuckets)
    const expiredAt = new Date('2026-07-13T13:30:00.000Z')
    await getDb()
      .insert(webRecoveryRateLimitBuckets)
      .values(
        Array.from({ length: 70 }, (_, index) => ({
          scope: 'member-reset:email',
          bucketKey: index.toString(16).padStart(64, '0'),
          windowStartedAt: expiredAt,
          attemptCount: 1,
          retryAfter: null,
          lastAttemptAt: expiredAt,
          createdAt: expiredAt,
          updatedAt: expiredAt,
        })),
      )
    await expect(
      admitWebRecoveryAttempt({
        purpose: 'owner-recovery',
        email: 'cleanup@example.test',
        clientAddress: '198.51.100.25',
        now: new Date(expiredAt.getTime() + 60_001),
      }),
    ).resolves.toEqual({ admitted: true })
    const afterCleanup = await getDb().select().from(webRecoveryRateLimitBuckets)
    expect(afterCleanup).toHaveLength(8)
  })

  it('requires fresh owner reauthentication for production local-user creation', async () => {
    const rejectedEmail = 'reauth-rejected@example.test'
    await expect(
      createLocalUserWithOwnerReauthentication({
        actor: owner,
        name: 'Rejected Local User',
        email: rejectedEmail,
        initialPassword: 'rejected-local-user-password',
        currentPassword: 'wrong-owner-password',
        requestContext,
      }),
    ).rejects.toMatchObject({
      code: 'local-user-create.reauthentication-failed',
    })
    const [rejectedUser] = await getDb()
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, rejectedEmail))
    expect(rejectedUser).toBeUndefined()

    const createdEmail = 'reauthenticated-local-user@example.test'
    const signInEntered = deferred<void>()
    const releaseSignIn = deferred<void>()
    const signInProbe = handleAuthRequest(
      createSignInRequest(createdEmail, 'reauthenticated-user-password'),
      serializedProviderPort(async () => {
        signInEntered.resolve(undefined)
        await releaseSignIn.promise
        return Response.json({ rejected: true }, { status: 401 })
      }),
    )
    await signInEntered.promise

    const createPromise = createLocalUserWithOwnerReauthentication({
      actor: owner,
      name: 'Reauthenticated Local User',
      email: createdEmail,
      initialPassword: 'reauthenticated-user-password',
      currentPassword: ownerPassword,
      requestContext,
    })
    try {
      await waitForBlockedCredentialLock()
    } finally {
      releaseSignIn.resolve(undefined)
    }
    await expect(signInProbe).resolves.toMatchObject({ status: 401 })
    const created = await createPromise
    expect((await signIn(created.email, 'reauthenticated-user-password')).status).toBe(
      200,
    )

    const lifecycleEvents = await getDb()
      .select({
        eventType: auditEvents.eventType,
        subjectUserId: auditEvents.subjectUserId,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, 'local-user'),
          eq(auditEvents.actorUserId, owner.userId),
        ),
      )
    expect(lifecycleEvents.map((event) => event.eventType)).toEqual([
      'local-user-create-rejected',
      'local-user-created',
    ])
    expect(lifecycleEvents[0]?.subjectUserId).toBeNull()
    expect(lifecycleEvents[1]?.subjectUserId).toBe(created.id)
    expect(JSON.stringify(lifecycleEvents)).not.toContain('wrong-owner-password')
    expect(JSON.stringify(lifecycleEvents)).not.toContain('reauthenticated-user-password')
  })

  it('checks the email bucket even when the address dimension is already throttled', async () => {
    await getDb().delete(webRecoveryRateLimitBuckets)
    const now = new Date('2026-07-13T13:32:00.000Z')
    const addressKey = createHmac('sha256', getServerConfig().authSecret)
      .update(
        `indigo-web-recovery-rate-v1\0member-reset:address\0${requestContext.clientAddress}`,
        'utf8',
      )
      .digest('hex')
    await getDb()
      .insert(webRecoveryRateLimitBuckets)
      .values({
        scope: 'member-reset:address',
        bucketKey: addressKey,
        windowStartedAt: now,
        attemptCount: 10_000,
        retryAfter: new Date(now.getTime() + 60_000),
        lastAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })

    const querySpy = vi.spyOn(Client.prototype, 'query')
    try {
      await expect(
        isWebRecoveryAttemptThrottled({
          purpose: 'member-reset',
          email: 'still-read-email-bucket@example.test',
          clientAddress: requestContext.clientAddress,
          now: new Date(now.getTime() + 1),
        }),
      ).resolves.toBe(true)
      const bucketReads = querySpy.mock.calls
        .map((call) => normalizedQueryText(call[0]))
        .filter(
          (query) =>
            query.toLowerCase().startsWith('select') &&
            query.toLowerCase().includes('web_recovery_rate_limit_bucket'),
        )
      expect(bucketReads).toHaveLength(2)
    } finally {
      querySpy.mockRestore()
      await getDb().delete(webRecoveryRateLimitBuckets)
    }
  })

  it('keeps admitted resolved and unresolved failures on identical SQL work classes', async () => {
    const now = new Date('2026-07-13T13:35:00.000Z')
    await getDb().delete(webRecoveryRateLimitBuckets)
    await getDb()
      .insert(memberResetStates)
      .values({
        targetUserId: member.id,
        activeVerificationId: null,
        lastIssuedAt: new Date(now.getTime() - 60_000),
        failedAttempts: 0,
        retryAfter: null,
        lastAttemptAt: null,
        createdAt: new Date(now.getTime() - 60_000),
        updatedAt: new Date(now.getTime() - 60_000),
      })
      .onConflictDoUpdate({
        target: memberResetStates.targetUserId,
        set: {
          activeVerificationId: null,
          failedAttempts: 0,
          retryAfter: null,
          lastAttemptAt: null,
          updatedAt: new Date(now.getTime() - 60_000),
        },
      })

    const capture = async (email: string) => {
      await getDb().delete(webRecoveryRateLimitBuckets)
      const querySpy = vi.spyOn(Client.prototype, 'query')
      try {
        await expect(
          redeemMemberReset({
            email,
            code: 'indigo_m1_invalid-code',
            newPassword: replacementMemberPassword,
            requestContext,
            now,
          }),
        ).resolves.toEqual({
          kind: 'rejected',
          message: 'The email, code, or password was not accepted.',
        })
        return querySpy.mock.calls.map((call) => normalizedQueryText(call[0]))
      } finally {
        querySpy.mockRestore()
      }
    }

    const resolvedTranscript = await capture(member.email)
    const unresolvedTranscript = await capture('unknown-reset-member@example.test')
    expect(unresolvedTranscript).toEqual(resolvedTranscript)

    const transcript = resolvedTranscript.join('\n').toLowerCase()
    expect(transcript.match(/web_recovery_rate_limit_bucket/g)?.length).toBeGreaterThan(4)
    expect(transcript).toContain('pg_advisory_lock_shared')
    expect(transcript).toContain('from "installation_state"')
    expect(transcript).toContain('from "account"')
    expect(transcript).toContain('from "member_reset_state"')
    expect(transcript).toContain('from "verification"')
    expect(transcript).toContain('insert into "audit_event"')

    await getDb()
      .delete(memberResetStates)
      .where(eq(memberResetStates.targetUserId, member.id))
    await getDb().delete(webRecoveryRateLimitBuckets)
  })

  it('restarts distinct expired buckets concurrently without cleanup races', async () => {
    await getDb().delete(webRecoveryRateLimitBuckets)
    const firstWindow = new Date('2026-07-13T13:40:00.000Z')
    const attempts = Array.from({ length: 12 }, (_, index) => ({
      purpose: 'owner-recovery' as const,
      email: `concurrent-cleanup-${index}@example.test`,
      clientAddress: `198.51.100.${index + 1}`,
    }))

    for (const attempt of attempts) {
      await expect(
        admitWebRecoveryAttempt({ ...attempt, now: firstWindow }),
      ).resolves.toEqual({ admitted: true })
    }

    const restartedAt = new Date(firstWindow.getTime() + 60_001)
    await expect(
      Promise.all(
        attempts.map((attempt) =>
          admitWebRecoveryAttempt({ ...attempt, now: restartedAt }),
        ),
      ),
    ).resolves.toEqual(attempts.map(() => ({ admitted: true })))

    const restarted = await getDb().select().from(webRecoveryRateLimitBuckets)
    expect(restarted).toHaveLength(attempts.length * 2)
    expect(restarted.every((bucket) => bucket.windowStartedAt > firstWindow)).toBe(true)
  })

  it('rejects owner targets and denied owner reauthentication with one redacted event each', async () => {
    const [before] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'member-reset-rejected'))
    await expect(
      issueMemberReset({
        actor: owner,
        targetUserId: owner.userId,
        currentPassword: ownerPassword,
        requestContext,
      }),
    ).rejects.toMatchObject({
      code: 'member-reset.target-invalid',
    } satisfies Partial<MemberResetError>)

    await expect(
      issueMemberReset({
        actor: owner,
        targetUserId: member.id,
        currentPassword: 'wrong-owner-password',
        requestContext,
      }),
    ).rejects.toMatchObject({
      code: 'member-reset.reauthentication-failed',
    } satisfies Partial<MemberResetError>)

    const rejected = await getDb()
      .select({
        eventType: auditEvents.eventType,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'member-reset-rejected'))
    const added = rejected.slice(Number(before?.value ?? 0))
    expect(added).toHaveLength(2)
    expect(JSON.stringify(added)).not.toContain(ownerPassword)
    expect(JSON.stringify(added)).not.toContain('wrong-owner-password')
    expect(JSON.stringify(added)).not.toContain(requestContext.clientAddress)
    expect(JSON.stringify(added)).toContain('203.0.113.0/24')
  })

  it('rejects an oversized replacement without hashing it into a live credential', async () => {
    await getDb().delete(webRecoveryRateLimitBuckets)
    const issuedAt = new Date('2026-07-13T13:50:00.000Z')
    const issued = await issueMemberReset({
      actor: owner,
      targetUserId: member.id,
      currentPassword: ownerPassword,
      requestContext,
      now: issuedAt,
    })
    const oversizedPassword = 'x'.repeat(256_000)

    await expect(
      redeemMemberReset({
        email: member.email,
        code: issued.code,
        newPassword: oversizedPassword,
        requestContext,
        now: new Date(issuedAt.getTime() + 1),
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      message: 'The email, code, or password was not accepted.',
    })

    const [pending] = await getDb()
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.id, issued.resetId))
    expect(pending?.id).toBe(issued.resetId)
    expect((await signIn(member.email, originalMemberPassword)).status).toBe(200)

    await getDb()
      .delete(memberResetStates)
      .where(eq(memberResetStates.targetUserId, member.id))
    await getDb().delete(verification).where(eq(verification.id, issued.resetId))
    await getDb().delete(webRecoveryRateLimitBuckets)
  })

  it('keeps the issued code one-use, cooldown-bound, digest-only, and available after a wrong guess', async () => {
    const issuedAt = new Date('2026-07-13T14:00:00.000Z')
    const issued = await issueMemberReset({
      actor: owner,
      targetUserId: member.id,
      currentPassword: ownerPassword,
      requestContext,
      now: issuedAt,
    })
    expect(issued.code).toMatch(/^indigo_m1_[A-Za-z0-9_-]{43}$/)

    await expect(
      issueMemberReset({
        actor: owner,
        targetUserId: member.id,
        currentPassword: ownerPassword,
        requestContext,
        now: new Date(issuedAt.getTime() + 29_999),
      }),
    ).rejects.toMatchObject({ code: 'member-reset.cooldown' })

    const [stored] = await getDb()
      .select({ value: verification.value })
      .from(verification)
      .where(eq(verification.id, issued.resetId))
    const expectedDigest = createHmac('sha256', getServerConfig().authSecret)
      .update(`member-reset-v1\0${issued.code}`, 'utf8')
      .digest('hex')
    expect(stored?.value).toBe(`member-reset-v1:${expectedDigest}`)
    expect(stored?.value).not.toContain(issued.code)

    const wrongAt = new Date(issuedAt.getTime() + 30_000)
    const wrong = await redeemMemberReset({
      email: member.email,
      code: `${issued.code}-wrong`,
      newPassword: replacementMemberPassword,
      requestContext,
      now: wrongAt,
    })
    expect(wrong).toMatchObject({ kind: 'rejected' })

    const [afterWrong] = await getDb()
      .select()
      .from(memberResetStates)
      .where(eq(memberResetStates.targetUserId, member.id))
    expect(afterWrong).toMatchObject({
      activeVerificationId: issued.resetId,
      failedAttempts: 1,
      retryAfter: new Date(wrongAt.getTime() + 1_000),
    })

    const [auditsBeforeSuppressed] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'member-reset-rejected'))
    const bucketsBeforeSuppressed = await getDb()
      .select()
      .from(webRecoveryRateLimitBuckets)

    const suppressed = await redeemMemberReset({
      email: member.email,
      code: issued.code,
      newPassword: replacementMemberPassword,
      requestContext,
      now: new Date(wrongAt.getTime() + 999),
    })
    expect(suppressed).toMatchObject({ kind: 'rejected' })
    const [auditsAfterSuppressed] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'member-reset-rejected'))
    const bucketsAfterSuppressed = await getDb()
      .select()
      .from(webRecoveryRateLimitBuckets)
    expect(auditsAfterSuppressed?.value).toBe(auditsBeforeSuppressed?.value)
    expect(bucketsAfterSuppressed).toEqual(bucketsBeforeSuppressed)

    const firstSession = await signIn(member.email, originalMemberPassword)
    const signInHandled = deferred<Response>()
    const releaseSignIn = deferred<void>()
    const signInPromise = handleAuthRequest(
      createSignInRequest(member.email, originalMemberPassword),
      serializedProviderPort(async (request) => {
        try {
          const response = await createScopedIdentityMutationGateway(getDb()).signInEmail(
            request,
          )
          signInHandled.resolve(response)
          await releaseSignIn.promise
          return response
        } catch (error) {
          signInHandled.reject(error)
          throw error
        }
      }),
    )
    const secondSession = await signInHandled.promise
    expect(firstSession.status).toBe(200)
    expect(secondSession.status).toBe(200)
    const [sessionsBefore] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, member.id))
    expect(sessionsBefore?.value).toBeGreaterThanOrEqual(2)

    const redemptionPromise = redeemMemberReset({
      email: member.email,
      code: issued.code,
      newPassword: replacementMemberPassword,
      requestContext,
      now: new Date(wrongAt.getTime() + 1_000),
    })
    try {
      await waitForBlockedCredentialLock()
    } finally {
      releaseSignIn.resolve(undefined)
    }
    const completedSignIn = await signInPromise
    expect(completedSignIn.status).toBe(secondSession.status)
    expect(completedSignIn.headers.get('set-cookie')).toBe(
      secondSession.headers.get('set-cookie'),
    )
    expect(await completedSignIn.json()).not.toHaveProperty('token')
    const redeemed = await redemptionPromise
    expect(redeemed).toMatchObject({
      kind: 'redeemed',
      targetUserId: member.id,
    })
    const [sessionsAfter] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, member.id))
    expect(sessionsAfter?.value).toBe(0)
    expect((await signIn(member.email, originalMemberPassword)).ok).toBe(false)
    expect((await signIn(member.email, replacementMemberPassword)).status).toBe(200)

    const replay = await redeemMemberReset({
      email: member.email,
      code: issued.code,
      newPassword: 'another-member-password',
      requestContext,
      now: new Date(wrongAt.getTime() + 2_000),
    })
    expect(replay).toMatchObject({ kind: 'rejected' })

    const events = await getDb()
      .select({
        eventType: auditEvents.eventType,
        entityId: auditEvents.entityId,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.subjectUserId, member.id),
          eq(auditEvents.entityType, 'member-reset'),
        ),
      )
    expect(events.some((event) => event.eventType === 'member-reset-issued')).toBe(true)
    expect(events.some((event) => event.eventType === 'member-reset-redeemed')).toBe(true)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(issued.code)
    expect(serialized).not.toContain(originalMemberPassword)
    expect(serialized).not.toContain(replacementMemberPassword)
    expect(serialized).not.toContain(requestContext.clientAddress)
  })
})
