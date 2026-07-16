import { count, eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
import { issueOwnerRecovery } from '@/composition/identity-host-recovery-mutations'
import { getProductionIdentityRecoveryMutationPort } from '@/composition/identity-recovery-mutations'
import { cleanupExpiredSessions } from '@/composition/identity-session-maintenance'
import {
  createInstanceResetPlan,
  executeInstanceReset,
} from '@/modules/data-portability/application/deletion'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import { issueOwnerRecoveryRedemptionActionBinding } from '@/modules/identity/infrastructure/action-binding'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import {
  captureOwnerRecoveryRedemptionMutationCommand,
  type OwnerRecoveryRedemptionMutationCommand,
} from '@/modules/identity/server/recovery-redemption-command'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import {
  deletionTombstones,
  installationState,
  session,
  user,
  verification,
} from '@/platform/db/schema'

vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({
      origin: 'http://localhost:3000',
      'x-forwarded-for': '198.51.100.91, 127.0.0.1',
    }),
}))

const ownerEmail = 'maintenance-race-owner@example.test'
const initialOwnerPassword = 'maintenance-race-owner-password'
const firstRecoveryPassword = 'maintenance-race-recovered-one'
const secondRecoveryPassword = 'maintenance-race-recovered-two'
const fixedCutoff = new Date('2090-01-01T00:00:00.000Z')
const expiredAt = new Date('2088-01-01T00:00:00.000Z')

let integrationDatabase: DisposableIntegrationDatabase | undefined
let owner: AuthenticatedActor
let memberUserId: string
let currentOwnerPassword = initialOwnerPassword

type CapturedOutcome<T> =
  | Readonly<{ status: 'fulfilled'; value: T }>
  | Readonly<{ status: 'rejected'; error: unknown }>

function captureOutcome<T>(promise: Promise<T>): Promise<CapturedOutcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (error: unknown) => ({ status: 'rejected', error }),
  )
}

