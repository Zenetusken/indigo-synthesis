import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  ne,
  sql,
} from 'drizzle-orm'
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
import {
  contentRevokedForProgramRevisionSql,
  lockProgramRevisionContentReleases,
  programRevisionContentIsRevoked,
} from '@/modules/programs/application/content-revocations'
import {
  activatePersistedProgramRevision,
  getProgramOverview,
} from '@/modules/programs/application/programs'
import { evaluatePersistedContentEligibility } from '@/modules/programs/domain/content-eligibility'
import {
  EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
  type ExecutablePrescriptionProjection,
  executablePrescriptionHash,
} from '@/modules/programs/domain/executable-prescription'
import {
  commandReceiptMatches,
  type TrainingCommandRequest,
  trainingCommandRequestHash,
} from '@/modules/training/domain/command-receipt'
import {
  abandonWorkoutCommandSchema,
  completeSetCommandSchema,
  completeWorkoutCommandSchema,
  correctPerformedSetCommandSchema,
  proposeExerciseSubstitutionCommandSchema,
  reportPainCommandSchema,
  resolveSafetyHoldCommandSchema,
  sessionPauseCommandSchema,
  skipSetCommandSchema,
  startWorkoutCommandSchema,
} from '@/modules/training/domain/commands'
import { evaluateSubstitution } from '@/modules/training/domain/substitution'
import { getServerConfig } from '@/platform/config/server'
import { type DatabaseTransaction, getDb } from '@/platform/db/client'
import {
  adjustmentDecisionInvalidations,
  adjustmentDecisions,
  athleteProfiles,
  auditEvents,
  exercisePrescriptions,
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
  sessionFeedbackCorrections,
  setPrescriptions,
  trainingCommandReceipts,
  trainingFactCorrections,
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

async function commandWasReplayed(
  transaction: DatabaseTransaction,
  commandId: string,
  request: TrainingCommandRequest,
): Promise<boolean> {
  const [receipt] = await transaction
    .select()
    .from(trainingCommandReceipts)
    .where(eq(trainingCommandReceipts.commandId, commandId))
    .limit(1)
  if (!receipt) return false
  if (commandReceiptMatches(receipt, request)) return true
  throw new WorkoutCommandError(
    'command.idempotency-conflict',
    'This command identifier was already used for a different request.',
  )
}

async function claimCommandReceipt(
  transaction: DatabaseTransaction,
  commandId: string,
  request: TrainingCommandRequest,
): Promise<boolean> {
  const [inserted] = await transaction
    .insert(trainingCommandReceipts)
    .values({
      commandId,
      userId: request.userId,
      commandType: request.commandType,
      sessionId: request.sessionId,
      targetId: request.targetId,
      requestHash: trainingCommandRequestHash(request),
      resultSnapshot: { status: 'succeeded' },
    })
    .onConflictDoNothing({ target: trainingCommandReceipts.commandId })
    .returning({ commandId: trainingCommandReceipts.commandId })
  if (inserted) return true
  if (await commandWasReplayed(transaction, commandId, request)) return false
  throw new WorkoutCommandError(
    'command.idempotency-conflict',
    'This command identifier was already used for a different request.',
  )
}

const developmentExerciseIds = new Set<string>(DEVELOPMENT_EXERCISE_IDS)

function activeHoldWhere(userId: string) {
  return and(
    eq(safetyHolds.userId, userId),
    isNull(safetyHolds.clearedAt),
    sql`NOT EXISTS (
      SELECT 1 FROM ${safetyHoldResolutions}
      WHERE ${safetyHoldResolutions.holdId} = ${safetyHolds.id}
    )`,
  )
}

async function nextCorrectionSequence(
  transaction: DatabaseTransaction,
  sessionId: string,
): Promise<number> {
  const result = await transaction.execute<{ sequence: number }>(sql`
    SELECT COALESCE(MAX(sequence), 0)::int + 1 AS sequence
    FROM ${trainingFactCorrections}
    WHERE ${trainingFactCorrections.sessionId} = ${sessionId}
  `)
  return result.rows[0]?.sequence ?? 1
}

async function invalidateProgressionFromCorrection(
  transaction: DatabaseTransaction,
  input: {
    readonly correctionId: string
    readonly userId: string
    readonly sourceSessionId: string
    readonly now: Date
  },
): Promise<{
  readonly decisionIds: readonly string[]
  readonly revisionIds: readonly string[]
  readonly pausedSessionIds: readonly string[]
}> {
  const affected = await transaction.execute<{
    kind: 'decision' | 'revision'
    id: string
  }>(sql`
    WITH RECURSIVE affected_revision(revision_id) AS (
      SELECT DISTINCT decision.applied_revision_id
      FROM ${adjustmentDecisions} AS decision
      WHERE decision.session_id = ${input.sourceSessionId}
        AND decision.applied_revision_id IS NOT NULL
      UNION
      SELECT lineage.revision_id
      FROM ${programRevisionLineage} AS lineage
      JOIN affected_revision AS parent
        ON parent.revision_id = lineage.parent_revision_id
    )
    SELECT 'revision'::text AS kind, revision_id AS id
    FROM affected_revision
    UNION ALL
    SELECT DISTINCT 'decision'::text AS kind, decision.id
    FROM ${adjustmentDecisions} AS decision
    LEFT JOIN ${workoutSessions} AS session ON session.id = decision.session_id
    LEFT JOIN ${plannedWorkouts} AS workout ON workout.id = session.planned_workout_id
    WHERE decision.session_id = ${input.sourceSessionId}
       OR workout.revision_id IN (SELECT revision_id FROM affected_revision)
  `)
  const revisionIds = affected.rows
    .filter((row) => row.kind === 'revision')
    .map((row) => row.id)
  const decisionIds = affected.rows
    .filter((row) => row.kind === 'decision')
    .map((row) => row.id)
  const pausedSessionIds =
    revisionIds.length === 0
      ? []
      : (
          await transaction
            .select({ id: workoutSessions.id })
            .from(workoutSessions)
            .innerJoin(
              plannedWorkouts,
              eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
            )
            .where(
              and(
                eq(workoutSessions.userId, input.userId),
                eq(workoutSessions.status, 'active'),
                inArray(plannedWorkouts.revisionId, revisionIds),
              ),
            )
        ).map((session) => session.id)

  if (revisionIds.length > 0) {
    await transaction
      .insert(programRevisionInvalidations)
      .values(
        revisionIds.map((revisionId) => ({
          revisionId,
          correctionId: input.correctionId,
          createdAt: input.now,
        })),
      )
      .onConflictDoNothing({ target: programRevisionInvalidations.revisionId })
  }
  if (decisionIds.length > 0) {
    await transaction
      .insert(adjustmentDecisionInvalidations)
      .values(
        decisionIds.map((decisionId) => ({
          decisionId,
          correctionId: input.correctionId,
          createdAt: input.now,
        })),
      )
      .onConflictDoNothing({ target: adjustmentDecisionInvalidations.decisionId })
  }

  return { decisionIds, revisionIds, pausedSessionIds }
}

async function completedSessionInvalidationIsDurable(
  transaction: DatabaseTransaction,
  sessionId: string,
): Promise<boolean> {
  const result = await transaction.execute<{ durable: boolean }>(sql`
    SELECT indigo_completed_session_invalidation_is_durable(${sessionId}) AS durable
  `)
  return result.rows[0]?.durable ?? false
}

export type TodayState =
  | { readonly kind: 'program-required' }
  | {
      readonly kind: 'active'
      readonly sessionId: string
      readonly status: string
      readonly progressionInvalidated: boolean
      readonly contentEligibility: ReturnType<typeof evaluatePersistedContentEligibility>
    }
  | {
      readonly kind: 'planned'
      readonly workout: NonNullable<
        Awaited<ReturnType<typeof getProgramOverview>>
      >['workouts'][number]
      readonly contentEligibility: ReturnType<typeof evaluatePersistedContentEligibility>
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
  | {
      readonly kind: 'hold'
      readonly holdId: string
      readonly sourceSessionId: string | null
      readonly sourceSessionStatus: string | null
      readonly resolutionAvailability: HoldResolutionAvailability
    }

export type HoldResolutionAvailability =
  | { readonly kind: 'available' }
  | {
      readonly kind: 'requires-abandonment'
      readonly sessionId: string
    }
  | {
      readonly kind: 'blocked'
      readonly reason:
        | 'not-session-pain-hold'
        | 'source-session-missing'
        | 'completed-source-awaiting-invalidation'
    }

function holdResolutionAvailability(input: {
  readonly reasonCode: string
  readonly sourceSessionId: string | null
  readonly sourceSessionStatus: string | null
  readonly completedSourceInvalidated: boolean
  readonly blockingAffectedSessionId: string | null
}): HoldResolutionAvailability {
  if (input.reasonCode !== 'session-pain-reported') {
    return { kind: 'blocked', reason: 'not-session-pain-hold' }
  }
  if (!input.sourceSessionId || !input.sourceSessionStatus) {
    return { kind: 'blocked', reason: 'source-session-missing' }
  }
  if (
    input.sourceSessionStatus === 'abandoned' ||
    (input.sourceSessionStatus === 'completed' && input.completedSourceInvalidated)
  )
    return { kind: 'available' }
  if (input.sourceSessionStatus === 'completed' && input.blockingAffectedSessionId) {
    return {
      kind: 'requires-abandonment',
      sessionId: input.blockingAffectedSessionId,
    }
  }
  if (input.sourceSessionStatus === 'active' || input.sourceSessionStatus === 'paused') {
    return {
      kind: 'requires-abandonment',
      sessionId: input.sourceSessionId,
    }
  }
  return {
    kind: 'blocked',
    reason:
      input.sourceSessionStatus === 'completed'
        ? 'completed-source-awaiting-invalidation'
        : 'source-session-missing',
  }
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
  readonly original: {
    readonly status: string
    readonly actualLoadGrams: number | null
    readonly actualRepetitions: number | null
    readonly rpe: number | null
    readonly confirmedAt: Date | null
    readonly skippedAt: Date | null
    readonly skipReason: string | null
    readonly note: string | null
  }
  readonly correction: {
    readonly id: string
    readonly reason: string
    readonly actorUserId: string
    readonly createdAt: Date
  } | null
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
  readonly progressionInvalidated: boolean
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
    readonly original: {
      readonly painReported: boolean
      readonly details: string | null
      readonly answeredAt: Date
    }
    readonly correction: {
      readonly id: string
      readonly reason: string
      readonly actorUserId: string
      readonly createdAt: Date
    } | null
  } | null
}

export async function getTodayState(
  userId: string,
  timezone: string,
  now = new Date(),
): Promise<TodayState> {
  const db = getDb()
  const [activeHold] = await db
    .select({
      id: safetyHolds.id,
      reasonCode: safetyHolds.reasonCode,
      sourceSessionId: safetyHolds.sourceSessionId,
      sourceSessionStatus: workoutSessions.status,
      completedSourceInvalidated: sql<boolean>`
        indigo_completed_session_invalidation_is_durable(${safetyHolds.sourceSessionId})
      `,
      blockingAffectedSessionId: sql<string | null>`(
        WITH RECURSIVE affected_revision(revision_id) AS (
          SELECT DISTINCT decision.applied_revision_id
          FROM ${adjustmentDecisions} AS decision
          WHERE decision.session_id = ${safetyHolds.sourceSessionId}
            AND decision.applied_revision_id IS NOT NULL
          UNION
          SELECT lineage.revision_id
          FROM ${programRevisionLineage} AS lineage
          JOIN affected_revision AS parent
            ON parent.revision_id = lineage.parent_revision_id
        )
        SELECT session.id
        FROM affected_revision AS affected
        JOIN ${plannedWorkouts} AS workout
          ON workout.revision_id = affected.revision_id
        JOIN ${workoutSessions} AS session
          ON session.planned_workout_id = workout.id
        WHERE session.status IN ('initializing', 'active', 'paused')
        ORDER BY session.started_at, session.id
        LIMIT 1
      )`,
    })
    .from(safetyHolds)
    .leftJoin(workoutSessions, eq(workoutSessions.id, safetyHolds.sourceSessionId))
    .where(activeHoldWhere(userId))
    .limit(1)
  if (activeHold) {
    return {
      kind: 'hold',
      holdId: activeHold.id,
      sourceSessionId: activeHold.sourceSessionId,
      sourceSessionStatus: activeHold.sourceSessionStatus,
      resolutionAvailability: holdResolutionAvailability(activeHold),
    }
  }

  const [activeSession] = await db
    .select({
      id: workoutSessions.id,
      status: workoutSessions.status,
      methodologyReviewStatus: programRevisions.methodologyReviewStatus,
      templateReviewStatus: programRevisions.templateReviewStatus,
      contentRevoked: contentRevokedForProgramRevisionSql(),
      invalidatedRevisionId: programRevisionInvalidations.revisionId,
    })
    .from(workoutSessions)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId))
    .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
    .leftJoin(
      programRevisionInvalidations,
      eq(programRevisionInvalidations.revisionId, programRevisions.id),
    )
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
      progressionInvalidated: activeSession.invalidatedRevisionId !== null,
      contentEligibility: evaluatePersistedContentEligibility({
        contentMode: getServerConfig().contentMode,
        methodologyStatus: activeSession.methodologyReviewStatus,
        templateStatus: activeSession.templateReviewStatus,
        revoked: activeSession.contentRevoked,
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

  const contentRevoked = await programRevisionContentIsRevoked(db, program.revisionId)
  return {
    kind: 'planned',
    workout,
    contentEligibility: evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: program.methodologyReviewStatus,
      templateStatus: program.templateReviewStatus,
      revoked: contentRevoked,
    }),
  }
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
          inArray(workoutSessions.status, ['initializing', 'active', 'paused']),
        ),
      )
      .for('update', { of: workoutSessions })
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
      .where(activeHoldWhere(userId))
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
        revisionId: programRevisions.id,
        name: plannedWorkouts.name,
        scheduledDate: plannedWorkouts.scheduledDate,
        slotCode: plannedWorkouts.slotCode,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateReviewStatus: programRevisions.templateReviewStatus,
        invalidatedRevisionId: programRevisionInvalidations.revisionId,
        timezone: athleteProfiles.timezone,
      })
      .from(plannedWorkouts)
      .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
      .leftJoin(
        programRevisionInvalidations,
        eq(programRevisionInvalidations.revisionId, programRevisions.id),
      )
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
    if (
      !(await lockProgramRevisionContentReleases(transaction, ownedWorkout.revisionId))
    ) {
      throw new WorkoutCommandError(
        'content.release-missing',
        'The persisted content release is unavailable.',
      )
    }
    const contentRevoked = await programRevisionContentIsRevoked(
      transaction,
      ownedWorkout.revisionId,
    )
    const eligibility = evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: ownedWorkout.methodologyReviewStatus,
      templateStatus: ownedWorkout.templateReviewStatus,
      revoked: contentRevoked,
    })
    if (!eligibility.eligible) {
      throw new WorkoutCommandError(
        eligibility.code,
        'The persisted content release is not eligible to start.',
      )
    }
    if (ownedWorkout.invalidatedRevisionId) {
      throw new WorkoutCommandError(
        'program.revision-invalidated',
        'This session progression was invalidated by a training correction.',
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
      status: 'initializing',
      startedAt: now,
      startCommandId: command.commandId,
      snapshotFinalizedAt: null,
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

    await transaction
      .update(workoutSessions)
      .set({ status: 'active', snapshotFinalizedAt: now, updatedAt: now })
      .where(
        and(
          eq(workoutSessions.id, sessionId),
          eq(workoutSessions.status, 'initializing'),
        ),
      )

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
      contentRevoked: contentRevokedForProgramRevisionSql(),
      invalidatedRevisionId: programRevisionInvalidations.revisionId,
    })
    .from(workoutSessions)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId))
    .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
    .leftJoin(
      programRevisionInvalidations,
      eq(programRevisionInvalidations.revisionId, programRevisions.id),
    )
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
  const [feedbackCorrection] = await db
    .select({
      id: trainingFactCorrections.id,
      reason: trainingFactCorrections.reason,
      actorUserId: trainingFactCorrections.actorUserId,
      createdAt: trainingFactCorrections.createdAt,
      painReported: sessionFeedbackCorrections.painReported,
      details: sessionFeedbackCorrections.details,
    })
    .from(sessionFeedbackCorrections)
    .innerJoin(
      trainingFactCorrections,
      eq(trainingFactCorrections.id, sessionFeedbackCorrections.correctionId),
    )
    .where(eq(sessionFeedbackCorrections.sessionId, sessionId))
    .orderBy(desc(trainingFactCorrections.sequence))
    .limit(1)
  const setCorrections =
    sets.length === 0
      ? []
      : await db
          .select({
            id: trainingFactCorrections.id,
            reason: trainingFactCorrections.reason,
            actorUserId: trainingFactCorrections.actorUserId,
            createdAt: trainingFactCorrections.createdAt,
            sequence: trainingFactCorrections.sequence,
            performedSetId: performedSetCorrections.performedSetId,
            status: performedSetCorrections.status,
            actualLoadGrams: performedSetCorrections.actualLoadGrams,
            actualRepetitions: performedSetCorrections.actualRepetitions,
            rpe: performedSetCorrections.rpe,
            confirmedAt: performedSetCorrections.confirmedAt,
            skippedAt: performedSetCorrections.skippedAt,
            skipReason: performedSetCorrections.skipReason,
            note: performedSetCorrections.note,
          })
          .from(performedSetCorrections)
          .innerJoin(
            trainingFactCorrections,
            eq(trainingFactCorrections.id, performedSetCorrections.correctionId),
          )
          .where(
            inArray(
              performedSetCorrections.performedSetId,
              sets.map((set) => set.id),
            ),
          )
          .orderBy(desc(trainingFactCorrections.sequence))
  const effectiveSetCorrection = new Map<string, (typeof setCorrections)[number]>()
  for (const correction of setCorrections) {
    if (!effectiveSetCorrection.has(correction.performedSetId)) {
      effectiveSetCorrection.set(correction.performedSetId, correction)
    }
  }
  const priorRowsWithCorrections =
    exercises.length > 0
      ? await db
          .select({
            setId: performedSets.id,
            sessionId: workoutSessions.id,
            exerciseCode: sessionExercises.exerciseCode,
            completedAt: workoutSessions.completedAt,
            ordinal: performedSets.ordinal,
            status: performedSets.status,
            loadGrams: performedSets.actualLoadGrams,
            repetitions: performedSets.actualRepetitions,
            rpe: performedSets.rpe,
            correctionSequence: trainingFactCorrections.sequence,
            correctedStatus: performedSetCorrections.status,
            correctedLoadGrams: performedSetCorrections.actualLoadGrams,
            correctedRepetitions: performedSetCorrections.actualRepetitions,
            correctedRpe: performedSetCorrections.rpe,
          })
          .from(sessionExercises)
          .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
          .innerJoin(
            performedSets,
            eq(performedSets.sessionExerciseId, sessionExercises.id),
          )
          .leftJoin(
            performedSetCorrections,
            eq(performedSetCorrections.performedSetId, performedSets.id),
          )
          .leftJoin(
            trainingFactCorrections,
            eq(trainingFactCorrections.id, performedSetCorrections.correctionId),
          )
          .where(
            and(
              eq(workoutSessions.userId, userId),
              ne(workoutSessions.id, sessionId),
              eq(workoutSessions.status, 'completed'),
              inArray(
                sessionExercises.exerciseCode,
                exercises.map((exercise) => exercise.exerciseCode),
              ),
            ),
          )
          .orderBy(
            desc(workoutSessions.completedAt),
            asc(performedSets.ordinal),
            desc(trainingFactCorrections.sequence),
          )
      : []
  const seenPriorSets = new Set<string>()
  const priorRows = priorRowsWithCorrections.flatMap((row) => {
    if (seenPriorSets.has(row.setId)) return []
    seenPriorSets.add(row.setId)
    const status = row.correctedStatus ?? row.status
    const loadGrams = row.correctedStatus ? row.correctedLoadGrams : row.loadGrams
    const repetitions = row.correctedStatus ? row.correctedRepetitions : row.repetitions
    const rpe = row.correctedStatus ? row.correctedRpe : row.rpe
    return status === 'performed' ? [{ ...row, status, loadGrams, repetitions, rpe }] : []
  })

  return {
    id: session.id,
    status: session.status,
    startedAt: session.startedAt,
    pausedAt: session.pausedAt,
    completedAt: session.completedAt,
    optimisticVersion: session.optimisticVersion,
    progressionInvalidated: sessionContext.invalidatedRevisionId !== null,
    contentEligibility: evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: sessionContext.methodologyReviewStatus,
      templateStatus: sessionContext.templateReviewStatus,
      revoked: sessionContext.contentRevoked,
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
        .map((set) => {
          const correction = effectiveSetCorrection.get(set.id)
          return {
            id: set.id,
            ordinal: set.ordinal,
            status: correction?.status ?? set.status,
            targetLoadGrams: set.targetLoadGrams,
            targetRepetitions: set.targetRepetitions,
            restSeconds: set.restSeconds,
            actualLoadGrams: correction
              ? correction.actualLoadGrams
              : set.actualLoadGrams,
            actualRepetitions: correction
              ? correction.actualRepetitions
              : set.actualRepetitions,
            rpe: correction ? correction.rpe : set.rpe,
            confirmedAt: correction ? correction.confirmedAt : set.confirmedAt,
            skippedAt: correction ? correction.skippedAt : set.skippedAt,
            skipReason: correction ? correction.skipReason : set.skipReason,
            note: correction ? correction.note : set.note,
            original: {
              status: set.status,
              actualLoadGrams: set.actualLoadGrams,
              actualRepetitions: set.actualRepetitions,
              rpe: set.rpe,
              confirmedAt: set.confirmedAt,
              skippedAt: set.skippedAt,
              skipReason: set.skipReason,
              note: set.note,
            },
            correction: correction
              ? {
                  id: correction.id,
                  reason: correction.reason,
                  actorUserId: correction.actorUserId,
                  createdAt: correction.createdAt,
                }
              : null,
          }
        }),
    })),
    feedback: feedbackCorrection
      ? {
          painReported: feedbackCorrection.painReported,
          details: feedbackCorrection.details,
          original: {
            painReported: feedback?.painReported ?? false,
            details: feedback?.details ?? null,
            answeredAt: feedback?.answeredAt ?? feedbackCorrection.createdAt,
          },
          correction: {
            id: feedbackCorrection.id,
            reason: feedbackCorrection.reason,
            actorUserId: feedbackCorrection.actorUserId,
            createdAt: feedbackCorrection.createdAt,
          },
        }
      : feedback
        ? {
            painReported: feedback.painReported,
            details: feedback.details,
            original: {
              painReported: feedback.painReported,
              details: feedback.details,
              answeredAt: feedback.answeredAt,
            },
            correction: null,
          }
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
        revisionId: programRevisions.id,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateReviewStatus: programRevisions.templateReviewStatus,
        invalidatedRevisionId: programRevisionInvalidations.revisionId,
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
      .leftJoin(
        programRevisionInvalidations,
        eq(programRevisionInvalidations.revisionId, programRevisions.id),
      )
      .where(
        and(
          eq(performedSets.id, input.setId),
          eq(workoutSessions.id, input.sessionId),
          eq(workoutSessions.userId, input.userId),
        ),
      )
      .for('update', { of: performedSets })
      .limit(1)
    if (!set) throw new WorkoutCommandError('set.not-found', 'Set not found.')
    const receiptRequest = {
      commandType: 'complete-set',
      userId: input.userId,
      sessionId: input.sessionId,
      targetId: input.setId,
      payload: {
        actualLoadGrams: input.actualLoadGrams,
        actualRepetitions: input.actualRepetitions,
        rpe: input.rpe,
        note: input.note,
      },
    } satisfies TrainingCommandRequest
    if (await commandWasReplayed(transaction, input.commandId, receiptRequest)) return
    if (!(await lockProgramRevisionContentReleases(transaction, set.revisionId))) {
      throw new WorkoutCommandError(
        'content.release-missing',
        'The persisted content release is unavailable.',
      )
    }
    const contentRevoked = await programRevisionContentIsRevoked(
      transaction,
      set.revisionId,
    )
    const eligibility = evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: set.methodologyReviewStatus,
      templateStatus: set.templateReviewStatus,
      revoked: contentRevoked,
    })
    if (!eligibility.eligible) {
      throw new WorkoutCommandError(
        eligibility.code,
        'This persisted session content is not eligible for set recording.',
      )
    }
    if (set.invalidatedRevisionId) {
      throw new WorkoutCommandError(
        'program.revision-invalidated',
        'This session progression was invalidated by a training correction.',
      )
    }
    if (set.status !== 'pending') {
      throw new WorkoutCommandError('set.already-resolved', 'Set is already resolved.')
    }

    const [session] = await transaction
      .select({ status: workoutSessions.status })
      .from(workoutSessions)
      .where(eq(workoutSessions.id, input.sessionId))
      .for('update', { of: workoutSessions })
      .limit(1)
    if (session?.status !== 'active') {
      throw new WorkoutCommandError('session.not-active', 'Resume the session first.')
    }
    const [hold] = await transaction
      .select({ id: safetyHolds.id })
      .from(safetyHolds)
      .where(activeHoldWhere(input.userId))
      .limit(1)
    if (hold)
      throw new WorkoutCommandError('safety.hold-active', 'Set recording is blocked.')

    if (!(await claimCommandReceipt(transaction, input.commandId, receiptRequest))) return

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

