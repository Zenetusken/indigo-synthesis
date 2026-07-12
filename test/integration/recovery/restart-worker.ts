import { eq, sql } from 'drizzle-orm'
import {
  completeSet,
  getTodayState,
  getWorkoutSession,
  setSessionPaused,
  startWorkout,
} from '@/modules/training/application/workouts'
import { closeDb, getDb } from '@/platform/db/client'
import {
  athleteProfiles,
  exercisePrescriptions,
  plannedWorkouts,
  programRevisions,
  programs,
  setPrescriptions,
  user,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

function normalizeSession(
  session: NonNullable<Awaited<ReturnType<typeof getWorkoutSession>>>,
) {
  return {
    id: session.id,
    status: session.status,
    startedAt: session.startedAt.toISOString(),
    pausedAt: session.pausedAt?.toISOString() ?? null,
    completedAt: session.completedAt?.toISOString() ?? null,
    optimisticVersion: session.optimisticVersion,
    plannedWorkout: session.plannedWorkout,
    exercises: session.exercises.map((exercise) => ({
      ...exercise,
      sets: exercise.sets.map((set) => ({
        ...set,
        confirmedAt: set.confirmedAt?.toISOString() ?? null,
        skippedAt: set.skippedAt?.toISOString() ?? null,
      })),
    })),
    feedback: session.feedback,
  }
}

async function writeActiveSession() {
  const db = getDb()
  const userId = newUuidV7()
  const programId = newUuidV7()
  const revisionId = newUuidV7()
  const plannedWorkoutId = newUuidV7()
  const exerciseId = newUuidV7()

  await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT set_config('indigo.user_creation_mode', 'bootstrap-owner', true)`,
    )
    await transaction.insert(user).values({
      id: userId,
      name: 'Restart Test Owner',
      email: 'restart-owner@example.test',
      emailVerified: false,
    })
  })
  await db.insert(athleteProfiles).values({
    userId,
    units: 'metric',
    timezone: 'UTC',
    goal: 'general-strength',
    experience: 'familiar',
    sessionMinutes: 60,
    adultAttested: true,
    techniqueAttested: true,
    restrictionStatus: 'none',
    limitations: null,
    confirmedAt: new Date('2026-07-11T12:00:00.000Z'),
  })
  await db.insert(programs).values({ id: programId, userId, status: 'active' })
  await db.insert(programRevisions).values({
    id: revisionId,
    programId,
    revisionNumber: 1,
    status: 'draft',
    engineVersion: 'restart-test-engine-v1',
    methodologyId: 'restart-test-methodology',
    methodologyVersion: '1.0.0',
    methodologyReviewStatus: 'development',
    templateId: 'restart-test-template',
    templateVersion: '1.0.0',
    templateReviewStatus: 'development',
    normalizedInputHash: 'restart-input-hash',
    outputHash: 'restart-output-hash',
    normalizedInput: { purpose: 'restart-recovery-integration-test' },
    outputSnapshot: { purpose: 'restart-recovery-integration-test' },
    warnings: [],
    manualReviewRequired: true,
  })
  await db.insert(plannedWorkouts).values({
    id: plannedWorkoutId,
    revisionId,
    scheduledDate: '2026-07-11',
    ordinal: 1,
    programOrdinal: 1,
    slotCode: 'A',
    name: 'Restart recovery session',
  })
  await db.insert(exercisePrescriptions).values({
    id: exerciseId,
    plannedWorkoutId,
    exerciseCode: 'development.back-squat',
    exerciseName: 'Back squat',
    ordinal: 1,
    safetyTier: 'standard',
    rationaleCode: 'restart.integration-fixture',
  })
  await db.insert(setPrescriptions).values([
    {
      id: newUuidV7(),
      exercisePrescriptionId: exerciseId,
      ordinal: 1,
      setKind: 'working',
      targetLoadGrams: 60_000,
      targetRepetitions: 5,
      restSeconds: 180,
    },
    {
      id: newUuidV7(),
      exercisePrescriptionId: exerciseId,
      ordinal: 2,
      setKind: 'working',
      targetLoadGrams: 60_000,
      targetRepetitions: 5,
      restSeconds: 180,
    },
  ])
  await db
    .update(programRevisions)
    .set({ status: 'active', activatedAt: new Date() })
    .where(eq(programRevisions.id, revisionId))

  const sessionId = await startWorkout(
    userId,
    plannedWorkoutId,
    newUuidV7(),
    new Date('2026-07-11T12:00:00.000Z'),
  )
  const started = await getWorkoutSession(userId, sessionId)
  const firstSet = started?.exercises[0]?.sets[0]
  if (!firstSet) throw new Error('Restart fixture did not create its first set.')

  const setCommandId = newUuidV7()
  await completeSet({
    userId,
    sessionId,
    setId: firstSet.id,
    commandId: setCommandId,
    actualLoadGrams: 62_500,
    actualRepetitions: 5,
    rpe: 8,
    note: 'Persist this exact set across the process boundary.',
  })
  await setSessionPaused(userId, sessionId, true)

  const session = await getWorkoutSession(userId, sessionId)
  if (!session) throw new Error('Restart fixture session disappeared before shutdown.')
  const today = await getTodayState(userId, 'UTC', new Date('2026-07-11T12:00:00Z'))
  return {
    pid: process.pid,
    userId,
    sessionId,
    setCommandId,
    session: normalizeSession(session),
    today,
  }
}

async function readActiveSession(
  userId: string,
  sessionId: string,
  setCommandId: string,
) {
  const beforeReplay = await getWorkoutSession(userId, sessionId)
  const firstSet = beforeReplay?.exercises[0]?.sets[0]
  if (!firstSet) throw new Error('Persisted restart fixture set was not recovered.')
  await completeSet({
    userId,
    sessionId,
    setId: firstSet.id,
    commandId: setCommandId,
    actualLoadGrams: 62_500,
    actualRepetitions: 5,
    rpe: 8,
    note: 'Persist this exact set across the process boundary.',
  })
  const session = await getWorkoutSession(userId, sessionId)
  if (!session) throw new Error('Persisted restart fixture session was not recovered.')
  const today = await getTodayState(userId, 'UTC', new Date('2026-07-11T12:00:00Z'))
  return {
    pid: process.pid,
    userId,
    sessionId,
    setCommandId,
    session: normalizeSession(session),
    today,
  }
}

const [phase, userId, sessionId, setCommandId] = process.argv.slice(2)

try {
  if (phase === 'write') {
    console.log(JSON.stringify(await writeActiveSession()))
  } else if (phase === 'read' && userId && sessionId && setCommandId) {
    console.log(JSON.stringify(await readActiveSession(userId, sessionId, setCommandId)))
  } else {
    throw new Error(
      'Expected restart worker phase write or read USER_ID SESSION_ID COMMAND_ID.',
    )
  }
} finally {
  await closeDb()
}
