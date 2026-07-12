import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { ZodType } from 'zod'
import { formatIsoDateInTimezone } from '@/modules/athletes/domain/time'
import { decideDevelopmentLoadAdjustment } from '@/modules/methodology/domain/adjustment'
import {
  type CanonicalValue,
  canonicalSha256,
} from '@/modules/methodology/domain/canonical'
import {
  DEVELOPMENT_EXERCISE_IDS,
  type DevelopmentExerciseId,
} from '@/modules/methodology/domain/development-fixture'
import { getProgramOverview } from '@/modules/programs/application/programs'
import { evaluatePersistedContentEligibility } from '@/modules/programs/domain/content-eligibility'
import {
  abandonWorkoutCommandSchema,
  completeSetCommandSchema,
  completeWorkoutCommandSchema,
  reportPainCommandSchema,
  sessionPauseCommandSchema,
  skipSetCommandSchema,
  startWorkoutCommandSchema,
} from '@/modules/training/domain/commands'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from '@/platform/db/client'
import {
  adjustmentDecisions,
  athleteProfiles,
  auditEvents,
  exercisePrescriptions,
  performedSets,
  plannedWorkouts,
  programRevisions,
  programs,
  safetyHolds,
  sessionExercises,
  sessionFeedback,
  setPrescriptions,
  workoutSessions,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

export class WorkoutCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'WorkoutCommandError'
  }
}

