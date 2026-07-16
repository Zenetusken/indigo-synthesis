import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
import { cleanupExpiredSessions } from '@/composition/identity-session-maintenance'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import { account, session, user, verification } from '@/platform/db/schema'

const execFile = promisify(execFileCallback)
const fixedCutoff = new Date('2090-01-01T00:00:00.000Z')
const equalExpiry = new Date('2088-01-01T00:00:00.000Z')
const secondExpiry = new Date('2088-01-02T00:00:00.000Z')
const finalExpiry = new Date('2088-01-03T00:00:00.000Z')
const preexistingPostCutoffExpiry = new Date('2090-01-01T00:00:00.001Z')
const insertedPostCutoffExpiry = new Date('2090-01-01T00:00:00.002Z')
const durableExpiry = new Date('2199-01-01T00:00:00.000Z')

const longProviderSessionId = `maintenance/equal-${'x'.repeat(400)}`
const equalExpiryIds = [
  'maintenance/equal-A',
  'maintenance/equal-a',
  longProviderSessionId,
] as const
const laterExpiredIds = [
  'maintenance/page-two-member',
  'maintenance/page-two-owner',
  'maintenance/page-two-final',
] as const
const preexistingPostCutoffId = 'maintenance/post-cutoff/preexisting'
const insertedPostCutoffId = 'maintenance/post-cutoff/inserted-after-page-one'
const durableSessionId = 'maintenance/sentinel/session-not-a-uuid'
const durableVerificationId = 'maintenance-sentinel-verification'
const cliExpiredSessionId = 'maintenance/cli/expired-not-a-uuid'

let integrationDatabase: DisposableIntegrationDatabase | undefined
let ownerUserId: string
let pagingMemberUserId: string
let sentinelMemberUserId: string
let sentinelAccountId: string
let sentinelAccountPassword: string | null

type IdentitySnapshot = Readonly<{
  users: readonly Readonly<{ id: string; email: string }>[]
  accounts: readonly Readonly<{
    id: string
    userId: string
    providerId: string
    password: string | null
  }>[]
  verifications: readonly Readonly<{
    id: string
    identifier: string
    value: string
  }>[]
}>

function byIdentity(left: { id: string }, right: { id: string }): number {
  return Buffer.compare(Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8'))
}

async function identitySnapshot(): Promise<IdentitySnapshot> {
  const [users, accounts, verifications] = await Promise.all([
    getDb().select({ id: user.id, email: user.email }).from(user),
    getDb()
      .select({
        id: account.id,
        userId: account.userId,
        providerId: account.providerId,
        password: account.password,
      })
      .from(account),
    getDb()
      .select({
        id: verification.id,
        identifier: verification.identifier,
        value: verification.value,
      })
      .from(verification),
  ])
  return Object.freeze({
    users: Object.freeze(users.toSorted(byIdentity)),
    accounts: Object.freeze(accounts.toSorted(byIdentity)),
    verifications: Object.freeze(verifications.toSorted(byIdentity)),
  })
}

async function orderedSessionIds(): Promise<readonly string[]> {
  const rows = await getDb()
    .select({ id: session.id })
    .from(session)
    .orderBy(sql`${session.id} COLLATE "C"`)
  return rows.map(({ id }) => id)
}

async function insertSession(input: {
  readonly id: string
  readonly userId: string
  readonly expiresAt: Date
}): Promise<void> {
  const now = new Date('2026-07-16T00:00:00.000Z')
  await getDb()
    .insert(session)
    .values({
      id: input.id,
      token: `token:${input.id}`,
      userId: input.userId,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    })
}

function decodeCanonicalCursor(cursor: string): readonly unknown[] {
  expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  const bytes = Buffer.from(cursor, 'base64url')
  expect(bytes.toString('base64url')).toBe(cursor)
  const decoded: unknown = JSON.parse(bytes.toString('utf8'))
  expect(Array.isArray(decoded)).toBe(true)
  return decoded as readonly unknown[]
}

async function runMaintenanceCli(arguments_: readonly string[]) {
  return execFile(
    'bash',
    [
      'scripts/run-external-host-command.sh',
      'scripts/identity/cleanup-expired-sessions.ts',
      ...arguments_,
    ],
    { cwd: process.cwd(), env: process.env },
  )
}

async function runMaintenanceCliWithoutWrapper(arguments_: readonly string[]) {
  return execFile(
    process.execPath,
    ['--import', 'tsx', 'scripts/identity/cleanup-expired-sessions.ts', ...arguments_],
    { cwd: process.cwd(), env: process.env },
  )
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'session_maintenance',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const owner = await createOwnerWithBootstrapCode({
    name: 'Maintenance Owner',
    email: 'maintenance-owner@example.test',
    password: 'maintenance-owner-password',
    code: bootstrap.code,
  })
  ownerUserId = owner.id

  const actor = {
    userId: ownerUserId,
    name: 'Maintenance Owner',
    email: 'maintenance-owner@example.test',
    role: 'owner' as const,
  }
  const pagingMember = await createLocalUserAsOwner(actor, {
    name: 'Maintenance Paging Member',
    email: 'maintenance-paging@example.test',
    password: 'maintenance-paging-password',
  })
  const sentinelMember = await createLocalUserAsOwner(actor, {
    name: 'Maintenance Sentinel',
    email: 'maintenance-sentinel@example.test',
    password: 'maintenance-sentinel-password',
  })
  pagingMemberUserId = pagingMember.id
  sentinelMemberUserId = sentinelMember.id

  const [sentinelCredential] = await getDb()
    .select({ id: account.id, password: account.password })
    .from(account)
    .where(eq(account.userId, sentinelMemberUserId))
  if (!sentinelCredential) throw new Error('Sentinel credential fixture is missing.')
  sentinelAccountId = sentinelCredential.id
  sentinelAccountPassword = sentinelCredential.password

  await insertSession({
    id: durableSessionId,
    userId: sentinelMemberUserId,
    expiresAt: durableExpiry,
  })
  const now = new Date('2026-07-16T00:00:00.000Z')
  await getDb()
    .insert(verification)
    .values({
      id: durableVerificationId,
      identifier: `indigo:unrelated:${sentinelMemberUserId}`,
      value: 'durable-unrelated-verification',
      expiresAt: durableExpiry,
      createdAt: now,
      updatedAt: now,
    })
})