/**
 * Authenticated application boundary for an exercise-substitution proposal.
 *
 * Indigo has no reviewed substitution release or persistence contract yet. This
 * gateway therefore verifies ownership, evaluates the domain policy, and denies
 * before any command receipt, session snapshot, or prescription can be written.
 * The unconditional denial is deliberate: if the domain policy is broadened before
 * persistence is implemented, this boundary still fails closed.
 */
export async function proposeExerciseSubstitution(rawInput: {
  readonly userId: string
  readonly sessionId: string
  readonly sessionExerciseId: string
  readonly commandId: string
  readonly requestedExerciseCode: string
}): Promise<never> {
  const input = {
    userId: rawInput.userId,
    ...parseWorkoutCommand(proposeExerciseSubstitutionCommandSchema, rawInput),
  }

  const [exercise] = await getDb()
    .select({ exerciseCode: sessionExercises.exerciseCode })
    .from(sessionExercises)
    .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
    .where(
      and(
        eq(sessionExercises.id, input.sessionExerciseId),
        eq(sessionExercises.sessionId, input.sessionId),
        eq(workoutSessions.userId, input.userId),
      ),
    )
    .limit(1)
  if (!exercise) {
    throw new WorkoutCommandError('exercise.not-found', 'Session exercise not found.')
  }

  const decision = evaluateSubstitution(
    exercise.exerciseCode,
    input.requestedExerciseCode,
  )
  throw new WorkoutCommandError(
    'substitution.unapproved',
    decision.allowed
      ? 'Substitution persistence is unavailable, so this proposal cannot be applied.'
      : decision.reason,
  )
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
        sessionStatus: workoutSessions.status,
        revisionId: programRevisions.id,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateReviewStatus: programRevisions.templateReviewStatus,
        invalidatedRevisionId: programRevisionInvalidations.revisionId,
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
      .leftJoin(
        programRevisionInvalidations,
        eq(programRevisionInvalidations.revisionId, programRevisions.id),
      )
      .where(
        and(
          eq(performedSets.id, input.setId),
          eq(workoutSessions.id, input.sessionId),
          eq(workoutSessions.userId, input.userId),
        ),
      )
      .for('update', { of: performedSets })
      .limit(1)
    if (!set) throw new WorkoutCommandError('set.not-found', 'Set not found.')
    const receiptRequest = {
      commandType: 'skip-set',
      userId: input.userId,
      sessionId: input.sessionId,
      targetId: input.setId,
      payload: { reason: input.reason },
    } satisfies TrainingCommandRequest
    if (await commandWasReplayed(transaction, input.commandId, receiptRequest)) return
    if (!(await lockProgramRevisionContentReleases(transaction, set.revisionId))) {
      throw new WorkoutCommandError(
        'content.release-missing',
        'The persisted content release is unavailable.',
      )
    }
    const contentRevoked = await programRevisionContentIsRevoked(
      transaction,
      set.revisionId,
    )
    const eligibility = evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: set.methodologyReviewStatus,
      templateStatus: set.templateReviewStatus,
      revoked: contentRevoked,
    })
    if (!eligibility.eligible) {
      throw new WorkoutCommandError(
        eligibility.code,
        'This persisted session content is not eligible for set changes.',
      )
    }
    if (set.invalidatedRevisionId) {
      throw new WorkoutCommandError(
        'program.revision-invalidated',
        'This session progression was invalidated by a training correction.',
      )
    }
    if (set.sessionStatus !== 'active') {
      throw new WorkoutCommandError('session.not-active', 'Resume the session first.')
    }
    if (set.status !== 'pending')
      throw new WorkoutCommandError('set.already-resolved', 'Set is already resolved.')

    const [hold] = await transaction
      .select({ id: safetyHolds.id })
      .from(safetyHolds)
      .where(activeHoldWhere(input.userId))
      .limit(1)
    if (hold) {
      throw new WorkoutCommandError('safety.hold-active', 'Set skipping is blocked.')
    }

    if (!(await claimCommandReceipt(transaction, input.commandId, receiptRequest))) return

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
          revisionId: programRevisions.id,
          methodologyReviewStatus: programRevisions.methodologyReviewStatus,
          templateReviewStatus: programRevisions.templateReviewStatus,
          invalidatedRevisionId: programRevisionInvalidations.revisionId,
        })
        .from(workoutSessions)
        .innerJoin(
          plannedWorkouts,
          eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
        )
        .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
        .leftJoin(
          programRevisionInvalidations,
          eq(programRevisionInvalidations.revisionId, programRevisions.id),
        )
        .where(
          and(
            eq(workoutSessions.id, command.sessionId),
            eq(workoutSessions.userId, userId),
            eq(workoutSessions.status, 'paused'),
          ),
        )
        .for('update', { of: workoutSessions })
        .limit(1)
      if (contentContext) {
        if (contentContext.invalidatedRevisionId) {
          throw new WorkoutCommandError(
            'program.revision-invalidated',
            'This session progression was invalidated by a training correction.',
          )
        }
        if (
          !(await lockProgramRevisionContentReleases(
            transaction,
            contentContext.revisionId,
          ))
        ) {
          throw new WorkoutCommandError(
            'content.release-missing',
            'The persisted content release is unavailable.',
          )
        }
        const contentRevoked = await programRevisionContentIsRevoked(
          transaction,
          contentContext.revisionId,
        )
        const eligibility = evaluatePersistedContentEligibility({
          contentMode: getServerConfig().contentMode,
          methodologyStatus: contentContext.methodologyReviewStatus,
          templateStatus: contentContext.templateReviewStatus,
          revoked: contentRevoked,
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
        .where(activeHoldWhere(userId))
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

export async function reportPain(rawInput: {
  readonly userId: string
  readonly sessionId: string
  readonly commandId: string
  readonly details: string
}): Promise<void> {
  const input = {
    userId: rawInput.userId,
    ...parseWorkoutCommand(reportPainCommandSchema, rawInput),
  }

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`,
    )
    const [session] = await transaction
      .select({ id: workoutSessions.id, status: workoutSessions.status })
      .from(workoutSessions)
      .where(
        and(
          eq(workoutSessions.id, input.sessionId),
          eq(workoutSessions.userId, input.userId),
        ),
      )
      .for('update', { of: workoutSessions })
      .limit(1)
    if (!session) throw new WorkoutCommandError('session.not-found', 'Session not found.')
    const receiptRequest = {
      commandType: 'report-pain',
      userId: input.userId,
      sessionId: input.sessionId,
      targetId: input.sessionId,
      payload: { details: input.details },
    } satisfies TrainingCommandRequest
    if (await commandWasReplayed(transaction, input.commandId, receiptRequest)) return
    if (!['active', 'paused', 'completed'].includes(session.status))
      throw new WorkoutCommandError(
        'session.not-reportable',
        'This session cannot accept a safety report.',
      )

    const [existingHold] = await transaction
      .select({ id: safetyHolds.id, sourceSessionId: safetyHolds.sourceSessionId })
      .from(safetyHolds)
      .where(
        and(
          activeHoldWhere(input.userId),
          eq(safetyHolds.reasonCode, 'session-pain-reported'),
          eq(safetyHolds.sourceSessionId, input.sessionId),
        ),
      )
      .for('update')
      .limit(1)
    if (!(await claimCommandReceipt(transaction, input.commandId, receiptRequest))) return

    const now = new Date()
    if (session.status === 'active') {
      await transaction
        .update(workoutSessions)
        .set({
          status: 'paused',
          pausedAt: now,
          optimisticVersion: sql`${workoutSessions.optimisticVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(workoutSessions.id, input.sessionId))
    }

    let correctionId: string | null = null
    let invalidation:
      | Awaited<ReturnType<typeof invalidateProgressionFromCorrection>>
      | undefined
    if (session.status === 'completed') {
      correctionId = newUuidV7()
      await transaction.insert(trainingFactCorrections).values({
        id: correctionId,
        userId: input.userId,
        sessionId: input.sessionId,
        actorUserId: input.userId,
        commandId: input.commandId,
        correctionKind: 'session-feedback',
        sequence: await nextCorrectionSequence(transaction, input.sessionId),
        reason: 'Pain reported after session completion.',
        createdAt: now,
      })
      await transaction.insert(sessionFeedbackCorrections).values({
        correctionId,
        sessionId: input.sessionId,
        userId: input.userId,
        painReported: true,
        details: input.details || null,
        answeredAt: now,
      })
      invalidation = await invalidateProgressionFromCorrection(transaction, {
        correctionId,
        userId: input.userId,
        sourceSessionId: input.sessionId,
        now,
      })
    } else {
      await transaction
        .insert(sessionFeedback)
        .values({
          sessionId: input.sessionId,
          painReported: true,
          details: input.details || null,
          answeredAt: now,
        })
        .onConflictDoNothing({ target: sessionFeedback.sessionId })
    }
    if (!existingHold) {
      await transaction.insert(safetyHolds).values({
        id: newUuidV7(),
        userId: input.userId,
        sourceSessionId: input.sessionId,
        reasonCode: 'session-pain-reported',
        details: input.details || null,
      })
    }
    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: input.userId,
      subjectUserId: input.userId,
      eventType: 'session-safety-stop',
      entityType: 'workout-session',
      entityId: input.sessionId,
      metadata: {
        action:
          session.status === 'completed' ? 'post-completion-hold' : 'paused-and-held',
        coalescedWithExistingHold: Boolean(existingHold),
        correctionId,
        invalidatedDecisionCount: invalidation?.decisionIds.length ?? 0,
        invalidatedRevisionCount: invalidation?.revisionIds.length ?? 0,
        pausedAffectedSessionCount: invalidation?.pausedSessionIds.length ?? 0,
      },
    })
  })
}

