import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import {
  assertDatabaseReady,
  expectedMigrationCount,
  inspectDatabase,
} from '@/platform/db/preflight'
import {
  account,
  destructiveReauthenticationStates,
  memberResetStates,
  user,
  verification,
  webRecoveryRateLimitBuckets,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

let integrationDatabase: DisposableIntegrationDatabase | undefined
let ownerUserId: string
let memberUserId: string

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'recovery_state',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const owner = await createOwnerWithBootstrapCode({
    name: 'Persistence Owner',
    email: 'persistence-owner@example.test',
    password: 'persistence-owner-password',
    code: bootstrap.code,
  })
  ownerUserId = owner.id
  memberUserId = newUuidV7()

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT set_config('indigo.user_creation_mode', 'owner-admin', true)`,
    )
    await transaction.insert(user).values({
      id: memberUserId,
      name: 'Persistence Member',
      email: 'persistence-member@example.test',
      emailVerified: false,
    })
  })
})

afterAll(async () => {
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe.sequential('access-recovery persistence contract', () => {
  it('applies the complete migration ledger and passes the concrete preflight', async () => {
    const report = await assertDatabaseReady()

    expect(report.committedMigrationCount).toBe(expectedMigrationCount)
    expect(report.appliedCommittedMigrationCount).toBe(expectedMigrationCount)
    expect(report.latestCommittedMigrationApplied).toBe(true)
    expect(report.accessRecoveryPersistencePresent).toBe(true)
  })

  it('allows only the two shipped credential reauthentication purposes', async () => {
    const [credential] = await getDb()
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, ownerUserId), eq(account.providerId, 'credential')))
    if (!credential) throw new Error('Persistence owner has no credential account.')

    const attemptedAt = new Date('2026-07-13T12:00:00.000Z')
    await getDb()
      .insert(destructiveReauthenticationStates)
      .values([
        {
          id: newUuidV7(),
          accountId: credential.id,
          purpose: 'member-reset-issue',
          windowStartedAt: attemptedAt,
          failedAttempts: 1,
          lastAttemptAt: attemptedAt,
        },
        {
          id: newUuidV7(),
          accountId: credential.id,
          purpose: 'local-user-create',
          windowStartedAt: attemptedAt,
          failedAttempts: 1,
          lastAttemptAt: attemptedAt,
        },
      ])

    await expect(
      getDb().insert(destructiveReauthenticationStates).values({
        id: newUuidV7(),
        accountId: credential.id,
        purpose: 'session-revoke',
        windowStartedAt: attemptedAt,
        failedAttempts: 1,
        lastAttemptAt: attemptedAt,
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } })

    await getDb()
      .delete(destructiveReauthenticationStates)
      .where(eq(destructiveReauthenticationStates.accountId, credential.id))
  })

  it('retains cooldown state when a one-use verification disappears and cascades by target', async () => {
    const verificationId = newUuidV7()
    const issuedAt = new Date('2026-07-13T12:00:00.000Z')
    await getDb()
      .insert(verification)
      .values({
        id: verificationId,
        identifier: `indigo:member-reset:${memberUserId}`,
        value: `member-reset-v1:${'a'.repeat(64)}`,
        expiresAt: new Date('2026-07-13T12:15:00.000Z'),
      })
    await getDb().insert(memberResetStates).values({
      targetUserId: memberUserId,
      activeVerificationId: verificationId,
      lastIssuedAt: issuedAt,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    })

    await expect(
      getDb()
        .update(memberResetStates)
        .set({ failedAttempts: 1 })
        .where(eq(memberResetStates.targetUserId, memberUserId)),
    ).rejects.toMatchObject({ cause: { code: '23514' } })

    await getDb().delete(verification).where(eq(verification.id, verificationId))
    const [afterConsumption] = await getDb()
      .select()
      .from(memberResetStates)
      .where(eq(memberResetStates.targetUserId, memberUserId))
    expect(afterConsumption).toMatchObject({
      activeVerificationId: null,
      failedAttempts: 0,
      lastIssuedAt: issuedAt,
    })

    await getDb().delete(user).where(eq(user.id, memberUserId))
    const [afterSubjectDeletion] = await getDb()
      .select()
      .from(memberResetStates)
      .where(eq(memberResetStates.targetUserId, memberUserId))
    expect(afterSubjectDeletion).toBeUndefined()
  })

  it('accepts only scoped HMAC digests and exposes updated-at cleanup ordering', async () => {
    const attemptedAt = new Date('2026-07-13T12:00:00.000Z')
    await getDb()
      .insert(webRecoveryRateLimitBuckets)
      .values({
        scope: 'member-reset:email',
        bucketKey: 'b'.repeat(64),
        windowStartedAt: attemptedAt,
        attemptCount: 1,
        lastAttemptAt: attemptedAt,
        createdAt: attemptedAt,
        updatedAt: attemptedAt,
      })

    await expect(
      getDb().insert(webRecoveryRateLimitBuckets).values({
        scope: 'member-reset:email',
        bucketKey: 'persistence-member@example.test',
        windowStartedAt: attemptedAt,
        attemptCount: 1,
        lastAttemptAt: attemptedAt,
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
    await expect(
      getDb()
        .insert(webRecoveryRateLimitBuckets)
        .values({
          scope: 'session-revoke:address',
          bucketKey: 'c'.repeat(64),
          windowStartedAt: attemptedAt,
          attemptCount: 1,
          lastAttemptAt: attemptedAt,
        }),
    ).rejects.toMatchObject({ cause: { code: '23514' } })

    const rows = await getDb()
      .select()
      .from(webRecoveryRateLimitBuckets)
      .orderBy(webRecoveryRateLimitBuckets.updatedAt)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      scope: 'member-reset:email',
      bucketKey: 'b'.repeat(64),
      attemptCount: 1,
      retryAfter: null,
    })
    expect(JSON.stringify(rows)).not.toContain('persistence-member@example.test')
  })

  it('fails preflight when the cleanup index is missing', async () => {
    await getDb().execute(
      sql.raw('DROP INDEX web_recovery_rate_limit_bucket_updated_idx'),
    )
    try {
      const report = await inspectDatabase()
      expect(report.accessRecoveryPersistencePresent).toBe(false)
      await expect(assertDatabaseReady()).rejects.toThrow(
        /access-recovery state, rate-limit, constraint, or index contract is absent/,
      )
    } finally {
      await getDb().execute(
        sql.raw(
          'CREATE INDEX web_recovery_rate_limit_bucket_updated_idx ON web_recovery_rate_limit_bucket (updated_at, scope, bucket_key)',
        ),
      )
    }
  })

  it('fails preflight when the expired-session maintenance seek index is missing', async () => {
    await getDb().execute(sql.raw('DROP INDEX session_expires_at_id_idx'))
    try {
      const report = await inspectDatabase()
      expect(report.accessRecoveryPersistencePresent).toBe(false)
      await expect(assertDatabaseReady()).rejects.toThrow(
        /access-recovery state, rate-limit, constraint, or index contract is absent/,
      )
    } finally {
      await getDb().execute(
        sql.raw(
          'CREATE INDEX session_expires_at_id_idx ON "session" (expires_at, id COLLATE "C")',
        ),
      )
    }
  })

  it('fails preflight for the wrong maintenance index ordering or access method', async () => {
    await getDb().execute(sql.raw('DROP INDEX session_expires_at_id_idx'))
    await getDb().execute(
      sql.raw(
        'CREATE INDEX session_expires_at_id_idx ON "session" (expires_at, id COLLATE "C" DESC)',
      ),
    )
    try {
      const report = await inspectDatabase()
      expect(report.accessRecoveryPersistencePresent).toBe(false)
      await expect(assertDatabaseReady()).rejects.toThrow(
        /access-recovery state, rate-limit, constraint, or index contract is absent/,
      )

      await getDb().execute(sql.raw('DROP INDEX session_expires_at_id_idx'))
      await getDb().execute(
        sql.raw(
          'CREATE INDEX session_expires_at_id_idx ON "session" USING brin (expires_at, id COLLATE "C")',
        ),
      )
      const wrongMethodReport = await inspectDatabase()
      expect(wrongMethodReport.accessRecoveryPersistencePresent).toBe(false)
    } finally {
      await getDb().execute(sql.raw('DROP INDEX IF EXISTS session_expires_at_id_idx'))
      await getDb().execute(
        sql.raw(
          'CREATE INDEX session_expires_at_id_idx ON "session" (expires_at, id COLLATE "C")',
        ),
      )
    }
  })
})