function parseWorkoutCommand<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data

  throw new WorkoutCommandError(
    'input.invalid',
    `Invalid workout command: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'command'}: ${issue.message}`)
      .join('; ')}`,
  )
}

const developmentExerciseIds = new Set<string>(DEVELOPMENT_EXERCISE_IDS)

export type TodayState =
  | { readonly kind: 'program-required' }
  | {
      readonly kind: 'active'
      readonly sessionId: string
      readonly status: string
      readonly contentEligibility: ReturnType<typeof evaluatePersistedContentEligibility>
    }
  | {
      readonly kind: 'planned'
      readonly workout: NonNullable<
        Awaited<ReturnType<typeof getProgramOverview>>
      >['workouts'][number]
    }
  | {
      readonly kind: 'completed'
      readonly sessionId: string
      readonly nextWorkout: {
        readonly id: string
        readonly date: string
        readonly name: string
      } | null
    }
  | {
      readonly kind: 'abandoned'
      readonly sessionId: string
      readonly nextWorkout: {
        readonly id: string
        readonly date: string
        readonly name: string
      } | null
    }
  | {
      readonly kind: 'rest-day'
      readonly nextWorkout: {
        readonly id: string
        readonly date: string
        readonly name: string
      } | null
    }

export type WorkoutSetView = {
  readonly id: string
  readonly ordinal: number
  readonly status: string
  readonly targetLoadGrams: number
  readonly targetRepetitions: number
  readonly restSeconds: number
  readonly actualLoadGrams: number | null
  readonly actualRepetitions: number | null
  readonly rpe: number | null
  readonly confirmedAt: Date | null
  readonly skippedAt: Date | null
  readonly skipReason: string | null
  readonly note: string | null
}

export type WorkoutExerciseView = {
  readonly id: string
  readonly exerciseCode: string
  readonly exerciseName: string
  readonly ordinal: number
  readonly rationaleCode: string
  readonly priorComparablePerformance: {
    readonly completedAt: Date
    readonly sets: readonly {
      readonly loadGrams: number
      readonly repetitions: number
      readonly rpe: number | null
    }[]
  } | null
  readonly sets: readonly WorkoutSetView[]
}

export type WorkoutSessionView = {
  readonly id: string
  readonly status: string
  readonly startedAt: Date
  readonly pausedAt: Date | null
  readonly completedAt: Date | null
  readonly optimisticVersion: number
  readonly contentEligibility: ReturnType<typeof evaluatePersistedContentEligibility>
  readonly plannedWorkout: {
    readonly id: string
    readonly name: string
    readonly scheduledDate: string
    readonly slotCode: string
  }
  readonly exercises: readonly WorkoutExerciseView[]
  readonly feedback: {
    readonly painReported: boolean
    readonly details: string | null
  } | null
}

export async function getTodayState(
  userId: string,
  timezone: string,
  now = new Date(),
): Promise<TodayState> {
  const db = getDb()
  const [activeSession] = await db
    .select({
      id: workoutSessions.id,
      status: workoutSessions.status,
      methodologyReviewStatus: programRevisions.methodologyReviewStatus,
      templateReviewStatus: programRevisions.templateReviewStatus,
    })
    .from(workoutSessions)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId))
    .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
    .where(
      and(
        eq(workoutSessions.userId, userId),
        inArray(workoutSessions.status, ['active', 'paused']),
      ),
    )
    .limit(1)

  if (activeSession) {
    return {
      kind: 'active',
      sessionId: activeSession.id,
      status: activeSession.status,
      contentEligibility: evaluatePersistedContentEligibility({
        contentMode: getServerConfig().contentMode,
        methodologyStatus: activeSession.methodologyReviewStatus,
        templateStatus: activeSession.templateReviewStatus,
      }),
    }
  }

  const program = await getProgramOverview(userId)
  if (program?.programStatus !== 'active') return { kind: 'program-required' }

  const today = formatIsoDateInTimezone(now, timezone)
  const next = program.workouts.find((entry) => entry.scheduledDate > today) ?? null
  const nextWorkout = next
    ? { id: next.id, date: next.scheduledDate, name: next.name }
    : null

  const [concludedSession] = await db
    .select({ id: workoutSessions.id, status: workoutSessions.status })
    .from(workoutSessions)
    .where(
      and(
        eq(workoutSessions.userId, userId),
        eq(workoutSessions.scheduledDate, today),
        inArray(workoutSessions.status, ['completed', 'abandoned']),
      ),
    )
    .limit(1)

  if (concludedSession?.status === 'completed') {
    return { kind: 'completed', sessionId: concludedSession.id, nextWorkout }
  }
  if (concludedSession?.status === 'abandoned') {
    return { kind: 'abandoned', sessionId: concludedSession.id, nextWorkout }
  }

  const workout = program.workouts.find((entry) => entry.scheduledDate === today)
  if (!workout) return { kind: 'rest-day', nextWorkout }

  return { kind: 'planned', workout }
}

export async function startWorkout(
  userId: string,
  plannedWorkoutId: string,
  commandId: string,
  now = new Date(),
): Promise<string> {
  const command = parseWorkoutCommand(startWorkoutCommandSchema, {
    plannedWorkoutId,
    commandId,
  })

  return getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    )
    const [existing] = await transaction
      .select({
        id: workoutSessions.id,
        plannedWorkoutId: workoutSessions.plannedWorkoutId,
      })
      .from(workoutSessions)
      .where(
        and(
          eq(workoutSessions.userId, userId),
          inArray(workoutSessions.status, ['active', 'paused']),
        ),
      )
      .for('update')
      .limit(1)

    if (existing) {
      if (existing.plannedWorkoutId === command.plannedWorkoutId) return existing.id
      throw new WorkoutCommandError(
        'session.already-active',
        'Resume the existing session before starting another.',
      )
    }

    const [hold] = await transaction
      .select({ id: safetyHolds.id })
      .from(safetyHolds)
      .where(and(eq(safetyHolds.userId, userId), isNull(safetyHolds.clearedAt)))
      .limit(1)
    if (hold) {
      throw new WorkoutCommandError(
        'safety.hold-active',
        'An active safety hold blocks workout start.',
      )
    }

    const [ownedWorkout] = await transaction
      .select({
        id: plannedWorkouts.id,
        name: plannedWorkouts.name,
        scheduledDate: plannedWorkouts.scheduledDate,
        slotCode: plannedWorkouts.slotCode,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateReviewStatus: programRevisions.templateReviewStatus,
        timezone: athleteProfiles.timezone,
      })
      .from(plannedWorkouts)
      .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
      .innerJoin(programs, eq(programs.id, programRevisions.programId))
      .innerJoin(athleteProfiles, eq(athleteProfiles.userId, programs.userId))
      .where(
        and(
          eq(plannedWorkouts.id, command.plannedWorkoutId),
          eq(programs.userId, userId),
          eq(programs.status, 'active'),
          eq(programRevisions.status, 'active'),
        ),
      )
      .limit(1)
    if (!ownedWorkout) {
      throw new WorkoutCommandError('workout.not-found', 'Planned workout not found.')
    }
    if (
      ownedWorkout.scheduledDate !== formatIsoDateInTimezone(now, ownedWorkout.timezone)
    ) {
      throw new WorkoutCommandError(
        'workout.not-scheduled-today',
        'Only the workout scheduled for your current local date can be started.',
      )
    }
    const eligibility = evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: ownedWorkout.methodologyReviewStatus,
      templateStatus: ownedWorkout.templateReviewStatus,
    })
    if (!eligibility.eligible) {
      throw new WorkoutCommandError(
        eligibility.code,
        'The persisted content release is not eligible to start.',
      )
    }

    const exercises = await transaction
      .select()
      .from(exercisePrescriptions)
      .where(eq(exercisePrescriptions.plannedWorkoutId, command.plannedWorkoutId))
      .orderBy(asc(exercisePrescriptions.ordinal))
    const unsafeExercise = exercises.find(
      (exercise) => exercise.safetyTier !== 'standard',
    )
    if (unsafeExercise) {
      throw new WorkoutCommandError(
        unsafeExercise.safetyTier === 'advanced'
          ? 'safety.advanced-ineligible'
          : 'safety.prescription-prohibited',
        'This prescription is not eligible to start.',
      )
    }
    const prescriptionSets = await transaction
      .select()
      .from(setPrescriptions)
      .where(
        inArray(
          setPrescriptions.exercisePrescriptionId,
          exercises.map((exercise) => exercise.id),
        ),
      )
      .orderBy(asc(setPrescriptions.ordinal))

    const sessionId = newUuidV7()
    await transaction.insert(workoutSessions).values({
      id: sessionId,
      userId,
      plannedWorkoutId: command.plannedWorkoutId,
      plannedWorkoutName: ownedWorkout.name,
      scheduledDate: ownedWorkout.scheduledDate,
      slotCode: ownedWorkout.slotCode,
      status: 'active',
      startedAt: now,
      startCommandId: command.commandId,
    })

    for (const exercise of exercises) {
      const sessionExerciseId = newUuidV7()
      await transaction.insert(sessionExercises).values({
        id: sessionExerciseId,
        sessionId,
        exerciseCode: exercise.exerciseCode,
        exerciseName: exercise.exerciseName,
        ordinal: exercise.ordinal,
        safetyTier: exercise.safetyTier,
        rationaleCode: exercise.rationaleCode,
        originalExerciseCode: exercise.exerciseCode,
      })
      await transaction.insert(performedSets).values(
        prescriptionSets
          .filter((set) => set.exercisePrescriptionId === exercise.id)
          .map((set) => ({
            id: newUuidV7(),
            sessionExerciseId,
            ordinal: set.ordinal,
            status: 'pending',
            targetLoadGrams: set.targetLoadGrams,
            targetRepetitions: set.targetRepetitions,
            restSeconds: set.restSeconds,
          })),
      )
    }

    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: userId,
      subjectUserId: userId,
      eventType: 'workout-started',
      entityType: 'workout-session',
      entityId: sessionId,
      metadata: { plannedWorkoutId: command.plannedWorkoutId },
    })

    return sessionId
  })
}

export async function getWorkoutSession(
  userId: string,
  sessionId: string,
): Promise<WorkoutSessionView | null> {
  const db = getDb()
  const [sessionContext] = await db
    .select({
      session: workoutSessions,
      methodologyReviewStatus: programRevisions.methodologyReviewStatus,
      templateReviewStatus: programRevisions.templateReviewStatus,
    })
    .from(workoutSessions)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId))
    .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
    .where(and(eq(workoutSessions.id, sessionId), eq(workoutSessions.userId, userId)))
    .limit(1)
  if (!sessionContext) return null
  const session = sessionContext.session

  const exercises = await db
    .select()
    .from(sessionExercises)
    .where(eq(sessionExercises.sessionId, sessionId))
    .orderBy(asc(sessionExercises.ordinal))
  const sets = await db
    .select()
    .from(performedSets)
    .where(
      inArray(
        performedSets.sessionExerciseId,
        exercises.map((exercise) => exercise.id),
      ),
    )
    .orderBy(asc(performedSets.ordinal))
  const [feedback] = await db
    .select()
    .from(sessionFeedback)
    .where(eq(sessionFeedback.sessionId, sessionId))
    .limit(1)
  const priorRows =
    exercises.length > 0
      ? await db
          .select({
            sessionId: workoutSessions.id,
            exerciseCode: sessionExercises.exerciseCode,
            completedAt: workoutSessions.completedAt,
            ordinal: performedSets.ordinal,
            loadGrams: performedSets.actualLoadGrams,
            repetitions: performedSets.actualRepetitions,
            rpe: performedSets.rpe,
          })
          .from(sessionExercises)
          .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
          .innerJoin(
            performedSets,
            eq(performedSets.sessionExerciseId, sessionExercises.id),
          )
          .where(
            and(
              eq(workoutSessions.userId, userId),
              ne(workoutSessions.id, sessionId),
              eq(workoutSessions.status, 'completed'),
              eq(performedSets.status, 'performed'),
              inArray(
                sessionExercises.exerciseCode,
                exercises.map((exercise) => exercise.exerciseCode),
              ),
            ),
          )
          .orderBy(desc(workoutSessions.completedAt), asc(performedSets.ordinal))
      : []

  return {
    id: session.id,
    status: session.status,
    startedAt: session.startedAt,
    pausedAt: session.pausedAt,
    completedAt: session.completedAt,
    optimisticVersion: session.optimisticVersion,
    contentEligibility: evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: sessionContext.methodologyReviewStatus,
      templateStatus: sessionContext.templateReviewStatus,
    }),
    plannedWorkout: {
      id: session.plannedWorkoutId,
      name: session.plannedWorkoutName,
      scheduledDate: session.scheduledDate,
      slotCode: session.slotCode,
    },
    exercises: exercises.map((exercise) => ({
      id: exercise.id,
      exerciseCode: exercise.exerciseCode,
      exerciseName: exercise.exerciseName,
      ordinal: exercise.ordinal,
      rationaleCode: exercise.rationaleCode,
      priorComparablePerformance: (() => {
        const latest = priorRows.find(
          (row) =>
            row.exerciseCode === exercise.exerciseCode &&
            row.completedAt !== null &&
            row.loadGrams !== null &&
            row.repetitions !== null,
        )
        if (!latest?.completedAt) return null
        return {
          completedAt: latest.completedAt,
          sets: priorRows
            .filter(
              (row) =>
                row.sessionId === latest.sessionId &&
                row.exerciseCode === exercise.exerciseCode &&
                row.loadGrams !== null &&
                row.repetitions !== null,
            )
            .map((row) => ({
              loadGrams: row.loadGrams ?? 0,
              repetitions: row.repetitions ?? 0,
              rpe: row.rpe,
            })),
        }
      })(),
      sets: sets
        .filter((set) => set.sessionExerciseId === exercise.id)
        .map((set) => ({
          id: set.id,
          ordinal: set.ordinal,
          status: set.status,
          targetLoadGrams: set.targetLoadGrams,
          targetRepetitions: set.targetRepetitions,
          restSeconds: set.restSeconds,
          actualLoadGrams: set.actualLoadGrams,
          actualRepetitions: set.actualRepetitions,
          rpe: set.rpe,
          confirmedAt: set.confirmedAt,
          skippedAt: set.skippedAt,
          skipReason: set.skipReason,
          note: set.note,
        })),
    })),
    feedback: feedback
      ? { painReported: feedback.painReported, details: feedback.details }
      : null,
  }
}

export async function completeSet(rawInput: {
  readonly userId: string
  readonly sessionId: string
  readonly setId: string
  readonly commandId: string
  readonly actualLoadGrams: number
  readonly actualRepetitions: number
  readonly rpe: number | null
  readonly note: string | null
}): Promise<void> {
  const input = {
    userId: rawInput.userId,
    ...parseWorkoutCommand(completeSetCommandSchema, rawInput),
  }

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`,
    )
    const [set] = await transaction
      .select({
        id: performedSets.id,
        status: performedSets.status,
        commandId: performedSets.commandId,
        targetLoadGrams: performedSets.targetLoadGrams,
        targetRepetitions: performedSets.targetRepetitions,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateReviewStatus: programRevisions.templateReviewStatus,
      })
      .from(performedSets)
      .innerJoin(
        sessionExercises,
        eq(sessionExercises.id, performedSets.sessionExerciseId),
      )
      .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
      .innerJoin(
        plannedWorkouts,
        eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
      )
      .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
      .where(
        and(
          eq(performedSets.id, input.setId),
          eq(workoutSessions.id, input.sessionId),
          eq(workoutSessions.userId, input.userId),
        ),
      )
      .for('update')
      .limit(1)
    if (!set) throw new WorkoutCommandError('set.not-found', 'Set not found.')
    if (set.commandId === input.commandId && set.status === 'performed') return
    const eligibility = evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: set.methodologyReviewStatus,
      templateStatus: set.templateReviewStatus,
    })
    if (!eligibility.eligible) {
      throw new WorkoutCommandError(
        eligibility.code,
        'This persisted session content is not eligible for set recording.',
      )
    }
    if (set.status !== 'pending') {
      throw new WorkoutCommandError('set.already-resolved', 'Set is already resolved.')
    }

    const [session] = await transaction
      .select({ status: workoutSessions.status })
      .from(workoutSessions)
      .where(eq(workoutSessions.id, input.sessionId))
      .for('update')
      .limit(1)
    if (session?.status !== 'active') {
      throw new WorkoutCommandError('session.not-active', 'Resume the session first.')
    }
    const [hold] = await transaction
      .select({ id: safetyHolds.id })
      .from(safetyHolds)
      .where(and(eq(safetyHolds.userId, input.userId), isNull(safetyHolds.clearedAt)))
      .limit(1)
    if (hold)
      throw new WorkoutCommandError('safety.hold-active', 'Set recording is blocked.')

    const now = new Date()
    await transaction
      .update(performedSets)
      .set({
        status: 'performed',
        actualLoadGrams: input.actualLoadGrams,
        actualRepetitions: input.actualRepetitions,
        rpe: input.rpe,
        loadProvenance:
          input.actualLoadGrams === set.targetLoadGrams ? 'copied-target' : 'edited',
        repetitionsProvenance:
          input.actualRepetitions === set.targetRepetitions ? 'copied-target' : 'edited',
        explicitlyConfirmed: true,
        confirmedAt: now,
        note: input.note,
        commandId: input.commandId,
        updatedAt: now,
      })
      .where(eq(performedSets.id, input.setId))
    await transaction
      .update(workoutSessions)
      .set({
        optimisticVersion: sql`${workoutSessions.optimisticVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(workoutSessions.id, input.sessionId))
  })
}

export async function skipSet(rawInput: {
  readonly userId: string
  readonly sessionId: string
  readonly setId: string
  readonly commandId: string
  readonly reason: string
}): Promise<void> {
  const input = {
    userId: rawInput.userId,
    ...parseWorkoutCommand(skipSetCommandSchema, rawInput),
  }

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`,
    )
    const [set] = await transaction
      .select({
        id: performedSets.id,
        status: performedSets.status,
        commandId: performedSets.commandId,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateReviewStatus: programRevisions.templateReviewStatus,
      })
      .from(performedSets)
      .innerJoin(
        sessionExercises,
        eq(sessionExercises.id, performedSets.sessionExerciseId),
      )
      .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
      .innerJoin(
        plannedWorkouts,
        eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
      )
      .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
      .where(
        and(
          eq(performedSets.id, input.setId),
          eq(workoutSessions.id, input.sessionId),
          eq(workoutSessions.userId, input.userId),
          eq(workoutSessions.status, 'active'),
        ),
      )
      .for('update')
      .limit(1)
    if (!set)
      throw new WorkoutCommandError('set.not-found', 'Set not found or session inactive.')
    if (set.commandId === input.commandId && set.status === 'skipped') return
    const eligibility = evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: set.methodologyReviewStatus,
      templateStatus: set.templateReviewStatus,
    })
    if (!eligibility.eligible) {
      throw new WorkoutCommandError(
        eligibility.code,
        'This persisted session content is not eligible for set changes.',
      )
    }
    if (set.status !== 'pending')
      throw new WorkoutCommandError('set.already-resolved', 'Set is already resolved.')

    const now = new Date()
    await transaction
      .update(performedSets)
      .set({
        status: 'skipped',
        skippedAt: now,
        skipReason: input.reason,
        commandId: input.commandId,
        updatedAt: now,
      })
      .where(eq(performedSets.id, input.setId))
    await transaction
      .update(workoutSessions)
      .set({
        optimisticVersion: sql`${workoutSessions.optimisticVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(workoutSessions.id, input.sessionId))
  })
}

export async function setSessionPaused(
  userId: string,
  sessionId: string,
  paused: boolean,
): Promise<void> {
  const command = parseWorkoutCommand(sessionPauseCommandSchema, {
    sessionId,
    paused,
  })

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    )
    if (!command.paused) {
      const [contentContext] = await transaction
        .select({
          methodologyReviewStatus: programRevisions.methodologyReviewStatus,
          templateReviewStatus: programRevisions.templateReviewStatus,
        })
        .from(workoutSessions)
        .innerJoin(
          plannedWorkouts,
          eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
        )
        .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
        .where(
          and(
            eq(workoutSessions.id, command.sessionId),
            eq(workoutSessions.userId, userId),
            eq(workoutSessions.status, 'paused'),
          ),
        )
        .for('update')
        .limit(1)
      if (contentContext) {
        const eligibility = evaluatePersistedContentEligibility({
          contentMode: getServerConfig().contentMode,
          methodologyStatus: contentContext.methodologyReviewStatus,
          templateStatus: contentContext.templateReviewStatus,
        })
        if (!eligibility.eligible) {
          throw new WorkoutCommandError(
            eligibility.code,
            'This persisted session content is not eligible to resume.',
          )
        }
      }
      const [hold] = await transaction
        .select({ id: safetyHolds.id })
        .from(safetyHolds)
        .where(and(eq(safetyHolds.userId, userId), isNull(safetyHolds.clearedAt)))
        .limit(1)
      if (hold)
        throw new WorkoutCommandError(
          'safety.hold-active',
          'The session cannot resume while a safety hold is active.',
        )
    }
    const fromStatus = command.paused ? 'active' : 'paused'
    const toStatus = command.paused ? 'paused' : 'active'
    const now = new Date()
    const [updated] = await transaction
      .update(workoutSessions)
      .set({
        status: toStatus,
        pausedAt: command.paused ? now : null,
        optimisticVersion: sql`${workoutSessions.optimisticVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(workoutSessions.id, command.sessionId),
          eq(workoutSessions.userId, userId),
          eq(workoutSessions.status, fromStatus),
        ),
      )
      .returning({ id: workoutSessions.id })
    if (!updated)
      throw new WorkoutCommandError(
        'session.transition-conflict',
        'The saved session state changed. Reload it.',
      )
  })
}