export async function correctPerformedSet(rawInput: {
  readonly userId: string
  readonly sessionId: string
  readonly setId: string
  readonly commandId: string
  readonly reason: string
  readonly actualLoadGrams: number
  readonly actualRepetitions: number
  readonly rpe: number | null
  readonly note: string | null
}): Promise<void> {
  const input = {
    userId: rawInput.userId,
    ...parseWorkoutCommand(correctPerformedSetCommandSchema, rawInput),
  }

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`,
    )
    const [target] = await transaction
      .select({
        id: performedSets.id,
        status: performedSets.status,
        targetLoadGrams: performedSets.targetLoadGrams,
        targetRepetitions: performedSets.targetRepetitions,
        sessionStatus: workoutSessions.status,
      })
      .from(performedSets)
      .innerJoin(
        sessionExercises,
        eq(sessionExercises.id, performedSets.sessionExerciseId),
      )
      .innerJoin(workoutSessions, eq(workoutSessions.id, sessionExercises.sessionId))
      .where(
        and(
          eq(performedSets.id, input.setId),
          eq(workoutSessions.id, input.sessionId),
          eq(workoutSessions.userId, input.userId),
        ),
      )
      .for('update')
      .limit(1)
    if (!target) throw new WorkoutCommandError('set.not-found', 'Set not found.')

    const receiptRequest = {
      commandType: 'correct-performed-set',
      userId: input.userId,
      sessionId: input.sessionId,
      targetId: input.setId,
      payload: {
        reason: input.reason,
        actualLoadGrams: input.actualLoadGrams,
        actualRepetitions: input.actualRepetitions,
        rpe: input.rpe,
        note: input.note,
      },
    } satisfies TrainingCommandRequest
    if (await commandWasReplayed(transaction, input.commandId, receiptRequest)) return
    if (target.sessionStatus !== 'completed' || target.status === 'pending') {
      throw new WorkoutCommandError(
        'set.not-correctable',
        'Only a resolved set from a completed session can be corrected.',
      )
    }
    if (!(await claimCommandReceipt(transaction, input.commandId, receiptRequest))) return

    const now = new Date()
    const correctionId = newUuidV7()
    await transaction.insert(trainingFactCorrections).values({
      id: correctionId,
      userId: input.userId,
      sessionId: input.sessionId,
      actorUserId: input.userId,
      commandId: input.commandId,
      correctionKind: 'performed-set',
      sequence: await nextCorrectionSequence(transaction, input.sessionId),
      reason: input.reason,
      createdAt: now,
    })
    await transaction.insert(performedSetCorrections).values({
      correctionId,
      sessionId: input.sessionId,
      userId: input.userId,
      performedSetId: input.setId,
      status: 'performed',
      actualLoadGrams: input.actualLoadGrams,
      actualRepetitions: input.actualRepetitions,
      rpe: input.rpe,
      loadProvenance:
        input.actualLoadGrams === target.targetLoadGrams ? 'copied-target' : 'edited',
      repetitionsProvenance:
        input.actualRepetitions === target.targetRepetitions ? 'copied-target' : 'edited',
      explicitlyConfirmed: true,
      confirmedAt: now,
      note: input.note,
    })
    const invalidation = await invalidateProgressionFromCorrection(transaction, {
      correctionId,
      userId: input.userId,
      sourceSessionId: input.sessionId,
      now,
    })
    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: input.userId,
      subjectUserId: input.userId,
      eventType: 'training-fact-corrected',
      entityType: 'performed-set',
      entityId: input.setId,
      metadata: {
        correctionId,
        invalidatedDecisionCount: invalidation.decisionIds.length,
        invalidatedRevisionCount: invalidation.revisionIds.length,
        pausedAffectedSessionCount: invalidation.pausedSessionIds.length,
      },
    })
  })
}

export async function resolveSafetyHold(rawInput: {
  readonly userId: string
  readonly holdId: string
  readonly commandId: string
  readonly reason: string
  readonly acknowledged: boolean
}): Promise<void> {
  const input = {
    userId: rawInput.userId,
    ...parseWorkoutCommand(resolveSafetyHoldCommandSchema, rawInput),
  }

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`,
    )
    const [hold] = await transaction
      .select({
        id: safetyHolds.id,
        userId: safetyHolds.userId,
        reasonCode: safetyHolds.reasonCode,
        sourceSessionId: safetyHolds.sourceSessionId,
        clearedAt: safetyHolds.clearedAt,
      })
      .from(safetyHolds)
      .where(eq(safetyHolds.id, input.holdId))
      .for('update')
      .limit(1)
    if (!hold || hold.userId !== input.userId) {
      throw new WorkoutCommandError('hold.not-found', 'Hold not found.')
    }
    if (
      hold.reasonCode !== 'session-pain-reported' ||
      !hold.sourceSessionId ||
      hold.clearedAt
    ) {
      throw new WorkoutCommandError(
        'hold.not-resolvable',
        'This hold is not an independently source-linked pain hold.',
      )
    }

    const receiptRequest = {
      commandType: 'resolve-safety-hold',
      userId: input.userId,
      sessionId: hold.sourceSessionId,
      targetId: input.holdId,
      payload: {
        reason: input.reason,
        acknowledged: input.acknowledged,
      },
    } satisfies TrainingCommandRequest
    if (await commandWasReplayed(transaction, input.commandId, receiptRequest)) return
    if (!input.acknowledged) {
      throw new WorkoutCommandError(
        'hold.ack-required',
        'Confirm that you understand this product does not assess or clear symptoms.',
      )
    }

    const [existingResolution] = await transaction
      .select({ id: safetyHoldResolutions.id })
      .from(safetyHoldResolutions)
      .where(eq(safetyHoldResolutions.holdId, input.holdId))
      .limit(1)
    if (existingResolution) {
      throw new WorkoutCommandError(
        'hold.already-resolved',
        'This hold has already been resolved.',
      )
    }

    const [sourceSession] = await transaction
      .select({ status: workoutSessions.status, userId: workoutSessions.userId })
      .from(workoutSessions)
      .where(eq(workoutSessions.id, hold.sourceSessionId))
      .limit(1)
    if (!sourceSession || sourceSession.userId !== input.userId) {
      throw new WorkoutCommandError(
        'hold.not-resolvable',
        'The source session is missing or does not belong to this trainee.',
      )
    }
    if (sourceSession.status === 'active' || sourceSession.status === 'paused') {
      throw new WorkoutCommandError(
        'hold.live-session-not-abandoned',
        'Abandon the affected workout before resolving this hold.',
      )
    }
    if (
      sourceSession.status === 'completed' &&
      !(await completedSessionInvalidationIsDurable(transaction, hold.sourceSessionId))
    ) {
      throw new WorkoutCommandError(
        'hold.completed-source-invalidation-required',
        'This hold remains active until affected future training is invalidated.',
      )
    }
    if (!['abandoned', 'completed'].includes(sourceSession.status)) {
      throw new WorkoutCommandError(
        'hold.not-resolvable',
        'The source session is not in a resolvable terminal state.',
      )
    }

    if (!(await claimCommandReceipt(transaction, input.commandId, receiptRequest))) return

    await transaction.insert(safetyHoldResolutions).values({
      id: newUuidV7(),
      holdId: input.holdId,
      userId: input.userId,
      reason: input.reason,
      acknowledged: input.acknowledged,
    })
    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: input.userId,
      subjectUserId: input.userId,
      eventType: 'safety-hold-resolved',
      entityType: 'safety-hold',
      entityId: input.holdId,
      metadata: {
        sourceSessionId: hold.sourceSessionId,
        reasonLength: input.reason.length,
        acknowledged: input.acknowledged,
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
    const receiptRequest = {
      commandType: 'complete-workout',
      userId: input.userId,
      sessionId: input.sessionId,
      targetId: input.sessionId,
      payload: { noPainAttested: input.noPainAttested },
    } satisfies TrainingCommandRequest
    if (await commandWasReplayed(transaction, input.commandId, receiptRequest)) return
    if (!input.noPainAttested) {
      throw new WorkoutCommandError(
        'session.feedback-required',
        'Confirm the end-of-session safety question.',
      )
    }
    if (session.status !== 'active') {
      throw new WorkoutCommandError(
        'session.not-completable',
        'Resume the session before completing it.',
      )
    }

    const [adjustmentContext] = await transaction
      .select({
        revisionId: programRevisions.id,
        methodologyId: programRevisions.methodologyId,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateReviewStatus: programRevisions.templateReviewStatus,
        invalidatedRevisionId: programRevisionInvalidations.revisionId,
      })
      .from(workoutSessions)
      .innerJoin(
        plannedWorkouts,
        eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
      )
      .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
      .leftJoin(
        programRevisionInvalidations,
        eq(programRevisionInvalidations.revisionId, programRevisions.id),
      )
      .where(eq(workoutSessions.id, input.sessionId))
      .for('update', { of: workoutSessions })
      .limit(1)
    if (!adjustmentContext) {
      throw new WorkoutCommandError(
        'content.release-missing',
        'The persisted content release is unavailable.',
      )
    }
    if (adjustmentContext.invalidatedRevisionId) {
      throw new WorkoutCommandError(
        'program.revision-invalidated',
        'This session progression was invalidated by a training correction.',
      )
    }
    if (
      !(await lockProgramRevisionContentReleases(
        transaction,
        adjustmentContext.revisionId,
      ))
    ) {
      throw new WorkoutCommandError(
        'content.release-missing',
        'The persisted content release is unavailable.',
      )
    }
    const contentRevoked = await programRevisionContentIsRevoked(
      transaction,
      adjustmentContext.revisionId,
    )
    const eligibility = evaluatePersistedContentEligibility({
      contentMode: getServerConfig().contentMode,
      methodologyStatus: adjustmentContext.methodologyReviewStatus,
      templateStatus: adjustmentContext.templateReviewStatus,
      revoked: contentRevoked,
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
      .where(activeHoldWhere(input.userId))
      .limit(1)
    if (hold) {
      throw new WorkoutCommandError(
        'safety.hold-active',
        'An active safety hold blocks workout completion.',
      )
    }

    if (!(await claimCommandReceipt(transaction, input.commandId, receiptRequest))) return

    const now = new Date()
    if (!feedback) {
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
    }

    const [programContext] = await transaction
      .select({
        programId: programs.id,
        sourceProgramOrdinal: plannedWorkouts.programOrdinal,
        sourceScheduledDate: plannedWorkouts.scheduledDate,
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

    let appliedRevisionId: string | null = null
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
            gt(plannedWorkouts.programOrdinal, programContext.sourceProgramOrdinal),
          ),
        )
        .orderBy(asc(plannedWorkouts.programOrdinal))

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
          sourceProgramOrdinal: programContext.sourceProgramOrdinal,
          sourceScheduledDate: programContext.sourceScheduledDate,
          decisions: decisions.map((decision) => ({
            exerciseCode: decision.exerciseCode,
            kind: decision.kind,
            currentTargetLoadGrams: decision.currentTargetLoadGrams,
            proposedTargetLoadGrams: decision.proposedTargetLoadGrams,
            reasonCode: decision.reasonCode,
            policyVersion: decision.policyVersion,
          })),
        } satisfies CanonicalValue
        const normalizedInputHash = canonicalSha256(normalizedInput)
        const outputSnapshot: ExecutablePrescriptionProjection = {
          hashMaterialVersion: EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
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
          workouts: futureWorkouts.map((workout, workoutIndex) => ({
            ordinal: workoutIndex + 1,
            programOrdinal: workout.programOrdinal,
            scheduledDate: workout.scheduledDate,
            slotCode: workout.slotCode,
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
        }
        const outputHash = executablePrescriptionHash(outputSnapshot)
        const revisionId = newUuidV7()

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
        await transaction.insert(programRevisionLineage).values({
          revisionId,
          parentRevisionId: programContext.sourceRevisionId,
          sourceSessionId: input.sessionId,
          sourceProgramOrdinal: programContext.sourceProgramOrdinal,
        })

        for (const workout of outputSnapshot.workouts) {
          const plannedWorkoutId = newUuidV7()
          await transaction.insert(plannedWorkouts).values({
            id: plannedWorkoutId,
            revisionId,
            scheduledDate: workout.scheduledDate,
            ordinal: workout.ordinal,
            programOrdinal: workout.programOrdinal,
            slotCode: workout.slotCode,
            name: workout.name,
          })

          for (const exercise of workout.exercises) {
            const exercisePrescriptionId = newUuidV7()
            await transaction.insert(exercisePrescriptions).values({
              id: exercisePrescriptionId,
              plannedWorkoutId,
              exerciseCode: exercise.exerciseCode,
              exerciseName: exercise.exerciseName,
              ordinal: exercise.ordinal,
              safetyTier: exercise.safetyTier,
              rationaleCode: exercise.rationaleCode,
            })
            await transaction.insert(setPrescriptions).values(
              exercise.sets.map((set) => ({
                id: newUuidV7(),
                exercisePrescriptionId,
                ordinal: set.ordinal,
                setKind: set.setKind,
                targetLoadGrams: set.targetLoadGrams,
                targetRepetitions: set.targetRepetitions,
                restSeconds: set.restSeconds,
              })),
            )
          }
        }

        await activatePersistedProgramRevision(transaction, {
          kind: 'remaining',
          userId: input.userId,
          revisionId,
          sourceSessionId: input.sessionId,
        })
        appliedRevisionId = revisionId
      }
    }

    if (decisions.length > 0) {
      await transaction.insert(adjustmentDecisions).values(
        decisions.map((decision) => ({
          id: newUuidV7(),
          sessionId: input.sessionId,
          appliedRevisionId,
          exerciseCode: decision.exerciseCode,
          decision: decision.kind === 'blocked' ? 'unavailable' : decision.kind,
          currentLoadGrams: decision.currentTargetLoadGrams,
          nextLoadGrams: decision.proposedTargetLoadGrams,
          reasonCode: decision.reasonCode,
          ruleVersion: decision.policyVersion,
        })),
      )
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
  rawReason: string,
): Promise<void> {
  const { sessionId, reason } = parseWorkoutCommand(abandonWorkoutCommandSchema, {
    sessionId: rawSessionId,
    reason: rawReason,
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
        abandonedReason: reason,
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

    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: userId,
      subjectUserId: userId,
      eventType: 'workout-abandoned',
      entityType: 'workout-session',
      entityId: sessionId,
      metadata: { reason },
    })
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
      contentRevoked: contentRevokedForProgramRevisionSql(),
    })
    .from(workoutSessions)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId))
    .innerJoin(programRevisions, eq(programRevisions.id, plannedWorkouts.revisionId))
    .where(
      and(eq(workoutSessions.userId, userId), eq(workoutSessions.status, 'completed')),
    )
    .orderBy(asc(workoutSessions.completedAt))

  return sessions.flatMap(
    ({ methodologyReviewStatus, templateReviewStatus, contentRevoked, ...session }) => {
      const contentEligibility = evaluatePersistedContentEligibility({
        contentMode: getServerConfig().contentMode,
        methodologyStatus: methodologyReviewStatus,
        templateStatus: templateReviewStatus,
        revoked: contentRevoked,
      })
      return contentEligibility.eligible || contentEligibility.code === 'content.revoked'
        ? [{ ...session, contentEligibility }]
        : []
    },
  )
}

