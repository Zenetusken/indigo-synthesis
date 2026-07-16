import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  DataExportError,
  type DataExportFiles,
} from '@/modules/data-portability/application/export'
import { evaluatePersistedContentEligibility } from '@/modules/programs/domain/content-eligibility'
import { getServerConfig } from '@/platform/config/server'
import {
  adjustmentDecisionInvalidations,
  adjustmentDecisions,
  athleteEquipment,
  athleteProfiles,
  athleteTrainingDays,
  auditEvents,
  contentReleaseRevocations,
  exercisePrescriptions,
  futureLoadExplanationCache,
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
  strengthBaselines,
  trainingCommandReceipts,
  trainingFactCorrections,
  user,
  workoutSessions,
} from '@/platform/db/schema'

function actorClassForExport(
  exportedSubjectUserId: string,
  actorUserId: string | null,
): 'self' | 'local-administrator' | 'system' {
  if (actorUserId === exportedSubjectUserId) return 'self'
  if (actorUserId === null) return 'system'
  return 'local-administrator'
}

export class SubjectExportGraphInvariantError extends Error {
  constructor() {
    super('The subject export graph contains a relationship outside its subject scope.')
    this.name = 'SubjectExportGraphInvariantError'
  }
}

/** Exact temporary Stage 3 read breadth; Stage 9 replaces it with module-owned ports. */
export const subjectExportReadContract = Object.freeze({
  adjustmentDecisions: 'adjustment_decision',
  adjustmentDecisionInvalidations: 'adjustment_decision_invalidation',
  athleteEquipment: 'athlete_equipment',
  athleteProfiles: 'athlete_profile',
  athleteTrainingDays: 'athlete_training_day',
  auditEvents: 'audit_event',
  contentReleaseRevocations: 'content_release_revocation',
  exercisePrescriptions: 'exercise_prescription',
  futureLoadExplanationCache: 'future_load_explanation_cache',
  performedSets: 'performed_set',
  performedSetCorrections: 'performed_set_correction',
  plannedWorkouts: 'planned_workout',
  programs: 'program',
  programRevisions: 'program_revision',
  programRevisionInvalidations: 'program_revision_invalidation',
  programRevisionLineage: 'program_revision_lineage',
  safetyHolds: 'safety_hold',
  safetyHoldResolutions: 'safety_hold_resolution',
  sessionExercises: 'session_exercise',
  sessionFeedback: 'session_feedback',
  sessionFeedbackCorrections: 'session_feedback_correction',
  setPrescriptions: 'set_prescription',
  strengthBaselines: 'strength_baseline',
  trainingCommandReceipts: 'training_command_receipt',
  trainingFactCorrections: 'training_fact_correction',
  user: 'user',
  workoutSessions: 'workout_session',
} as const)

export const subjectExportReadManifest = Object.freeze(
  Object.values(subjectExportReadContract),
)

export class SubjectExportGatewayScopeError extends Error {
  constructor() {
    super('The scoped subject export gateway has already been consumed.')
    this.name = 'SubjectExportGatewayScopeError'
  }
}

function invalidSubjectGraph(): never {
  throw new SubjectExportGraphInvariantError()
}

const exportBindChunkSize = 1_000

async function collectInBoundedChunks<Input, Row>(
  values: readonly Input[],
  read: (chunk: readonly Input[]) => Promise<readonly Row[]>,
): Promise<Row[]> {
  const rows: Row[] = []
  for (let offset = 0; offset < values.length; offset += exportBindChunkSize) {
    rows.push(...(await read(values.slice(offset, offset + exportBindChunkSize))))
  }
  return rows
}

