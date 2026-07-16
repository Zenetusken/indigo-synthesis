import { and, count, eq, isNull, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
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
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { createScopedIdentityMutationGateway } from '@/modules/identity/infrastructure/scoped-mutation-auth'
import { canonicalSha256 } from '@/modules/methodology/domain/canonical'
import { revokeContentRelease } from '@/modules/programs/application/content-revocations'
import { generateDraftProgram } from '@/modules/programs/application/programs'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb, getPool } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import { assertDatabaseReady } from '@/platform/db/preflight'
import {
  adjustmentDecisionInvalidations,
  adjustmentDecisions,
  athleteEquipment,
  athleteProfiles,
  athleteTrainingDays,
  auditEvents,
  contentReleaseRevocations,
  deletionTombstones,
  exercisePrescriptions,
  futureLoadExplanationCache,
  installationState,
  memberResetStates,
  performedSetCorrections,
  performedSets,
  plannedWorkouts,
  programRevisionInvalidations,
  programRevisionLineage,
  programRevisions,
  programs,
  safetyHoldResolutions,
  safetyHolds,
  sessionExercises,
  sessionFeedback,
  setPrescriptions,
  strengthBaselines,
  trainingCommandReceipts,
  trainingFactCorrections,
  user,
  verification,
  webRecoveryRateLimitBuckets,
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
const resolvedHoldId = newUuidV7()
const resolvedHoldResolutionId = newUuidV7()
const completedDecisionId = newUuidV7()
const cachedExplanationId = newUuidV7()
const cachedExplanationCreatedAt = new Date('2026-07-10T12:31:00.000Z')
const cachedExplanation = {
  prose:
    'The next load increases from 60 kg to 62.5 kg because all completed work remained within the development RPE boundary.',
  modelId: 'unsloth/Qwen3.5-9B-GGUF@3885219#Qwen3.5-9B-Q4_K_M.gguf',
  modelContentDigest: 'a'.repeat(64),
  servedModelName: 'indigo-qwen3.5-9b-q4-k-m',
  runtimeId: 'llama.cpp@99f3dc3:pid:123:start:456',
  runtimeAttestationDigest: 'b'.repeat(64),
  promptVersion: 'future-load.v3',
  validatorVersion: 'future-load.v3',
  factBundleHash: 'c'.repeat(64),
  generateDurationMs: 842,
} as const

let integrationDatabase: DisposableIntegrationDatabase | undefined
let actor: AuthenticatedActor
let otherUser: { readonly id: string; readonly email: string }
let bootstrapToken: string

async function authRequest(path: string, body: Record<string, unknown>) {
  const origin = getServerConfig().appOrigin
  return createScopedIdentityMutationGateway(getDb()).signInEmail(
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
    await transaction.insert(programs).values({
      id: programId,
      userId,
      status: 'draft',
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
        revisionId: firstRevisionId,
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
      .update(programs)
      .set({ status: 'active', updatedAt: now })
      .where(eq(programs.id, programId))
    await transaction
      .update(programRevisions)
      .set({
        status: 'active',
        activatedAt: now,
      })
      .where(eq(programRevisions.id, firstRevisionId))

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
        status: 'initializing',
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
        status: 'pending',
        targetLoadGrams: 60_000,
        targetRepetitions: 5,
        restSeconds: 180,
      })
      await transaction
        .update(workoutSessions)
        .set({
          status: 'active',
          snapshotFinalizedAt: fixture.startedAt,
          updatedAt: fixture.startedAt,
        })
        .where(eq(workoutSessions.id, fixture.sessionId))

      if (fixture.status !== 'pending') {
        const setCommandId = `set-${fixture.suffix}`
        await transaction.insert(trainingCommandReceipts).values({
          commandId: setCommandId,
          userId,
          commandType: fixture.status === 'performed' ? 'complete-set' : 'skip-set',
          sessionId: fixture.sessionId,
          targetId: fixture.setId,
          requestHash: `canonical-${fixture.status}-request-hash`,
          resultSnapshot: { status: 'succeeded' },
          createdAt: fixture.startedAt,
        })
        await transaction
          .update(performedSets)
          .set(
            fixture.status === 'performed'
              ? {
                  status: 'performed',
                  actualLoadGrams: 62_500,
                  actualRepetitions: 5,
                  rpe: 8,
                  loadProvenance: 'edited',
                  repetitionsProvenance: 'copied-target',
                  explicitlyConfirmed: true,
                  confirmedAt: new Date('2026-07-10T12:20:00.000Z'),
                  note: 'Felt controlled.',
                  commandId: setCommandId,
                }
              : {
                  status: 'skipped',
                  skippedAt: new Date('2026-07-09T12:05:00.000Z'),
                  skipReason: 'Session ended early.',
                  commandId: setCommandId,
                },
          )
          .where(eq(performedSets.id, fixture.setId))
        await transaction
          .update(workoutSessions)
          .set({ optimisticVersion: 2, updatedAt: fixture.startedAt })
          .where(eq(workoutSessions.id, fixture.sessionId))
      }

      if (fixture.suffix === 'completed') {
        await transaction.insert(sessionFeedback).values({
          sessionId: fixture.sessionId,
          painReported: false,
          details: null,
          answeredAt: new Date('2026-07-10T12:30:00.000Z'),
        })
        await transaction.insert(programRevisionLineage).values({
          revisionId: secondRevisionId,
          parentRevisionId: firstRevisionId,
          sourceSessionId: fixture.sessionId,
          sourceProgramOrdinal: 2,
          createdAt: new Date('2026-07-10T12:30:00.000Z'),
        })
        await transaction.insert(adjustmentDecisions).values({
          id: completedDecisionId,
          sessionId: fixture.sessionId,
          appliedRevisionId: secondRevisionId,
          exerciseCode: 'development.back-squat',
          decision: 'increase',
          currentLoadGrams: 60_000,
          nextLoadGrams: 62_500,
          reasonCode: 'all-sets-within-rpe-bound',
          ruleVersion: 'development-adjustment-v1',
        })
        await transaction.insert(futureLoadExplanationCache).values({
          id: cachedExplanationId,
          userId,
          sessionId: fixture.sessionId,
          decisionId: completedDecisionId,
          cacheKey: 'd'.repeat(64),
          ...cachedExplanation,
          createdAt: cachedExplanationCreatedAt,
        })
        await transaction.insert(trainingCommandReceipts).values({
          commandId: 'complete-completed',
          userId,
          commandType: 'complete-workout',
          sessionId: fixture.sessionId,
          targetId: fixture.sessionId,
          requestHash: 'canonical-completion-request-hash',
          resultSnapshot: { status: 'succeeded' },
          createdAt: new Date('2026-07-10T12:30:00.000Z'),
        })
        await transaction
          .update(workoutSessions)
          .set({
            status: 'completed',
            completedAt: new Date('2026-07-10T12:30:00.000Z'),
            completionCommandId: 'complete-completed',
            optimisticVersion: 3,
          })
          .where(eq(workoutSessions.id, fixture.sessionId))
        await transaction
          .update(programRevisions)
          .set({ status: 'superseded' })
          .where(eq(programRevisions.id, firstRevisionId))
        await transaction
          .update(programRevisions)
          .set({
            status: 'active',
            activatedAt: new Date('2026-07-10T12:30:00.000Z'),
          })
          .where(eq(programRevisions.id, secondRevisionId))
      } else if (fixture.suffix === 'abandoned') {
        await transaction
          .update(workoutSessions)
          .set({
            status: 'abandoned',
            abandonedAt: new Date('2026-07-09T12:10:00.000Z'),
            abandonedReason: 'Session ended early.',
            optimisticVersion: 3,
          })
          .where(eq(workoutSessions.id, fixture.sessionId))
      }
    }
    await transaction.insert(safetyHolds).values({
      id: resolvedHoldId,
      userId,
      sourceSessionId: abandonedSessionId,
      reasonCode: 'session-pain-reported',
      details: 'Historical pain hold with retained workout provenance.',
      createdAt: new Date('2026-07-09T12:10:00.000Z'),
    })
    await transaction.insert(safetyHoldResolutions).values({
      id: resolvedHoldResolutionId,
      holdId: resolvedHoldId,
      userId,
      reason: 'Symptoms were reviewed; I am choosing to resume training.',
      acknowledged: true,
      createdAt: new Date('2026-07-11T12:05:00.000Z'),
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

async function seedResolvedHoldForSubject(userId: string): Promise<{
  readonly sessionId: string
  readonly holdId: string
  readonly resolutionId: string
}> {
  return getDb().transaction(async (transaction) => {
    const [workout] = await transaction
      .select({
        id: plannedWorkouts.id,
        name: plannedWorkouts.name,
        scheduledDate: plannedWorkouts.scheduledDate,
        slotCode: plannedWorkouts.slotCode,
        revisionId: programRevisions.id,
        revisionStatus: programRevisions.status,
        programId: programs.id,
        programStatus: programs.status,
      })
      .from(plannedWorkouts)
      .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
      .innerJoin(programs, eq(programs.id, programRevisions.programId))
      .where(eq(programs.userId, userId))
      .limit(1)
    if (!workout) throw new Error('Member deletion fixture has no planned workout.')

    const sessionId = newUuidV7()
    const holdId = newUuidV7()
    const resolutionId = newUuidV7()
    const exerciseId = newUuidV7()
    const abandonedAt = new Date('2026-07-11T14:00:00.000Z')
    if (workout.programStatus === 'draft') {
      await transaction
        .update(programs)
        .set({ status: 'active', updatedAt: abandonedAt })
        .where(eq(programs.id, workout.programId))
    }
    if (workout.revisionStatus === 'draft') {
      await transaction
        .update(programRevisions)
        .set({ status: 'active', activatedAt: abandonedAt })
        .where(eq(programRevisions.id, workout.revisionId))
    }
    await transaction.insert(workoutSessions).values({
      id: sessionId,
      userId,
      plannedWorkoutId: workout.id,
      plannedWorkoutName: workout.name,
      scheduledDate: workout.scheduledDate,
      slotCode: workout.slotCode,
      status: 'initializing',
      startedAt: new Date('2026-07-11T13:30:00.000Z'),
      optimisticVersion: 1,
      startCommandId: newUuidV7(),
    })
    await transaction.insert(sessionExercises).values({
      id: exerciseId,
      sessionId,
      exerciseCode: 'development.back-squat',
      exerciseName: 'Back squat member deletion fixture',
      ordinal: 1,
      safetyTier: 'standard',
      rationaleCode: 'development.fixture-instantiation',
      originalExerciseCode: 'development.back-squat',
      substitutionReason: null,
    })
    await transaction.insert(performedSets).values({
      id: newUuidV7(),
      sessionExerciseId: exerciseId,
      ordinal: 1,
      status: 'pending',
      targetLoadGrams: 60_000,
      targetRepetitions: 5,
      restSeconds: 180,
    })
    await transaction
      .update(workoutSessions)
      .set({ status: 'active', snapshotFinalizedAt: abandonedAt })
      .where(eq(workoutSessions.id, sessionId))
    await transaction
      .update(workoutSessions)
      .set({
        status: 'abandoned',
        abandonedAt,
        abandonedReason: 'Stopped after reporting pain.',
        optimisticVersion: 2,
      })
      .where(eq(workoutSessions.id, sessionId))
    await transaction.insert(safetyHolds).values({
      id: holdId,
      userId,
      sourceSessionId: sessionId,
      reasonCode: 'session-pain-reported',
      details: 'Member deletion provenance fixture.',
      createdAt: abandonedAt,
    })
    await transaction.insert(safetyHoldResolutions).values({
      id: resolutionId,
      holdId,
      userId,
      reason: 'I understand this is not symptom clearance and choose to continue.',
      acknowledged: true,
      createdAt: new Date('2026-07-11T14:05:00.000Z'),
    })
    return { sessionId, holdId, resolutionId }
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
    const [installation] = await getDb()
      .select({ productMutationEpoch: installationState.productMutationEpoch })
      .from(installationState)
    if (!installation) throw new Error('Export fixture has no installation state.')
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
      revisionId: firstRevisionId,
      normalizedInputHash: 'input-hash-v1',
      outputHash: 'output-hash-v1',
    })
    expect(completed?.exercises[0]?.sets[0]).toMatchObject({
      status: 'performed',
      loadProvenance: 'edited',
      repetitionsProvenance: 'copied-target',
      explicitlyConfirmed: true,
      original: {
        status: 'performed',
        actualLoadGrams: 62_500,
        actualRepetitions: 5,
      },
      corrections: [],
      effective: {
        status: 'performed',
        actualLoadGrams: 62_500,
        actualRepetitions: 5,
        correctionId: null,
      },
    })
    expect(completed?.adjustments[0]).toMatchObject({
      id: completedDecisionId,
      appliedRevisionId: secondRevisionId,
      ruleVersion: 'development-adjustment-v1',
      reasonCode: 'all-sets-within-rpe-bound',
      invalidation: null,
      explanations: [
        {
          id: cachedExplanationId,
          sessionId: completedSessionId,
          decisionId: completedDecisionId,
          ...cachedExplanation,
          createdAt: cachedExplanationCreatedAt,
        },
      ],
    })
    expect(completed?.feedback).toMatchObject({
      original: { painReported: false, details: null },
      corrections: [],
      effective: { painReported: false, details: null, correctionId: null },
    })
    expect(completed?.corrections).toEqual([])
    expect(completed?.commandReceipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId: 'set-completed',
          commandType: 'complete-set',
        }),
        expect.objectContaining({
          commandId: 'complete-completed',
          commandType: 'complete-workout',
          requestHash: 'canonical-completion-request-hash',
        }),
      ]),
    )
    expect(archive.manifest.schemaVersion).toBe('1.5.0-development')
    expect(archive.profile.safetyHolds).toEqual([
      expect.objectContaining({
        id: resolvedHoldId,
        sourceSessionId: abandonedSessionId,
        reasonCode: 'session-pain-reported',
      }),
    ])
    expect(archive.profile.safetyHoldResolutions).toEqual([
      expect.objectContaining({
        id: resolvedHoldResolutionId,
        holdId: resolvedHoldId,
        reason: 'Symptoms were reviewed; I am choosing to resume training.',
        acknowledged: true,
      }),
    ])
    expect(Object.keys(archive.manifest.hashes).sort()).toEqual(
      [
        'auditEvents',
        'contentReleaseRevocations',
        'identity',
        'profile',
        'programs',
        'provenance',
        'sessions',
      ].sort(),
    )
    expect(archive.contentReleaseRevocations).toEqual([])
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
    expect(serialized).not.toContain(installation.productMutationEpoch)

    await getDb()
      .update(workoutSessions)
      .set({
        status: 'paused',
        pausedAt: new Date('2026-07-11T12:15:00.000Z'),
        optimisticVersion: sql`${workoutSessions.optimisticVersion} + 1`,
        updatedAt: new Date('2026-07-11T12:15:00.000Z'),
      })
      .where(eq(workoutSessions.id, activeSessionId))
    const pausedArchive = await createDataExport(actor)
    expect(
      pausedArchive.sessions.find((session) => session.id === activeSessionId),
    ).toMatchObject({ status: 'paused' })
  })

  it('retains cached prose when development content is non-revoked but ineligible', async () => {
    const previousMode = process.env.INDIGO_CONTENT_MODE
    process.env.INDIGO_CONTENT_MODE = 'reviewed'
    resetServerConfigForTests()
    try {
      const archive = await createDataExport(actor)
      const completed = archive.sessions.find(
        (session) => session.id === completedSessionId,
      )

      expect(completed?.prescriptionProvenance).toMatchObject({
        available: true,
        contentStatus: {
          eligibility: {
            eligible: false,
            code: 'content.development-forbidden-in-production',
          },
          revocations: [],
        },
      })
      expect(completed?.adjustments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: completedDecisionId,
            explanations: [
              expect.objectContaining({
                id: cachedExplanationId,
                sessionId: completedSessionId,
                decisionId: completedDecisionId,
                ...cachedExplanation,
                createdAt: cachedExplanationCreatedAt,
              }),
            ],
          }),
        ]),
      )
    } finally {
      if (previousMode === undefined) delete process.env.INDIGO_CONTENT_MODE
      else process.env.INDIGO_CONTENT_MODE = previousMode
      resetServerConfigForTests()
    }
  })

  it('redacts content revocation actor identities from member exports', async () => {
    const memberProgramId = newUuidV7()
    const memberRevisionId = newUuidV7()
    const revocationId = newUuidV7()
    const contentId = `member-redaction-methodology-${revocationId}`
    const now = new Date('2026-07-11T15:00:00.000Z')

    try {
      await getDb().transaction(async (transaction) => {
        await transaction.insert(programs).values({
          id: memberProgramId,
          userId: otherUser.id,
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        })
        await transaction.insert(programRevisions).values({
          id: memberRevisionId,
          programId: memberProgramId,
          revisionNumber: 1,
          status: 'draft',
          engineVersion: 'engine-v1',
          methodologyId: contentId,
          methodologyVersion: '1.0.0',
          methodologyReviewStatus: 'reviewed',
          templateId: 'member-redaction-template',
          templateVersion: '1.0.0',
          templateReviewStatus: 'reviewed',
          normalizedInputHash: 'member-redaction-input',
          outputHash: 'member-redaction-output',
          normalizedInput: { fixture: 'member-redaction' },
          outputSnapshot: { fixture: 'member-redaction' },
          warnings: [],
          manualReviewRequired: false,
          createdAt: now,
        })
        await transaction.insert(contentReleaseRevocations).values({
          id: revocationId,
          contentKind: 'methodology',
          contentId,
          contentVersion: '1.0.0',
          reason: 'Member export redaction fixture.',
          actorUserId: actor.userId,
          createdAt: now,
        })
      })

      const archive = await createDataExport({
        userId: otherUser.id,
        name: 'Other Local User',
        email: otherUser.email,
      })

      expect(archive.contentReleaseRevocations).toEqual([
        expect.objectContaining({
          id: revocationId,
          actorClass: 'local-administrator',
        }),
      ])
      expect(archive.contentReleaseRevocations[0]).not.toHaveProperty('actorUserId')
      expect(
        archive.programs[0]?.revisions[0]?.contentStatus.revocations[0],
      ).toMatchObject({
        id: revocationId,
        actorClass: 'local-administrator',
      })
      expect(
        archive.programs[0]?.revisions[0]?.contentStatus.revocations[0],
      ).not.toHaveProperty('actorUserId')
      expect(JSON.stringify(archive.contentReleaseRevocations)).not.toContain(
        actor.userId,
      )
      expect(JSON.stringify(archive.programs)).not.toContain(actor.userId)
    } finally {
      await getDb().transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL indigo.deletion_mode = 'instance-reset'`)
        await transaction
          .delete(contentReleaseRevocations)
          .where(eq(contentReleaseRevocations.id, revocationId))
        await transaction.delete(programs).where(eq(programs.id, memberProgramId))
      })
    }
  })

  it('exports correction history and binds append-only correction facts into deletion previews', async () => {
    const [completedExercise] = await getDb()
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, completedSessionId))
      .limit(1)
    const [completedSet] = completedExercise
      ? await getDb()
          .select()
          .from(performedSets)
          .where(eq(performedSets.sessionExerciseId, completedExercise.id))
          .limit(1)
      : []
    const [decision] = await getDb()
      .select({ id: adjustmentDecisions.id })
      .from(adjustmentDecisions)
      .where(eq(adjustmentDecisions.sessionId, completedSessionId))
      .limit(1)
    if (!completedSet || !decision) {
      throw new Error('Correction export fixture is incomplete.')
    }

    const commandId = 'correct-completed-set'
    const correctionId = newUuidV7()
    const correctedAt = new Date('2026-07-11T12:40:00.000Z')
    await getDb().transaction(async (transaction) => {
      await transaction.insert(trainingCommandReceipts).values({
        commandId,
        userId: actor.userId,
        commandType: 'correct-performed-set',
        sessionId: completedSessionId,
        targetId: completedSet.id,
        requestHash: 'canonical-correction-request-hash',
        resultSnapshot: { status: 'succeeded' },
        createdAt: correctedAt,
      })
      await transaction.insert(trainingFactCorrections).values({
        id: correctionId,
        userId: actor.userId,
        sessionId: completedSessionId,
        actorUserId: actor.userId,
        commandId,
        correctionKind: 'performed-set',
        sequence: 1,
        reason: 'Corrected a transcription error in the completed set.',
        createdAt: correctedAt,
      })
      await transaction.insert(performedSetCorrections).values({
        correctionId,
        sessionId: completedSessionId,
        userId: actor.userId,
        performedSetId: completedSet.id,
        status: 'performed',
        actualLoadGrams: 60_000,
        actualRepetitions: 5,
        rpe: 7,
        loadProvenance: 'copied-target',
        repetitionsProvenance: 'copied-target',
        explicitlyConfirmed: true,
        confirmedAt: correctedAt,
        note: 'Corrected after reviewing the training log.',
      })
      await transaction.insert(adjustmentDecisionInvalidations).values({
        decisionId: decision.id,
        correctionId,
        createdAt: correctedAt,
      })
      await transaction.insert(programRevisionInvalidations).values({
        revisionId: secondRevisionId,
        correctionId,
        createdAt: correctedAt,
      })
    })

    const archive = await createDataExport(actor)
    const completed = archive.sessions.find(
      (session) => session.id === completedSessionId,
    )
    expect(completed?.corrections).toEqual([
      expect.objectContaining({
        id: correctionId,
        commandId,
        correctionKind: 'performed-set',
        sequence: 1,
      }),
    ])
    expect(completed?.exercises[0]?.sets[0]).toMatchObject({
      original: { actualLoadGrams: 62_500, rpe: 8 },
      corrections: [
        {
          correctionId,
          sessionId: completedSessionId,
          userId: actor.userId,
          performedSetId: completedSet.id,
          status: 'performed',
          actualLoadGrams: 60_000,
          actualRepetitions: 5,
          rpe: 7,
          loadProvenance: 'copied-target',
          repetitionsProvenance: 'copied-target',
          explicitlyConfirmed: true,
          confirmedAt: correctedAt,
          skippedAt: null,
          skipReason: null,
          note: 'Corrected after reviewing the training log.',
          correction: expect.objectContaining({
            id: correctionId,
            actorUserId: actor.userId,
            reason: 'Corrected a transcription error in the completed set.',
          }),
        },
      ],
      effective: {
        status: 'performed',
        actualLoadGrams: 60_000,
        actualRepetitions: 5,
        rpe: 7,
        loadProvenance: 'copied-target',
        repetitionsProvenance: 'copied-target',
        explicitlyConfirmed: true,
        confirmedAt: correctedAt,
        skippedAt: null,
        skipReason: null,
        note: 'Corrected after reviewing the training log.',
        correctionId,
      },
    })
    expect(completed?.adjustments[0]?.invalidation).toMatchObject({
      decisionId: decision.id,
      correctionId,
      correction: {
        id: correctionId,
        commandId,
        kind: 'performed-set',
        sequence: 1,
        reason: 'Corrected a transcription error in the completed set.',
        actorUserId: actor.userId,
        createdAt: correctedAt,
      },
    })
    const invalidatedRevision = archive.programs
      .flatMap((program) => program.revisions)
      .find((revision) => revision.id === secondRevisionId)
    expect(invalidatedRevision?.invalidation).toMatchObject({
      revisionId: secondRevisionId,
      correctionId,
      correction: { id: correctionId, kind: 'performed-set' },
    })

    const plan = await createInstanceResetPlan(actor)
    expect(plan.counts).toMatchObject({
      trainingFactCorrections: 1,
      sessionFeedbackCorrections: 0,
      performedSetCorrections: 1,
      adjustmentDecisionInvalidations: 1,
      programRevisionInvalidations: 1,
      futureLoadExplanationCache: 1,
    })
  })

  it('enforces durable hold provenance and fail-closed append-only resolution facts', async () => {
    const preflight = await assertDatabaseReady(getPool())
    expect(preflight.safetyHoldIntegrityPresent).toBe(true)

    await expect(
      getDb()
        .update(safetyHoldResolutions)
        .set({ reason: 'tampered resolution reason' })
        .where(eq(safetyHoldResolutions.id, resolvedHoldResolutionId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    await expect(
      getDb()
        .delete(safetyHoldResolutions)
        .where(eq(safetyHoldResolutions.id, resolvedHoldResolutionId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    await expect(
      getDb()
        .update(safetyHolds)
        .set({ details: 'tampered hold provenance' })
        .where(eq(safetyHolds.id, resolvedHoldId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    await expect(
      getDb().delete(safetyHolds).where(eq(safetyHolds.id, resolvedHoldId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })

    await expect(
      getDb().insert(safetyHoldResolutions).values({
        id: newUuidV7(),
        holdId: resolvedHoldId,
        userId: actor.userId,
        reason: 'Acknowledgement bypass attempt.',
        acknowledged: false,
      }),
    ).rejects.toMatchObject({
      cause: {
        code: '23514',
        constraint: 'safety_hold_resolution_acknowledged_check',
      },
    })
    await expect(
      getDb().insert(safetyHoldResolutions).values({
        id: newUuidV7(),
        holdId: resolvedHoldId,
        userId: actor.userId,
        reason: '   ',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'safety_hold_resolution_reason_check' },
    })
    await expect(
      getDb().execute(sql`
        INSERT INTO safety_hold_resolution
          (id, hold_id, user_id, reason, acknowledged)
        VALUES
          (${newUuidV7()}, ${resolvedHoldId}, ${actor.userId}, ${'\t\n'}, true)
      `),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'safety_hold_resolution_reason_check' },
    })
    await expect(
      getDb().execute(sql`
        INSERT INTO safety_hold_resolution
          (id, hold_id, user_id, reason, acknowledged)
        VALUES
          (${newUuidV7()}, ${resolvedHoldId}, ${actor.userId}, ${'\tSurrounded by tabs\t'}, true)
      `),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'safety_hold_resolution_reason_check' },
    })
    await expect(
      getDb().insert(safetyHoldResolutions).values({
        id: newUuidV7(),
        holdId: resolvedHoldId,
        userId: actor.userId,
        reason: ' untrimmed reason ',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'safety_hold_resolution_reason_check' },
    })
    await expect(
      getDb().insert(safetyHoldResolutions).values({
        id: newUuidV7(),
        holdId: resolvedHoldId,
        userId: otherUser.id,
        reason: 'Cross-subject resolution attempt.',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({ cause: { code: '23503' } })
    await expect(
      getDb().insert(safetyHolds).values({
        id: newUuidV7(),
        userId: actor.userId,
        sourceSessionId: abandonedSessionId,
        reasonCode: 'session-pain-reported',
        details: 'Duplicate source attempt.',
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'safety_hold_source_session_uidx' },
    })

    const activePainHoldId = newUuidV7()
    await expect(
      getDb().execute(sql`
        INSERT INTO safety_hold
          (id, user_id, source_session_id, reason_code, details, cleared_at)
        VALUES
          (
            ${newUuidV7()},
            ${actor.userId},
            ${activeSessionId},
            'session-pain-reported',
            'Pre-cleared insertion attempt.',
            ${new Date('2026-07-11T12:20:00.000Z')}
          )
      `),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
    await getDb().insert(safetyHolds).values({
      id: activePainHoldId,
      userId: actor.userId,
      sourceSessionId: activeSessionId,
      reasonCode: 'session-pain-reported',
      details: 'Direct clearance mutation fixture.',
    })
    await expect(
      getDb().execute(sql`
        UPDATE safety_hold
        SET cleared_at = ${new Date('2026-07-11T12:20:00.000Z')}
        WHERE id = ${activePainHoldId}
      `),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    const [stillActivePainHold] = await getDb()
      .select({ id: safetyHolds.id, clearedAt: safetyHolds.clearedAt })
      .from(safetyHolds)
      .where(
        and(
          eq(safetyHolds.id, activePainHoldId),
          isNull(safetyHolds.clearedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${safetyHoldResolutions}
            WHERE ${safetyHoldResolutions.holdId} = ${safetyHolds.id}
          )`,
        ),
      )
      .limit(1)
    expect(stillActivePainHold).toEqual({ id: activePainHoldId, clearedAt: null })
    await getDb().transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL indigo.deletion_mode = 'trainee-data'`)
      await transaction.delete(safetyHolds).where(eq(safetyHolds.id, activePainHoldId))
    })

    await expect(
      getDb().transaction(async (transaction) => {
        const holdId = newUuidV7()
        await transaction.insert(safetyHolds).values({
          id: holdId,
          userId: actor.userId,
          reasonCode: 'eligibility-restriction',
          details: 'Legacy-compatible source-less hold.',
        })
        await transaction.insert(safetyHoldResolutions).values({
          id: newUuidV7(),
          holdId,
          userId: actor.userId,
          reason: 'Source fabrication is forbidden.',
          acknowledged: true,
        })
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } })

    await expect(
      getDb().transaction(async (transaction) => {
        const holdId = newUuidV7()
        await transaction.insert(safetyHolds).values({
          id: holdId,
          userId: actor.userId,
          sourceSessionId: completedSessionId,
          reasonCode: 'session-pain-reported',
          details: 'Completed source must remain fail-closed.',
        })
        await transaction.insert(safetyHoldResolutions).values({
          id: newUuidV7(),
          holdId,
          userId: actor.userId,
          reason: 'Completed source bypass attempt.',
          acknowledged: true,
        })
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
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
    const memberResolvedHold = await seedResolvedHoldForSubject(memberActor.userId)
    const memberResetVerificationId = newUuidV7()
    const memberResetIssuedAt = new Date('2026-07-13T12:00:00.000Z')
    await getDb()
      .insert(verification)
      .values({
        id: memberResetVerificationId,
        identifier: `indigo:member-reset:${memberActor.userId}`,
        value: 'member-reset-v1:fixture-digest',
        expiresAt: new Date('2026-07-13T12:15:00.000Z'),
      })
    await getDb().insert(memberResetStates).values({
      targetUserId: memberActor.userId,
      activeVerificationId: memberResetVerificationId,
      lastIssuedAt: memberResetIssuedAt,
      createdAt: memberResetIssuedAt,
      updatedAt: memberResetIssuedAt,
    })
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
      authVerifications: 1,
      memberResetStates: 1,
      athleteProfiles: 1,
      programs: 1,
      programRevisions: 1,
      plannedWorkouts: 6,
      workoutSessions: 1,
      safetyHolds: 1,
      safetyHoldResolutions: 1,
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
    const [deletedMemberHold] = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.id, memberResolvedHold.holdId))
    const [deletedMemberResolution] = await getDb()
      .select()
      .from(safetyHoldResolutions)
      .where(eq(safetyHoldResolutions.id, memberResolvedHold.resolutionId))
    const [deletedMemberWorkout] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, memberResolvedHold.sessionId))
    const [deletedMemberResetState] = await getDb()
      .select()
      .from(memberResetStates)
      .where(eq(memberResetStates.targetUserId, memberActor.userId))
    const [deletedMemberVerification] = await getDb()
      .select()
      .from(verification)
      .where(eq(verification.id, memberResetVerificationId))
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
    expect(deletedMemberHold).toBeUndefined()
    expect(deletedMemberResolution).toBeUndefined()
    expect(deletedMemberWorkout).toBeUndefined()
    expect(deletedMemberResetState).toBeUndefined()
    expect(deletedMemberVerification).toBeUndefined()
    expect(tombstone).toMatchObject({
      actorClass: 'trainee',
      scope: 'trainee-data',
      rowCounts: plan.counts,
    })
    const serialized = JSON.stringify(tombstone)
    expect(serialized).not.toContain(memberActor.userId)
    expect(serialized).not.toContain(memberActor.email)
  })

  it('binds every affected live-table count and retains only reset metadata', async () => {
    // Reset must succeed with a live revocation row present: the append-only
    // guard permits its deletion only inside instance-reset mode, and the row
    // must be purged before the authoring user row so the FK actor-unlink
    // update never fires.
    await revokeContentRelease({
      actor,
      contentKind: 'methodology',
      contentId: 'development.methodology-fixture',
      contentVersion: '0.0.1-development',
      reason: 'Reset coverage requires a live revocation.',
    })
    const [ownerRecoveryVerification] = await getDb()
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.identifier, `indigo:owner-recovery:${actor.userId}`))
    if (!ownerRecoveryVerification) {
      throw new Error('Instance-reset fixture has no owner-recovery verification.')
    }
    const persistenceFixtureAt = new Date('2026-07-13T12:00:00.000Z')
    await getDb().insert(memberResetStates).values({
      targetUserId: actor.userId,
      activeVerificationId: ownerRecoveryVerification.id,
      lastIssuedAt: persistenceFixtureAt,
      createdAt: persistenceFixtureAt,
      updatedAt: persistenceFixtureAt,
    })
    await getDb()
      .insert(webRecoveryRateLimitBuckets)
      .values({
        scope: 'owner-recovery:address',
        bucketKey: 'a'.repeat(64),
        windowStartedAt: persistenceFixtureAt,
        attemptCount: 1,
        lastAttemptAt: persistenceFixtureAt,
        createdAt: persistenceFixtureAt,
        updatedAt: persistenceFixtureAt,
      })

    const stalePlan = await createInstanceResetPlan(actor)
    expect(Object.keys(stalePlan.counts)).toHaveLength(35)
    expect(stalePlan.counts).toMatchObject({
      installationStates: 1,
      users: 1,
      authAccounts: 1,
      authVerifications: 1,
      destructiveReauthenticationStates: 0,
      memberResetStates: 1,
      webRecoveryRateLimitBuckets: 1,
      athleteProfiles: 1,
      athleteTrainingDays: 1,
      athleteEquipment: 1,
      strengthBaselines: 1,
      safetyHolds: 1,
      safetyHoldResolutions: 1,
      programs: 1,
      programRevisions: 2,
      plannedWorkouts: 3,
      exercisePrescriptions: 3,
      setPrescriptions: 3,
      workoutSessions: 3,
      sessionExercises: 3,
      performedSets: 3,
      programRevisionLineage: 1,
      trainingCommandReceipts: 4,
      sessionFeedback: 1,
      adjustmentDecisions: 1,
      trainingFactCorrections: 1,
      sessionFeedbackCorrections: 0,
      performedSetCorrections: 1,
      adjustmentDecisionInvalidations: 1,
      programRevisionInvalidations: 1,
      contentReleaseRevocations: 1,
      futureLoadExplanationCache: 1,
      auditEvents: 5,
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

    const retryPlan = await createInstanceResetPlan(actor)
    expect(retryPlan.counts.auditEvents).toBe(plan.counts.auditEvents + 1)
    const [installationBeforeReset] = await getDb()
      .select({ productMutationEpoch: installationState.productMutationEpoch })
      .from(installationState)
    if (!installationBeforeReset) {
      throw new Error('Reset fixture has no installation mutation epoch.')
    }

    await getDb().execute(sql`
      CREATE FUNCTION indigo_test_fail_reset_after_epoch()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected post-epoch reset failure';
      END;
      $$;
      CREATE TRIGGER indigo_test_fail_reset_after_epoch
      BEFORE DELETE ON program
      FOR EACH STATEMENT EXECUTE FUNCTION indigo_test_fail_reset_after_epoch();
    `)
    await expect(
      executeInstanceReset({
        actor,
        planId: retryPlan.id,
        planDigest: retryPlan.digest,
        password: ownerPassword,
        typedConfirmation: 'RESET',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({
      cause: { message: 'injected post-epoch reset failure' },
    })
    const [installationAfterRollback] = await getDb()
      .select({ productMutationEpoch: installationState.productMutationEpoch })
      .from(installationState)
    expect(installationAfterRollback?.productMutationEpoch).toBe(
      installationBeforeReset.productMutationEpoch,
    )
    await getDb().execute(sql`
      DROP TRIGGER indigo_test_fail_reset_after_epoch ON program;
      DROP FUNCTION indigo_test_fail_reset_after_epoch();
    `)

    await executeInstanceReset({
      actor,
      planId: retryPlan.id,
      planDigest: retryPlan.digest,
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
        (SELECT count(*) FROM safety_hold_resolution) +
        (SELECT count(*) FROM program) +
        (SELECT count(*) FROM program_revision) +
        (SELECT count(*) FROM program_revision_lineage) +
        (SELECT count(*) FROM planned_workout) +
        (SELECT count(*) FROM exercise_prescription) +
        (SELECT count(*) FROM set_prescription) +
        (SELECT count(*) FROM workout_session) +
        (SELECT count(*) FROM session_exercise) +
        (SELECT count(*) FROM performed_set) +
        (SELECT count(*) FROM training_command_receipt) +
        (SELECT count(*) FROM session_feedback) +
        (SELECT count(*) FROM adjustment_decision) +
        (SELECT count(*) FROM training_fact_correction) +
        (SELECT count(*) FROM session_feedback_correction) +
        (SELECT count(*) FROM performed_set_correction) +
        (SELECT count(*) FROM adjustment_decision_invalidation) +
        (SELECT count(*) FROM program_revision_invalidation) +
        (SELECT count(*) FROM content_release_revocation) +
        (SELECT count(*) FROM future_load_explanation_cache) +
        (SELECT count(*) FROM destructive_reauthentication_state) +
        (SELECT count(*) FROM member_reset_state) +
        (SELECT count(*) FROM web_recovery_rate_limit_bucket) +
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
    expect(installation?.productMutationEpoch).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(installation?.productMutationEpoch).not.toBe(
      installationBeforeReset?.productMutationEpoch,
    )
    expect(tombstone).toMatchObject({
      actorClass: 'owner',
      scope: 'instance-reset',
      rowCounts: retryPlan.counts,
    })
    expect(tombstone?.completionDigest).toBe(
      canonicalSha256({
        eventId: tombstone.id,
        scope: 'instance-reset',
        schemaVersion: tombstone.schemaVersion,
        completedAt: tombstone.createdAt.toISOString(),
        counts: retryPlan.counts,
      }),
    )
    const serializedTombstone = JSON.stringify(tombstone)
    expect(serializedTombstone).not.toContain(actor.userId)
    expect(serializedTombstone).not.toContain(actor.email)
    expect(serializedTombstone).not.toContain(recoveryDigest)
    expect(serializedTombstone).not.toContain('Back squat')
    expect(serializedTombstone).not.toContain(
      installationBeforeReset.productMutationEpoch,
    )
    expect(JSON.stringify(retryPlan)).not.toContain(
      installationBeforeReset.productMutationEpoch,
    )

    const [userCount] = await getDb().select({ value: count() }).from(user)
    expect(userCount?.value).toBe(0)
  })
})
