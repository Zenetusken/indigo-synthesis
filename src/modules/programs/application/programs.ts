import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { DEVELOPMENT_EXERCISE_EQUIPMENT } from '@/modules/methodology/domain/development-fixture'
import {
  type DevelopmentProgramGenerationResult,
  generateDevelopmentProgram,
  type Weekday,
} from '@/modules/methodology/domain/program'
import { evaluatePersistedContentEligibility } from '@/modules/programs/domain/content-eligibility'
import { validatePersistedPrescriptionForActivation } from '@/modules/programs/domain/prescription-activation'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from '@/platform/db/client'
import {
  athleteEquipment,
  auditEvents,
  exercisePrescriptions,
  plannedWorkouts,
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
      outputHash: result.prescription.outputHash.value,
      normalizedInput: result.normalizedInput,
      outputSnapshot: result.prescription.output,
      warnings: result.prescription.warnings,
      manualReviewRequired: result.prescription.manualReview.required,
    })

    for (const workout of result.prescription.output.plannedWorkouts) {
      const plannedWorkoutId = newUuidV7()
      await transaction.insert(plannedWorkouts).values({
        id: plannedWorkoutId,
        revisionId,
        scheduledDate: workout.localDate,
        ordinal: result.prescription.output.plannedWorkouts.indexOf(workout) + 1,
        slotCode: workout.sessionKey,
        name: `Session ${workout.sessionKey} — development fixture`,
      })

      for (const exercise of workout.exercises) {
        const exercisePrescriptionId = newUuidV7()
        await transaction.insert(exercisePrescriptions).values({
          id: exercisePrescriptionId,
          plannedWorkoutId,
          exerciseCode: exercise.exerciseId,
          exerciseName: exercise.name,
          ordinal: exercise.ordinal,
          safetyTier: 'standard',
          rationaleCode: 'development.fixture-instantiation',
        })
        await transaction.insert(setPrescriptions).values(
          exercise.sets.map((set) => ({
            id: newUuidV7(),
            exercisePrescriptionId,
            ordinal: set.ordinal,
            setKind: 'working',
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
        outputHash: result.prescription.outputHash.value,
      },
    })
  })

  return result
}

export async function activateProgram(userId: string, revisionId: string): Promise<void> {
  const config = getServerConfig()

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    )
    const [owned] = await transaction
      .select({
        programId: programs.id,
        revisionStatus: programRevisions.status,
        methodologyId: programRevisions.methodologyId,
        templateId: programRevisions.templateId,
        templateReviewStatus: programRevisions.templateReviewStatus,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
      })
      .from(programRevisions)
      .innerJoin(programs, eq(programs.id, programRevisions.programId))
      .where(and(eq(programRevisions.id, revisionId), eq(programs.userId, userId)))
      .for('update')
      .limit(1)

    if (!owned) {
      throw new ProgramUnavailableError(
        'program.not-found',
        'Program revision not found.',
      )
    }
    if (owned.revisionStatus !== 'draft') {
      throw new ProgramUnavailableError(
        'program.revision-not-draft',
        'Only a draft revision can be activated.',
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
    const prescriptionEligibility = validatePersistedPrescriptionForActivation({
      workouts: workoutRows.map((workout) => ({
        scheduledDate: workout.scheduledDate,
        ordinal: workout.ordinal,
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
      })),
      availableEquipment: equipment.map((item) => item.code),
      requiredEquipmentByExercise:
        owned.methodologyId === 'development.methodology-fixture' &&
        owned.templateId === 'development.full-body-three-day'
          ? (DEVELOPMENT_EXERCISE_EQUIPMENT as Readonly<
              Record<string, readonly string[]>
            >)
          : {},
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
    if (activeSession) {
      throw new ProgramUnavailableError(
        'program.active-session',
        'Finish or abandon the active workout before changing programs.',
      )
    }

    const now = new Date()
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
