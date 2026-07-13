import { count, eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createInstanceResetPlan,
  executeInstanceReset,
} from '@/modules/data-portability/application/deletion'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/modules/identity/bootstrap/owner-bootstrap'
import {
  CredentialLifecycleUnavailableError,
  withCredentialLifecycleLock,
  withExclusiveCredentialLifecycleFence,
  withSubmittedEmailCredentialLifecycleLocks,
} from '@/modules/identity/infrastructure/credential-lifecycle-lock'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import {
  issueMemberReset,
  redeemMemberReset,
} from '@/modules/identity/recovery/member-reset'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb, getPool } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import {
  auditEvents,
  deletionTombstones,
  installationState,
  user,
  webRecoveryRateLimitBuckets,
} from '@/platform/db/schema'

const ownerPassword = 'instance-fence-owner-password'
const memberPassword = 'instance-fence-member-password'
const replacementPassword = 'instance-fence-replacement-password'
const requestContext = {
  channel: 'web',
  clientAddress: '198.51.100.87',
} as const

let integrationDatabase: DisposableIntegrationDatabase | undefined
let owner: AuthenticatedActor
let member: { readonly id: string; readonly email: string }

type CapturedOutcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly error: unknown }

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

function isInstallationOwnerCaptureQuery(query: unknown): boolean {
  return (
    String(query).replace(/\s+/g, ' ').trim() ===
    'SELECT owner_user_id FROM installation_state WHERE singleton = 1'
  )
}

async function waitForDatabaseCondition(
  description: string,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'reset_fence',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const createdOwner = await createOwnerWithBootstrapCode({
    name: 'Instance Fence Owner',
    email: 'instance-fence-owner@example.test',
    password: ownerPassword,
    code: bootstrap.code,
  })
  owner = { ...createdOwner, userId: createdOwner.id, role: 'owner' }
  member = await createLocalUserAsOwner(owner, {
    name: 'Instance Fence Member',
    email: 'instance-fence-member@example.test',
    password: memberPassword,
  })
})

