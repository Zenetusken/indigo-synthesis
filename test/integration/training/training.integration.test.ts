import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AuthenticatedActor,
  deriveIdentityRole,
} from '@/modules/identity/application/actor'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/modules/identity/bootstrap/owner-bootstrap'
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
import {
  abandonWorkout,
  completeSet,
  completeWorkout,
  getCompletedSessions,
  getTodayState,
  getWorkoutSession,
  reportPain,
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
import { assertDatabaseReady } from '@/platform/db/preflight'
import {
  adjustmentDecisions,
  auditEvents,
  exercisePrescriptions,
  performedSets,
  plannedWorkouts,
  programRevisionLineage,
  programRevisions,
  programs,
  safetyHolds,
  sessionFeedback,
  setPrescriptions,
  trainingCommandReceipts,
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
    const { seeded, sessionId } = await startedSession()
    if (markFutureUsed) {
      await getDb()
        .insert(workoutSessions)
        .values({
          id: newUuidV7(),
          userId: owner.id,
          plannedWorkoutId: seeded.nextWorkoutId,
          plannedWorkoutName: 'Previously consumed future workout',
          scheduledDate: TEST_NEXT_DAY,
          slotCode: 'B',
          status: 'abandoned',
          startedAt: new Date('2026-07-10T10:00:00.000Z'),
          abandonedAt: new Date('2026-07-10T10:05:00.000Z'),
          startCommandId: newUuidV7(),
        })
    }
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
    const [safetyAudit] = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'session-safety-stop'))

    expect(feedback).toMatchObject({
      painReported: true,
      details: 'reported after completion',
    })
    expect(safetyAudit).toMatchObject({
      actorUserId: owner.id,
      subjectUserId: owner.id,
      entityId: sessionId,
      metadata: {
        action: 'post-completion-hold',
        coalescedWithExistingHold: false,
      },
    })
    await expect(
      getDb()
        .update(sessionFeedback)
        .set({ details: 'correction mode must not escape its transaction' })
        .where(eq(sessionFeedback.sessionId, sessionId)),
    ).rejects.toMatchObject({ cause: { code: '55000' } })
  })

  it('accepts pain from a paused session and coalesces an existing safety hold', async () => {
    const { sessionId } = await startedSession()
    await setSessionPaused(owner.id, sessionId, true)
    const existingHoldId = newUuidV7()
    await getDb().insert(safetyHolds).values({
      id: existingHoldId,
      userId: owner.id,
      reasonCode: 'pre-existing-review',
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
    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({
      id: existingHoldId,
      reasonCode: 'pre-existing-review',
      details: 'already under review',
      clearedAt: null,
    })
    expect(safetyAudit?.metadata).toMatchObject({
      action: 'paused-and-held',
      coalescedWithExistingHold: true,
    })
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
      await expect(assertDatabaseReady()).rejects.toThrow(
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
})
