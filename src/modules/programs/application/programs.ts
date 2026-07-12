import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import type { CanonicalValue } from '@/modules/methodology/domain/canonical'
import { DEVELOPMENT_EXERCISE_EQUIPMENT } from '@/modules/methodology/domain/development-fixture'
import {
  type DevelopmentProgramGenerationResult,
  generateDevelopmentProgram,
  type Weekday,
} from '@/modules/methodology/domain/program'
import { evaluatePersistedContentEligibility } from '@/modules/programs/domain/content-eligibility'
import {
  EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
  type ExecutablePrescriptionProjection,
  executablePrescriptionHash,
  verifyExecutablePrescriptionIntegrity,
} from '@/modules/programs/domain/executable-prescription'
import { validatePersistedPrescriptionForActivation } from '@/modules/programs/domain/prescription-activation'
import { getServerConfig } from '@/platform/config/server'
import { type DatabaseTransaction, getDb } from '@/platform/db/client'
import {
  athleteEquipment,
  auditEvents,
  exercisePrescriptions,
  plannedWorkouts,
  programRevisionLineage,
  programRevisions,
  programs,
  safetyHolds,
  setPrescriptions,
  workoutSessions,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

export class ProgramUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProgramUnavailableError'
  }
}

export type ProgramSetView = {
  readonly id: string
  readonly ordinal: number
  readonly targetLoadGrams: number
  readonly targetRepetitions: number
  readonly restSeconds: number
}

export type ProgramExerciseView = {
  readonly id: string
  readonly exerciseCode: string
  readonly exerciseName: string
  readonly ordinal: number
  readonly safetyTier: string
  readonly rationaleCode: string
  readonly sets: readonly ProgramSetView[]
}

export type ProgramWorkoutView = {
  readonly id: string
  readonly scheduledDate: string
  readonly ordinal: number
  readonly programOrdinal: number
  readonly slotCode: string
  readonly name: string
  readonly exercises: readonly ProgramExerciseView[]
}

export type ProgramOverview = {
  readonly programId: string
  readonly programStatus: string
  readonly revisionId: string
  readonly revisionNumber: number
  readonly revisionStatus: string
  readonly engineVersion: string
  readonly methodologyId: string
  readonly methodologyVersion: string
  readonly methodologyReviewStatus: string
  readonly templateId: string
  readonly templateVersion: string
  readonly templateReviewStatus: string
  readonly normalizedInputHash: string
  readonly outputHash: string
  readonly warnings: readonly { readonly code: string; readonly summary: string }[]
  readonly manualReviewRequired: boolean
  readonly workouts: readonly ProgramWorkoutView[]
}

function toIsoWeekday(day: number): Weekday {
  return (day === 0 ? 7 : day) as Weekday
}

function developmentExecutablePrescription(
  result: Extract<DevelopmentProgramGenerationResult, { readonly status: 'created' }>,
): ExecutablePrescriptionProjection {
  return {
    hashMaterialVersion: EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
    engineVersion: result.prescription.engineVersion,
    methodology: {
      id: result.prescription.methodologyRelease.id,
      version: result.prescription.methodologyRelease.version,
      reviewStatus: 'development',
    },
    template: {
      id: result.prescription.template.id,
      version: result.prescription.template.version,
      reviewStatus: 'development',
    },
    normalizedInputHash: result.prescription.normalizedInputHash.value,
    workouts: result.prescription.output.plannedWorkouts.map((workout, index) => ({
      scheduledDate: workout.localDate,
      ordinal: index + 1,
      programOrdinal: index + 1,
      slotCode: workout.sessionKey,
      name: `Session ${workout.sessionKey} — development fixture`,
      exercises: workout.exercises.map((exercise) => ({
        exerciseCode: exercise.exerciseId,
        exerciseName: exercise.name,
        ordinal: exercise.ordinal,
        safetyTier: 'standard',
        rationaleCode: 'development.fixture-instantiation',
        sets: exercise.sets.map((set) => ({
          ordinal: set.ordinal,
          setKind: 'working',
          targetLoadGrams: set.targetLoadGrams,
          targetRepetitions: set.targetRepetitions,
          restSeconds: set.restSeconds,
        })),
      })),
    })),
  }
}