async function waitForDatabaseCondition(
  description: string,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function waitForBlockingEdge(input: {
  readonly description: string
  readonly waitingApplication:
    | 'indigo-synthesis:control'
    | 'indigo-synthesis:ordinary'
    | 'indigo-synthesis:external-host'
  readonly waitEvent?: 'advisory'
  readonly blockerPid?: number
  readonly blockerApplication?:
    | 'indigo-synthesis:control'
    | 'indigo-synthesis:external-host'
}): Promise<void> {
  await waitForDatabaseCondition(input.description, async () => {
    const result = await getDb().execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity AS waiter
        JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) AS edge(blocker_pid)
          ON true
        JOIN pg_stat_activity AS blocker
          ON blocker.pid = edge.blocker_pid
        WHERE waiter.datname = current_database()
          AND waiter.application_name = ${input.waitingApplication}
          AND (${input.waitEvent ?? null}::text IS NULL OR waiter.wait_event = ${input.waitEvent ?? null})
          AND (${input.blockerPid ?? null}::integer IS NULL OR blocker.pid = ${input.blockerPid ?? null})
          AND (
            ${input.blockerApplication ?? null}::text IS NULL
            OR blocker.application_name = ${input.blockerApplication ?? null}
          )
      ) AS blocked
    `)
    return result.rows[0]?.blocked === true
  })
}

async function rowLocker(): Promise<{
  readonly client: Client
  readonly pid: number
}> {
  const client = new Client({
    connectionString: getServerConfig().databaseUrl,
    application_name: 'indigo-synthesis:test-row-locker',
  })
  await client.connect()
  await client.query('BEGIN')
  const result = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid()::integer AS pid',
  )
  const pid = result.rows[0]?.pid
  if (!pid) {
    await client.end()
    throw new Error('Could not identify the maintenance race row locker.')
  }
  return { client, pid }
}

async function insertExpiredSession(id: string, userId: string): Promise<void> {
  const now = new Date('2026-07-15T12:00:00.000Z')
  await getDb()
    .insert(session)
    .values({
      id,
      token: `token:${id}`,
      userId,
      expiresAt: expiredAt,
      createdAt: now,
      updatedAt: now,
    })
}

async function recoveryCommand(input: {
  readonly code: string
  readonly newPassword: string
  readonly commandEnteredAt: Date
}): Promise<OwnerRecoveryRedemptionMutationCommand> {
  const [installation] = await getDb()
    .select({ epoch: installationState.productMutationEpoch })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
  if (!installation) throw new Error('Maintenance race installation is missing.')

  const formData = new FormData()
  formData.set(
    'actionBinding',
    issueOwnerRecoveryRedemptionActionBinding(
      { expectedEpoch: installation.epoch },
      input.commandEnteredAt,
    ),
  )
  formData.set('email', ownerEmail)
  formData.set('code', input.code)
  formData.set('newPassword', input.newPassword)
  formData.set('confirmPassword', input.newPassword)
  const captured = await captureOwnerRecoveryRedemptionMutationCommand({
    formData,
    commandEnteredAt: input.commandEnteredAt,
  })
  if (captured.kind !== 'captured') {
    throw new Error(`Owner recovery command was rejected at ${captured.reason}.`)
  }
  return captured.command
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'maintenance_race',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const createdOwner = await createOwnerWithBootstrapCode({
    name: 'Maintenance Race Owner',
    email: ownerEmail,
    password: initialOwnerPassword,
    code: bootstrap.code,
  })
  owner = { ...createdOwner, userId: createdOwner.id, role: 'owner' }
  const member = await createLocalUserAsOwner(owner, {
    name: 'Maintenance Race Member',
    email: 'maintenance-race-member@example.test',
    password: 'maintenance-race-member-password',
  })
  memberUserId = member.id
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
})

describe.sequential('expired-session maintenance concurrency', () => {
  it('serializes browser recovery after a maintenance page that wins the account lock', async () => {
    const commandEnteredAt = new Date('2026-07-15T13:00:00.000Z')
    const issued = await issueOwnerRecovery({
      ownerEmail,
      ttlMinutes: 15,
      now: commandEnteredAt,
    })
    const command = await recoveryCommand({
      code: issued.code,
      newPassword: firstRecoveryPassword,
      commandEnteredAt,
    })
    const sessionId = 'maintenance-race/recovery/maintenance-first'
    await insertExpiredSession(sessionId, owner.userId)
    const locker = await rowLocker()
    let maintenance:
      | Promise<CapturedOutcome<Awaited<ReturnType<typeof cleanupExpiredSessions>>>>
      | undefined
    let recovery:
      | Promise<
          CapturedOutcome<
            Awaited<
              ReturnType<
                ReturnType<
                  typeof getProductionIdentityRecoveryMutationPort
                >['redeemOwnerRecovery']
              >
            >
          >
        >
      | undefined

    try {
      await locker.client.query('SELECT id FROM "session" WHERE id = $1 FOR UPDATE', [
        sessionId,
      ])
      maintenance = captureOutcome(
        cleanupExpiredSessions({ batchSize: 64, now: fixedCutoff }),
      )
      await waitForBlockingEdge({
        description: 'maintenance DELETE to reach the raw session lock',
        waitingApplication: 'indigo-synthesis:external-host',
        blockerPid: locker.pid,
      })

      recovery = captureOutcome(
        getProductionIdentityRecoveryMutationPort().redeemOwnerRecovery(command),
      )
      await waitForBlockingEdge({
        description: 'browser recovery to queue behind maintenance account ownership',
        waitingApplication: 'indigo-synthesis:control',
        waitEvent: 'advisory',
        blockerApplication: 'indigo-synthesis:external-host',
      })
      await locker.client.query('COMMIT')

      await expect(maintenance).resolves.toEqual({
        status: 'fulfilled',
        value: { status: 'complete', deletedCount: 1, nextCursor: null },
      })
      await expect(recovery).resolves.toEqual({
        status: 'fulfilled',
        value: {
          kind: 'redeemed',
          ownerUserId: owner.userId,
          revokedSessionCount: 0,
        },
      })
      currentOwnerPassword = firstRecoveryPassword
    } finally {
      await locker.client.query('ROLLBACK').catch(() => undefined)
      await locker.client.end().catch(() => undefined)
      await Promise.allSettled(
        [maintenance, recovery].filter((task) => task !== undefined),
      )
    }

    const [remainingSession] = await getDb()
      .select({ id: session.id })
      .from(session)
      .where(eq(session.id, sessionId))
    const [remainingCode] = await getDb()
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.id, issued.recoveryId))
    expect(remainingSession).toBeUndefined()
    expect(remainingCode).toBeUndefined()
  })

  it('rejects a stale maintenance capture after browser recovery wins the account lock', async () => {
    const commandEnteredAt = new Date('2026-07-15T14:00:00.000Z')
    const issued = await issueOwnerRecovery({
      ownerEmail,
      ttlMinutes: 15,
      now: commandEnteredAt,
    })
    const command = await recoveryCommand({
      code: issued.code,
      newPassword: secondRecoveryPassword,
      commandEnteredAt,
    })
    const sessionId = 'maintenance-race/recovery/recovery-first'
    await insertExpiredSession(sessionId, owner.userId)
    const locker = await rowLocker()
    let maintenance:
      | Promise<CapturedOutcome<Awaited<ReturnType<typeof cleanupExpiredSessions>>>>
      | undefined
    let recovery:
      | Promise<
          CapturedOutcome<
            Awaited<
              ReturnType<
                ReturnType<
                  typeof getProductionIdentityRecoveryMutationPort
                >['redeemOwnerRecovery']
              >
            >
          >
        >
      | undefined

    try {
      await locker.client.query(
        "SELECT id FROM account WHERE user_id = $1 AND provider_id = 'credential' FOR UPDATE",
        [owner.userId],
      )
      recovery = captureOutcome(
        getProductionIdentityRecoveryMutationPort().redeemOwnerRecovery(command),
      )
      await waitForBlockingEdge({
        description: 'browser recovery to reach the raw credential lock',
        waitingApplication: 'indigo-synthesis:control',
        blockerPid: locker.pid,
      })

      maintenance = captureOutcome(
        cleanupExpiredSessions({ batchSize: 64, now: fixedCutoff }),
      )
      await waitForBlockingEdge({
        description: 'maintenance to queue behind browser recovery account ownership',
        waitingApplication: 'indigo-synthesis:external-host',
        waitEvent: 'advisory',
        blockerApplication: 'indigo-synthesis:control',
      })
      await locker.client.query('COMMIT')

      await expect(recovery).resolves.toEqual({
        status: 'fulfilled',
        value: {
          kind: 'redeemed',
          ownerUserId: owner.userId,
          revokedSessionCount: 1,
        },
      })
      await expect(maintenance).resolves.toMatchObject({
        status: 'rejected',
        error: { code: 'expired-session-maintenance.stale' },
      })
      currentOwnerPassword = secondRecoveryPassword
    } finally {
      await locker.client.query('ROLLBACK').catch(() => undefined)
      await locker.client.end().catch(() => undefined)
      await Promise.allSettled(
        [maintenance, recovery].filter((task) => task !== undefined),
      )
    }

    const [remainingSession] = await getDb()
      .select({ id: session.id })
      .from(session)
      .where(eq(session.id, sessionId))
    const [remainingCode] = await getDb()
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.id, issued.recoveryId))
    expect(remainingSession).toBeUndefined()
    expect(remainingCode).toBeUndefined()
  })

  it('makes a queued reset refresh its exact plan after maintenance wins', async () => {
    const sessionId = 'maintenance-race/reset/maintenance-first'
    await insertExpiredSession(sessionId, memberUserId)
    const plan = await createInstanceResetPlan(owner)
    const locker = await rowLocker()
    let maintenance:
      | Promise<CapturedOutcome<Awaited<ReturnType<typeof cleanupExpiredSessions>>>>
      | undefined
    let reset: Promise<CapturedOutcome<void>> | undefined

    try {
      await locker.client.query('SELECT id FROM "session" WHERE id = $1 FOR UPDATE', [
        sessionId,
      ])
      maintenance = captureOutcome(
        cleanupExpiredSessions({ batchSize: 64, now: fixedCutoff }),
      )
      await waitForBlockingEdge({
        description: 'maintenance DELETE to reach the reset-race session lock',
        waitingApplication: 'indigo-synthesis:external-host',
        blockerPid: locker.pid,
      })

      reset = captureOutcome(
        executeInstanceReset({
          actor: owner,
          planId: plan.id,
          planDigest: plan.digest,
          password: currentOwnerPassword,
          typedConfirmation: 'RESET',
          acknowledged: true,
        }),
      )
      await waitForBlockingEdge({
        description: 'instance reset to queue behind maintenance instance ownership',
        waitingApplication: 'indigo-synthesis:control',
        waitEvent: 'advisory',
        blockerApplication: 'indigo-synthesis:external-host',
      })
      await locker.client.query('COMMIT')

      await expect(maintenance).resolves.toEqual({
        status: 'fulfilled',
        value: { status: 'complete', deletedCount: 1, nextCursor: null },
      })
      await expect(reset).resolves.toMatchObject({
        status: 'rejected',
        error: { code: 'deletion.plan-changed' },
      })
    } finally {
      await locker.client.query('ROLLBACK').catch(() => undefined)
      await locker.client.end().catch(() => undefined)
      await Promise.allSettled([maintenance, reset].filter((task) => task !== undefined))
    }

    const [installation] = await getDb().select().from(installationState)
    const tombstones = await getDb()
      .select({ id: deletionTombstones.id })
      .from(deletionTombstones)
      .where(eq(deletionTombstones.scope, 'instance-reset'))
    expect(installation?.ownerUserId).toBe(owner.userId)
    expect(tombstones).toEqual([])
  })

  it('rejects a stale maintenance capture after instance reset wins', async () => {
    const sessionId = 'maintenance-race/reset/reset-first'
    await insertExpiredSession(sessionId, owner.userId)
    const plan = await createInstanceResetPlan(owner)
    const locker = await rowLocker()
    let maintenance:
      | Promise<CapturedOutcome<Awaited<ReturnType<typeof cleanupExpiredSessions>>>>
      | undefined
    let reset: Promise<CapturedOutcome<void>> | undefined

    try {
      await locker.client.query(
        "SELECT id FROM account WHERE user_id = $1 AND provider_id = 'credential' FOR UPDATE",
        [owner.userId],
      )
      reset = captureOutcome(
        executeInstanceReset({
          actor: owner,
          planId: plan.id,
          planDigest: plan.digest,
          password: currentOwnerPassword,
          typedConfirmation: 'RESET',
          acknowledged: true,
        }),
      )
      await waitForBlockingEdge({
        description: 'instance reset to reach the raw credential lock',
        waitingApplication: 'indigo-synthesis:ordinary',
        blockerPid: locker.pid,
      })

      maintenance = captureOutcome(
        cleanupExpiredSessions({ batchSize: 64, now: fixedCutoff }),
      )
      await waitForBlockingEdge({
        description: 'maintenance to queue behind reset instance ownership',
        waitingApplication: 'indigo-synthesis:external-host',
        waitEvent: 'advisory',
        blockerApplication: 'indigo-synthesis:control',
      })
      await locker.client.query('COMMIT')

      await expect(reset).resolves.toEqual({ status: 'fulfilled', value: undefined })
      await expect(maintenance).resolves.toMatchObject({
        status: 'rejected',
        error: { code: 'expired-session-maintenance.stale' },
      })
    } finally {
      await locker.client.query('ROLLBACK').catch(() => undefined)
      await locker.client.end().catch(() => undefined)
      await Promise.allSettled([maintenance, reset].filter((task) => task !== undefined))
    }

    const [installation] = await getDb().select().from(installationState)
    const [users] = await getDb().select({ value: count() }).from(user)
    const [sessions] = await getDb().select({ value: count() }).from(session)
    const tombstones = await getDb()
      .select({ id: deletionTombstones.id })
      .from(deletionTombstones)
      .where(eq(deletionTombstones.scope, 'instance-reset'))
    expect(installation).toMatchObject({ ownerUserId: null, bootstrapClosedAt: null })
    expect(users?.value).toBe(0)
    expect(sessions?.value).toBe(0)
    expect(tombstones).toHaveLength(1)
  })
})