export async function reportPain(
  userId: string,
  rawSessionId: string,
  rawDetails: string,
): Promise<void> {
  const { sessionId, details } = parseWorkoutCommand(reportPainCommandSchema, {
    sessionId: rawSessionId,
    details: rawDetails,
  })

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    )
    const now = new Date()
    const [session] = await transaction
      .select({ id: workoutSessions.id, status: workoutSessions.status })
      .from(workoutSessions)
      .where(
        and(
          eq(workoutSessions.id, sessionId),
          eq(workoutSessions.userId, userId),
          inArray(workoutSessions.status, ['active', 'paused', 'completed']),
        ),
      )
      .for('update')
      .limit(1)
    if (!session)
      throw new WorkoutCommandError(
        'session.not-reportable',
        'This session cannot accept a safety report.',
      )

    if (session.status === 'active') {
      await transaction
        .update(workoutSessions)
        .set({
          status: 'paused',
          pausedAt: now,
          optimisticVersion: sql`${workoutSessions.optimisticVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(workoutSessions.id, sessionId))
    }

    if (session.status === 'completed') {
      await transaction.execute(
        sql`SELECT set_config(
          'indigo.session_feedback_write_mode',
          'post-completion-safety-report',
          true
        )`,
      )
    }

    await transaction
      .insert(sessionFeedback)
      .values({
        sessionId,
        painReported: true,
        details: details.trim() || null,
        answeredAt: now,
      })
      .onConflictDoUpdate({
        target: sessionFeedback.sessionId,
        set: { painReported: true, details: details.trim() || null, answeredAt: now },
      })
    const [existingHold] = await transaction
      .select({ id: safetyHolds.id })
      .from(safetyHolds)
      .where(and(eq(safetyHolds.userId, userId), isNull(safetyHolds.clearedAt)))
      .for('update')
      .limit(1)
    if (!existingHold) {
      await transaction.insert(safetyHolds).values({
        id: newUuidV7(),
        userId,
        reasonCode: 'session-pain-reported',
        details: details.trim() || null,
      })
    }
    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: userId,
      subjectUserId: userId,
      eventType: 'session-safety-stop',
      entityType: 'workout-session',
      entityId: sessionId,
      metadata: {
        action:
          session.status === 'completed' ? 'post-completion-hold' : 'paused-and-held',
        coalescedWithExistingHold: Boolean(existingHold),
      },
    })
  })
}

export async function completeWorkout(rawInput: {
  readonly userId: string
  readonly sessionId: string
  readonly commandId: string
  readonly noPainAttested: boolean
}): Promise<void> {
  const input = {
    userId: rawInput.userId,
    ...parseWorkoutCommand(completeWorkoutCommandSchema, rawInput),
  }

  if (!input.noPainAttested) {
    throw new WorkoutCommandError(
      'session.feedback-required',
      'Confirm the end-of-session safety question.',
    )
  }

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`,
    )
    const [session] = await transaction
      .select()
      .from(workoutSessions)
      .where(
        and(
          eq(workoutSessions.id, input.sessionId),
          eq(workoutSessions.userId, input.userId),
        ),
      )
      .for('update')
      .limit(1)
    if (!session) throw new WorkoutCommandError('session.not-found', 'Session not found.')
    if (session.status === 'completed' && session.completionCommandId === input.commandId)
      return
    if (!['active', 'paused'].includes(session.status)) {
      throw new WorkoutCommandError(
        'session.not-completable',
        'This session cannot be completed.',
      )
    }

    const [adjustmentContext] = await transaction
      .select({
        methodologyId: programRevisions.methodologyId,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateReviewStatus: programRevisions.templateReviewStatus,
      })
      .from(workoutSessions)
      .innerJoin(
        plannedWorkouts,
        eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
      )
      .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
      .where(eq(workoutSessions.id, input.sessionId))
      .for('update')
      .limit(1)
    if (!adjustmentContext) {
      throw new WorkoutCommandError(
        'content.release-missing',
        'The persisted content release is unavailable.',
      )
    }
    const eligibility = evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: adjustmentContext.methodologyReviewStatus,
      templateStatus: adjustmentContext.templateReviewStatus,
    })
    if (!eligibility.eligible) {
      throw new WorkoutCommandError(
        eligibility.code,
        'This persisted session content is not eligible for completion.',
      )
    }

    const exercises = await transaction
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, input.sessionId))
      .orderBy(asc(sessionExercises.ordinal))
    const sets = await transaction
      .select()
      .from(performedSets)
      .where(
        inArray(
          performedSets.sessionExerciseId,
          exercises.map((exercise) => exercise.id),
        ),
      )
      .orderBy(asc(performedSets.ordinal))
    if (sets.some((set) => set.status === 'pending')) {
      throw new WorkoutCommandError(
        'session.pending-sets',
        'Perform or explicitly skip every set first.',
      )
    }
    const [feedback] = await transaction
      .select()
      .from(sessionFeedback)
      .where(eq(sessionFeedback.sessionId, input.sessionId))
      .for('update')
      .limit(1)
    if (feedback?.painReported)
      throw new WorkoutCommandError(
        'safety.pain-reported',
        'A pain report blocks normal completion.',
      )
    const [hold] = await transaction
      .select({ id: safetyHolds.id })
      .from(safetyHolds)
      .where(and(eq(safetyHolds.userId, input.userId), isNull(safetyHolds.clearedAt)))
      .limit(1)
    if (hold) {
      throw new WorkoutCommandError(
        'safety.hold-active',
        'An active safety hold blocks workout completion.',
      )
    }

    const now = new Date()
    if (feedback) {
      await transaction
        .update(sessionFeedback)
        .set({ painReported: false, details: null, answeredAt: now })
        .where(eq(sessionFeedback.sessionId, input.sessionId))
    } else {
      await transaction.insert(sessionFeedback).values({
        sessionId: input.sessionId,
        painReported: false,
        details: null,
        answeredAt: now,
      })
    }

    const developmentAdjustmentEligible =
      adjustmentContext.methodologyId === 'development.methodology-fixture' &&
      adjustmentContext.methodologyReviewStatus === 'development' &&
      adjustmentContext.templateReviewStatus === 'development' &&
      getServerConfig().contentMode === 'development'

    const decisions: Array<{
      exerciseCode: string
      kind: 'blocked' | 'hold' | 'increase'
      currentTargetLoadGrams: number
      proposedTargetLoadGrams: number
      reasonCode: string
      policyVersion: string
    }> = []

    for (const exercise of exercises) {
      const exerciseSets = sets.filter((set) => set.sessionExerciseId === exercise.id)
      const first = exerciseSets[0]
      if (!first) continue
      const decision =
        developmentAdjustmentEligible && developmentExerciseIds.has(exercise.exerciseCode)
          ? decideDevelopmentLoadAdjustment({
              exerciseId: exercise.exerciseCode as DevelopmentExerciseId,
              currentTargetLoadGrams: first.targetLoadGrams,
              targetRepetitions: first.targetRepetitions,
              expectedSetCount: exerciseSets.length,
              painReported: false,
              sets: exerciseSets.map((set) =>
                set.status === 'skipped'
                  ? { status: 'skipped' as const }
                  : {
                      status: 'performed' as const,
                      loadGrams: set.actualLoadGrams,
                      repetitions: set.actualRepetitions,
                      rpe: set.rpe,
                      explicitlyConfirmed: set.explicitlyConfirmed,
                    },
              ),
            })
          : {
              kind: 'blocked' as const,
              currentTargetLoadGrams: first.targetLoadGrams,
              proposedTargetLoadGrams: first.targetLoadGrams,
              reasonCode: 'adjustment.policy-unavailable',
              policyVersion: 'unavailable',
            }
      decisions.push({
        exerciseCode: exercise.exerciseCode,
        kind: decision.kind,
        currentTargetLoadGrams: decision.currentTargetLoadGrams,
        proposedTargetLoadGrams: decision.proposedTargetLoadGrams,
        reasonCode: decision.reasonCode,
        policyVersion: decision.policyVersion,
      })
      await transaction.insert(adjustmentDecisions).values({
        id: newUuidV7(),
        sessionId: input.sessionId,
        exerciseCode: exercise.exerciseCode,
        decision: decision.kind === 'blocked' ? 'unavailable' : decision.kind,
        currentLoadGrams: decision.currentTargetLoadGrams,
        nextLoadGrams: decision.proposedTargetLoadGrams,
        reasonCode: decision.reasonCode,
        ruleVersion: decision.policyVersion,
      })
    }

    const [programContext] = await transaction
      .select({
        programId: programs.id,
        sourceWorkoutOrdinal: plannedWorkouts.ordinal,
        sourceRevisionId: programRevisions.id,
        sourceRevisionNumber: programRevisions.revisionNumber,
        sourceRevisionStatus: programRevisions.status,
        engineVersion: programRevisions.engineVersion,
        methodologyId: programRevisions.methodologyId,
        methodologyVersion: programRevisions.methodologyVersion,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateId: programRevisions.templateId,
        templateVersion: programRevisions.templateVersion,
        templateReviewStatus: programRevisions.templateReviewStatus,
        baseInputHash: programRevisions.normalizedInputHash,
        baseOutputHash: programRevisions.outputHash,
        warnings: programRevisions.warnings,
        manualReviewRequired: programRevisions.manualReviewRequired,
      })
      .from(workoutSessions)
      .innerJoin(
        plannedWorkouts,
        eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
      )
      .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
      .innerJoin(programs, eq(programs.id, programRevisions.programId))
      .where(
        and(eq(workoutSessions.id, input.sessionId), eq(programs.userId, input.userId)),
      )
      .for('update')
      .limit(1)

    if (
      developmentAdjustmentEligible &&
      programContext?.sourceRevisionStatus === 'active' &&
      decisions.some((decision) => decision.kind === 'increase')
    ) {
      const futureWorkouts = await transaction
        .select()
        .from(plannedWorkouts)
        .where(
          and(
            eq(plannedWorkouts.revisionId, programContext.sourceRevisionId),
            gt(plannedWorkouts.ordinal, programContext.sourceWorkoutOrdinal),
          ),
        )
        .orderBy(asc(plannedWorkouts.ordinal))

      if (futureWorkouts.length > 0) {
        const futureWorkoutIds = futureWorkouts.map((workout) => workout.id)
        const futureExercises = await transaction
          .select()
          .from(exercisePrescriptions)
          .where(inArray(exercisePrescriptions.plannedWorkoutId, futureWorkoutIds))
          .orderBy(asc(exercisePrescriptions.ordinal))
        const futureExerciseIds = futureExercises.map((exercise) => exercise.id)
        const futureSets = await transaction
          .select()
          .from(setPrescriptions)
          .where(inArray(setPrescriptions.exercisePrescriptionId, futureExerciseIds))
          .orderBy(asc(setPrescriptions.ordinal))
        const decisionsByExercise = new Map(
          decisions.map((decision) => [decision.exerciseCode, decision] as const),
        )
        const adjustedLoad = (exerciseCode: string, originalLoadGrams: number) => {
          const decision = decisionsByExercise.get(exerciseCode)
          return decision?.kind === 'increase'
            ? decision.proposedTargetLoadGrams
            : originalLoadGrams
        }
        const adjustedRationale = (exerciseCode: string, original: string) => {
          const decision = decisionsByExercise.get(exerciseCode)
          return decision?.kind === 'increase' ? decision.reasonCode : original
        }
        const normalizedInput = {
          hashMaterialVersion: 'development-adjustment-v1',
          kind: 'development-future-adjustment',
          baseInputHash: programContext.baseInputHash,
          baseOutputHash: programContext.baseOutputHash,
          sourceWorkoutOrdinal: programContext.sourceWorkoutOrdinal,
          decisions: decisions.map((decision) => ({
            exerciseCode: decision.exerciseCode,
            kind: decision.kind,
            currentTargetLoadGrams: decision.currentTargetLoadGrams,
            proposedTargetLoadGrams: decision.proposedTargetLoadGrams,
            reasonCode: decision.reasonCode,
            policyVersion: decision.policyVersion,
          })),
        } satisfies CanonicalValue
        const outputSnapshot = {
          hashMaterialVersion: 'development-adjustment-v1',
          kind: 'development-future-prescription',
          plannedWorkouts: futureWorkouts.map((workout) => ({
            ordinal: workout.ordinal,
            localDate: workout.scheduledDate,
            sessionKey: workout.slotCode,
            name: workout.name,
            exercises: futureExercises
              .filter((exercise) => exercise.plannedWorkoutId === workout.id)
              .map((exercise) => ({
                ordinal: exercise.ordinal,
                exerciseCode: exercise.exerciseCode,
                exerciseName: exercise.exerciseName,
                safetyTier: exercise.safetyTier,
                rationaleCode: adjustedRationale(
                  exercise.exerciseCode,
                  exercise.rationaleCode,
                ),
                sets: futureSets
                  .filter((set) => set.exercisePrescriptionId === exercise.id)
                  .map((set) => ({
                    ordinal: set.ordinal,
                    setKind: set.setKind,
                    targetLoadGrams: adjustedLoad(
                      exercise.exerciseCode,
                      set.targetLoadGrams,
                    ),
                    targetRepetitions: set.targetRepetitions,
                    restSeconds: set.restSeconds,
                  })),
              })),
          })),
        } satisfies CanonicalValue
        const normalizedInputHash = canonicalSha256(normalizedInput)
        const outputHash = canonicalSha256({
          hashMaterialVersion: 'development-adjustment-v1',
          engineVersion: programContext.engineVersion,
          methodology: {
            id: programContext.methodologyId,
            version: programContext.methodologyVersion,
            reviewStatus: programContext.methodologyReviewStatus,
          },
          template: {
            id: programContext.templateId,
            version: programContext.templateVersion,
            reviewStatus: programContext.templateReviewStatus,
          },
          normalizedInputHash,
          output: outputSnapshot,
          warnings: programContext.warnings as CanonicalValue,
          manualReviewRequired: programContext.manualReviewRequired,
        })
        const revisionId = newUuidV7()

        await transaction
          .update(programRevisions)
          .set({ status: 'superseded' })
          .where(eq(programRevisions.id, programContext.sourceRevisionId))
        await transaction.insert(programRevisions).values({
          id: revisionId,
          programId: programContext.programId,
          revisionNumber: programContext.sourceRevisionNumber + 1,
          status: 'draft',
          engineVersion: programContext.engineVersion,
          methodologyId: programContext.methodologyId,
          methodologyVersion: programContext.methodologyVersion,
          methodologyReviewStatus: programContext.methodologyReviewStatus,
          templateId: programContext.templateId,
          templateVersion: programContext.templateVersion,
          templateReviewStatus: programContext.templateReviewStatus,
          normalizedInputHash,
          outputHash,
          normalizedInput,
          outputSnapshot,
          warnings: programContext.warnings,
          manualReviewRequired: programContext.manualReviewRequired,
        })
        await transaction
          .update(adjustmentDecisions)
          .set({ appliedRevisionId: revisionId })
          .where(eq(adjustmentDecisions.sessionId, input.sessionId))

        for (const workout of futureWorkouts) {
          const plannedWorkoutId = newUuidV7()
          await transaction.insert(plannedWorkouts).values({
            id: plannedWorkoutId,
            revisionId,
            scheduledDate: workout.scheduledDate,
            ordinal: workout.ordinal,
            slotCode: workout.slotCode,
            name: workout.name,
          })

          for (const exercise of futureExercises.filter(
            (entry) => entry.plannedWorkoutId === workout.id,
          )) {
            const exercisePrescriptionId = newUuidV7()
            await transaction.insert(exercisePrescriptions).values({
              id: exercisePrescriptionId,
              plannedWorkoutId,
              exerciseCode: exercise.exerciseCode,
              exerciseName: exercise.exerciseName,
              ordinal: exercise.ordinal,
              safetyTier: exercise.safetyTier,
              rationaleCode: adjustedRationale(
                exercise.exerciseCode,
                exercise.rationaleCode,
              ),
            })
            await transaction.insert(setPrescriptions).values(
              futureSets
                .filter((set) => set.exercisePrescriptionId === exercise.id)
                .map((set) => ({
                  id: newUuidV7(),
                  exercisePrescriptionId,
                  ordinal: set.ordinal,
                  setKind: set.setKind,
                  targetLoadGrams: adjustedLoad(
                    exercise.exerciseCode,
                    set.targetLoadGrams,
                  ),
                  targetRepetitions: set.targetRepetitions,
                  restSeconds: set.restSeconds,
                })),
            )
          }
        }

        await transaction
          .update(programRevisions)
          .set({ status: 'active', activatedAt: now })
          .where(eq(programRevisions.id, revisionId))

        await transaction.insert(auditEvents).values({
          id: newUuidV7(),
          actorUserId: input.userId,
          subjectUserId: input.userId,
          eventType: 'program-adjustment-revision-activated',
          entityType: 'program-revision',
          entityId: revisionId,
          metadata: {
            sourceRevisionId: programContext.sourceRevisionId,
            sourceSessionId: input.sessionId,
            decisionCount: decisions.length,
          },
        })
      }
    }

    await transaction
      .update(workoutSessions)
      .set({
        status: 'completed',
        completedAt: now,
        pausedAt: null,
        completionCommandId: input.commandId,
        optimisticVersion: sql`${workoutSessions.optimisticVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(workoutSessions.id, input.sessionId))

    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: input.userId,
      subjectUserId: input.userId,
      eventType: 'workout-completed',
      entityType: 'workout-session',
      entityId: input.sessionId,
      metadata: {
        completedSetCount: sets.filter((set) => set.status === 'performed').length,
      },
    })
  })
}

export async function abandonWorkout(
  userId: string,
  rawSessionId: string,
): Promise<void> {
  const { sessionId } = parseWorkoutCommand(abandonWorkoutCommandSchema, {
    sessionId: rawSessionId,
  })

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    )
    const now = new Date()
    const [updated] = await transaction
      .update(workoutSessions)
      .set({
        status: 'abandoned',
        abandonedAt: now,
        pausedAt: null,
        optimisticVersion: sql`${workoutSessions.optimisticVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(workoutSessions.id, sessionId),
          eq(workoutSessions.userId, userId),
          inArray(workoutSessions.status, ['active', 'paused']),
        ),
      )
      .returning({ id: workoutSessions.id })
    if (!updated)
      throw new WorkoutCommandError(
        'session.not-abandonable',
        'Session is not active or paused.',
      )
  })
}