afterAll(async () => {
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe.sequential('instance reset credential lifecycle fence', () => {
  it('allows independent credential accounts to hold the shared fence concurrently', async () => {
    const firstEntered = deferred<void>()
    const secondEntered = deferred<void>()
    const release = deferred<void>()

    const first = withCredentialLifecycleLock(owner.userId, async () => {
      firstEntered.resolve(undefined)
      await release.promise
    })
    await firstEntered.promise
    const second = withCredentialLifecycleLock(member.id, async () => {
      secondEntered.resolve(undefined)
      await release.promise
    })

    try {
      await secondEntered.promise
    } finally {
      release.resolve(undefined)
    }
    await Promise.all([first, second])
  })

  it('rejects work submitted before a replacement installation generation', async () => {
    const activeEntered = deferred<void>()
    const releases = Array.from({ length: 4 }, () => deferred<void>())
    let enteredCount = 0
    const active = releases.map((release, index) =>
      withCredentialLifecycleLock(`generation-active-${index}`, async () => {
        enteredCount += 1
        if (enteredCount === releases.length) activeEntered.resolve(undefined)
        await release.promise
      }),
    )
    await activeEntered.promise

    let replacement: Promise<CapturedOutcome<void>> | undefined
    let staleRequest: Promise<CapturedOutcome<string>> | undefined
    let trustedBlockers: Array<Promise<CapturedOutcome<void>>> | undefined
    let staleCallbackEntered = false
    const poolQuerySpy = vi.spyOn(getPool(), 'query')

    try {
      replacement = captureOutcome(
        withExclusiveCredentialLifecycleFence(async () => {
          await getDb()
            .update(installationState)
            .set({ ownerUserId: member.id, updatedAt: new Date() })
            .where(eq(installationState.singleton, 1))
        }),
      )
      staleRequest = captureOutcome(
        withSubmittedEmailCredentialLifecycleLocks({
          email: 'stale-generation@example.test',
          resolveAccountUserIds: async () => [],
          callback: async () => {
            staleCallbackEntered = true
            return 'entered'
          },
        }),
      )
      trustedBlockers = Array.from({ length: 3 }, (_, index) =>
        captureOutcome(
          withCredentialLifecycleLock(
            `generation-blocker-${index}`,
            async () => undefined,
          ),
        ),
      )

      await vi.waitFor(() => {
        const captureQueries = poolQuerySpy.mock.calls.filter(([query]) =>
          isInstallationOwnerCaptureQuery(query),
        )
        expect(captureQueries).toHaveLength(4)
      })
      const completedCaptureQueries = poolQuerySpy.mock.calls.flatMap(([query], index) =>
        isInstallationOwnerCaptureQuery(query)
          ? [Promise.resolve(poolQuerySpy.mock.results[index]?.value)]
          : [],
      )
      await Promise.all(completedCaptureQueries)
      await Promise.resolve()
      poolQuerySpy.mockRestore()

      releases[0]?.resolve(undefined)
      await waitForDatabaseCondition(
        'replacement generation to wait on the instance fence',
        async () => {
          const result = await getDb().execute<{ waiting: number }>(sql`
            SELECT count(*)::integer AS waiting
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND application_name = 'indigo-credential-lifecycle'
              AND wait_event = 'advisory'
          `)
          return Number(result.rows[0]?.waiting ?? 0) >= 1
        },
      )
      for (const release of releases.slice(1)) release.resolve(undefined)

      const replacementOutcome = await replacement
      expect(replacementOutcome.status).toBe('fulfilled')
      const staleOutcome = await staleRequest
      expect(staleOutcome.status).toBe('rejected')
      if (staleOutcome.status !== 'rejected') {
        throw new Error('Stale lifecycle request unexpectedly entered its callback.')
      }
      expect(staleOutcome.error).toBeInstanceOf(CredentialLifecycleUnavailableError)
      expect(staleCallbackEntered).toBe(false)
      const blockerOutcomes = await Promise.all(trustedBlockers)
      expect(
        blockerOutcomes.every(
          (outcome) =>
            outcome.status === 'fulfilled' ||
            outcome.error instanceof CredentialLifecycleUnavailableError,
        ),
      ).toBe(true)
    } finally {
      poolQuerySpy.mockRestore()
      for (const release of releases) release.resolve(undefined)
      await Promise.allSettled(active)
      await Promise.allSettled(
        [replacement, staleRequest, ...(trustedBlockers ?? [])].filter(
          (task) => task !== undefined,
        ),
      )
      await getDb()
        .update(installationState)
        .set({ ownerUserId: owner.userId, updatedAt: new Date() })
        .where(eq(installationState.singleton, 1))
    }
  })

  it('keeps queued credential work read-only when reset wins the exclusive fence', async () => {
    const issued = await issueMemberReset({
      actor: owner,
      targetUserId: member.id,
      currentPassword: ownerPassword,
      requestContext,
    })
    const plan = await createInstanceResetPlan(owner)
    const rowLocker = new Client({ connectionString: getServerConfig().databaseUrl })
    await rowLocker.connect()
    let reset: Promise<void> | undefined
    let redemption:
      | Promise<{
          value: Awaited<ReturnType<typeof redeemMemberReset>> | null
          error: unknown
        }>
      | undefined

    try {
      await rowLocker.query('BEGIN')
      const pidResult = await rowLocker.query<{ pid: number }>(
        'SELECT pg_backend_pid()::integer AS pid',
      )
      const lockerPid = pidResult.rows[0]?.pid
      if (!lockerPid) throw new Error('Could not identify the row-lock fixture.')
      await rowLocker.query(
        "SELECT id FROM account WHERE user_id = $1 AND provider_id = 'credential' FOR UPDATE",
        [owner.userId],
      )

      reset = executeInstanceReset({
        actor: owner,
        planId: plan.id,
        planDigest: plan.digest,
        password: ownerPassword,
        typedConfirmation: 'RESET',
        acknowledged: true,
      })
      await waitForDatabaseCondition(
        'instance reset to reach owner credential lock',
        async () => {
          const result = await getDb().execute<{ waiting: number }>(sql`
          SELECT count(*)::integer AS waiting
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND ${lockerPid} = ANY(pg_blocking_pids(pid))
        `)
          return Number(result.rows[0]?.waiting ?? 0) >= 1
        },
      )

      redemption = redeemMemberReset({
        email: member.email,
        code: issued.code,
        newPassword: replacementPassword,
        requestContext,
      }).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      )
      await waitForDatabaseCondition(
        'member redemption to wait on the instance fence',
        async () => {
          const result = await getDb().execute<{ waiting: number }>(sql`
          SELECT count(*)::integer AS waiting
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = 'indigo-credential-lifecycle'
            AND wait_event = 'advisory'
        `)
          return Number(result.rows[0]?.waiting ?? 0) >= 1
        },
      )

      await rowLocker.query('COMMIT')
      await reset
      const redemptionOutcome = await redemption
      expect(redemptionOutcome.value).toBeNull()
      expect(redemptionOutcome.error).toBeInstanceOf(CredentialLifecycleUnavailableError)
    } finally {
      await rowLocker.query('ROLLBACK').catch(() => undefined)
      await rowLocker.end().catch(() => undefined)
      await Promise.allSettled([reset, redemption].filter((task) => task !== undefined))
    }

    const [installation] = await getDb().select().from(installationState)
    const [users] = await getDb().select({ value: count() }).from(user)
    const [audits] = await getDb().select({ value: count() }).from(auditEvents)
    const [buckets] = await getDb()
      .select({ value: count() })
      .from(webRecoveryRateLimitBuckets)
    const tombstones = await getDb()
      .select()
      .from(deletionTombstones)
      .where(eq(deletionTombstones.scope, 'instance-reset'))

    expect(installation).toMatchObject({ ownerUserId: null, bootstrapClosedAt: null })
    expect(users?.value).toBe(0)
    expect(audits?.value).toBe(0)
    expect(buckets?.value).toBe(0)
    expect(tombstones).toHaveLength(1)
  })
})
