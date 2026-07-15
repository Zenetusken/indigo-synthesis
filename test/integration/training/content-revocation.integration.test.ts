import { count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
import { createDataExport } from '@/modules/data-portability/application/export'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import {
  programRevisionContentIsRevoked,
  revokeContentRelease,
} from '@/modules/programs/application/content-revocations'
import { activateProgram } from '@/modules/programs/application/programs'
import { explainFutureLoadDecision } from '@/modules/training/application/future-load-explanation'
import {
  completeSet,
  completeWorkout,
  getCompletedSessions,
  getSessionAdjustments,
  getTodayState,
  getWorkoutSession,
  setSessionPaused,
  skipSet,
  startWorkout,
} from '@/modules/training/application/workouts'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import {
  adjustmentDecisions,
  contentReleaseRevocations,
  programs,
  workoutSessions,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  resetProductData,
  seedCoherentProgram,
  TEST_NOW,
  TEST_TARGET_LOAD_GRAMS,
  TEST_TARGET_REPETITIONS,
} from './harness'

let integrationDatabase: DisposableIntegrationDatabase | undefined
let ownerActor: AuthenticatedActor

async function revokeFixtureMethodology(
  contentVersion = '0.0.1-development',
): Promise<string> {
  return revokeContentRelease({
    actor: ownerActor,
    contentKind: 'methodology',
    contentId: 'development.methodology-fixture',
    contentVersion,
    reason: `Revoked ${contentVersion} during integration coverage.`,
  })
}

async function startedSession() {
  const seeded = await seedCoherentProgram(ownerActor.userId)
  const sessionId = await startWorkout(
    ownerActor.userId,
    seeded.currentWorkoutId,
    newUuidV7(),
    TEST_NOW,
  )
  const session = await getWorkoutSession(ownerActor.userId, sessionId)
  const setId = session?.exercises[0]?.sets[0]?.id
  if (!session || !setId) throw new Error('Revocation fixture session has no set.')
  return { seeded, sessionId, setId }
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'content_revocation',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const owner = await createOwnerWithBootstrapCode({
    name: 'Content Revocation Owner',
    email: 'content-revocation-owner@example.test',
    password: 'content-revocation-owner-password',
    code: bootstrap.code,
  })
  ownerActor = {
    userId: owner.id,
    name: owner.name,
    email: owner.email,
    role: 'owner',
  }
})

beforeEach(async () => {
  await resetProductData()
})

