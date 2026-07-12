import { count, eq } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AuthenticatedActor,
  deriveIdentityRole,
} from '@/modules/identity/application/actor'
import { getAuth, resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { activateProgram } from '@/modules/programs/application/programs'
import {
  abandonWorkout,
  completeSet,
  completeWorkout,
  getCompletedSessions,
  getTodayState,
  getWorkoutSession,
  reportPain,
  setSessionPaused,
  startWorkout,
} from '@/modules/training/application/workouts'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import { migrateDatabase } from '@/platform/db/migrate'
import { assertDatabaseReady } from '@/platform/db/preflight'
import {
  adjustmentDecisions,
  auditEvents,
  exercisePrescriptions,
  performedSets,
  plannedWorkouts,
  programRevisions,
  programs,
  safetyHolds,
  sessionFeedback,
  setPrescriptions,
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

type TestIdentity = {
  readonly id: string
  readonly name: string
  readonly email: string
}

type AuthBody = {
  readonly user?: TestIdentity
}

let sourceDatabaseUrl: string
let disposableDatabaseName: string
let administrationClient: Client
let administrationConnected = false
let disposableDatabaseCreated = false
let owner: TestIdentity
let member: TestIdentity

function quotedIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

async function signUpOwner(): Promise<TestIdentity> {
  const origin = getServerConfig().appOrigin
  const response = await getAuth().handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        name: 'Training Integration Owner',
        email: 'training-owner@example.test',
        password: 'training-owner-password',
      }),
    }),
  )

  if (!response.ok) {
    throw new Error(`Owner signup failed with status ${response.status}.`)
  }
  const body = (await response.json()) as AuthBody
  if (!body.user) throw new Error('Owner signup returned no user.')
  return body.user
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

beforeAll(async () => {
  const configuredDatabaseUrl = process.env.DATABASE_URL
  if (!configuredDatabaseUrl) {
    throw new Error('DATABASE_URL is required for training integration tests.')
  }

  sourceDatabaseUrl = configuredDatabaseUrl
  disposableDatabaseName = `indigo_training_${process.pid}_${Date.now()}`
  administrationClient = new Client({ connectionString: sourceDatabaseUrl })
  await administrationClient.connect()
  administrationConnected = true
  await administrationClient.query(
    `CREATE DATABASE ${quotedIdentifier(disposableDatabaseName)}`,
  )
  disposableDatabaseCreated = true

  const disposableUrl = new URL(sourceDatabaseUrl)
  disposableUrl.pathname = `/${disposableDatabaseName}`
  process.env.DATABASE_URL = disposableUrl.toString()
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

  if (sourceDatabaseUrl) {
    process.env.DATABASE_URL = sourceDatabaseUrl
    resetServerConfigForTests()
  }

  if (administrationConnected) {
    try {
      if (disposableDatabaseCreated) {
        await administrationClient.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [disposableDatabaseName],
        )
        await administrationClient.query(
          `DROP DATABASE IF EXISTS ${quotedIdentifier(disposableDatabaseName)}`,
        )
      }
    } finally {
      await administrationClient.end()
    }
  }
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
    const [adjustedWorkout] = await getDb()
      .select()
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.revisionId, adjustedRevision.id))
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

    expect(revisions).toHaveLength(2)
    expect(originalRevision).toMatchObject({
      status: 'superseded',
      outputHash: seeded.originalOutputHash,
    })
    expect(originalTarget?.targetLoadGrams).toBe(TEST_TARGET_LOAD_GRAMS)
    expect(adjustedRevision.status).toBe('active')
    expect(adjustedRevision.outputHash).not.toBe(seeded.originalOutputHash)
    expect(adjustedTarget?.targetLoadGrams).toBe(TEST_TARGET_LOAD_GRAMS + 1_000)
    expect(completionAudits?.value).toBe(1)
    expect(revisionAudits?.value).toBe(1)
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

    await reportPain(owner.id, sessionId, 'reported after completion')

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

    await reportPain(owner.id, sessionId, 'pain while paused')

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

  it('reports a same-day abandoned session truthfully instead of returning planned', async () => {
    const { seeded, sessionId } = await startedSession()
    await abandonWorkout(owner.id, sessionId)

    const today = await getTodayState(owner.id, 'UTC', TEST_NOW)
    const [savedSession] = await getDb()
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.id, sessionId))

    expect(savedSession).toMatchObject({
      status: 'abandoned',
      completedAt: null,
    })
    expect(savedSession?.abandonedAt).toBeInstanceOf(Date)
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
