import { count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
import {
  type AuthenticatedActor,
  deriveIdentityRole,
} from '@/modules/identity/application/actor'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { canonicalSha256 } from '@/modules/methodology/domain/canonical'
import {
  activatePersistedProgramRevision,
  activateProgram,
} from '@/modules/programs/application/programs'
import {
  type ExecutablePrescriptionProjection,
  executablePrescriptionHash,
} from '@/modules/programs/domain/executable-prescription'
import { explainFutureLoadDecision } from '@/modules/training/application/future-load-explanation'
import {
  createMemoryFutureLoadExplanationCache,
  createPostgresFutureLoadExplanationCache,
  storageKeyFromExplanationCacheKey,
} from '@/modules/training/application/future-load-explanation-cache'
import { getFutureLoadFactBundlesForSession } from '@/modules/training/application/future-load-fact-bundle'
import {
  abandonWorkout,
  completeSet,
  completeWorkout,
  correctPerformedSet,
  getCompletedSessions,
  getSessionFutureLoadDecisions,
  getTodayState,
  getWorkoutSession,
  reportPain,
  resolveSafetyHold,
  setSessionPaused,
  skipSet,
  startWorkout,
} from '@/modules/training/application/workouts'
import { resetServerConfigForTests } from '@/platform/config/server'
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
  auditEvents,
  exercisePrescriptions,
  futureLoadExplanationCache,
  performedSets,
  plannedWorkouts,
  programRevisionInvalidations,
  programRevisionLineage,
  programRevisions,
  programs,
  safetyHoldResolutions,
  safetyHolds,
  sessionFeedback,
  sessionFeedbackCorrections,
  setPrescriptions,
  trainingCommandReceipts,
  trainingFactCorrections,
  workoutSessions,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  resetProductData,
  seedCoherentProgram,
  TEST_NEXT_DAY,
  TEST_NOW,
  TEST_TARGET_LOAD_GRAMS,
  TEST_TARGET_REPETITIONS,
  TEST_TODAY,
} from './harness'

type TestIdentity = {
  readonly id: string
  readonly name: string
  readonly email: string
}

let integrationDatabase: DisposableIntegrationDatabase | undefined
let owner: TestIdentity
let member: TestIdentity

async function signUpOwner(): Promise<TestIdentity> {
  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  return createOwnerWithBootstrapCode({
    name: 'Training Integration Owner',
    email: 'training-owner@example.test',
    password: 'training-owner-password',
    code: bootstrap.code,
  })
}

async function startedSession() {
  const seeded = await seedCoherentProgram(owner.id)
  const sessionId = await startWorkout(
    owner.id,
    seeded.currentWorkoutId,
    newUuidV7(),
    TEST_NOW,
  )
  const session = await getWorkoutSession(owner.id, sessionId)
  const setId = session?.exercises[0]?.sets[0]?.id
  if (!session || !setId) throw new Error('Started fixture session has no set.')
  return { seeded, sessionId, setId, session }
}

async function completedSessionWithDecision() {
  const { sessionId, setId } = await startedSession()
  await completeSet({
    userId: owner.id,
    sessionId,
    setId,
    commandId: newUuidV7(),
    actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
    actualRepetitions: TEST_TARGET_REPETITIONS,
    rpe: 8,
    note: null,
  })
  await completeWorkout({
    userId: owner.id,
    sessionId,
    commandId: newUuidV7(),
    noPainAttested: true,
  })
  const decisions = await getSessionFutureLoadDecisions(owner.id, sessionId)
  const decision = decisions?.[0]
  if (!decision) throw new Error('Expected a future-load decision for cache testing.')
  return { sessionId, setId, decision }
}

async function completedSessionWithDecisionFor(userId: string) {
  const seeded = await seedCoherentProgram(userId)
  const sessionId = await startWorkout(
    userId,
    seeded.currentWorkoutId,
    newUuidV7(),
    TEST_NOW,
  )
  const session = await getWorkoutSession(userId, sessionId)
  const setId = session?.exercises[0]?.sets[0]?.id
  if (!setId) throw new Error('Started fixture session has no set.')
  await completeSet({
    userId,
    sessionId,
    setId,
    commandId: newUuidV7(),
    actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
    actualRepetitions: TEST_TARGET_REPETITIONS,
    rpe: 8,
    note: null,
  })
  await completeWorkout({
    userId,
    sessionId,
    commandId: newUuidV7(),
    noPainAttested: true,
  })
  const decisions = await getSessionFutureLoadDecisions(userId, sessionId)
  const decision = decisions?.[0]
  if (!decision) throw new Error('Expected a future-load decision for cache testing.')
  return { sessionId, setId, decision }
}

function cachedExplanationInput(input: {
  readonly sessionId: string
  readonly decisionId: string
  readonly cacheKey: string
}) {
  return {
    userId: owner.id,
    sessionId: input.sessionId,
    decisionId: input.decisionId,
    cacheKey: input.cacheKey,
    prose: 'A validated cached explanation for the stored decision.',
    modelId: 'qwen3.5-9b-q4_k_m',
    modelContentDigest: 'a'.repeat(64),
    servedModelName: 'qwen3.5-9b-q4_k_m',
    runtimeId: 'llama.cpp@test',
    runtimeAttestationDigest: 'b'.repeat(64),
    promptVersion: 'future-load.v2',
    validatorVersion: 'future-load-validator.v2',
    factBundleHash: 'c'.repeat(64),
    generateDurationMs: 1000,
  }
}

function persistedExplanationRow(input: {
  readonly userId: string
  readonly sessionId: string
  readonly decisionId: string
  readonly cacheKey: string
}) {
  return {
    id: newUuidV7(),
    ...cachedExplanationInput(input),
    userId: input.userId,
    cacheKey: storageKeyFromExplanationCacheKey(input.cacheKey),
  }
}