afterAll(async () => {
  resetAuthForTests()
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe('runtime content revocation', () => {
  it('blocks activation only for the exact revoked release version', async () => {
    const adjacent = await seedCoherentProgram(ownerActor.userId, { status: 'draft' })
    await revokeFixtureMethodology('0.0.2-development')

    await expect(
      activateProgram(ownerActor.userId, adjacent.revisionId),
    ).resolves.toBeUndefined()

    await resetProductData()
    const exact = await seedCoherentProgram(ownerActor.userId, { status: 'draft' })
    await revokeFixtureMethodology()

    await expect(
      activateProgram(ownerActor.userId, exact.revisionId),
    ).rejects.toMatchObject({ code: 'content.revoked' })

    const [program] = await getDb()
      .select({ status: programs.status })
      .from(programs)
      .where(eq(programs.id, exact.programId))
    expect(program?.status).toBe('draft')
  })

  it('rejects duplicate revocation with a typed domain error', async () => {
    await revokeFixtureMethodology()

    await expect(revokeFixtureMethodology()).rejects.toMatchObject({
      name: 'ContentRevocationError',
      code: 'content-revocation.already-revoked',
    })
  })

  it('fails closed when evaluating revocation for an unknown revision', async () => {
    await expect(
      getDb().transaction((transaction) =>
        programRevisionContentIsRevoked(transaction, newUuidV7()),
      ),
    ).rejects.toMatchObject({
      name: 'ContentRevocationError',
      code: 'content-revocation.revision-missing',
    })
  })

  it('keeps revocations unique and append-only in PostgreSQL', async () => {
    const revocationId = await revokeFixtureMethodology()

    // Database-level uniqueness backstop, bypassing the application guard.
    const [existing] = await getDb()
      .select()
      .from(contentReleaseRevocations)
      .where(eq(contentReleaseRevocations.id, revocationId))
    if (!existing) throw new Error('Seeded revocation row is missing.')
    await expect(
      getDb()
        .insert(contentReleaseRevocations)
        .values({ ...existing, id: newUuidV7() }),
    ).rejects.toMatchObject({ cause: { code: '23505' } })

    await expect(
      getDb()
        .update(contentReleaseRevocations)
        .set({ reason: 'Changed after the fact.' })
        .where(eq(contentReleaseRevocations.id, revocationId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    await expect(
      getDb()
        .delete(contentReleaseRevocations)
        .where(eq(contentReleaseRevocations.id, revocationId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
  })

  it('permits only the actor-unlink update, and only inside a deletion mode', async () => {
    const revocationId = await revokeFixtureMethodology()

    // Actor unlink outside any sanctioned deletion mode stays rejected.
    await expect(
      getDb()
        .update(contentReleaseRevocations)
        .set({ actorUserId: null })
        .where(eq(contentReleaseRevocations.id, revocationId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })

    // A fact-column change stays rejected even inside a deletion mode.
    await expect(
      getDb().transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL indigo.deletion_mode = 'instance-reset'`)
        await transaction
          .update(contentReleaseRevocations)
          .set({ reason: 'Rewritten during reset.' })
          .where(eq(contentReleaseRevocations.id, revocationId))
      }),
    ).rejects.toMatchObject({ cause: { code: '55000' } })

    // The exact FK ON DELETE SET NULL transition is permitted in-mode.
    await getDb().transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL indigo.deletion_mode = 'trainee-data'`)
      await transaction
        .update(contentReleaseRevocations)
        .set({ actorUserId: null })
        .where(eq(contentReleaseRevocations.id, revocationId))
    })
    const [unlinked] = await getDb()
      .select({ actorUserId: contentReleaseRevocations.actorUserId })
      .from(contentReleaseRevocations)
      .where(eq(contentReleaseRevocations.id, revocationId))
    expect(unlinked?.actorUserId).toBeNull()
  })

  it('blocks start, resume, set completion, and set skip after revocation', async () => {
    const blockedStart = await seedCoherentProgram(ownerActor.userId)
    await revokeFixtureMethodology()

    const planned = await getTodayState(ownerActor.userId, 'UTC', TEST_NOW)
    expect(planned).toMatchObject({
      kind: 'planned',
      contentEligibility: { eligible: false, code: 'content.revoked' },
    })

    await expect(
      startWorkout(
        ownerActor.userId,
        blockedStart.currentWorkoutId,
        newUuidV7(),
        TEST_NOW,
      ),
    ).rejects.toMatchObject({ code: 'content.revoked' })

    await resetProductData()
    const { sessionId, setId } = await startedSession()
    await revokeFixtureMethodology()

    const today = await getTodayState(ownerActor.userId, 'UTC', TEST_NOW)
    expect(today).toMatchObject({
      kind: 'active',
      contentEligibility: { eligible: false, code: 'content.revoked' },
    })
    await expect(
      completeSet({
        userId: ownerActor.userId,
        sessionId,
        setId,
        commandId: newUuidV7(),
        actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
        actualRepetitions: TEST_TARGET_REPETITIONS,
        rpe: 8,
        note: null,
      }),
    ).rejects.toMatchObject({ code: 'content.revoked' })
    await expect(
      skipSet({
        userId: ownerActor.userId,
        sessionId,
        setId,
        commandId: newUuidV7(),
        reason: 'Blocked by revoked content.',
      }),
    ).rejects.toMatchObject({ code: 'content.revoked' })

    await setSessionPaused(ownerActor.userId, sessionId, true)
    await expect(
      setSessionPaused(ownerActor.userId, sessionId, false),
    ).rejects.toMatchObject({ code: 'content.revoked' })

    const session = await getWorkoutSession(ownerActor.userId, sessionId)
    expect(session?.contentEligibility).toEqual({
      eligible: false,
      code: 'content.revoked',
    })
  })

  it('blocks workout completion and adjustment creation after revocation', async () => {
    const { sessionId, setId } = await startedSession()
    await completeSet({
      userId: ownerActor.userId,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 8,
      note: null,
    })
    await revokeFixtureMethodology()

    await expect(
      completeWorkout({
        userId: ownerActor.userId,
        sessionId,
        commandId: newUuidV7(),
        noPainAttested: true,
      }),
    ).rejects.toMatchObject({ code: 'content.revoked' })

    const [decisionCount] = await getDb()
      .select({ value: count() })
      .from(adjustmentDecisions)
    const [session] = await getDb()
      .select({ status: workoutSessions.status })
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))
    expect(decisionCount?.value).toBe(0)
    expect(session?.status).toBe('active')
  })

  it('keeps revoked completed workouts visible in History and export', async () => {
    const { sessionId, setId } = await startedSession()
    await completeSet({
      userId: ownerActor.userId,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 8,
      note: null,
    })
    await completeWorkout({
      userId: ownerActor.userId,
      sessionId,
      commandId: newUuidV7(),
      noPainAttested: true,
    })
    const revocationId = await revokeFixtureMethodology()

    const completed = await getCompletedSessions(ownerActor.userId)
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      id: sessionId,
      contentEligibility: { eligible: false, code: 'content.revoked' },
    })

    const adjustments = await getSessionAdjustments(ownerActor.userId, sessionId)
    expect(adjustments?.length).toBeGreaterThan(0)
    const decisionId = adjustments?.[0]?.id
    if (!decisionId) throw new Error('Completed revoked fixture has no decision.')
    await expect(
      explainFutureLoadDecision({
        userId: ownerActor.userId,
        sessionId,
        decisionId,
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'content-ineligible',
    })

    const archive = await createDataExport(ownerActor)
    expect(archive.identity.id).toBe(ownerActor.userId)
    expect(archive.contentReleaseRevocations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: revocationId })]),
    )
    expect(archive.programs[0]?.revisions[0]?.contentStatus).toMatchObject({
      eligibility: { eligible: false, code: 'content.revoked' },
      revocations: [expect.objectContaining({ id: revocationId })],
    })
    expect(archive.sessions[0]?.prescriptionProvenance).toMatchObject({
      available: true,
      contentStatus: {
        eligibility: { eligible: false, code: 'content.revoked' },
        revocations: [expect.objectContaining({ id: revocationId })],
      },
    })
  })

  it('allows full instance reset to remove revocations under deletion mode only', async () => {
    const revocationId = await revokeFixtureMethodology()

    await getDb().transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL indigo.deletion_mode = 'instance-reset'`)
      await transaction
        .delete(contentReleaseRevocations)
        .where(eq(contentReleaseRevocations.id, revocationId))
    })

    const [remaining] = await getDb()
      .select({ value: count() })
      .from(contentReleaseRevocations)
    expect(remaining?.value).toBe(0)
  })
})