async function readSubjectExportFiles(
  transaction: NodePgDatabase,
  subjectUserId: string,
) {
  const [identity] = await transaction
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })
    .from(user)
    .where(eq(user.id, subjectUserId))
    .limit(1)
  if (!identity) {
    throw new DataExportError(
      'export.subject-missing',
      'The authenticated export subject no longer exists.',
    )
  }

  // A transaction owns one PostgreSQL client. Keep its reads sequential so the
  // repeatable-read snapshot remains compatible with pg's single-query contract.
  const profile = await transaction
    .select({
      userId: athleteProfiles.userId,
      units: athleteProfiles.units,
      timezone: athleteProfiles.timezone,
      goal: athleteProfiles.goal,
      experience: athleteProfiles.experience,
      sessionMinutes: athleteProfiles.sessionMinutes,
      adultAttested: athleteProfiles.adultAttested,
      techniqueAttested: athleteProfiles.techniqueAttested,
      restrictionStatus: athleteProfiles.restrictionStatus,
      limitations: athleteProfiles.limitations,
      confirmedAt: athleteProfiles.confirmedAt,
      createdAt: athleteProfiles.createdAt,
      updatedAt: athleteProfiles.updatedAt,
    })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, subjectUserId))
    .limit(1)
  const days = await transaction
    .select({
      userId: athleteTrainingDays.userId,
      weekday: athleteTrainingDays.weekday,
      ordinal: athleteTrainingDays.ordinal,
    })
    .from(athleteTrainingDays)
    .where(eq(athleteTrainingDays.userId, subjectUserId))
    .orderBy(asc(athleteTrainingDays.ordinal))
  const equipment = await transaction
    .select({
      userId: athleteEquipment.userId,
      equipmentCode: athleteEquipment.equipmentCode,
    })
    .from(athleteEquipment)
    .where(eq(athleteEquipment.userId, subjectUserId))
    .orderBy(asc(athleteEquipment.equipmentCode))
  const baselines = await transaction
    .select({
      id: strengthBaselines.id,
      userId: strengthBaselines.userId,
      exerciseCode: strengthBaselines.exerciseCode,
      loadGrams: strengthBaselines.loadGrams,
      repetitions: strengthBaselines.repetitions,
      protocol: strengthBaselines.protocol,
      testedOn: strengthBaselines.testedOn,
      provenance: strengthBaselines.provenance,
      createdAt: strengthBaselines.createdAt,
    })
    .from(strengthBaselines)
    .where(eq(strengthBaselines.userId, subjectUserId))
    .orderBy(asc(strengthBaselines.exerciseCode))
  const holds = await transaction
    .select({
      id: safetyHolds.id,
      userId: safetyHolds.userId,
      sourceSessionId: safetyHolds.sourceSessionId,
      reasonCode: safetyHolds.reasonCode,
      details: safetyHolds.details,
      createdAt: safetyHolds.createdAt,
      clearedAt: safetyHolds.clearedAt,
    })
    .from(safetyHolds)
    .where(eq(safetyHolds.userId, subjectUserId))
    .orderBy(asc(safetyHolds.createdAt), asc(safetyHolds.id))
  const holdResolutions = await transaction
    .select({
      id: safetyHoldResolutions.id,
      holdId: safetyHoldResolutions.holdId,
      userId: safetyHoldResolutions.userId,
      reason: safetyHoldResolutions.reason,
      acknowledged: safetyHoldResolutions.acknowledged,
      createdAt: safetyHoldResolutions.createdAt,
    })
    .from(safetyHoldResolutions)
    .where(eq(safetyHoldResolutions.userId, subjectUserId))
    .orderBy(asc(safetyHoldResolutions.createdAt), asc(safetyHoldResolutions.id))

  const ownedPrograms = await transaction
    .select({
      id: programs.id,
      userId: programs.userId,
      status: programs.status,
      createdAt: programs.createdAt,
      updatedAt: programs.updatedAt,
    })
    .from(programs)
    .where(eq(programs.userId, subjectUserId))
    .orderBy(asc(programs.createdAt), asc(programs.id))
  const programIds = ownedPrograms.map((program) => program.id)
  const revisions = await collectInBoundedChunks(programIds, (chunk) =>
    transaction
      .select({
        id: programRevisions.id,
        programId: programRevisions.programId,
        revisionNumber: programRevisions.revisionNumber,
        status: programRevisions.status,
        engineVersion: programRevisions.engineVersion,
        methodologyId: programRevisions.methodologyId,
        methodologyVersion: programRevisions.methodologyVersion,
        methodologyReviewStatus: programRevisions.methodologyReviewStatus,
        templateId: programRevisions.templateId,
        templateVersion: programRevisions.templateVersion,
        templateReviewStatus: programRevisions.templateReviewStatus,
        normalizedInputHash: programRevisions.normalizedInputHash,
        outputHash: programRevisions.outputHash,
        normalizedInput: programRevisions.normalizedInput,
        outputSnapshot: programRevisions.outputSnapshot,
        warnings: programRevisions.warnings,
        manualReviewRequired: programRevisions.manualReviewRequired,
        createdAt: programRevisions.createdAt,
        activatedAt: programRevisions.activatedAt,
      })
      .from(programRevisions)
      .where(inArray(programRevisions.programId, chunk))
      .orderBy(asc(programRevisions.programId), asc(programRevisions.revisionNumber)),
  )
  const revisionIds = revisions.map((revision) => revision.id)
  const revisionContentRevocations = await transaction
    .select({
      id: contentReleaseRevocations.id,
      contentKind: contentReleaseRevocations.contentKind,
      contentId: contentReleaseRevocations.contentId,
      contentVersion: contentReleaseRevocations.contentVersion,
      reason: contentReleaseRevocations.reason,
      actorUserId: contentReleaseRevocations.actorUserId,
      createdAt: contentReleaseRevocations.createdAt,
    })
    .from(contentReleaseRevocations)
    .where(sql`EXISTS (
                SELECT 1
                FROM ${programRevisions} AS revision
                INNER JOIN ${programs} AS owned_program
                  ON owned_program.id = revision.program_id
                WHERE owned_program.user_id = ${subjectUserId}
                  AND (
                    (
                      ${contentReleaseRevocations.contentKind} = 'methodology'
                      AND ${contentReleaseRevocations.contentId} = revision.methodology_id
                      AND ${contentReleaseRevocations.contentVersion} = revision.methodology_version
                    )
                    OR (
                      ${contentReleaseRevocations.contentKind} = 'template'
                      AND ${contentReleaseRevocations.contentId} = revision.template_id
                      AND ${contentReleaseRevocations.contentVersion} = revision.template_version
                    )
                  )
              )`)
    .orderBy(asc(contentReleaseRevocations.createdAt), asc(contentReleaseRevocations.id))
  const revisionLineage = await collectInBoundedChunks(revisionIds, (chunk) =>
    transaction
      .select({
        revisionId: programRevisionLineage.revisionId,
        parentRevisionId: programRevisionLineage.parentRevisionId,
        sourceSessionId: programRevisionLineage.sourceSessionId,
        sourceProgramOrdinal: programRevisionLineage.sourceProgramOrdinal,
        createdAt: programRevisionLineage.createdAt,
      })
      .from(programRevisionLineage)
      .where(inArray(programRevisionLineage.revisionId, chunk))
      .orderBy(asc(programRevisionLineage.createdAt)),
  )
  const workouts = await collectInBoundedChunks(revisionIds, (chunk) =>
    transaction
      .select({
        id: plannedWorkouts.id,
        revisionId: plannedWorkouts.revisionId,
        scheduledDate: plannedWorkouts.scheduledDate,
        ordinal: plannedWorkouts.ordinal,
        programOrdinal: plannedWorkouts.programOrdinal,
        slotCode: plannedWorkouts.slotCode,
        name: plannedWorkouts.name,
        createdAt: plannedWorkouts.createdAt,
      })
      .from(plannedWorkouts)
      .where(inArray(plannedWorkouts.revisionId, chunk))
      .orderBy(asc(plannedWorkouts.revisionId), asc(plannedWorkouts.ordinal)),
  )
  const workoutIds = workouts.map((workout) => workout.id)
  const exercises = await collectInBoundedChunks(workoutIds, (chunk) =>
    transaction
      .select({
        id: exercisePrescriptions.id,
        plannedWorkoutId: exercisePrescriptions.plannedWorkoutId,
        exerciseCode: exercisePrescriptions.exerciseCode,
        exerciseName: exercisePrescriptions.exerciseName,
        ordinal: exercisePrescriptions.ordinal,
        safetyTier: exercisePrescriptions.safetyTier,
        rationaleCode: exercisePrescriptions.rationaleCode,
      })
      .from(exercisePrescriptions)
      .where(inArray(exercisePrescriptions.plannedWorkoutId, chunk))
      .orderBy(
        asc(exercisePrescriptions.plannedWorkoutId),
        asc(exercisePrescriptions.ordinal),
      ),
  )
  const exerciseIds = exercises.map((exercise) => exercise.id)
  const prescriptions = await collectInBoundedChunks(exerciseIds, (chunk) =>
    transaction
      .select({
        id: setPrescriptions.id,
        exercisePrescriptionId: setPrescriptions.exercisePrescriptionId,
        ordinal: setPrescriptions.ordinal,
        setKind: setPrescriptions.setKind,
        targetLoadGrams: setPrescriptions.targetLoadGrams,
        targetRepetitions: setPrescriptions.targetRepetitions,
        restSeconds: setPrescriptions.restSeconds,
      })
      .from(setPrescriptions)
      .where(inArray(setPrescriptions.exercisePrescriptionId, chunk))
      .orderBy(
        asc(setPrescriptions.exercisePrescriptionId),
        asc(setPrescriptions.ordinal),
      ),
  )

  const ownedSessions = await transaction
    .select({
      id: workoutSessions.id,
      userId: workoutSessions.userId,
      plannedWorkoutId: workoutSessions.plannedWorkoutId,
      plannedWorkoutName: workoutSessions.plannedWorkoutName,
      scheduledDate: workoutSessions.scheduledDate,
      slotCode: workoutSessions.slotCode,
      status: workoutSessions.status,
      startedAt: workoutSessions.startedAt,
      pausedAt: workoutSessions.pausedAt,
      completedAt: workoutSessions.completedAt,
      abandonedAt: workoutSessions.abandonedAt,
      abandonedReason: workoutSessions.abandonedReason,
      snapshotFinalizedAt: workoutSessions.snapshotFinalizedAt,
      optimisticVersion: workoutSessions.optimisticVersion,
      startCommandId: workoutSessions.startCommandId,
      completionCommandId: workoutSessions.completionCommandId,
      createdAt: workoutSessions.createdAt,
      updatedAt: workoutSessions.updatedAt,
    })
    .from(workoutSessions)
    .where(eq(workoutSessions.userId, subjectUserId))
    .orderBy(asc(workoutSessions.startedAt), asc(workoutSessions.id))
  const sessionIds = ownedSessions.map((session) => session.id)
  const sessionExerciseRows = await collectInBoundedChunks(sessionIds, (chunk) =>
    transaction
      .select({
        id: sessionExercises.id,
        sessionId: sessionExercises.sessionId,
        exerciseCode: sessionExercises.exerciseCode,
        exerciseName: sessionExercises.exerciseName,
        ordinal: sessionExercises.ordinal,
        safetyTier: sessionExercises.safetyTier,
        rationaleCode: sessionExercises.rationaleCode,
        originalExerciseCode: sessionExercises.originalExerciseCode,
        substitutionReason: sessionExercises.substitutionReason,
      })
      .from(sessionExercises)
      .where(inArray(sessionExercises.sessionId, chunk))
      .orderBy(asc(sessionExercises.sessionId), asc(sessionExercises.ordinal)),
  )
  const sessionExerciseIds = sessionExerciseRows.map((exercise) => exercise.id)
  const setRows = await collectInBoundedChunks(sessionExerciseIds, (chunk) =>
    transaction
      .select({
        id: performedSets.id,
        sessionExerciseId: performedSets.sessionExerciseId,
        ordinal: performedSets.ordinal,
        status: performedSets.status,
        targetLoadGrams: performedSets.targetLoadGrams,
        targetRepetitions: performedSets.targetRepetitions,
        restSeconds: performedSets.restSeconds,
        actualLoadGrams: performedSets.actualLoadGrams,
        actualRepetitions: performedSets.actualRepetitions,
        rpe: performedSets.rpe,
        loadProvenance: performedSets.loadProvenance,
        repetitionsProvenance: performedSets.repetitionsProvenance,
        explicitlyConfirmed: performedSets.explicitlyConfirmed,
        confirmedAt: performedSets.confirmedAt,
        skippedAt: performedSets.skippedAt,
        skipReason: performedSets.skipReason,
        note: performedSets.note,
        commandId: performedSets.commandId,
        createdAt: performedSets.createdAt,
        updatedAt: performedSets.updatedAt,
      })
      .from(performedSets)
      .where(inArray(performedSets.sessionExerciseId, chunk))
      .orderBy(asc(performedSets.sessionExerciseId), asc(performedSets.ordinal)),
  )
  const feedbackRows = await collectInBoundedChunks(sessionIds, (chunk) =>
    transaction
      .select({
        sessionId: sessionFeedback.sessionId,
        painReported: sessionFeedback.painReported,
        details: sessionFeedback.details,
        answeredAt: sessionFeedback.answeredAt,
      })
      .from(sessionFeedback)
      .where(inArray(sessionFeedback.sessionId, chunk))
      .orderBy(asc(sessionFeedback.sessionId)),
  )
  const commandReceipts = await collectInBoundedChunks(sessionIds, (chunk) =>
    transaction
      .select({
        commandId: trainingCommandReceipts.commandId,
        userId: trainingCommandReceipts.userId,
        commandType: trainingCommandReceipts.commandType,
        sessionId: trainingCommandReceipts.sessionId,
        targetId: trainingCommandReceipts.targetId,
        requestHash: trainingCommandReceipts.requestHash,
        resultSnapshot: trainingCommandReceipts.resultSnapshot,
        createdAt: trainingCommandReceipts.createdAt,
      })
      .from(trainingCommandReceipts)
      .where(inArray(trainingCommandReceipts.sessionId, chunk))
      .orderBy(
        asc(trainingCommandReceipts.createdAt),
        asc(trainingCommandReceipts.commandId),
      ),
  )
  const adjustmentRows = await collectInBoundedChunks(sessionIds, (chunk) =>
    transaction
      .select({
        id: adjustmentDecisions.id,
        sessionId: adjustmentDecisions.sessionId,
        appliedRevisionId: adjustmentDecisions.appliedRevisionId,
        exerciseCode: adjustmentDecisions.exerciseCode,
        decision: adjustmentDecisions.decision,
        currentLoadGrams: adjustmentDecisions.currentLoadGrams,
        nextLoadGrams: adjustmentDecisions.nextLoadGrams,
        reasonCode: adjustmentDecisions.reasonCode,
        ruleVersion: adjustmentDecisions.ruleVersion,
        createdAt: adjustmentDecisions.createdAt,
      })
      .from(adjustmentDecisions)
      .where(inArray(adjustmentDecisions.sessionId, chunk))
      .orderBy(asc(adjustmentDecisions.sessionId), asc(adjustmentDecisions.exerciseCode)),
  )
  const explanationRows = await collectInBoundedChunks(sessionIds, (chunk) =>
    transaction
      .select({
        id: futureLoadExplanationCache.id,
        userId: futureLoadExplanationCache.userId,
        sessionId: futureLoadExplanationCache.sessionId,
        decisionId: futureLoadExplanationCache.decisionId,
        prose: futureLoadExplanationCache.prose,
        modelId: futureLoadExplanationCache.modelId,
        modelContentDigest: futureLoadExplanationCache.modelContentDigest,
        servedModelName: futureLoadExplanationCache.servedModelName,
        runtimeId: futureLoadExplanationCache.runtimeId,
        runtimeAttestationDigest: futureLoadExplanationCache.runtimeAttestationDigest,
        promptVersion: futureLoadExplanationCache.promptVersion,
        validatorVersion: futureLoadExplanationCache.validatorVersion,
        factBundleHash: futureLoadExplanationCache.factBundleHash,
        generateDurationMs: futureLoadExplanationCache.generateDurationMs,
        createdAt: futureLoadExplanationCache.createdAt,
      })
      .from(futureLoadExplanationCache)
      .where(
        and(
          eq(futureLoadExplanationCache.userId, subjectUserId),
          inArray(futureLoadExplanationCache.sessionId, chunk),
        ),
      )
      .orderBy(
        asc(futureLoadExplanationCache.sessionId),
        asc(futureLoadExplanationCache.decisionId),
        asc(futureLoadExplanationCache.createdAt),
        asc(futureLoadExplanationCache.id),
      ),
  )

  const correctionRows =
    sessionIds.length === 0
      ? []
      : await transaction
          .select({
            id: trainingFactCorrections.id,
            userId: trainingFactCorrections.userId,
            sessionId: trainingFactCorrections.sessionId,
            actorUserId: trainingFactCorrections.actorUserId,
            commandId: trainingFactCorrections.commandId,
            correctionKind: trainingFactCorrections.correctionKind,
            sequence: trainingFactCorrections.sequence,
            reason: trainingFactCorrections.reason,
            createdAt: trainingFactCorrections.createdAt,
          })
          .from(trainingFactCorrections)
          .where(eq(trainingFactCorrections.userId, subjectUserId))
          .orderBy(
            asc(trainingFactCorrections.sessionId),
            asc(trainingFactCorrections.sequence),
            asc(trainingFactCorrections.id),
          )
  const correctionIds = correctionRows.map((correction) => correction.id)
  const feedbackCorrectionRows = await collectInBoundedChunks(correctionIds, (chunk) =>
    transaction
      .select({
        correctionId: sessionFeedbackCorrections.correctionId,
        sessionId: sessionFeedbackCorrections.sessionId,
        userId: sessionFeedbackCorrections.userId,
        painReported: sessionFeedbackCorrections.painReported,
        details: sessionFeedbackCorrections.details,
        answeredAt: sessionFeedbackCorrections.answeredAt,
      })
      .from(sessionFeedbackCorrections)
      .where(inArray(sessionFeedbackCorrections.correctionId, chunk)),
  )
  const performedSetCorrectionRows = await collectInBoundedChunks(
    correctionIds,
    (chunk) =>
      transaction
        .select({
          correctionId: performedSetCorrections.correctionId,
          sessionId: performedSetCorrections.sessionId,
          userId: performedSetCorrections.userId,
          performedSetId: performedSetCorrections.performedSetId,
          status: performedSetCorrections.status,
          actualLoadGrams: performedSetCorrections.actualLoadGrams,
          actualRepetitions: performedSetCorrections.actualRepetitions,
          rpe: performedSetCorrections.rpe,
          loadProvenance: performedSetCorrections.loadProvenance,
          repetitionsProvenance: performedSetCorrections.repetitionsProvenance,
          explicitlyConfirmed: performedSetCorrections.explicitlyConfirmed,
          confirmedAt: performedSetCorrections.confirmedAt,
          skippedAt: performedSetCorrections.skippedAt,
          skipReason: performedSetCorrections.skipReason,
          note: performedSetCorrections.note,
        })
        .from(performedSetCorrections)
        .where(inArray(performedSetCorrections.correctionId, chunk)),
  )
  const adjustmentIds = adjustmentRows.map((adjustment) => adjustment.id)
  const adjustmentInvalidationRows = await collectInBoundedChunks(
    adjustmentIds,
    (chunk) =>
      transaction
        .select({
          decisionId: adjustmentDecisionInvalidations.decisionId,
          correctionId: adjustmentDecisionInvalidations.correctionId,
          createdAt: adjustmentDecisionInvalidations.createdAt,
        })
        .from(adjustmentDecisionInvalidations)
        .where(inArray(adjustmentDecisionInvalidations.decisionId, chunk))
        .orderBy(asc(adjustmentDecisionInvalidations.decisionId)),
  )
  const revisionInvalidationRows = await collectInBoundedChunks(revisionIds, (chunk) =>
    transaction
      .select({
        revisionId: programRevisionInvalidations.revisionId,
        correctionId: programRevisionInvalidations.correctionId,
        createdAt: programRevisionInvalidations.createdAt,
      })
      .from(programRevisionInvalidations)
      .where(inArray(programRevisionInvalidations.revisionId, chunk))
      .orderBy(asc(programRevisionInvalidations.revisionId)),
  )

  const auditRows = await transaction
    .select({
      id: auditEvents.id,
      actorUserId: auditEvents.actorUserId,
      eventType: auditEvents.eventType,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(eq(auditEvents.subjectUserId, subjectUserId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))

  const programIdSet = new Set(programIds)
  const revisionIdSet = new Set(revisionIds)
  const workoutIdSet = new Set(workoutIds)
  const exerciseIdSet = new Set(exerciseIds)
  const sessionIdSet = new Set(sessionIds)
  const sessionExerciseIdSet = new Set(sessionExerciseIds)
  const performedSetIdSet = new Set(setRows.map((set) => set.id))
  const holdIdSet = new Set(holds.map((hold) => hold.id))
  const receiptCommandIdSet = new Set(commandReceipts.map((receipt) => receipt.commandId))
  const adjustmentIdSet = new Set(adjustmentIds)
  const correctionIdSet = new Set(correctionIds)

  const everySubjectRow = <Row extends { readonly userId: string }>(
    rows: readonly Row[],
  ) => rows.every((row) => row.userId === subjectUserId)
  if (
    identity.id !== subjectUserId ||
    !everySubjectRow(profile) ||
    !everySubjectRow(days) ||
    !everySubjectRow(equipment) ||
    !everySubjectRow(baselines) ||
    !everySubjectRow(holds) ||
    !everySubjectRow(holdResolutions) ||
    !everySubjectRow(ownedPrograms) ||
    !everySubjectRow(ownedSessions) ||
    !everySubjectRow(commandReceipts) ||
    !everySubjectRow(explanationRows) ||
    !everySubjectRow(correctionRows) ||
    !everySubjectRow(feedbackCorrectionRows) ||
    !everySubjectRow(performedSetCorrectionRows) ||
    revisions.some((revision) => !programIdSet.has(revision.programId)) ||
    revisionLineage.some(
      (lineage) =>
        !revisionIdSet.has(lineage.revisionId) ||
        !revisionIdSet.has(lineage.parentRevisionId) ||
        !sessionIdSet.has(lineage.sourceSessionId),
    ) ||
    workouts.some((workout) => !revisionIdSet.has(workout.revisionId)) ||
    exercises.some((exercise) => !workoutIdSet.has(exercise.plannedWorkoutId)) ||
    prescriptions.some(
      (prescription) => !exerciseIdSet.has(prescription.exercisePrescriptionId),
    ) ||
    ownedSessions.some((session) => !workoutIdSet.has(session.plannedWorkoutId)) ||
    sessionExerciseRows.some((exercise) => !sessionIdSet.has(exercise.sessionId)) ||
    setRows.some((set) => !sessionExerciseIdSet.has(set.sessionExerciseId)) ||
    feedbackRows.some((feedback) => !sessionIdSet.has(feedback.sessionId)) ||
    holds.some(
      (hold) => hold.sourceSessionId !== null && !sessionIdSet.has(hold.sourceSessionId),
    ) ||
    holdResolutions.some((resolution) => !holdIdSet.has(resolution.holdId)) ||
    adjustmentRows.some(
      (adjustment) =>
        !sessionIdSet.has(adjustment.sessionId) ||
        (adjustment.appliedRevisionId !== null &&
          !revisionIdSet.has(adjustment.appliedRevisionId)),
    ) ||
    explanationRows.some(
      (explanation) =>
        !sessionIdSet.has(explanation.sessionId) ||
        !adjustmentIdSet.has(explanation.decisionId),
    ) ||
    correctionRows.some(
      (correction) =>
        correction.actorUserId !== subjectUserId ||
        !sessionIdSet.has(correction.sessionId) ||
        !receiptCommandIdSet.has(correction.commandId),
    ) ||
    feedbackCorrectionRows.some(
      (correction) =>
        !correctionIdSet.has(correction.correctionId) ||
        !sessionIdSet.has(correction.sessionId),
    ) ||
    performedSetCorrectionRows.some(
      (correction) =>
        !correctionIdSet.has(correction.correctionId) ||
        !sessionIdSet.has(correction.sessionId) ||
        !performedSetIdSet.has(correction.performedSetId),
    ) ||
    adjustmentInvalidationRows.some(
      (invalidation) =>
        !adjustmentIdSet.has(invalidation.decisionId) ||
        !correctionIdSet.has(invalidation.correctionId),
    ) ||
    revisionInvalidationRows.some(
      (invalidation) =>
        !revisionIdSet.has(invalidation.revisionId) ||
        !correctionIdSet.has(invalidation.correctionId),
    )
  ) {
    invalidSubjectGraph()
  }

  for (const receipt of commandReceipts) {
    const targetIsCurrent =
      receipt.commandType === 'complete-set' ||
      receipt.commandType === 'skip-set' ||
      receipt.commandType === 'correct-performed-set'
        ? performedSetIdSet.has(receipt.targetId)
        : receipt.commandType === 'complete-workout' ||
            receipt.commandType === 'report-pain'
          ? receipt.targetId === receipt.sessionId
          : receipt.commandType === 'resolve-safety-hold'
            ? holdIdSet.has(receipt.targetId)
            : false
    if (!sessionIdSet.has(receipt.sessionId) || !targetIsCurrent) {
      invalidSubjectGraph()
    }
  }

  const exportAuditEntityId = (entityType: string, entityId: string | null) => {
    switch (entityType) {
      case 'athlete-profile':
      case 'local-user':
        if (entityId === null || entityId !== subjectUserId) invalidSubjectGraph()
        return entityId
      case 'workout-session':
        if (entityId === null || !sessionIdSet.has(entityId)) invalidSubjectGraph()
        return entityId
      case 'performed-set':
        if (entityId === null || !performedSetIdSet.has(entityId)) {
          invalidSubjectGraph()
        }
        return entityId
      case 'program-revision':
        if (entityId === null || !revisionIdSet.has(entityId)) invalidSubjectGraph()
        return entityId
      case 'safety-hold':
        if (entityId === null || !holdIdSet.has(entityId)) invalidSubjectGraph()
        return entityId
      case 'content-release':
      case 'destructive-reauthentication-state':
      case 'installation':
      case 'member-reset':
      case 'owner-bootstrap':
      case 'owner-recovery':
        return null
      default:
        return invalidSubjectGraph()
    }
  }

  const workoutById = new Map(workouts.map((workout) => [workout.id, workout]))
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]))
  const programById = new Map(ownedPrograms.map((program) => [program.id, program]))
  const exportedContentRevocations = revisionContentRevocations.map(
    ({ actorUserId, ...revocation }) => ({
      ...revocation,
      actorClass: actorClassForExport(subjectUserId, actorUserId),
    }),
  )
  const revocationsForRevision = (revision: (typeof revisions)[number]) =>
    exportedContentRevocations.filter(
      (revocation) =>
        (revocation.contentKind === 'methodology' &&
          revocation.contentId === revision.methodologyId &&
          revocation.contentVersion === revision.methodologyVersion) ||
        (revocation.contentKind === 'template' &&
          revocation.contentId === revision.templateId &&
          revocation.contentVersion === revision.templateVersion),
    )
  const contentMode = getServerConfig().contentMode
  const contentStatusForRevision = (revision: (typeof revisions)[number]) => {
    const revocations = revocationsForRevision(revision)
    return {
      eligibility: evaluatePersistedContentEligibility({
        contentMode,
        methodologyStatus: revision.methodologyReviewStatus,
        templateStatus: revision.templateReviewStatus,
        revoked: revocations.length > 0,
      }),
      revocations,
    }
  }
  const correctionById = new Map(
    correctionRows.map((correction) => [correction.id, correction]),
  )
  const correctionAttribution = (correctionId: string) => {
    const correction = correctionById.get(correctionId)
    return correction
      ? {
          id: correction.id,
          commandId: correction.commandId,
          kind: correction.correctionKind,
          sequence: correction.sequence,
          reason: correction.reason,
          actorUserId: correction.actorUserId,
          createdAt: correction.createdAt,
        }
      : null
  }

  const files = {
    identity,
    profile: {
      profile: profile[0] ?? null,
      trainingDays: days,
      equipment,
      strengthBaselines: baselines,
      safetyHolds: holds,
      safetyHoldResolutions: holdResolutions,
    },
    programs: ownedPrograms.map((program) => ({
      ...program,
      revisions: revisions
        .filter((revision) => revision.programId === program.id)
        .map((revision) => ({
          ...revision,
          contentStatus: contentStatusForRevision(revision),
          invalidation: (() => {
            const invalidation = revisionInvalidationRows.find(
              (entry) => entry.revisionId === revision.id,
            )
            return invalidation
              ? {
                  ...invalidation,
                  correction: correctionAttribution(invalidation.correctionId),
                }
              : null
          })(),
          lineage:
            revisionLineage.find((entry) => entry.revisionId === revision.id) ?? null,
          plannedWorkouts: workouts
            .filter((workout) => workout.revisionId === revision.id)
            .map((workout) => ({
              ...workout,
              exercises: exercises
                .filter((exercise) => exercise.plannedWorkoutId === workout.id)
                .map((exercise) => ({
                  ...exercise,
                  sets: prescriptions.filter(
                    (set) => set.exercisePrescriptionId === exercise.id,
                  ),
                })),
            })),
        })),
    })),
    sessions: ownedSessions.map((session) => {
      const sourceWorkout = workoutById.get(session.plannedWorkoutId)
      const sourceRevision = sourceWorkout
        ? revisionById.get(sourceWorkout.revisionId)
        : undefined
      const sourceProgram = sourceRevision
        ? programById.get(sourceRevision.programId)
        : undefined
      const ownedSource = sourceWorkout && sourceRevision && sourceProgram
      return {
        ...session,
        prescriptionProvenance: ownedSource
          ? {
              available: true as const,
              programId: sourceProgram.id,
              programStatus: sourceProgram.status,
              revisionId: sourceRevision.id,
              revisionNumber: sourceRevision.revisionNumber,
              revisionStatus: sourceRevision.status,
              engineVersion: sourceRevision.engineVersion,
              methodology: {
                id: sourceRevision.methodologyId,
                version: sourceRevision.methodologyVersion,
                reviewStatus: sourceRevision.methodologyReviewStatus,
              },
              template: {
                id: sourceRevision.templateId,
                version: sourceRevision.templateVersion,
                reviewStatus: sourceRevision.templateReviewStatus,
              },
              normalizedInputHash: sourceRevision.normalizedInputHash,
              outputHash: sourceRevision.outputHash,
              contentStatus: contentStatusForRevision(sourceRevision),
              plannedWorkout: {
                id: sourceWorkout.id,
                scheduledDate: sourceWorkout.scheduledDate,
                ordinal: sourceWorkout.ordinal,
                slotCode: sourceWorkout.slotCode,
                name: sourceWorkout.name,
              },
            }
          : {
              available: false as const,
              reason: 'source-prescription-missing-or-not-owned',
              plannedWorkoutId: session.plannedWorkoutId,
            },
        exercises: sessionExerciseRows
          .filter((exercise) => exercise.sessionId === session.id)
          .map((exercise) => ({
            ...exercise,
            sets: setRows
              .filter((set) => set.sessionExerciseId === exercise.id)
              .map((set) => {
                const corrections = performedSetCorrectionRows
                  .filter((entry) => entry.performedSetId === set.id)
                  .map((entry) => ({
                    ...entry,
                    correction: correctionAttribution(entry.correctionId),
                  }))
                  .sort(
                    (left, right) =>
                      (left.correction?.sequence ?? 0) -
                      (right.correction?.sequence ?? 0),
                  )
                const latest = corrections.at(-1)
                return {
                  ...set,
                  original: {
                    status: set.status,
                    actualLoadGrams: set.actualLoadGrams,
                    actualRepetitions: set.actualRepetitions,
                    rpe: set.rpe,
                    loadProvenance: set.loadProvenance,
                    repetitionsProvenance: set.repetitionsProvenance,
                    explicitlyConfirmed: set.explicitlyConfirmed,
                    confirmedAt: set.confirmedAt,
                    skippedAt: set.skippedAt,
                    skipReason: set.skipReason,
                    note: set.note,
                  },
                  corrections,
                  effective: latest
                    ? {
                        status: latest.status,
                        actualLoadGrams: latest.actualLoadGrams,
                        actualRepetitions: latest.actualRepetitions,
                        rpe: latest.rpe,
                        loadProvenance: latest.loadProvenance,
                        repetitionsProvenance: latest.repetitionsProvenance,
                        explicitlyConfirmed: latest.explicitlyConfirmed,
                        confirmedAt: latest.confirmedAt,
                        skippedAt: latest.skippedAt,
                        skipReason: latest.skipReason,
                        note: latest.note,
                        correctionId: latest.correctionId,
                      }
                    : {
                        status: set.status,
                        actualLoadGrams: set.actualLoadGrams,
                        actualRepetitions: set.actualRepetitions,
                        rpe: set.rpe,
                        loadProvenance: set.loadProvenance,
                        repetitionsProvenance: set.repetitionsProvenance,
                        explicitlyConfirmed: set.explicitlyConfirmed,
                        confirmedAt: set.confirmedAt,
                        skippedAt: set.skippedAt,
                        skipReason: set.skipReason,
                        note: set.note,
                        correctionId: null,
                      },
                }
              }),
          })),
        feedback: (() => {
          const original =
            feedbackRows.find((feedback) => feedback.sessionId === session.id) ?? null
          const corrections = feedbackCorrectionRows
            .filter((entry) => entry.sessionId === session.id)
            .map((entry) => ({
              ...entry,
              correction: correctionAttribution(entry.correctionId),
            }))
            .sort(
              (left, right) =>
                (left.correction?.sequence ?? 0) - (right.correction?.sequence ?? 0),
            )
          const latest = corrections.at(-1)
          return {
            original,
            corrections,
            effective: latest
              ? {
                  painReported: latest.painReported,
                  details: latest.details,
                  answeredAt: latest.answeredAt,
                  correctionId: latest.correctionId,
                }
              : original
                ? { ...original, correctionId: null }
                : null,
          }
        })(),
        adjustments: adjustmentRows
          .filter((adjustment) => adjustment.sessionId === session.id)
          .map((adjustment) => {
            const invalidation = adjustmentInvalidationRows.find(
              (entry) => entry.decisionId === adjustment.id,
            )
            return {
              ...adjustment,
              invalidation: invalidation
                ? {
                    ...invalidation,
                    correction: correctionAttribution(invalidation.correctionId),
                  }
                : null,
              explanations: explanationRows
                .filter((explanation) => explanation.decisionId === adjustment.id)
                .map(({ userId: _userId, ...explanation }) => explanation),
            }
          }),
        corrections: correctionRows.filter(
          (correction) => correction.sessionId === session.id,
        ),
        commandReceipts: commandReceipts.filter(
          (receipt) => receipt.sessionId === session.id,
        ),
      }
    }),
    contentReleaseRevocations: exportedContentRevocations,
    auditEvents: auditRows.map(
      ({ actorUserId, entityId, metadata: _metadata, ...event }) => ({
        ...event,
        entityId: exportAuditEntityId(event.entityType, entityId),
        metadata: {},
        actorClass: actorClassForExport(subjectUserId, actorUserId),
      }),
    ),
    provenance: {
      programRevision:
        'Each revision carries immutable engine, methodology, template, input-hash, output-hash, review-status, and activation fields.',
      sessionSnapshot:
        'Session exercises and performed sets are the persisted start-time snapshot; they are not recomputed from the current program.',
      performedSet:
        'loadProvenance and repetitionsProvenance distinguish copied targets from trainee edits; explicitlyConfirmed and confirmedAt record attestation.',
      adjustment:
        'Each adjustment records the source session, rule version, reason code, prior load, proposed load, applied revision, and permanent correction-attributed invalidation when present.',
      explanation:
        'Each cached validated explanation is nested under its owning adjustment and retains model, artifact, served-model, runtime, prompt, validator, FactBundle, generation-duration, and creation provenance.',
      correction:
        'Original feedback and resolved-set facts are retained. Ordered, actor-attributed corrections expose a separate effective projection without rewriting history.',
      contentRevocation:
        'Exact methodology/template release revocations are append-only instance facts. Relevant revocations are exported with each affected revision and session provenance; actorClass is redacted to self, local-administrator, or system.',
      commandReceipt:
        'Every idempotent training mutation records an append-only command identifier, canonical request hash, target, and result snapshot.',
      safetyHold:
        'Session-linked pain holds retain their source session. Append-only resolutions retain the trainee acknowledgement and bounded reason.',
      auditActor:
        'actorClass is self, local-administrator, or system. Other local account identifiers, operational entity identifiers, and unconstrained writer metadata are intentionally not disclosed.',
    },
  } satisfies DataExportFiles
  return files
}

export type SubjectExportFiles = Awaited<ReturnType<typeof readSubjectExportFiles>>

export type ScopedSubjectExportGateway = Readonly<{
  readFiles(): Promise<SubjectExportFiles>
}>

/** Binds the broad temporary projection to one actor-selected scoped UoW database. */
export function createScopedSubjectExportGateway(
  database: NodePgDatabase,
  binding: Readonly<{ subjectUserId: string }>,
): ScopedSubjectExportGateway {
  const subjectUserId = binding.subjectUserId
  if (
    typeof subjectUserId !== 'string' ||
    subjectUserId.length === 0 ||
    subjectUserId.includes('\0') ||
    Buffer.byteLength(subjectUserId, 'utf8') > 512
  ) {
    throw new TypeError('A valid subject export binding is required.')
  }
  let consumed = false
  return Object.freeze({
    async readFiles() {
      if (consumed) throw new SubjectExportGatewayScopeError()
      consumed = true
      return readSubjectExportFiles(database, subjectUserId)
    },
  })
}