function deferred() {
  let resolvePromise: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

async function seedRemainingDraft(input: {
  readonly programId: string
  readonly sourceRevisionId: string
  readonly sourceSessionId: string
  readonly scheduledDate: string
  readonly programOrdinal: number
}): Promise<string> {
  const [source] = await getDb()
    .select()
    .from(programRevisions)
    .where(eq(programRevisions.id, input.sourceRevisionId))
  if (!source) throw new Error('Remaining-schedule source revision is missing.')

  const revisionId = newUuidV7()
  const normalizedInput = {
    fixture: 'remaining-activation-invariant',
    sourceRevisionId: input.sourceRevisionId,
    sourceSessionId: input.sourceSessionId,
  }
  const normalizedInputHash = canonicalSha256(normalizedInput)
  const outputSnapshot: ExecutablePrescriptionProjection = {
    hashMaterialVersion: 'executable-prescription-v2',
    engineVersion: source.engineVersion,
    methodology: {
      id: source.methodologyId,
      version: source.methodologyVersion,
      reviewStatus: source.methodologyReviewStatus,
    },
    template: {
      id: source.templateId,
      version: source.templateVersion,
      reviewStatus: source.templateReviewStatus,
    },
    normalizedInputHash,
    workouts: [
      {
        scheduledDate: input.scheduledDate,
        ordinal: 1,
        programOrdinal: input.programOrdinal,
        slotCode: 'B',
        name: 'Persisted remaining schedule fixture',
        exercises: [
          {
            exerciseCode: 'development.back-squat',
            exerciseName: 'Back squat — development fixture',
            ordinal: 1,
            safetyTier: 'standard',
            rationaleCode: 'development.remaining-invariant',
            sets: [
              {
                ordinal: 1,
                setKind: 'working',
                targetLoadGrams: TEST_TARGET_LOAD_GRAMS,
                targetRepetitions: TEST_TARGET_REPETITIONS,
                restSeconds: 120,
              },
            ],
          },
        ],
      },
    ],
  }

  await getDb().transaction(async (transaction) => {
    const plannedWorkoutId = newUuidV7()
    const exercisePrescriptionId = newUuidV7()
    await transaction.insert(programRevisions).values({
      id: revisionId,
      programId: input.programId,
      revisionNumber: source.revisionNumber + 1,
      status: 'draft',
      engineVersion: source.engineVersion,
      methodologyId: source.methodologyId,
      methodologyVersion: source.methodologyVersion,
      methodologyReviewStatus: source.methodologyReviewStatus,
      templateId: source.templateId,
      templateVersion: source.templateVersion,
      templateReviewStatus: source.templateReviewStatus,
      normalizedInputHash,
      outputHash: executablePrescriptionHash(outputSnapshot),
      normalizedInput,
      outputSnapshot,
      warnings: source.warnings,
      manualReviewRequired: source.manualReviewRequired,
    })
    await transaction.insert(programRevisionLineage).values({
      revisionId,
      parentRevisionId: input.sourceRevisionId,
      sourceSessionId: input.sourceSessionId,
      sourceProgramOrdinal: 1,
    })
    await transaction.insert(plannedWorkouts).values({
      id: plannedWorkoutId,
      revisionId,
      scheduledDate: input.scheduledDate,
      ordinal: 1,
      programOrdinal: input.programOrdinal,
      slotCode: 'B',
      name: 'Persisted remaining schedule fixture',
    })
    await transaction.insert(exercisePrescriptions).values({
      id: exercisePrescriptionId,
      plannedWorkoutId,
      exerciseCode: 'development.back-squat',
      exerciseName: 'Back squat — development fixture',
      ordinal: 1,
      safetyTier: 'standard',
      rationaleCode: 'development.remaining-invariant',
    })
    await transaction.insert(setPrescriptions).values({
      id: newUuidV7(),
      exercisePrescriptionId,
      ordinal: 1,
      setKind: 'working',
      targetLoadGrams: TEST_TARGET_LOAD_GRAMS,
      targetRepetitions: TEST_TARGET_REPETITIONS,
      restSeconds: 120,
    })
  })
  return revisionId
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'training',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  owner = await signUpOwner()
  const actor: AuthenticatedActor = {
    userId: owner.id,
    name: owner.name,
    email: owner.email,
    role: deriveIdentityRole(owner.id, owner.id),
  }
  member = await createLocalUserAsOwner(actor, {
    name: 'Training Integration Member',
    email: 'training-member@example.test',
    password: 'training-member-password',
  })
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

describe('training PostgreSQL command boundary', () => {
  it('rejects a fractional set command without mutating the pending set', async () => {
    const { sessionId, setId } = await startedSession()

    await expect(
      completeSet({
        userId: owner.id,
        sessionId,
        setId,
        commandId: newUuidV7(),
        actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
        actualRepetitions: 4.5,
        rpe: 7.5,
        note: 'tampered fractional form values',
      }),
    ).rejects.toMatchObject({ code: 'input.invalid' })

    const [savedSet] = await getDb()
      .select()
      .from(performedSets)
      .where(eq(performedSets.id, setId))
    expect(savedSet).toMatchObject({
      status: 'pending',
      actualLoadGrams: null,
      actualRepetitions: null,
      rpe: null,
      commandId: null,
    })
  })

  it('rejects a future planned workout using the persisted athlete timezone', async () => {
    const seeded = await seedCoherentProgram(owner.id)

    await expect(
      startWorkout(owner.id, seeded.nextWorkoutId, newUuidV7(), TEST_NOW),
    ).rejects.toMatchObject({ code: 'workout.not-scheduled-today' })

    const [sessionCount] = await getDb().select({ value: count() }).from(workoutSessions)
    expect(sessionCount?.value).toBe(0)
  })

  it('coalesces concurrent and sequential replays of one set command into one write', async () => {
    const { sessionId, setId, session } = await startedSession()
    const command = {
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 8,
      note: 'one attested write',
    }

    await Promise.all([completeSet(command), completeSet(command), completeSet(command)])
    const [savedAfterConcurrent] = await getDb()
      .select()
      .from(performedSets)
      .where(eq(performedSets.id, setId))
    const [sessionAfterConcurrent] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))

    await completeSet(command)
    const [savedAfterSequential] = await getDb()
      .select()
      .from(performedSets)
      .where(eq(performedSets.id, setId))
    const [sessionAfterSequential] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))
    const [commandWrites] = await getDb()
      .select({ value: count() })
      .from(performedSets)
      .where(eq(performedSets.commandId, command.commandId))

    expect(savedAfterConcurrent).toMatchObject({
      status: 'performed',
      commandId: command.commandId,
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 8,
      explicitlyConfirmed: true,
    })
    expect(commandWrites?.value).toBe(1)
    expect(sessionAfterConcurrent?.optimisticVersion).toBe(session.optimisticVersion + 1)
    expect(sessionAfterSequential?.optimisticVersion).toBe(
      sessionAfterConcurrent?.optimisticVersion,
    )
    expect(savedAfterSequential?.confirmedAt?.toISOString()).toBe(
      savedAfterConcurrent?.confirmedAt?.toISOString(),
    )
    expect(savedAfterSequential?.updatedAt.toISOString()).toBe(
      savedAfterConcurrent?.updatedAt.toISOString(),
    )
    const [receiptCount] = await getDb()
      .select({ value: count() })
      .from(trainingCommandReceipts)
      .where(eq(trainingCommandReceipts.commandId, command.commandId))
    expect(receiptCount?.value).toBe(1)

    await expect(
      completeSet({ ...command, note: 'same identifier, different payload' }),
    ).rejects.toMatchObject({ code: 'command.idempotency-conflict' })
    await expect(completeSet({ ...command, userId: member.id })).rejects.toMatchObject({
      code: 'set.not-found',
    })
  })

  it('replays an exact skip after lifecycle change and rejects payload conflicts', async () => {
    const { sessionId, setId } = await startedSession()
    const command = {
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      reason: 'Technique reset requested.',
    }

    await skipSet(command)
    await setSessionPaused(owner.id, sessionId, true)
    await skipSet(command)
    await expect(
      skipSet({ ...command, reason: 'Changed after successful execution.' }),
    ).rejects.toMatchObject({ code: 'command.idempotency-conflict' })

    const receipts = await getDb()
      .select()
      .from(trainingCommandReceipts)
      .where(eq(trainingCommandReceipts.commandId, command.commandId))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      commandType: 'skip-set',
      targetId: setId,
      resultSnapshot: { status: 'succeeded' },
    })
  })

  it('builds contract FactBundles from completed session adjustment decisions', async () => {
    const { sessionId, setId } = await startedSession()
    await completeSet({
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 7,
      note: null,
    })
    await completeWorkout({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      noPainAttested: true,
    })

    const result = await getFutureLoadFactBundlesForSession(owner.id, sessionId)
    expect(result.status).toBe('available')
    if (result.status !== 'available') return

    expect(result.buildErrors).toEqual([])
    expect(result.bundles.length).toBeGreaterThanOrEqual(1)
    const first = result.bundles[0]
    expect(first?.factBundleHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first?.factBundle.decision.sessionId).toBe(sessionId)
    expect(first?.factBundle.decision.exerciseCode).toBe(first?.decision.exerciseCode)
    expect(first?.factBundle.grounding.reasonCode).toBe(first?.decision.reasonCode)
    expect(first?.factBundle.grounding.ruleVersion).toBe(first?.decision.ruleVersion)
    expect(first?.factBundle.grounding.methodologyId).toBe(
      'development.methodology-fixture',
    )
    expect(first?.factBundle.decision.setFacts.length).toBeGreaterThanOrEqual(1)
    expect(first?.factBundle.display.exerciseName).toContain('development fixture')
    expect(first?.factBundle.constraints.developmentFixtureNoticeRequired).toBe(true)
  })

  it('coalesces completion replay and applies one immutable future adjustment revision', async () => {
    const { seeded, sessionId, setId } = await startedSession()
    await completeSet({
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 8,
      note: null,
    })
    const completionCommand = {
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      noPainAttested: true,
    }

    await Promise.all([
      completeWorkout(completionCommand),
      completeWorkout(completionCommand),
    ])
    const [firstCompletion] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))
    await completeWorkout(completionCommand)

    const revisions = await getDb()
      .select()
      .from(programRevisions)
      .where(eq(programRevisions.programId, seeded.programId))
    const originalRevision = revisions.find((row) => row.id === seeded.revisionId)
    const adjustedRevision = revisions.find((row) => row.revisionNumber === 2)
    if (!adjustedRevision) throw new Error('No adjusted revision was created.')

    const [originalTarget] = await getDb()
      .select()
      .from(setPrescriptions)
      .where(eq(setPrescriptions.id, seeded.nextSetPrescriptionId))
    const adjustedWorkouts = await getDb()
      .select()
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.revisionId, adjustedRevision.id))
    const [adjustedWorkout] = adjustedWorkouts
    if (!adjustedWorkout) throw new Error('Adjusted revision has no future workout.')
    const [adjustedExercise] = await getDb()
      .select()
      .from(exercisePrescriptions)
      .where(eq(exercisePrescriptions.plannedWorkoutId, adjustedWorkout.id))
    if (!adjustedExercise) throw new Error('Adjusted workout has no exercise.')
    const [adjustedTarget] = await getDb()
      .select()
      .from(setPrescriptions)
      .where(eq(setPrescriptions.exercisePrescriptionId, adjustedExercise.id))
    const [completionAudits] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'workout-completed'))
    const [revisionAudits] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'program-adjustment-revision-activated'))
    const decisions = await getDb()
      .select()
      .from(adjustmentDecisions)
      .where(eq(adjustmentDecisions.sessionId, sessionId))
    const [completionAfterReplay] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))
    const [lineage] = await getDb()
      .select()
      .from(programRevisionLineage)
      .where(eq(programRevisionLineage.revisionId, adjustedRevision.id))
    const completionReceipts = await getDb()
      .select()
      .from(trainingCommandReceipts)
      .where(eq(trainingCommandReceipts.commandId, completionCommand.commandId))

    expect(revisions).toHaveLength(2)
    expect(originalRevision).toMatchObject({
      status: 'superseded',
      outputHash: seeded.originalOutputHash,
    })
    expect(originalTarget?.targetLoadGrams).toBe(TEST_TARGET_LOAD_GRAMS)
    expect(adjustedRevision.status).toBe('active')
    expect(adjustedRevision.outputHash).not.toBe(seeded.originalOutputHash)
    expect(adjustedWorkouts.map((workout) => workout.ordinal)).toEqual([1])
    expect(adjustedWorkouts.map((workout) => workout.programOrdinal)).toEqual([2])
    expect(lineage).toMatchObject({
      revisionId: adjustedRevision.id,
      parentRevisionId: seeded.revisionId,
      sourceSessionId: sessionId,
      sourceProgramOrdinal: 1,
    })
    expect(adjustedTarget?.targetLoadGrams).toBe(TEST_TARGET_LOAD_GRAMS + 1_000)
    expect(completionAudits?.value).toBe(1)
    expect(revisionAudits?.value).toBe(1)
    expect(completionReceipts).toHaveLength(1)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      decision: 'increase',
      currentLoadGrams: TEST_TARGET_LOAD_GRAMS,
      nextLoadGrams: TEST_TARGET_LOAD_GRAMS + 1_000,
      appliedRevisionId: adjustedRevision.id,
    })
    expect(completionAfterReplay?.completionCommandId).toBe(completionCommand.commandId)
    expect(completionAfterReplay?.completedAt?.toISOString()).toBe(
      firstCompletion?.completedAt?.toISOString(),
    )
    expect(completionAfterReplay?.optimisticVersion).toBe(
      firstCompletion?.optimisticVersion,
    )
  })

  it('denies a different local user without changing the owner set or session', async () => {
    const { sessionId, setId } = await startedSession()
    const [beforeSet] = await getDb()
      .select()
      .from(performedSets)
      .where(eq(performedSets.id, setId))
    const [beforeSession] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))

    await expect(
      completeSet({
        userId: member.id,
        sessionId,
        setId,
        commandId: newUuidV7(),
        actualLoadGrams: 99_000,
        actualRepetitions: 99,
        rpe: 10,
        note: 'unauthorized',
      }),
    ).rejects.toMatchObject({ code: 'set.not-found' })
    await expect(
      completeWorkout({
        userId: member.id,
        sessionId,
        commandId: newUuidV7(),
        noPainAttested: true,
      }),
    ).rejects.toMatchObject({ code: 'session.not-found' })

    const [afterSet] = await getDb()
      .select()
      .from(performedSets)
      .where(eq(performedSets.id, setId))
    const [afterSession] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))
    const [completionAudits] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'workout-completed'))

    expect(afterSet).toEqual(beforeSet)
    expect(afterSession).toEqual(beforeSession)
    expect(completionAudits?.value).toBe(0)
  })

  it('rejects an unsafe persisted prescription before program activation', async () => {
    const seeded = await seedCoherentProgram(owner.id, { status: 'draft' })
    const [draftRevision] = await getDb()
      .select({ outputSnapshot: programRevisions.outputSnapshot })
      .from(programRevisions)
      .where(eq(programRevisions.id, seeded.revisionId))
    if (!draftRevision) throw new Error('Draft revision was not persisted.')
    const originalSnapshot =
      draftRevision.outputSnapshot as ExecutablePrescriptionProjection
    const advancedSnapshot: ExecutablePrescriptionProjection = {
      ...originalSnapshot,
      workouts: originalSnapshot.workouts.map((workout) => ({
        ...workout,
        exercises: workout.exercises.map((exercise) =>
          workout.ordinal === 1 && exercise.exerciseCode === 'development.back-squat'
            ? { ...exercise, safetyTier: 'advanced' }
            : exercise,
        ),
      })),
    }

    await getDb()
      .update(programRevisions)
      .set({
        outputSnapshot: advancedSnapshot,
        outputHash: executablePrescriptionHash(advancedSnapshot),
      })
      .where(eq(programRevisions.id, seeded.revisionId))
    await getDb()
      .update(exercisePrescriptions)
      .set({ safetyTier: 'advanced' })
      .where(eq(exercisePrescriptions.id, seeded.currentPrescriptionId))

    await expect(activateProgram(owner.id, seeded.revisionId)).rejects.toMatchObject({
      code: 'safety.advanced-ineligible',
    })

    const [program] = await getDb()
      .select()
      .from(programs)
      .where(eq(programs.id, seeded.programId))
    const [revision] = await getDb()
      .select()
      .from(programRevisions)
      .where(eq(programRevisions.id, seeded.revisionId))
    const [activationAudits] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'program-activated'))

    expect(program?.status).toBe('draft')
    expect(revision).toMatchObject({ status: 'draft', activatedAt: null })
    expect(activationAudits?.value).toBe(0)
  })

  it('rejects independently tampered executable rows before activation', async () => {
    const seeded = await seedCoherentProgram(owner.id, { status: 'draft' })
    await getDb()
      .update(setPrescriptions)
      .set({ targetLoadGrams: TEST_TARGET_LOAD_GRAMS + 1_000 })
      .where(eq(setPrescriptions.id, seeded.currentSetPrescriptionId))

    await expect(activateProgram(owner.id, seeded.revisionId)).rejects.toMatchObject({
      code: 'program.prescription-integrity-failed',
    })

    const [revision] = await getDb()
      .select()
      .from(programRevisions)
      .where(eq(programRevisions.id, seeded.revisionId))
    expect(revision).toMatchObject({ status: 'draft', activatedAt: null })
  })

  it.each([
    ['stale', TEST_TODAY, 2, false],
    ['used', TEST_NEXT_DAY, 2, true],
    ['gapped', TEST_NEXT_DAY, 3, false],
  ] as const)('rejects a %s persisted remaining schedule before superseding its source', async (_case, scheduledDate, programOrdinal, markFutureUsed) => {
    const seeded = await seedCoherentProgram(owner.id)
    if (markFutureUsed) {
      const consumedSessionId = await startWorkout(
        owner.id,
        seeded.nextWorkoutId,
        newUuidV7(),
        new Date('2026-07-13T12:00:00.000Z'),
      )
      await abandonWorkout(owner.id, consumedSessionId, 'Schedule was already consumed.')
    }
    const sessionId = await startWorkout(
      owner.id,
      seeded.currentWorkoutId,
      newUuidV7(),
      TEST_NOW,
    )
    const revisionId = await seedRemainingDraft({
      programId: seeded.programId,
      sourceRevisionId: seeded.revisionId,
      sourceSessionId: sessionId,
      scheduledDate,
      programOrdinal,
    })

    await expect(
      getDb().transaction((transaction) =>
        activatePersistedProgramRevision(transaction, {
          kind: 'remaining',
          userId: owner.id,
          revisionId,
          sourceSessionId: sessionId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'program.prescription-invalid' })

    const [source] = await getDb()
      .select()
      .from(programRevisions)
      .where(eq(programRevisions.id, seeded.revisionId))
    const [draft] = await getDb()
      .select()
      .from(programRevisions)
      .where(eq(programRevisions.id, revisionId))
    expect(source?.status).toBe('active')
    expect(draft).toMatchObject({ status: 'draft', activatedAt: null })
  })

  it('enforces ownership and released-fact immutability below the application layer', async () => {
    const seeded = await seedCoherentProgram(owner.id)

    await expect(
      getDb().insert(workoutSessions).values({
        id: newUuidV7(),
        userId: member.id,
        plannedWorkoutId: seeded.currentWorkoutId,
        plannedWorkoutName: 'Cross-user injection attempt',
        scheduledDate: '2026-07-11',
        slotCode: 'A',
        status: 'active',
        startedAt: TEST_NOW,
        startCommandId: newUuidV7(),
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } })

    const sessionId = await startWorkout(
      owner.id,
      seeded.currentWorkoutId,
      newUuidV7(),
      TEST_NOW,
    )
    const session = await getWorkoutSession(owner.id, sessionId)
    const setId = session?.exercises[0]?.sets[0]?.id
    if (!setId) throw new Error('Integrity fixture has no performed set.')
    await completeSet({
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 8,
      note: null,
    })
    await completeWorkout({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      noPainAttested: true,
    })

    await expect(
      getDb()
        .update(performedSets)
        .set({ note: 'direct terminal tamper' })
        .where(eq(performedSets.id, setId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    await expect(
      getDb()
        .update(setPrescriptions)
        .set({ targetLoadGrams: 999_999 })
        .where(eq(setPrescriptions.id, seeded.nextSetPrescriptionId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    await expect(
      getDb()
        .insert(performedSets)
        .values({
          id: newUuidV7(),
          sessionExerciseId: session.exercises[0]?.id ?? '',
          ordinal: 2,
          status: 'pending',
          targetLoadGrams: TEST_TARGET_LOAD_GRAMS,
          targetRepetitions: TEST_TARGET_REPETITIONS,
          restSeconds: 120,
        }),
    ).rejects.toMatchObject({ cause: { code: '55000' } })

    const [receipt] = await getDb().select().from(trainingCommandReceipts).limit(1)
    if (!receipt) throw new Error('Expected an append-only training receipt.')
    await expect(
      getDb()
        .update(trainingCommandReceipts)
        .set({ resultSnapshot: { status: 'tampered' } })
        .where(eq(trainingCommandReceipts.commandId, receipt.commandId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    await expect(
      getDb()
        .delete(trainingCommandReceipts)
        .where(eq(trainingCommandReceipts.commandId, receipt.commandId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })

    const [lineage] = await getDb().select().from(programRevisionLineage).limit(1)
    if (!lineage) throw new Error('Expected immutable adjustment lineage.')
    await expect(
      getDb()
        .update(programRevisionLineage)
        .set({ sourceProgramOrdinal: 999 })
        .where(eq(programRevisionLineage.revisionId, lineage.revisionId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    await expect(
      getDb()
        .delete(programRevisionLineage)
        .where(eq(programRevisionLineage.revisionId, lineage.revisionId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
  })

  it('keeps terminal feedback immutable while auditing post-completion pain', async () => {
    const { sessionId, setId } = await startedSession()
    await completeSet({
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 8,
      note: null,
    })
    await completeWorkout({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      noPainAttested: true,
    })

    await expect(
      getDb()
        .update(sessionFeedback)
        .set({ details: 'direct terminal tamper' })
        .where(eq(sessionFeedback.sessionId, sessionId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
    await expect(
      getDb().delete(sessionFeedback).where(eq(sessionFeedback.sessionId, sessionId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })

    const decisions = await getSessionFutureLoadDecisions(owner.id, sessionId)
    expect(decisions).not.toBeNull()
    expect(decisions?.length).toBeGreaterThan(0)
    const firstDecision = decisions?.[0]
    expect(firstDecision).toBeDefined()
    if (!firstDecision) throw new Error('expected future-load decision')

    // Simulate a pre-pain cached paraphrase, then post-completion pain must purge it.
    await getDb()
      .insert(futureLoadExplanationCache)
      .values({
        id: newUuidV7(),
        userId: owner.id,
        sessionId,
        decisionId: firstDecision.id,
        cacheKey: storageKeyFromExplanationCacheKey('test-stale-key'),
        prose: 'stale inferred paraphrase',
        modelId: 'test-model',
        modelContentDigest: 'a'.repeat(64),
        servedModelName: 'test-model',
        runtimeId: 'test-runtime',
        runtimeAttestationDigest: 'c'.repeat(64),
        promptVersion: 'future-load.v2',
        validatorVersion: 'future-load-validator.v2',
        factBundleHash: 'b'.repeat(64),
        generateDurationMs: 1000,
      })

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'reported after completion',
    })

    const [feedback] = await getDb()
      .select()
      .from(sessionFeedback)
      .where(eq(sessionFeedback.sessionId, sessionId))
    const [correction] = await getDb()
      .select({
        correctionKind: trainingFactCorrections.correctionKind,
        reason: trainingFactCorrections.reason,
        painReported: sessionFeedbackCorrections.painReported,
        details: sessionFeedbackCorrections.details,
      })
      .from(trainingFactCorrections)
      .innerJoin(
        sessionFeedbackCorrections,
        eq(sessionFeedbackCorrections.correctionId, trainingFactCorrections.id),
      )
      .where(eq(trainingFactCorrections.sessionId, sessionId))
    const [decisionInvalidationCount] = await getDb()
      .select({ value: count() })
      .from(adjustmentDecisionInvalidations)
    const [revisionInvalidationCount] = await getDb()
      .select({ value: count() })
      .from(programRevisionInvalidations)
    const [safetyAudit] = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'session-safety-stop'))

    expect(feedback).toMatchObject({
      painReported: false,
      details: null,
    })
    expect(correction).toMatchObject({
      correctionKind: 'session-feedback',
      painReported: true,
      details: 'reported after completion',
    })
    expect(correction?.reason).toBe('Pain reported after session completion.')
    expect(decisionInvalidationCount?.value).toBeGreaterThan(0)
    expect(revisionInvalidationCount?.value).toBeGreaterThan(0)
    expect(safetyAudit).toMatchObject({
      actorUserId: owner.id,
      subjectUserId: owner.id,
      entityId: sessionId,
      metadata: {
        action: 'post-completion-hold',
        coalescedWithExistingHold: false,
      },
    })

    const cacheRows = await getDb()
      .select()
      .from(futureLoadExplanationCache)
      .where(eq(futureLoadExplanationCache.sessionId, sessionId))
    expect(cacheRows).toHaveLength(0)

    const bundles = await getFutureLoadFactBundlesForSession(owner.id, sessionId)
    expect(bundles.status).toBe('available')
    if (bundles.status === 'available') {
      expect(bundles.bundles.length).toBeGreaterThan(0)
      for (const entry of bundles.bundles) {
        expect(entry.factBundle.decision.invalidated).toBe(true)
        expect(entry.factBundle.decision.invalidationReason).toBe(
          'post-completion-pain-report',
        )
      }
      const firstBundle = bundles.bundles[0]
      expect(firstBundle).toBeDefined()
      if (!firstBundle) throw new Error('expected fact bundle')
      const explanation = await explainFutureLoadDecision({
        userId: owner.id,
        sessionId,
        decisionId: firstBundle.decision.id,
        deps: {
          cache: createMemoryFutureLoadExplanationCache({
            activeState: () => ({
              status: 'invalidated',
              reason: 'post-completion-pain-report',
            }),
          }),
          getConfig: () => ({
            mode: 'local',
            modelId: 'qwen3.5-9b-q4_k_m',
            modelsDir: 'llm/models',
            weightsDir: 'llm/weights',
            runtimeAttestationPath: 'tmp/llm-runtime-attestation.json',
            endpointOverride: 'http://127.0.0.1:8080/v1',
            timeoutMsOverride: 1000,
            modelSha256Override: 'a'.repeat(64),
            requireGpu: true,
          }),
          compose: () => {
            throw new Error('compose must not run when invalidated')
          },
        },
      })
      expect(explanation).toMatchObject({
        status: 'unavailable',
        reason: 'decision-invalidated',
      })
    }

    await expect(
      getDb()
        .update(sessionFeedback)
        .set({ details: 'correction mode must not escape its transaction' })
        .where(eq(sessionFeedback.sessionId, sessionId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
  })

  it('commits post-completion safety state even when cache cleanup is unavailable', async () => {
    const { sessionId, setId } = await startedSession()
    await completeSet({
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 8,
      note: null,
    })
    await completeWorkout({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      noPainAttested: true,
    })
    const unavailableCleanup = {
      ...createMemoryFutureLoadExplanationCache(),
      deleteBySessionId: async () => {
        throw new Error('cache relation unavailable after safety commit')
      },
    }

    await reportPain(
      {
        userId: owner.id,
        sessionId,
        commandId: newUuidV7(),
        details: 'late issue while cache is unavailable',
      },
      { explanationCache: unavailableCleanup },
    )

    const [feedback] = await getDb()
      .select()
      .from(sessionFeedback)
      .where(eq(sessionFeedback.sessionId, sessionId))
    const [correction] = await getDb()
      .select({
        painReported: sessionFeedbackCorrections.painReported,
        details: sessionFeedbackCorrections.details,
      })
      .from(sessionFeedbackCorrections)
      .where(eq(sessionFeedbackCorrections.sessionId, sessionId))
    const [hold] = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.userId, owner.id))
    expect(feedback).toMatchObject({
      painReported: false,
      details: null,
    })
    expect(correction).toMatchObject({
      painReported: true,
      details: 'late issue while cache is unavailable',
    })
    expect(hold).toMatchObject({ reasonCode: 'session-pain-reported' })
  })

  it('fails closed when completed-session feedback is missing', async () => {
    const { sessionId, decision } = await completedSessionWithDecision()
    await getDb().transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT set_config('indigo.deletion_mode', 'trainee-data', true)`,
      )
      await transaction
        .delete(sessionFeedback)
        .where(eq(sessionFeedback.sessionId, sessionId))
    })

    const result = await createPostgresFutureLoadExplanationCache().getIfActive({
      userId: owner.id,
      sessionId,
      decisionId: decision.id,
      cacheKey: 'missing-feedback',
    })

    expect(result).toEqual({ status: 'state-unavailable' })
  })

  it('rejects cache rows whose user, session, and decision ownership disagree', async () => {
    const ownerState = await completedSessionWithDecision()
    const memberState = await completedSessionWithDecisionFor(member.id)

    await expect(
      getDb()
        .insert(futureLoadExplanationCache)
        .values(
          persistedExplanationRow({
            userId: owner.id,
            sessionId: memberState.sessionId,
            decisionId: memberState.decision.id,
            cacheKey: 'cross-user-cache-row',
          }),
        ),
    ).rejects.toMatchObject({
      cause: {
        code: '23503',
        constraint: 'future_load_explanation_cache_session_user_fk',
      },
    })

    await expect(
      getDb()
        .insert(futureLoadExplanationCache)
        .values(
          persistedExplanationRow({
            userId: member.id,
            sessionId: memberState.sessionId,
            decisionId: ownerState.decision.id,
            cacheKey: 'cross-session-decision-row',
          }),
        ),
    ).rejects.toMatchObject({
      cause: {
        code: '23503',
        constraint: 'future_load_explanation_cache_decision_session_fk',
      },
    })
  })

  it('rejects malformed cache provenance and duration at the database boundary', async () => {
    const { sessionId, decision } = await completedSessionWithDecision()
    const valid = persistedExplanationRow({
      userId: owner.id,
      sessionId,
      decisionId: decision.id,
      cacheKey: 'valid-cache-provenance',
    })

    await expect(
      getDb()
        .insert(futureLoadExplanationCache)
        .values({
          ...valid,
          cacheKey: 'not-a-sha256',
        }),
    ).rejects.toMatchObject({
      cause: {
        code: '23514',
        constraint: 'future_load_explanation_cache_hashes_check',
      },
    })
    await expect(
      getDb()
        .insert(futureLoadExplanationCache)
        .values({
          ...valid,
          id: newUuidV7(),
          modelId: '   ',
        }),
    ).rejects.toMatchObject({
      cause: {
        code: '23514',
        constraint: 'future_load_explanation_cache_identity_check',
      },
    })
    await expect(
      getDb()
        .insert(futureLoadExplanationCache)
        .values({
          ...valid,
          id: newUuidV7(),
          generateDurationMs: -1,
        }),
    ).rejects.toMatchObject({
      cause: {
        code: '23514',
        constraint: 'future_load_explanation_cache_duration_check',
      },
    })
  })

  it('rolls cache statement failures back to a savepoint after confirming active state', async () => {
    const { sessionId, decision } = await completedSessionWithDecision()
    const cache = createPostgresFutureLoadExplanationCache({
      testHooks: {
        beforeCacheStatement: async (transaction) => {
          await transaction.execute(
            sql`SELECT * FROM indigo_intentionally_missing_cache_relation`,
          )
        },
      },
    })
    const input = cachedExplanationInput({
      sessionId,
      decisionId: decision.id,
      cacheKey: 'savepoint-failure',
    })

    await expect(cache.getIfActive(input)).resolves.toEqual({
      status: 'cache-unavailable',
    })
    await expect(cache.putIfActive(input)).resolves.toEqual({
      status: 'cache-unavailable',
    })
    const [feedback] = await getDb()
      .select({ painReported: sessionFeedback.painReported })
      .from(sessionFeedback)
      .where(eq(sessionFeedback.sessionId, sessionId))
    expect(feedback).toEqual({ painReported: false })
  })

  it('maps an authoritative-state query failure to state-unavailable', async () => {
    const { sessionId, decision } = await completedSessionWithDecision()
    const cache = createPostgresFutureLoadExplanationCache({
      testHooks: {
        beforeAuthoritativeState: async (transaction) => {
          await transaction.execute(
            sql`SELECT * FROM indigo_intentionally_missing_state_relation`,
          )
        },
      },
    })

    await expect(
      cache.getIfActive({
        userId: owner.id,
        sessionId,
        decisionId: decision.id,
        cacheKey: 'state-failure',
      }),
    ).resolves.toEqual({ status: 'state-unavailable' })
  })

  it('refreshes creation provenance when repairing a same-key cache row', async () => {
    const { sessionId, decision } = await completedSessionWithDecision()
    const input = cachedExplanationInput({
      sessionId,
      decisionId: decision.id,
      cacheKey: 'repair-created-at',
    })
    const staleCreatedAt = new Date('2020-01-01T00:00:00.000Z')
    await getDb()
      .insert(futureLoadExplanationCache)
      .values({
        id: newUuidV7(),
        ...input,
        cacheKey: storageKeyFromExplanationCacheKey(input.cacheKey),
        prose: 'invalid stale content',
        createdAt: staleCreatedAt,
      })

    await expect(
      createPostgresFutureLoadExplanationCache().putIfActive(input),
    ).resolves.toEqual({ status: 'stored' })
    const [row] = await getDb()
      .select({
        prose: futureLoadExplanationCache.prose,
        createdAt: futureLoadExplanationCache.createdAt,
      })
      .from(futureLoadExplanationCache)
      .where(
        eq(
          futureLoadExplanationCache.cacheKey,
          storageKeyFromExplanationCacheKey(input.cacheKey),
        ),
      )
    expect(row?.prose).toBe(input.prose)
    expect(row?.createdAt.getTime()).toBeGreaterThan(staleCreatedAt.getTime())
  })

  it('replaces stale cache variants instead of accumulating rows for one decision', async () => {
    const { sessionId, decision } = await completedSessionWithDecision()
    const cache = createPostgresFutureLoadExplanationCache()
    const stale = cachedExplanationInput({
      sessionId,
      decisionId: decision.id,
      cacheKey: 'stale-model-and-prompt',
    })
    const current = {
      ...cachedExplanationInput({
        sessionId,
        decisionId: decision.id,
        cacheKey: 'current-model-and-prompt',
      }),
      prose: 'The current validated explanation.',
      modelContentDigest: 'd'.repeat(64),
      promptVersion: 'future-load.v3',
    }

    await expect(cache.putIfActive(stale)).resolves.toEqual({ status: 'stored' })
    await expect(cache.putIfActive(current)).resolves.toEqual({ status: 'stored' })

    const rows = await getDb()
      .select({
        cacheKey: futureLoadExplanationCache.cacheKey,
        prose: futureLoadExplanationCache.prose,
        promptVersion: futureLoadExplanationCache.promptVersion,
      })
      .from(futureLoadExplanationCache)
      .where(eq(futureLoadExplanationCache.decisionId, decision.id))
    expect(rows).toEqual([
      {
        cacheKey: storageKeyFromExplanationCacheKey(current.cacheKey),
        prose: current.prose,
        promptVersion: current.promptVersion,
      },
    ])
  })

  it('serializes publication before pain and purges the published row afterward', async () => {
    const { sessionId, decision } = await completedSessionWithDecision()
    const publicationLocked = deferred()
    const releasePublication = deferred()
    const cache = createPostgresFutureLoadExplanationCache({
      testHooks: {
        afterActiveState: async (operation) => {
          if (operation !== 'put') return
          publicationLocked.resolve()
          await releasePublication.promise
        },
      },
    })
    const publication = cache.putIfActive(
      cachedExplanationInput({
        sessionId,
        decisionId: decision.id,
        cacheKey: 'publication-before-pain',
      }),
    )
    await publicationLocked.promise

    const pain = reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'pain queued behind cache publication',
    })
    releasePublication.resolve()

    await expect(publication).resolves.toEqual({ status: 'stored' })
    await pain
    const rows = await getDb()
      .select({ id: futureLoadExplanationCache.id })
      .from(futureLoadExplanationCache)
      .where(eq(futureLoadExplanationCache.sessionId, sessionId))
    expect(rows).toHaveLength(0)
  })

  it('serializes pain before publication and rejects the queued cache write', async () => {
    const { sessionId, decision } = await completedSessionWithDecision()
    const painLocked = deferred()
    const releasePain = deferred()
    const pain = reportPain(
      {
        userId: owner.id,
        sessionId,
        commandId: newUuidV7(),
        details: 'pain linearized first',
      },
      {
        testHooks: {
          afterSafetyStateWritten: async () => {
            painLocked.resolve()
            await releasePain.promise
          },
        },
      },
    )
    await painLocked.promise

    const publication = createPostgresFutureLoadExplanationCache().putIfActive(
      cachedExplanationInput({
        sessionId,
        decisionId: decision.id,
        cacheKey: 'pain-before-publication',
      }),
    )
    releasePain.resolve()
    await pain

    await expect(publication).resolves.toEqual({
      status: 'invalidated',
      reason: 'post-completion-pain-report',
    })
    const rows = await getDb()
      .select({ id: futureLoadExplanationCache.id })
      .from(futureLoadExplanationCache)
      .where(eq(futureLoadExplanationCache.sessionId, sessionId))
    expect(rows).toHaveLength(0)
  })

  it('invalidates and purges cached prose after a performed-set correction', async () => {
    const { sessionId, setId, decision } = await completedSessionWithDecision()
    const cache = createPostgresFutureLoadExplanationCache()
    await expect(
      cache.putIfActive(
        cachedExplanationInput({
          sessionId,
          decisionId: decision.id,
          cacheKey: 'before-performed-set-correction',
        }),
      ),
    ).resolves.toEqual({ status: 'stored' })

    await correctPerformedSet({
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      reason: 'Corrected from the training log.',
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS + 2500,
      actualRepetitions: TEST_TARGET_REPETITIONS - 1,
      rpe: 9,
      note: 'Verified after the session.',
    })

    await expect(
      cache.putIfActive(
        cachedExplanationInput({
          sessionId,
          decisionId: decision.id,
          cacheKey: 'after-performed-set-correction',
        }),
      ),
    ).resolves.toEqual({
      status: 'invalidated',
      reason: 'training-fact-correction',
    })
    const rows = await getDb()
      .select({ id: futureLoadExplanationCache.id })
      .from(futureLoadExplanationCache)
      .where(eq(futureLoadExplanationCache.sessionId, sessionId))
    expect(rows).toHaveLength(0)
  })

  it('keeps pain invalidation semantics after a second post-completion report', async () => {
    const { sessionId } = await completedSessionWithDecision()
    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'first post-completion report',
    })
    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'second post-completion report',
    })

    const [correctionCount] = await getDb()
      .select({ value: count() })
      .from(sessionFeedbackCorrections)
      .where(eq(sessionFeedbackCorrections.sessionId, sessionId))
    expect(correctionCount?.value).toBe(2)

    const decisions = await getSessionFutureLoadDecisions(owner.id, sessionId)
    expect(decisions).not.toBeNull()
    expect(
      decisions?.every(
        (decision) => decision.invalidationCorrectionKind === 'session-feedback',
      ),
    ).toBe(true)

    const bundles = await getFutureLoadFactBundlesForSession(owner.id, sessionId)
    expect(bundles.status).toBe('available')
    if (bundles.status === 'available') {
      expect(bundles.bundles.length).toBeGreaterThan(0)
      expect(
        bundles.bundles.every(
          ({ factBundle }) =>
            factBundle.decision.invalidationReason === 'post-completion-pain-report',
        ),
      ).toBe(true)
    }
  })

  it('creates a source-linked pain hold without coalescing an unrelated eligibility hold', async () => {
    const { sessionId } = await startedSession()
    await setSessionPaused(owner.id, sessionId, true)
    const existingHoldId = newUuidV7()
    await getDb().insert(safetyHolds).values({
      id: existingHoldId,
      userId: owner.id,
      reasonCode: 'eligibility-restriction',
      details: 'already under review',
    })

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'pain while paused',
    })

    const [savedSession] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))
    const [feedback] = await getDb()
      .select()
      .from(sessionFeedback)
      .where(eq(sessionFeedback.sessionId, sessionId))
    const holds = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.userId, owner.id))
    const [safetyAudit] = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'session-safety-stop'))

    expect(savedSession?.status).toBe('paused')
    expect(feedback).toMatchObject({
      painReported: true,
      details: 'pain while paused',
    })
    expect(holds).toHaveLength(2)
    expect(holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: existingHoldId,
          reasonCode: 'eligibility-restriction',
          sourceSessionId: null,
        }),
        expect.objectContaining({
          reasonCode: 'session-pain-reported',
          sourceSessionId: sessionId,
          details: 'pain while paused',
        }),
      ]),
    )
    expect(safetyAudit?.metadata).toMatchObject({
      action: 'paused-and-held',
      coalescedWithExistingHold: false,
    })
  })

  it('keeps pain holds independent across different source sessions', async () => {
    const seeded = await seedCoherentProgram(owner.id)
    const priorSessionId = await startWorkout(
      owner.id,
      seeded.nextWorkoutId,
      newUuidV7(),
      new Date('2026-07-13T12:00:00.000Z'),
    )
    await reportPain({
      userId: owner.id,
      sessionId: priorSessionId,
      commandId: newUuidV7(),
      details: 'pain from the prior session',
    })
    await abandonWorkout(owner.id, priorSessionId, 'Prior pain report source.')
    const [priorHold] = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.sourceSessionId, priorSessionId))
    if (!priorHold) throw new Error('Prior session pain hold was not created.')
    await resolveSafetyHold({
      userId: owner.id,
      holdId: priorHold.id,
      commandId: newUuidV7(),
      reason: 'Prior session was abandoned and reviewed.',
      acknowledged: true,
    })

    const sessionId = await startWorkout(
      owner.id,
      seeded.currentWorkoutId,
      newUuidV7(),
      TEST_NOW,
    )

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'new pain from the current session',
    })

    const painHolds = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.reasonCode, 'session-pain-reported'))
    expect(painHolds).toHaveLength(2)
    expect(painHolds.map((hold) => hold.sourceSessionId).sort()).toEqual(
      [priorSessionId, sessionId].sort(),
    )
  })

  it('coalesces concurrent pain replays and rejects a reused identifier conflict', async () => {
    const { sessionId } = await startedSession()
    const command = {
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'sharp pain during the working set',
    }

    await Promise.all([reportPain(command), reportPain(command), reportPain(command)])
    await reportPain(command)
    await expect(
      reportPain({ ...command, details: 'different report under reused identifier' }),
    ).rejects.toMatchObject({ code: 'command.idempotency-conflict' })

    const [receiptCount] = await getDb()
      .select({ value: count() })
      .from(trainingCommandReceipts)
      .where(eq(trainingCommandReceipts.commandId, command.commandId))
    const [auditCount] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'session-safety-stop'))
    expect(receiptCount?.value).toBe(1)
    expect(auditCount?.value).toBe(1)
  })

  it('coalesces separate pain commands only for the exact same source session', async () => {
    const { sessionId } = await startedSession()

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'first report for this session',
    })
    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'additional context for the same session',
    })

    const painHolds = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.reasonCode, 'session-pain-reported'))
    expect(painHolds).toHaveLength(1)
    expect(painHolds[0]).toMatchObject({ sourceSessionId: sessionId })
  })

  it('reports a same-day abandoned session truthfully instead of returning planned', async () => {
    const { seeded, sessionId } = await startedSession()
    const reason = 'Equipment unavailable at gym.'
    await abandonWorkout(owner.id, sessionId, reason)

    const today = await getTodayState(owner.id, 'UTC', TEST_NOW)
    const [savedSession] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))
    const [abandonAudit] = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'workout-abandoned'))

    expect(savedSession).toMatchObject({
      status: 'abandoned',
      completedAt: null,
      abandonedReason: reason,
    })
    expect(savedSession?.abandonedAt).toBeInstanceOf(Date)
    expect(abandonAudit).toMatchObject({
      actorUserId: owner.id,
      subjectUserId: owner.id,
      entityId: sessionId,
      metadata: { reason },
    })
    expect(today).toEqual({
      kind: 'abandoned',
      sessionId,
      nextWorkout: {
        id: seeded.nextWorkoutId,
        date: '2026-07-13',
        name: 'Next development fixture',
      },
    })
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['too long', 'x'.repeat(301)],
  ] as const)('rejects an abandon with a %s reason', async (_case, reason) => {
    const { sessionId } = await startedSession()

    await expect(abandonWorkout(owner.id, sessionId, reason)).rejects.toMatchObject({
      code: 'input.invalid',
    })

    const [savedSession] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))
    const [abandonAudit] = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'workout-abandoned'))

    expect(savedSession).toMatchObject({ status: 'active', abandonedAt: null })
    expect(abandonAudit).toBeUndefined()
  })

  it('blocks a development session and history after switching to reviewed mode', async () => {
    const { sessionId, setId } = await startedSession()
    const previousContentMode = process.env.INDIGO_CONTENT_MODE
    const previousNodeEnv = process.env.NODE_ENV
    const configureMode = (
      contentMode: 'development' | 'reviewed',
      nodeEnv: 'test' | 'production',
    ) => {
      Reflect.set(process.env, 'INDIGO_CONTENT_MODE', contentMode)
      Reflect.set(process.env, 'NODE_ENV', nodeEnv)
      resetServerConfigForTests()
    }

    try {
      configureMode('reviewed', 'production')

      await expect(
        completeSet({
          userId: owner.id,
          sessionId,
          setId,
          commandId: newUuidV7(),
          actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
          actualRepetitions: TEST_TARGET_REPETITIONS,
          rpe: 8,
          note: 'must not be persisted in reviewed mode',
        }),
      ).rejects.toMatchObject({
        code: 'content.development-forbidden-in-production',
      })
      await setSessionPaused(owner.id, sessionId, true)
      await expect(setSessionPaused(owner.id, sessionId, false)).rejects.toMatchObject({
        code: 'content.development-forbidden-in-production',
      })

      const blockedSession = await getWorkoutSession(owner.id, sessionId)
      const blockedToday = await getTodayState(owner.id, 'UTC', TEST_NOW)
      expect(blockedSession?.contentEligibility).toEqual({
        eligible: false,
        code: 'content.development-forbidden-in-production',
      })
      expect(blockedToday).toMatchObject({
        kind: 'active',
        sessionId,
        contentEligibility: {
          eligible: false,
          code: 'content.development-forbidden-in-production',
        },
      })
      await expect(assertDatabaseReady(getPool())).rejects.toThrow(
        'reviewed content mode cannot start with 1 unreviewed program revisions',
      )

      configureMode('development', 'test')
      await setSessionPaused(owner.id, sessionId, false)
      await completeSet({
        userId: owner.id,
        sessionId,
        setId,
        commandId: newUuidV7(),
        actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
        actualRepetitions: TEST_TARGET_REPETITIONS,
        rpe: 8,
        note: null,
      })

      configureMode('reviewed', 'production')
      await expect(
        completeWorkout({
          userId: owner.id,
          sessionId,
          commandId: newUuidV7(),
          noPainAttested: true,
        }),
      ).rejects.toMatchObject({
        code: 'content.development-forbidden-in-production',
      })

      const [savedSession] = await getDb()
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.id, sessionId))
      const feedback = await getDb()
        .select()
        .from(sessionFeedback)
        .where(eq(sessionFeedback.sessionId, sessionId))
      const decisions = await getDb()
        .select()
        .from(adjustmentDecisions)
        .where(eq(adjustmentDecisions.sessionId, sessionId))

      expect(savedSession).toMatchObject({ status: 'active', completedAt: null })
      expect(feedback).toEqual([])
      expect(decisions).toEqual([])
      expect(await getCompletedSessions(owner.id)).toEqual([])
    } finally {
      if (previousContentMode === undefined)
        Reflect.deleteProperty(process.env, 'INDIGO_CONTENT_MODE')
      else Reflect.set(process.env, 'INDIGO_CONTENT_MODE', previousContentMode)
      if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV')
      else Reflect.set(process.env, 'NODE_ENV', previousNodeEnv)
      resetServerConfigForTests()
    }
  })

  it('links a new pain hold to its source session and blocks resolution while live', async () => {
    const { sessionId } = await startedSession()

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'sharp shoulder pain',
    })

    const [hold] = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.userId, owner.id))
    expect(hold).toMatchObject({
      sourceSessionId: sessionId,
      reasonCode: 'session-pain-reported',
    })
    expect(await getTodayState(owner.id, 'UTC', TEST_NOW)).toMatchObject({
      kind: 'hold',
      holdId: hold.id,
      resolutionAvailability: {
        kind: 'requires-abandonment',
        sessionId,
      },
    })

    await expect(
      resolveSafetyHold({
        userId: owner.id,
        holdId: hold.id,
        commandId: newUuidV7(),
        reason: 'Pain has subsided.',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({ code: 'hold.live-session-not-abandoned' })
  })

  it('resolves a pain hold after abandoning the source session and records an append-only resolution', async () => {
    const { sessionId } = await startedSession()
    const reason = 'Shoulder mobility work completed; I am choosing to resume.'

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'shoulder pain',
    })
    const [hold] = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.userId, owner.id))
    await abandonWorkout(owner.id, sessionId, 'Equipment unavailable at gym.')
    expect(await getTodayState(owner.id, 'UTC', TEST_NOW)).toMatchObject({
      kind: 'hold',
      holdId: hold.id,
      resolutionAvailability: { kind: 'available' },
    })

    const commandId = newUuidV7()
    await resolveSafetyHold({
      userId: owner.id,
      holdId: hold.id,
      commandId,
      reason,
      acknowledged: true,
    })

    const [resolution] = await getDb()
      .select()
      .from(safetyHoldResolutions)
      .where(eq(safetyHoldResolutions.holdId, hold.id))
    const [audit] = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'safety-hold-resolved'))
    const [receipt] = await getDb()
      .select()
      .from(trainingCommandReceipts)
      .where(eq(trainingCommandReceipts.commandId, commandId))

    expect(resolution).toMatchObject({
      userId: owner.id,
      reason,
      acknowledged: true,
    })
    expect(audit).toMatchObject({
      actorUserId: owner.id,
      subjectUserId: owner.id,
      entityId: hold.id,
      metadata: {
        sourceSessionId: sessionId,
        reasonLength: reason.length,
        acknowledged: true,
      },
    })
    expect(receipt).toMatchObject({
      commandType: 'resolve-safety-hold',
      sessionId,
      targetId: hold.id,
    })

    const today = await getTodayState(owner.id, 'UTC', TEST_NOW)
    expect(today.kind).not.toBe('hold')
  })

  it('resolves a completed-session pain hold only after durable H1 invalidation', async () => {
    const { sessionId, setId } = await startedSession()
    await completeSet({
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 8,
      note: null,
    })
    await completeWorkout({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      noPainAttested: true,
    })

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'pain reported after completion',
    })
    const [hold] = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.userId, owner.id))

    expect(await getTodayState(owner.id, 'UTC', TEST_NOW)).toMatchObject({
      kind: 'hold',
      holdId: hold.id,
      resolutionAvailability: { kind: 'available' },
    })

    await resolveSafetyHold({
      userId: owner.id,
      holdId: hold.id,
      commandId: newUuidV7(),
      reason: 'Choosing to continue with qualified guidance.',
      acknowledged: true,
    })
    const resolutions = await getDb()
      .select()
      .from(safetyHoldResolutions)
      .where(eq(safetyHoldResolutions.holdId, hold.id))
    expect(resolutions).toHaveLength(1)
    expect(await getTodayState(owner.id, 'UTC', TEST_NOW)).toMatchObject({
      kind: 'program-required',
    })
  })

  it('denies self-resolution of a source-less eligibility hold', async () => {
    const holdId = newUuidV7()
    await getDb().insert(safetyHolds).values({
      id: holdId,
      userId: owner.id,
      sourceSessionId: null,
      reasonCode: 'eligibility-restriction',
      details: 'source-less hold fixture',
    })

    expect(await getTodayState(owner.id, 'UTC', TEST_NOW)).toMatchObject({
      kind: 'hold',
      holdId,
      resolutionAvailability: {
        kind: 'blocked',
        reason: 'not-session-pain-hold',
      },
    })
    await expect(
      resolveSafetyHold({
        userId: owner.id,
        holdId,
        commandId: newUuidV7(),
        reason: 'Attempted self-resolution.',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({ code: 'hold.not-resolvable' })

    const [receiptCount] = await getDb()
      .select({ value: count() })
      .from(trainingCommandReceipts)
    const [resolutionCount] = await getDb()
      .select({ value: count() })
      .from(safetyHoldResolutions)
    expect(receiptCount?.value).toBe(0)
    expect(resolutionCount?.value).toBe(0)
  })

  it('prevents another user from resolving the hold and preserves the live session', async () => {
    const { sessionId } = await startedSession()

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'knee pain',
    })
    const [hold] = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.userId, owner.id))
    await abandonWorkout(owner.id, sessionId, 'Equipment unavailable at gym.')

    await expect(
      resolveSafetyHold({
        userId: member.id,
        holdId: hold.id,
        commandId: newUuidV7(),
        reason: 'I am an attacker.',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({ code: 'hold.not-found' })

    const [resolutionCount] = await getDb()
      .select({ value: count() })
      .from(safetyHoldResolutions)
    expect(resolutionCount?.value).toBe(0)
  })

  it('coalesces concurrent hold resolutions and rejects a reused command identifier conflict', async () => {
    const { sessionId } = await startedSession()

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'wrist pain',
    })
    const [hold] = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.userId, owner.id))
    await abandonWorkout(owner.id, sessionId, 'Equipment unavailable at gym.')

    const command = {
      userId: owner.id,
      holdId: hold.id,
      commandId: newUuidV7(),
      reason: 'Resolution replay test.',
      acknowledged: true,
    }

    await Promise.all([
      resolveSafetyHold(command),
      resolveSafetyHold(command),
      resolveSafetyHold(command),
    ])
    await resolveSafetyHold(command)
    await expect(
      resolveSafetyHold({
        ...command,
        reason: 'Different payload under reused identifier.',
      }),
    ).rejects.toMatchObject({ code: 'command.idempotency-conflict' })

    const [resolutionCount] = await getDb()
      .select({ value: count() })
      .from(safetyHoldResolutions)
    const [auditCount] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'safety-hold-resolved'))
    const [receiptCount] = await getDb()
      .select({ value: count() })
      .from(trainingCommandReceipts)
      .where(eq(trainingCommandReceipts.commandId, command.commandId))

    expect(resolutionCount?.value).toBe(1)
    expect(auditCount?.value).toBe(1)
    expect(receiptCount?.value).toBe(1)
  })

  it('requires acknowledgement and a non-empty reason to resolve a hold', async () => {
    const { sessionId } = await startedSession()

    await reportPain({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      details: 'elbow pain',
    })
    const [hold] = await getDb()
      .select()
      .from(safetyHolds)
      .where(eq(safetyHolds.userId, owner.id))
    await abandonWorkout(owner.id, sessionId, 'Equipment unavailable at gym.')

    await expect(
      resolveSafetyHold({
        userId: owner.id,
        holdId: hold.id,
        commandId: newUuidV7(),
        reason: '',
        acknowledged: true,
      }),
    ).rejects.toMatchObject({ code: 'input.invalid' })
    await expect(
      resolveSafetyHold({
        userId: owner.id,
        holdId: hold.id,
        commandId: newUuidV7(),
        reason: 'Reason provided.',
        acknowledged: false,
      }),
    ).rejects.toMatchObject({ code: 'hold.ack-required' })

    const [resolutionCount] = await getDb()
      .select({ value: count() })
      .from(safetyHoldResolutions)
    expect(resolutionCount?.value).toBe(0)
  })
})