export async function getSessionAdjustments(userId: string, sessionId: string) {
  const [owned] = await getDb()
    .select({
      id: workoutSessions.id,
      methodologyReviewStatus: programRevisions.methodologyReviewStatus,
      templateReviewStatus: programRevisions.templateReviewStatus,
      contentRevoked: contentRevokedForProgramRevisionSql(),
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
  const contentEligibility = evaluatePersistedContentEligibility({
    contentMode: getServerConfig().contentMode,
    methodologyStatus: owned.methodologyReviewStatus,
    templateStatus: owned.templateReviewStatus,
    revoked: owned.contentRevoked,
  })
  if (!contentEligibility.eligible && contentEligibility.code !== 'content.revoked') {
    return null
  }
  return getDb()
    .select({
      ...getTableColumns(adjustmentDecisions),
      invalidatedAt: adjustmentDecisionInvalidations.createdAt,
      invalidationCorrectionId: adjustmentDecisionInvalidations.correctionId,
      invalidationReason: trainingFactCorrections.reason,
    })
    .from(adjustmentDecisions)
    .leftJoin(
      adjustmentDecisionInvalidations,
      eq(adjustmentDecisionInvalidations.decisionId, adjustmentDecisions.id),
    )
    .leftJoin(
      trainingFactCorrections,
      eq(trainingFactCorrections.id, adjustmentDecisionInvalidations.correctionId),
    )
    .where(eq(adjustmentDecisions.sessionId, sessionId))
    .orderBy(asc(adjustmentDecisions.exerciseCode))
}