export async function generateDraftProgram(
  userId: string,
  asOfDate: string,
): Promise<DevelopmentProgramGenerationResult> {
  const profileBundle = await getAthleteProfile(userId)
  if (!profileBundle) {
    throw new ProgramUnavailableError('profile.missing', 'Complete trainee setup first.')
  }

  const requiredEquipment = new Set(['barbell', 'rack', 'bench', 'plates'])
  for (const item of profileBundle.equipment) {
    requiredEquipment.delete(item.equipmentCode)
  }
  if (requiredEquipment.size > 0) {
    throw new ProgramUnavailableError(
      'equipment.missing',
      `The development fixture requires: ${[...requiredEquipment].join(', ')}.`,
    )
  }

  const restriction = profileBundle.profile.restrictionStatus
  const result = generateDevelopmentProgram(
    {
      asOfDate,
      trainingWeekdays: profileBundle.days.map((day) => toIsoWeekday(day.weekday)),
      startingLoads: profileBundle.baselines.map((baseline) => ({
        exerciseId: baseline.exerciseCode,
        loadGrams: baseline.loadGrams,
      })),
      safety: {
        isAdult: profileBundle.profile.adultAttested,
        familiarWithResistanceTraining: profileBundle.profile.techniqueAttested,
        hasCurrentPain:
          restriction === 'present' ? true : restriction === 'uncertain' ? null : false,
        hasContraindication:
          restriction === 'present' ? true : restriction === 'uncertain' ? null : false,
        hasProfessionalRestriction:
          restriction === 'present' ? true : restriction === 'uncertain' ? null : false,
      },
    },
    getServerConfig().contentMode === 'development' ? 'development' : 'production',
  )

  if (result.status === 'blocked') {
    return result
  }
  const executablePrescription = developmentExecutablePrescription(result)
  const persistedOutputHash = executablePrescriptionHash(executablePrescription)

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    )
    const [existing] = await transaction
      .select({ id: programRevisions.id })
      .from(programRevisions)
      .innerJoin(programs, eq(programs.id, programRevisions.programId))
      .where(
        and(
          eq(programs.userId, userId),
          eq(
            programRevisions.normalizedInputHash,
            result.prescription.normalizedInputHash.value,
          ),
          inArray(programRevisions.status, ['draft', 'active']),
        ),
      )
      .limit(1)
    if (existing) return

    const now = new Date()
    const programId = newUuidV7()
    const revisionId = newUuidV7()

    await transaction
      .update(programs)
      .set({ status: 'retired', updatedAt: now })
      .where(and(eq(programs.userId, userId), eq(programs.status, 'draft')))

    await transaction.insert(programs).values({
      id: programId,
      userId,
      status: 'draft',
    })

    await transaction.insert(programRevisions).values({
      id: revisionId,
      programId,
      revisionNumber: 1,
      status: 'draft',
      engineVersion: result.prescription.engineVersion,
      methodologyId: result.prescription.methodologyRelease.id,
      methodologyVersion: result.prescription.methodologyRelease.version,
      methodologyReviewStatus: 'development',
      templateId: result.prescription.template.id,
      templateVersion: result.prescription.template.version,
      templateReviewStatus: 'development',
      normalizedInputHash: result.prescription.normalizedInputHash.value,
      outputHash: persistedOutputHash,
      normalizedInput: result.normalizedInput,
      outputSnapshot: executablePrescription,
      warnings: result.prescription.warnings,
      manualReviewRequired: result.prescription.manualReview.required,
    })

    for (const workout of executablePrescription.workouts) {
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

    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: userId,
      subjectUserId: userId,
      eventType: 'program-draft-created',
      entityType: 'program-revision',
      entityId: revisionId,
      metadata: {
        contentMode: 'development',
        inputHash: result.prescription.normalizedInputHash.value,
        outputHash: persistedOutputHash,
      },
    })
  })

  return result
}

