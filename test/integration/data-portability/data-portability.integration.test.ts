import { count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { saveAthleteProfile } from '@/modules/athletes/application/profile'
import {
  createInstanceResetPlan,
  createSubjectDeletionPlan,
  type DeletionError,
  executeInstanceReset,
  executeSubjectDeletion,
} from '@/modules/data-portability/application/deletion'
import { createDataExport } from '@/modules/data-portability/application/export'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/modules/identity/bootstrap/owner-bootstrap'
import { getAuth, resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { canonicalSha256 } from '@/modules/methodology/domain/canonical'
import { generateDraftProgram } from '@/modules/programs/application/programs'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import {
  adjustmentDecisions,
  athleteEquipment,
  athleteProfiles,
  athleteTrainingDays,
  auditEvents,
  deletionTombstones,
  exercisePrescriptions,
  installationState,
  performedSets,
  plannedWorkouts,
  programRevisions,
  programs,
  safetyHolds,
  sessionExercises,
  sessionFeedback,
  setPrescriptions,
  strengthBaselines,
  trainingCommandReceipts,
  user,
  verification,
  workoutSessions,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

const ownerPassword = 'portability-owner-password'
const otherUserPassword = 'portability-member-password'
const recoveryDigest = 'stored-recovery-digest-do-not-export'
const programId = newUuidV7()
const firstRevisionId = newUuidV7()
const secondRevisionId = newUuidV7()
const abandonedWorkoutId = newUuidV7()
const activeWorkoutId = newUuidV7()
const completedWorkoutId = newUuidV7()
const abandonedSessionId = newUuidV7()
const activeSessionId = newUuidV7()
const completedSessionId = newUuidV7()

let integrationDatabase: DisposableIntegrationDatabase | undefined
let actor: AuthenticatedActor
let otherUser: { readonly id: string; readonly email: string }
let bootstrapToken: string

async function authRequest(path: string, body: Record<string, unknown>) {
  const origin = getServerConfig().appOrigin
  return getAuth().handler(
    new Request(`${origin}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    }),
  )
}

async function seedOwnedProductHistory(userId: string): Promise<void> {
  const now = new Date('2026-07-11T12:00:00.000Z')
  await getDb().transaction(async (transaction) => {
    await transaction.insert(athleteProfiles).values({
      userId,
      units: 'metric',
      timezone: 'America/Toronto',
      goal: 'general-strength',
      experience: 'experienced',
      sessionMinutes: 60,
      adultAttested: true,
      techniqueAttested: true,
      restrictionStatus: 'none',
      limitations: null,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    await transaction.insert(athleteTrainingDays).values({
      userId,
      weekday: 1,
      ordinal: 1,
    })
    await transaction.insert(athleteEquipment).values({
      userId,
      equipmentCode: 'barbell',
    })
    await transaction.insert(strengthBaselines).values({
      id: newUuidV7(),
      userId,
      exerciseCode: 'development.back-squat',
      loadGrams: 60_000,
      repetitions: 5,
      protocol: 'trainee-selected-starting-load',
      testedOn: '2026-07-10',
      provenance: 'user-attested',
      createdAt: now,
    })
    await transaction.insert(safetyHolds).values({
      id: newUuidV7(),
      userId,
      reasonCode: 'historical-test-hold',
      details: 'Cleared historical hold for export coverage.',
      createdAt: now,
      clearedAt: new Date('2026-07-11T12:05:00.000Z'),
    })

    await transaction.insert(programs).values({
      id: programId,
      userId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    await transaction.insert(programRevisions).values([
      {
        id: firstRevisionId,
        programId,
        revisionNumber: 1,
        status: 'draft',
        engineVersion: 'engine-v1',
        methodologyId: 'method-v1',
        methodologyVersion: '1.0.0',
        methodologyReviewStatus: 'development',
        templateId: 'template-v1',
        templateVersion: '1.0.0',
        templateReviewStatus: 'development',
        normalizedInputHash: 'input-hash-v1',
        outputHash: 'output-hash-v1',
        normalizedInput: { revision: 1 },
        outputSnapshot: { revision: 1 },
        warnings: [{ code: 'development', summary: 'Development content.' }],
        manualReviewRequired: true,
        createdAt: now,
      },
      {
        id: secondRevisionId,
        programId,
        revisionNumber: 2,
        status: 'draft',
        engineVersion: 'engine-v1',
        methodologyId: 'method-v1',
        methodologyVersion: '1.0.0',
        methodologyReviewStatus: 'development',
        templateId: 'template-v1',
        templateVersion: '1.0.0',
        templateReviewStatus: 'development',
        normalizedInputHash: 'input-hash-v2',
        outputHash: 'output-hash-v2',
        normalizedInput: { revision: 2 },
        outputSnapshot: { revision: 2 },
        warnings: [],
        manualReviewRequired: false,
        createdAt: new Date('2026-07-11T12:10:00.000Z'),
      },
    ])
    await transaction.insert(plannedWorkouts).values([
      {
        id: abandonedWorkoutId,
        revisionId: firstRevisionId,
        scheduledDate: '2026-07-09',
        ordinal: 1,
        programOrdinal: 1,
        slotCode: 'A',
        name: 'Superseded prescription session',
      },
      {
        id: activeWorkoutId,
        revisionId: secondRevisionId,
        scheduledDate: '2026-07-11',
        ordinal: 1,
        programOrdinal: 1,
        slotCode: 'A',
        name: 'Active prescription session',
      },
      {
        id: completedWorkoutId,
        revisionId: secondRevisionId,
        scheduledDate: '2026-07-12',
        ordinal: 2,
        programOrdinal: 2,
        slotCode: 'B',
        name: 'Completed prescription session',
      },
    ])

    const prescriptionFixtures = [
      { workoutId: abandonedWorkoutId, suffix: 'abandoned' },
      { workoutId: activeWorkoutId, suffix: 'active' },
      { workoutId: completedWorkoutId, suffix: 'completed' },
    ].map((fixture) => ({ ...fixture, exerciseId: newUuidV7(), setId: newUuidV7() }))
    await transaction.insert(exercisePrescriptions).values(
      prescriptionFixtures.map((fixture) => ({
        id: fixture.exerciseId,
        plannedWorkoutId: fixture.workoutId,
        exerciseCode: 'development.back-squat',
        exerciseName: `Back squat ${fixture.suffix}`,
        ordinal: 1,
        safetyTier: 'standard',
        rationaleCode: 'development.fixture-instantiation',
      })),
    )
    await transaction.insert(setPrescriptions).values(
      prescriptionFixtures.map((fixture) => ({
        id: fixture.setId,
        exercisePrescriptionId: fixture.exerciseId,
        ordinal: 1,
        setKind: 'working',
        targetLoadGrams: 60_000,
        targetRepetitions: 5,
        restSeconds: 180,
      })),
    )
    await transaction
      .update(programRevisions)
      .set({ status: 'superseded', activatedAt: now })
      .where(eq(programRevisions.id, firstRevisionId))
    await transaction
      .update(programRevisions)
      .set({
        status: 'active',
        activatedAt: new Date('2026-07-11T12:10:00.000Z'),
      })
      .where(eq(programRevisions.id, secondRevisionId))

    const sessionFixtures = [
      {
        sessionId: abandonedSessionId,
        workoutId: abandonedWorkoutId,
        workoutName: 'Superseded prescription session',
        scheduledDate: '2026-07-09',
        slotCode: 'A',
        startedAt: new Date('2026-07-09T12:00:00.000Z'),
        suffix: 'abandoned',
        status: 'skipped' as const,
      },
      {
        sessionId: activeSessionId,
        workoutId: activeWorkoutId,
        workoutName: 'Active prescription session',
        scheduledDate: '2026-07-11',
        slotCode: 'A',
        startedAt: new Date('2026-07-11T12:00:00.000Z'),
        suffix: 'active',
        status: 'pending' as const,
      },
      {
        sessionId: completedSessionId,
        workoutId: completedWorkoutId,
        workoutName: 'Completed prescription session',
        scheduledDate: '2026-07-12',
        slotCode: 'B',
        startedAt: new Date('2026-07-10T12:00:00.000Z'),
        suffix: 'completed',
        status: 'performed' as const,
      },
    ].map((fixture) => ({ ...fixture, exerciseId: newUuidV7(), setId: newUuidV7() }))

    // Seed terminal facts through legal lifecycle transitions. At most one active
    // session exists at a time, and all child facts are written before terminal state.
    for (const fixture of [sessionFixtures[0], sessionFixtures[2], sessionFixtures[1]]) {
      if (!fixture) throw new Error('Missing portability session fixture.')
      await transaction.insert(workoutSessions).values({
        id: fixture.sessionId,
        userId,
        plannedWorkoutId: fixture.workoutId,
        plannedWorkoutName: fixture.workoutName,
        scheduledDate: fixture.scheduledDate,
        slotCode: fixture.slotCode,
        status: 'active',
        startedAt: fixture.startedAt,
        optimisticVersion: 1,
        startCommandId: `start-${fixture.suffix}`,
      })
      await transaction.insert(sessionExercises).values({
        id: fixture.exerciseId,
        sessionId: fixture.sessionId,
        exerciseCode: 'development.back-squat',
        exerciseName: `Back squat ${fixture.suffix}`,
        ordinal: 1,
        safetyTier: 'standard',
        rationaleCode: 'development.fixture-instantiation',
        originalExerciseCode: 'development.back-squat',
        substitutionReason: null,
      })
      await transaction.insert(performedSets).values({
        id: fixture.setId,
        sessionExerciseId: fixture.exerciseId,
        ordinal: 1,
        status: fixture.status,
        targetLoadGrams: 60_000,
        targetRepetitions: 5,
        restSeconds: 180,
        actualLoadGrams: fixture.status === 'performed' ? 62_500 : null,
        actualRepetitions: fixture.status === 'performed' ? 5 : null,
        rpe: fixture.status === 'performed' ? 8 : null,
        loadProvenance: fixture.status === 'performed' ? 'edited' : null,
        repetitionsProvenance: fixture.status === 'performed' ? 'copied-target' : null,
        explicitlyConfirmed: fixture.status === 'performed',
        confirmedAt:
          fixture.status === 'performed' ? new Date('2026-07-10T12:20:00.000Z') : null,
        skippedAt:
          fixture.status === 'skipped' ? new Date('2026-07-09T12:05:00.000Z') : null,
        skipReason: fixture.status === 'skipped' ? 'Session ended early.' : null,
        note: fixture.status === 'performed' ? 'Felt controlled.' : null,
        commandId: fixture.status === 'pending' ? null : `set-${fixture.suffix}`,
      })

      if (fixture.suffix === 'completed') {
        await transaction.insert(sessionFeedback).values({
          sessionId: fixture.sessionId,
          painReported: false,
          details: null,
          answeredAt: new Date('2026-07-10T12:30:00.000Z'),
        })
        await transaction.insert(adjustmentDecisions).values({
          id: newUuidV7(),
          sessionId: fixture.sessionId,
          appliedRevisionId: secondRevisionId,
          exerciseCode: 'development.back-squat',
          decision: 'increase',
          currentLoadGrams: 60_000,
          nextLoadGrams: 62_500,
          reasonCode: 'all-sets-within-rpe-bound',
          ruleVersion: 'development-adjustment-v1',
        })
        await transaction
          .update(workoutSessions)
          .set({
            status: 'completed',
            completedAt: new Date('2026-07-10T12:30:00.000Z'),
            completionCommandId: 'complete-completed',
            optimisticVersion: 2,
          })
          .where(eq(workoutSessions.id, fixture.sessionId))
      } else if (fixture.suffix === 'abandoned') {
        await transaction
          .update(workoutSessions)
          .set({
            status: 'abandoned',
            abandonedAt: new Date('2026-07-09T12:10:00.000Z'),
            optimisticVersion: 2,
          })
          .where(eq(workoutSessions.id, fixture.sessionId))
      }
    }
    await transaction.insert(trainingCommandReceipts).values({
      commandId: 'complete-completed',
      userId,
      commandType: 'complete-workout',
      sessionId: completedSessionId,
      targetId: completedSessionId,
      requestHash: 'canonical-completion-request-hash',
      resultSnapshot: { status: 'succeeded' },
      createdAt: new Date('2026-07-10T12:30:00.000Z'),
    })
    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: userId,
      subjectUserId: userId,
      eventType: 'test-history-created',
      entityType: 'workout-session',
      entityId: completedSessionId,
      metadata: { provenance: 'integration-fixture' },
      createdAt: now,
    })
    await transaction.insert(verification).values({
      id: newUuidV7(),
      identifier: `indigo:owner-recovery:${userId}`,
      value: recoveryDigest,
      expiresAt: new Date('2026-07-12T12:00:00.000Z'),
    })
  })
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'data_portability',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const createdOwner = await createOwnerWithBootstrapCode({
    name: 'Portability Owner',
    email: 'portability-owner@example.test',
    password: ownerPassword,
    code: bootstrap.code,
  })
  actor = { ...createdOwner, userId: createdOwner.id, role: 'owner' }
  const signIn = await authRequest('/sign-in/email', {
    email: actor.email,
    password: ownerPassword,
  })
  const signInBody = (await signIn.json()) as { token?: string }
  if (!signIn.ok || !signInBody.token) {
    throw new Error('Could not create the portability test session.')
  }
  bootstrapToken = signInBody.token
  otherUser = await createLocalUserAsOwner(actor, {
    name: 'Other Local User',
    email: 'other-portability-user@example.test',
    password: otherUserPassword,
  })
  await seedOwnedProductHistory(actor.userId)
})

afterAll(async () => {
  resetAuthForTests()
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe('subject export and exact instance reset', () => {
  it('exports every owned revision and session state with interpretable provenance', async () => {
    const archive = await createDataExport(actor)
    const revisions = archive.programs.flatMap((program) => program.revisions)
    const statuses = archive.sessions.map((session) => session.status).sort()

    expect(revisions.map((revision) => revision.id)).toEqual([
      firstRevisionId,
      secondRevisionId,
    ])
    expect(statuses).toEqual(['abandoned', 'active', 'completed'])
    const completed = archive.sessions.find(
      (session) => session.id === completedSessionId,
    )
    expect(completed?.prescriptionProvenance).toMatchObject({
      available: true,
      revisionId: secondRevisionId,
      normalizedInputHash: 'input-hash-v2',
      outputHash: 'output-hash-v2',
    })
    expect(completed?.exercises[0]?.sets[0]).toMatchObject({
      status: 'performed',
      loadProvenance: 'edited',
      repetitionsProvenance: 'copied-target',
      explicitlyConfirmed: true,
    })
    expect(completed?.adjustments[0]).toMatchObject({
      appliedRevisionId: secondRevisionId,
      ruleVersion: 'development-adjustment-v1',
      reasonCode: 'all-sets-within-rpe-bound',
    })
    expect(completed?.commandReceipts).toEqual([
      expect.objectContaining({
        commandId: 'complete-completed',
        commandType: 'complete-workout',
        requestHash: 'canonical-completion-request-hash',
      }),
    ])
    expect(archive.profile.safetyHolds).toHaveLength(1)
    expect(Object.keys(archive.manifest.hashes).sort()).toEqual(
      ['auditEvents', 'identity', 'profile', 'programs', 'provenance', 'sessions'].sort(),
    )
    expect(archive.manifest.hashes.programs).toBe(
      canonicalSha256(JSON.parse(JSON.stringify(archive.programs))),
    )
    expect(archive.manifest.hashes.sessions).toBe(
      canonicalSha256(JSON.parse(JSON.stringify(archive.sessions))),
    )
    expect(archive.manifest.omissions.map((entry) => entry.category)).toEqual(
      expect.arrayContaining([
        'authentication-material',
        'other-local-users',
        'methodology-and-template-source-material',
        'administrative-workflow-state',
      ]),
    )

    const serialized = JSON.stringify(archive)
    expect(serialized).not.toContain(ownerPassword)
    expect(serialized).not.toContain(otherUserPassword)
    expect(serialized).not.toContain(bootstrapToken)
    expect(serialized).not.toContain(recoveryDigest)
    expect(serialized).not.toContain(otherUser.id)
    expect(serialized).not.toContain(otherUser.email)

    await getDb()
      .update(workoutSessions)
      .set({
        status: 'paused',
        pausedAt: new Date('2026-07-11T12:15:00.000Z'),
      })
      .where(eq(workoutSessions.id, activeSessionId))
    const pausedArchive = await createDataExport(actor)
    expect(
      pausedArchive.sessions.find((session) => session.id === activeSessionId),
    ).toMatchObject({ status: 'paused' })
  })

  it('deletes one member subject while retaining owner data and redacting foreign audit identity', async () => {
    const memberActor: AuthenticatedActor = {
      userId: otherUser.id,
      name: 'Other Local User',
      email: otherUser.email,
      role: 'member',
    }
    await saveAthleteProfile(memberActor.userId, {
      units: 'metric',
      timezone: 'UTC',
      experience: 'familiar',
      sessionMinutes: 60,
      adultAttested: true,
      techniqueAttested: true,
      restrictionStatus: 'none',
      limitations: null,
      weekdays: [1, 3, 5],
      equipment: ['barbell', 'rack', 'bench', 'plates'],
      startingLoads: {
        'development.back-squat': 60_000,
        'development.bench-press': 60_000,
        'development.barbell-row': 60_000,
        'development.deadlift': 60_000,
        'development.overhead-press': 60_000,
      },
    })
    await generateDraftProgram(memberActor.userId, '2026-07-11')
    const foreignAuditId = newUuidV7()
    await getDb().insert(auditEvents).values({
      id: foreignAuditId,
      actorUserId: memberActor.userId,
      subjectUserId: actor.userId,
      eventType: 'member-admin-test-event',
      entityType: 'integration-fixture',
      entityId: null,
      metadata: {},
    })

    const plan = await createSubjectDeletionPlan(memberActor)
    expect(plan.counts).toMatchObject({
      users: 1,
      authAccounts: 1,
      athleteProfiles: 1,
      programs: 1,
      programRevisions: 1,
      plannedWorkouts: 6,
      auditActorReferencesRedacted: 1,
      deletionPlans: 1,
    })
    await executeSubjectDeletion({
      actor: memberActor,
      planId: plan.id,
      planDigest: plan.digest,
      password: otherUserPassword,
      typedConfirmation: 'DELETE',
      acknowledged: true,
    })

    const [deletedMember] = await getDb()
      .select()
      .from(user)
      .where(eq(user.id, memberActor.userId))
    const [retainedOwner] = await getDb()
      .select()
      .from(user)
      .where(eq(user.id, actor.userId))
    const [retainedOwnerProgram] = await getDb()
      .select()
      .from(programs)
      .where(eq(programs.userId, actor.userId))
    const [redactedAudit] = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, foreignAuditId))
    const [tombstone] = await getDb()
      .select()
      .from(deletionTombstones)
      .where(eq(deletionTombstones.scope, 'trainee-data'))

    expect(deletedMember).toBeUndefined()
    expect(retainedOwner?.id).toBe(actor.userId)
    expect(retainedOwnerProgram?.id).toBe(programId)
    expect(redactedAudit).toMatchObject({
      id: foreignAuditId,
      actorUserId: null,
      subjectUserId: actor.userId,
    })
    expect(tombstone).toMatchObject({
      actorClass: 'trainee',
      scope: 'trainee-data',
      rowCounts: plan.counts,
    })
    const serialized = JSON.stringify(tombstone)
    expect(serialized).not.toContain(memberActor.userId)
    expect(serialized).not.toContain(memberActor.email)
  })

  it('binds every affected live-table count into the plan and leaves only a tombstone', async () => {
    const stalePlan = await createInstanceResetPlan(actor)
    expect(Object.keys(stalePlan.counts)).toHaveLength(24)
    expect(stalePlan.counts).toMatchObject({
      installationStates: 1,
      users: 1,
      authAccounts: 1,
      authVerifications: 1,
      athleteProfiles: 1,
      athleteTrainingDays: 1,
      athleteEquipment: 1,
      strengthBaselines: 1,
      safetyHolds: 1,
      programs: 1,
      programRevisions: 2,
      plannedWorkouts: 3,
      exercisePrescriptions: 3,
      setPrescriptions: 3,
      workoutSessions: 3,
      sessionExercises: 3,
      performedSets: 3,
      programRevisionLineage: 0,
      trainingCommandReceipts: 1,
      sessionFeedback: 1,
      adjustmentDecisions: 1,
      auditEvents: 4,
      deletionPlans: 1,
    })

    await getDb()
      .insert(verification)
      .values({
        id: newUuidV7(),
        identifier: `indigo:owner-recovery:${actor.userId}:new`,
        value: 'post-preview-secret',
        expiresAt: new Date('2026-07-12T12:00:00.000Z'),
      })
    await expect(
      executeInstanceReset({
        actor,
        planId: stalePlan.id,
        planDigest: stalePlan.digest,
        password: ownerPassword,
        typedConfirmation: 'RESET',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({
      code: 'deletion.plan-changed',
    } satisfies Partial<DeletionError>)

    const plan = await createInstanceResetPlan(actor)
    expect(plan.counts.authVerifications).toBe(2)
    expect(plan.counts.deletionPlans).toBe(1)
    await expect(
      executeInstanceReset({
        actor,
        planId: plan.id,
        planDigest: plan.digest,
        password: 'incorrect-password',
        typedConfirmation: 'RESET',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({
      code: 'deletion.reauthentication-failed',
    } satisfies Partial<DeletionError>)

    await executeInstanceReset({
      actor,
      planId: plan.id,
      planDigest: plan.digest,
      password: ownerPassword,
      typedConfirmation: 'RESET',
      acknowledged: true,
    })

    const remaining = await getDb().execute<{ liveRows: number }>(sql`
      SELECT (
        (SELECT count(*) FROM "user") +
        (SELECT count(*) FROM "session") +
        (SELECT count(*) FROM account) +
        (SELECT count(*) FROM verification) +
        (SELECT count(*) FROM athlete_profile) +
        (SELECT count(*) FROM athlete_training_day) +
        (SELECT count(*) FROM athlete_equipment) +
        (SELECT count(*) FROM strength_baseline) +
        (SELECT count(*) FROM safety_hold) +
        (SELECT count(*) FROM program) +
        (SELECT count(*) FROM program_revision) +
        (SELECT count(*) FROM planned_workout) +
        (SELECT count(*) FROM exercise_prescription) +
        (SELECT count(*) FROM set_prescription) +
        (SELECT count(*) FROM workout_session) +
        (SELECT count(*) FROM session_exercise) +
        (SELECT count(*) FROM performed_set) +
        (SELECT count(*) FROM session_feedback) +
        (SELECT count(*) FROM adjustment_decision) +
        (SELECT count(*) FROM audit_event) +
        (SELECT count(*) FROM deletion_plan)
      )::int AS "liveRows"
    `)
    expect(remaining.rows[0]?.liveRows).toBe(0)

    const [installation] = await getDb().select().from(installationState)
    const [tombstone] = await getDb()
      .select()
      .from(deletionTombstones)
      .where(eq(deletionTombstones.scope, 'instance-reset'))
    expect(installation).toMatchObject({ ownerUserId: null, bootstrapClosedAt: null })
    expect(tombstone).toMatchObject({
      actorClass: 'owner',
      scope: 'instance-reset',
      rowCounts: plan.counts,
    })
    expect(tombstone?.completionDigest).toBe(
      canonicalSha256({
        eventId: tombstone.id,
        scope: 'instance-reset',
        schemaVersion: tombstone.schemaVersion,
        completedAt: tombstone.createdAt.toISOString(),
        counts: plan.counts,
      }),
    )
    const serializedTombstone = JSON.stringify(tombstone)
    expect(serializedTombstone).not.toContain(actor.userId)
    expect(serializedTombstone).not.toContain(actor.email)
    expect(serializedTombstone).not.toContain(recoveryDigest)
    expect(serializedTombstone).not.toContain('Back squat')

    const [userCount] = await getDb().select({ value: count() }).from(user)
    expect(userCount?.value).toBe(0)
  })
})