afterAll(async () => {
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe('expired-session maintenance', () => {
  it('deletes deterministic pages against one fixed cutoff and preserves exact unrelated state', async () => {
    const identitiesBefore = await identitySnapshot()
    const sessionsBefore = await orderedSessionIds()
    expect(sessionsBefore).toEqual([durableSessionId])

    for (const id of equalExpiryIds) {
      await insertSession({ id, userId: pagingMemberUserId, expiresAt: equalExpiry })
    }
    await insertSession({
      id: laterExpiredIds[0],
      userId: pagingMemberUserId,
      expiresAt: secondExpiry,
    })
    await insertSession({
      id: laterExpiredIds[1],
      userId: ownerUserId,
      expiresAt: secondExpiry,
    })
    await insertSession({
      id: laterExpiredIds[2],
      userId: pagingMemberUserId,
      expiresAt: finalExpiry,
    })
    await insertSession({
      id: preexistingPostCutoffId,
      userId: pagingMemberUserId,
      expiresAt: preexistingPostCutoffExpiry,
    })

    const firstPage = await cleanupExpiredSessions({
      batchSize: 3,
      now: fixedCutoff,
    })
    expect(firstPage).toMatchObject({ status: 'continue', deletedCount: 3 })
    if (firstPage.status !== 'continue') {
      throw new Error('The first full maintenance page did not return a cursor.')
    }
    expect(firstPage.nextCursor.length).toBeGreaterThan(300)
    expect(decodeCanonicalCursor(firstPage.nextCursor)).toEqual([
      1,
      fixedCutoff.toISOString(),
      equalExpiry.toISOString().replace(/Z$/, '000Z'),
      equalExpiryIds[2],
    ])
    expect(await orderedSessionIds()).toEqual(
      [durableSessionId, ...laterExpiredIds, preexistingPostCutoffId].toSorted(),
    )

    await insertSession({
      id: insertedPostCutoffId,
      userId: ownerUserId,
      expiresAt: insertedPostCutoffExpiry,
    })

    const secondPage = await cleanupExpiredSessions({
      batchSize: 3,
      cursor: firstPage.nextCursor,
      now: fixedCutoff,
    })
    expect(secondPage).toMatchObject({ status: 'continue', deletedCount: 3 })
    if (secondPage.status !== 'continue') {
      throw new Error('The second full maintenance page did not return a cursor.')
    }
    expect(decodeCanonicalCursor(secondPage.nextCursor)).toEqual([
      1,
      fixedCutoff.toISOString(),
      finalExpiry.toISOString().replace(/Z$/, '000Z'),
      laterExpiredIds[2],
    ])

    const terminalPage = await cleanupExpiredSessions({
      batchSize: 3,
      cursor: secondPage.nextCursor,
      now: fixedCutoff,
    })
    expect(terminalPage).toMatchObject({ status: 'complete', deletedCount: 0 })

    const replay = await cleanupExpiredSessions({
      batchSize: 3,
      cursor: firstPage.nextCursor,
      now: fixedCutoff,
    })
    expect(replay).toMatchObject({ status: 'complete', deletedCount: 0 })

    expect(await orderedSessionIds()).toEqual(
      [durableSessionId, insertedPostCutoffId, preexistingPostCutoffId].toSorted(),
    )
    expect(await identitySnapshot()).toEqual(identitiesBefore)

    const [sentinelCredential] = await getDb()
      .select({ id: account.id, password: account.password })
      .from(account)
      .where(eq(account.id, sentinelAccountId))
    const [sentinelSession] = await getDb()
      .select({ id: session.id, userId: session.userId })
      .from(session)
      .where(eq(session.id, durableSessionId))
    const [sentinelVerification] = await getDb()
      .select({ id: verification.id, value: verification.value })
      .from(verification)
      .where(eq(verification.id, durableVerificationId))
    expect(sentinelCredential).toEqual({
      id: sentinelAccountId,
      password: sentinelAccountPassword,
    })
    expect(sentinelSession).toEqual({
      id: durableSessionId,
      userId: sentinelMemberUserId,
    })
    expect(sentinelVerification).toEqual({
      id: durableVerificationId,
      value: 'durable-unrelated-verification',
    })
  })

  it('pages exact PostgreSQL microseconds without collapsing SQL tuple order', async () => {
    const createdAt = new Date('2026-07-16T00:00:00.000Z')
    await getDb().execute(sql`
      INSERT INTO "session" (
        id,
        token,
        user_id,
        expires_at,
        created_at,
        updated_at
      ) VALUES
        (
          'maintenance/micro/z-earlier',
          'token:maintenance/micro/z-earlier',
          ${pagingMemberUserId},
          '2088-01-04T00:00:00.000100Z'::timestamptz,
          ${createdAt},
          ${createdAt}
        ),
        (
          'maintenance/micro/a-later',
          'token:maintenance/micro/a-later',
          ${pagingMemberUserId},
          '2088-01-04T00:00:00.000200Z'::timestamptz,
          ${createdAt},
          ${createdAt}
        )
    `)

    const page = await cleanupExpiredSessions({ batchSize: 2, now: fixedCutoff })
    expect(page).toMatchObject({ status: 'continue', deletedCount: 2 })
    if (page.status !== 'continue') {
      throw new Error('The exact-microsecond page did not return a cursor.')
    }
    expect(decodeCanonicalCursor(page.nextCursor)).toEqual([
      1,
      fixedCutoff.toISOString(),
      '2088-01-04T00:00:00.000200Z',
      'maintenance/micro/a-later',
    ])
    await expect(
      cleanupExpiredSessions({
        batchSize: 2,
        cursor: page.nextCursor,
        now: fixedCutoff,
      }),
    ).resolves.toMatchObject({ status: 'complete', deletedCount: 0 })
    const remainingSessionIds = await orderedSessionIds()
    expect(remainingSessionIds).not.toContain('maintenance/micro/z-earlier')
    expect(remainingSessionIds).not.toContain('maintenance/micro/a-later')
  })

  it('refuses an unwrapped CLI before DML and emits one exact canonical wrapped result', async () => {
    await insertSession({
      id: cliExpiredSessionId,
      userId: pagingMemberUserId,
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    })
    const sessionsBeforeRefusal = await orderedSessionIds()
    const identitiesBefore = await identitySnapshot()

    let refusal: unknown
    try {
      await runMaintenanceCliWithoutWrapper(['--batch-size', '64'])
    } catch (error) {
      refusal = error
    }
    expect(refusal).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining(
        'This host command must be launched through scripts/run-external-host-command.sh.',
      ),
    })
    expect(await orderedSessionIds()).toEqual(sessionsBeforeRefusal)
    expect(await identitySnapshot()).toEqual(identitiesBefore)

    const invalidCursor = 'invalid-private-maintenance-cursor'
    let invalidCursorFailure: unknown
    try {
      await runMaintenanceCli(['--batch-size', '64', '--cursor', invalidCursor])
    } catch (error) {
      invalidCursorFailure = error
    }
    expect(invalidCursorFailure).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('expired-session-maintenance.invalid-cursor'),
    })
    expect((invalidCursorFailure as { stderr: string }).stderr).not.toContain(
      invalidCursor,
    )
    expect(await orderedSessionIds()).toEqual(sessionsBeforeRefusal)
    expect(await identitySnapshot()).toEqual(identitiesBefore)

    const wrapped = await runMaintenanceCli(['--batch-size', '64'])
    expect(wrapped).toEqual({
      stdout: '{"status":"complete","deletedCount":1,"nextCursor":null}\n',
      stderr: '',
    })
    expect(await orderedSessionIds()).toEqual(
      [durableSessionId, insertedPostCutoffId, preexistingPostCutoffId].toSorted(),
    )
    expect(await identitySnapshot()).toEqual(identitiesBefore)
  })
})