type PersistedProgramActivationRequest =
  | {
      readonly kind: 'initial'
      readonly userId: string
      readonly revisionId: string
    }
  | {
      readonly kind: 'remaining'
      readonly userId: string
      readonly revisionId: string
      readonly sourceSessionId: string
    }

export async function activatePersistedProgramRevision(
  transaction: DatabaseTransaction,
  request: PersistedProgramActivationRequest,
): Promise<void> {
  const { userId, revisionId } = request
  const config = getServerConfig()
  const [owned] = await transaction
    .select({
      programId: programs.id,
      revisionStatus: programRevisions.status,
      engineVersion: programRevisions.engineVersion,
      methodologyId: programRevisions.methodologyId,
      methodologyVersion: programRevisions.methodologyVersion,
      templateId: programRevisions.templateId,
      templateVersion: programRevisions.templateVersion,
      templateReviewStatus: programRevisions.templateReviewStatus,
      methodologyReviewStatus: programRevisions.methodologyReviewStatus,
      normalizedInputHash: programRevisions.normalizedInputHash,
      normalizedInput: programRevisions.normalizedInput,
      outputHash: programRevisions.outputHash,
      outputSnapshot: programRevisions.outputSnapshot,
    })
    .from(programRevisions)
    .innerJoin(programs, eq(programs.id, programRevisions.programId))
    .where(and(eq(programRevisions.id, revisionId), eq(programs.userId, userId)))
    .for('update')
    .limit(1)

  if (!owned) {
    throw new ProgramUnavailableError('program.not-found', 'Program revision not found.')
  }
  if (owned.revisionStatus !== 'draft') {
    throw new ProgramUnavailableError(
      'program.revision-not-draft',
      'Only a draft revision can be activated.',
    )
  }

  const [remainingSource] =
    request.kind === 'remaining'
      ? await transaction
          .select({
            parentRevisionId: programRevisionLineage.parentRevisionId,
            sourceSessionId: programRevisionLineage.sourceSessionId,
            sourceProgramOrdinal: programRevisionLineage.sourceProgramOrdinal,
            sourceScheduledDate: workoutSessions.scheduledDate,
            sourceSessionStatus: workoutSessions.status,
            parentStatus: programRevisions.status,
            parentProgramId: programRevisions.programId,
          })
          .from(programRevisionLineage)
          .innerJoin(
            workoutSessions,
            eq(workoutSessions.id, programRevisionLineage.sourceSessionId),
          )
          .innerJoin(
            plannedWorkouts,
            eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
          )
          .innerJoin(
            programRevisions,
            eq(programRevisions.id, programRevisionLineage.parentRevisionId),
          )
          .where(
            and(
              eq(programRevisionLineage.revisionId, revisionId),
              eq(programRevisionLineage.sourceSessionId, request.sourceSessionId),
              eq(workoutSessions.userId, userId),
              eq(plannedWorkouts.revisionId, programRevisionLineage.parentRevisionId),
              eq(
                plannedWorkouts.programOrdinal,
                programRevisionLineage.sourceProgramOrdinal,
              ),
            ),
          )
          .for('update')
          .limit(1)
      : []
  if (
    request.kind === 'remaining' &&
    (!remainingSource ||
      remainingSource.parentProgramId !== owned.programId ||
      remainingSource.parentStatus !== 'active' ||
      !['active', 'paused'].includes(remainingSource.sourceSessionStatus))
  ) {
    throw new ProgramUnavailableError(
      'program.remaining-schedule-stale',
      'The source revision or workout is no longer eligible for adjustment.',
    )
  }

  const eligibility = evaluatePersistedContentEligibility({
    contentMode: config.contentMode,
    methodologyStatus: owned.methodologyReviewStatus,
    templateStatus: owned.templateReviewStatus,
  })
  if (!eligibility.eligible) {
    throw new ProgramUnavailableError(
      eligibility.code,
      'The persisted content release is not eligible for activation.',
    )
  }

  const workoutRows = await transaction
    .select()
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.revisionId, revisionId))
    .orderBy(asc(plannedWorkouts.ordinal))
    .for('update')
  const workoutIds = workoutRows.map((workout) => workout.id)
  const exerciseRows =
    workoutIds.length > 0
      ? await transaction
          .select()
          .from(exercisePrescriptions)
          .where(inArray(exercisePrescriptions.plannedWorkoutId, workoutIds))
          .orderBy(asc(exercisePrescriptions.ordinal))
          .for('update')
      : []
  const exerciseIds = exerciseRows.map((exercise) => exercise.id)
  const prescriptionSets =
    exerciseIds.length > 0
      ? await transaction
          .select()
          .from(setPrescriptions)
          .where(inArray(setPrescriptions.exercisePrescriptionId, exerciseIds))
          .orderBy(asc(setPrescriptions.ordinal))
          .for('update')
      : []
  const equipment = await transaction
    .select({ code: athleteEquipment.equipmentCode })
    .from(athleteEquipment)
    .where(eq(athleteEquipment.userId, userId))
  const persistedWorkouts = workoutRows.map((workout) => ({
    scheduledDate: workout.scheduledDate,
    ordinal: workout.ordinal,
    programOrdinal: workout.programOrdinal,
    slotCode: workout.slotCode,
    name: workout.name,
    exercises: exerciseRows
      .filter((exercise) => exercise.plannedWorkoutId === workout.id)
      .map((exercise) => ({
        exerciseCode: exercise.exerciseCode,
        exerciseName: exercise.exerciseName,
        ordinal: exercise.ordinal,
        safetyTier: exercise.safetyTier,
        rationaleCode: exercise.rationaleCode,
        sets: prescriptionSets
          .filter((set) => set.exercisePrescriptionId === exercise.id)
          .map((set) => ({
            ordinal: set.ordinal,
            setKind: set.setKind,
            targetLoadGrams: set.targetLoadGrams,
            targetRepetitions: set.targetRepetitions,
            restSeconds: set.restSeconds,
          })),
      })),
  }))
  const persistedProjection: ExecutablePrescriptionProjection = {
    hashMaterialVersion: EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
    engineVersion: owned.engineVersion,
    methodology: {
      id: owned.methodologyId,
      version: owned.methodologyVersion,
      reviewStatus: owned.methodologyReviewStatus,
    },
    template: {
      id: owned.templateId,
      version: owned.templateVersion,
      reviewStatus: owned.templateReviewStatus,
    },
    normalizedInputHash: owned.normalizedInputHash,
    workouts: persistedWorkouts,
  }
  const integrity = verifyExecutablePrescriptionIntegrity({
    normalizedInput: owned.normalizedInput as CanonicalValue,
    storedNormalizedInputHash: owned.normalizedInputHash,
    storedOutputSnapshot: owned.outputSnapshot as CanonicalValue,
    storedOutputHash: owned.outputHash,
    persistedProjection,
  })
  if (!integrity.valid) {
    throw new ProgramUnavailableError(
      'program.prescription-integrity-failed',
      'The saved executable prescription does not match its immutable hashes.',
    )
  }
  const usedProgramOrdinals =
    request.kind === 'remaining'
      ? await transaction
          .select({ programOrdinal: plannedWorkouts.programOrdinal })
          .from(workoutSessions)
          .innerJoin(
            plannedWorkouts,
            eq(plannedWorkouts.id, workoutSessions.plannedWorkoutId),
          )
          .innerJoin(
            programRevisions,
            eq(programRevisions.id, plannedWorkouts.revisionId),
          )
          .where(
            and(
              eq(workoutSessions.userId, userId),
              eq(programRevisions.programId, owned.programId),
            ),
          )
      : []
  const prescriptionEligibility = validatePersistedPrescriptionForActivation({
    workouts: persistedWorkouts,
    availableEquipment: equipment.map((item) => item.code),
    requiredEquipmentByExercise:
      owned.methodologyId === 'development.methodology-fixture' &&
      owned.templateId === 'development.full-body-three-day'
        ? (DEVELOPMENT_EXERCISE_EQUIPMENT as Readonly<Record<string, readonly string[]>>)
        : {},
    sequence:
      request.kind === 'remaining' && remainingSource
        ? {
            kind: 'remaining',
            sourceProgramOrdinal: remainingSource.sourceProgramOrdinal,
            sourceScheduledDate: remainingSource.sourceScheduledDate,
            usedProgramOrdinals: usedProgramOrdinals.map(
              (workout) => workout.programOrdinal,
            ),
          }
        : { kind: 'initial' },
  })
  if (!prescriptionEligibility.eligible) {
    throw new ProgramUnavailableError(
      prescriptionEligibility.code,
      prescriptionEligibility.message,
    )
  }

  const [hold] = await transaction
    .select({ id: safetyHolds.id })
    .from(safetyHolds)
    .where(and(eq(safetyHolds.userId, userId), isNull(safetyHolds.clearedAt)))
    .limit(1)
  if (hold) {
    throw new ProgramUnavailableError(
      'safety.hold-active',
      'An active safety hold blocks program activation.',
    )
  }
  const [activeSession] = await transaction
    .select({ id: workoutSessions.id })
    .from(workoutSessions)
    .where(
      and(
        eq(workoutSessions.userId, userId),
        inArray(workoutSessions.status, ['active', 'paused']),
      ),
    )
    .limit(1)
  if (
    activeSession &&
    (request.kind !== 'remaining' || activeSession.id !== request.sourceSessionId)
  ) {
    throw new ProgramUnavailableError(
      'program.active-session',
      'Finish or abandon the active workout before changing programs.',
    )
  }

  const now = new Date()
  if (request.kind === 'remaining' && remainingSource) {
    const [superseded] = await transaction
      .update(programRevisions)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(programRevisions.id, remainingSource.parentRevisionId),
          eq(programRevisions.status, 'active'),
        ),
      )
      .returning({ id: programRevisions.id })
    if (!superseded) {
      throw new ProgramUnavailableError(
        'program.remaining-schedule-stale',
        'The source program changed before the adjustment could activate.',
      )
    }
    await transaction
      .update(programRevisions)
      .set({ status: 'active', activatedAt: now })
      .where(
        and(eq(programRevisions.id, revisionId), eq(programRevisions.status, 'draft')),
      )
    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: userId,
      subjectUserId: userId,
      eventType: 'program-adjustment-revision-activated',
      entityType: 'program-revision',
      entityId: revisionId,
      metadata: {
        sourceRevisionId: remainingSource.parentRevisionId,
        sourceSessionId: remainingSource.sourceSessionId,
        sourceProgramOrdinal: remainingSource.sourceProgramOrdinal,
      },
    })
    return
  }

  const activePrograms = await transaction
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.userId, userId), eq(programs.status, 'active')))
    .for('update')
  if (activePrograms.length > 0) {
    await transaction
      .update(programRevisions)
      .set({ status: 'superseded' })
      .where(
        and(
          inArray(
            programRevisions.programId,
            activePrograms.map((program) => program.id),
          ),
          eq(programRevisions.status, 'active'),
        ),
      )
  }
  await transaction
    .update(programs)
    .set({ status: 'retired', updatedAt: now })
    .where(and(eq(programs.userId, userId), eq(programs.status, 'active')))
  await transaction
    .update(programs)
    .set({ status: 'active', updatedAt: now })
    .where(eq(programs.id, owned.programId))
  await transaction
    .update(programRevisions)
    .set({ status: 'active', activatedAt: now })
    .where(eq(programRevisions.id, revisionId))
  await transaction.insert(auditEvents).values({
    id: newUuidV7(),
    actorUserId: userId,
    subjectUserId: userId,
    eventType: 'program-activated',
    entityType: 'program-revision',
    entityId: revisionId,
    metadata: { contentMode: config.contentMode },
  })
}