export async function getCompletedSessions(userId: string) {
  const sessions = await getDb()
    .select({
      id: workoutSessions.id,
      startedAt: workoutSessions.startedAt,
      completedAt: workoutSessions.completedAt,
      plannedName: workoutSessions.plannedWorkoutName,
      scheduledDate: workoutSessions.scheduledDate,
      slotCode: workoutSessions.slotCode,
      methodologyReviewStatus: programRevisions.methodologyReviewStatus,
      templateReviewStatus: programRevisions.templateReviewStatus,
    })
    .from(workoutSessions)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId))
    .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
    .where(
      and(eq(workoutSessions.userId, userId), eq(workoutSessions.status, 'completed')),
    )
    .orderBy(asc(workoutSessions.completedAt))

  return sessions.flatMap(
    ({ methodologyReviewStatus, templateReviewStatus, ...session }) =>
      evaluatePersistedContentEligibility({
        contentMode: getServerConfig().contentMode,
        methodologyStatus: methodologyReviewStatus,
        templateStatus: templateReviewStatus,
      }).eligible
        ? [session]
        : [],
  )
}

export async function getSessionAdjustments(userId: string, sessionId: string) {
  const [owned] = await getDb()
    .select({
      id: workoutSessions.id,
      methodologyReviewStatus: programRevisions.methodologyReviewStatus,
      templateReviewStatus: programRevisions.templateReviewStatus,
    })
    .from(workoutSessions)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId))
    .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
    .where(
      and(
        eq(workoutSessions.id, sessionId),
        eq(workoutSessions.userId, userId),
        eq(workoutSessions.status, 'completed'),
      ),
    )
    .limit(1)
  if (!owned) return null
  if (
    !evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: owned.methodologyReviewStatus,
      templateStatus: owned.templateReviewStatus,
    }).eligible
  ) {
    return null
  }
  return getDb()
    .select()
    .from(adjustmentDecisions)
    .where(eq(adjustmentDecisions.sessionId, sessionId))
    .orderBy(asc(adjustmentDecisions.exerciseCode))
}