export async function activateProgram(userId: string, revisionId: string): Promise<void> {
  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    )
    await activatePersistedProgramRevision(transaction, {
      kind: 'initial',
      userId,
      revisionId,
    })
  })
}

export async function getProgramOverview(
  userId: string,
): Promise<ProgramOverview | null> {
  const db = getDb()
  const [activeProgram] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.userId, userId), eq(programs.status, 'active')))
    .orderBy(desc(programs.createdAt))
    .limit(1)

  const [draftProgram] = activeProgram
    ? []
    : await db
        .select()
        .from(programs)
        .where(and(eq(programs.userId, userId), eq(programs.status, 'draft')))
        .orderBy(desc(programs.createdAt))
        .limit(1)

  const program = activeProgram ?? draftProgram

  if (!program) return null

  const [revision] = await db
    .select()
    .from(programRevisions)
    .where(
      and(
        eq(programRevisions.programId, program.id),
        inArray(programRevisions.status, ['active', 'draft']),
      ),
    )
    .orderBy(desc(programRevisions.revisionNumber))
    .limit(1)
  if (!revision) return null

  const workoutRows = await db
    .select()
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.revisionId, revision.id))
    .orderBy(asc(plannedWorkouts.ordinal))
  const workoutIds = workoutRows.map((workout) => workout.id)
  const exerciseRows =
    workoutIds.length > 0
      ? await db
          .select()
          .from(exercisePrescriptions)
          .where(inArray(exercisePrescriptions.plannedWorkoutId, workoutIds))
          .orderBy(asc(exercisePrescriptions.ordinal))
      : []
  const exerciseIds = exerciseRows.map((exercise) => exercise.id)
  const setRows =
    exerciseIds.length > 0
      ? await db
          .select()
          .from(setPrescriptions)
          .where(inArray(setPrescriptions.exercisePrescriptionId, exerciseIds))
          .orderBy(asc(setPrescriptions.ordinal))
      : []

  return {
    programId: program.id,
    programStatus: program.status,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    revisionStatus: revision.status,
    engineVersion: revision.engineVersion,
    methodologyId: revision.methodologyId,
    methodologyVersion: revision.methodologyVersion,
    methodologyReviewStatus: revision.methodologyReviewStatus,
    templateId: revision.templateId,
    templateVersion: revision.templateVersion,
    templateReviewStatus: revision.templateReviewStatus,
    normalizedInputHash: revision.normalizedInputHash,
    outputHash: revision.outputHash,
    warnings: revision.warnings as ProgramOverview['warnings'],
    manualReviewRequired: revision.manualReviewRequired,
    workouts: workoutRows.map((workout) => ({
      id: workout.id,
      scheduledDate: workout.scheduledDate,
      ordinal: workout.ordinal,
      programOrdinal: workout.programOrdinal,
      slotCode: workout.slotCode,
      name: workout.name,
      exercises: exerciseRows
        .filter((exercise) => exercise.plannedWorkoutId === workout.id)
        .map((exercise) => ({
          id: exercise.id,
          exerciseCode: exercise.exerciseCode,
          exerciseName: exercise.exerciseName,
          ordinal: exercise.ordinal,
          safetyTier: exercise.safetyTier,
          rationaleCode: exercise.rationaleCode,
          sets: setRows
            .filter((set) => set.exercisePrescriptionId === exercise.id)
            .map((set) => ({
              id: set.id,
              ordinal: set.ordinal,
              targetLoadGrams: set.targetLoadGrams,
              targetRepetitions: set.targetRepetitions,
              restSeconds: set.restSeconds,
            })),
        })),
    })),
  }
}
