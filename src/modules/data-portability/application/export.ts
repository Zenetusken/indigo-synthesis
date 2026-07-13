import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  type CanonicalValue,
  canonicalSha256,
} from '@/modules/methodology/domain/canonical'
import { evaluatePersistedContentEligibility } from '@/modules/programs/domain/content-eligibility'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from '@/platform/db/client'
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

export const exportSchemaVersion = '1.5.0-development'

function canonical(value: unknown): CanonicalValue {
  return JSON.parse(JSON.stringify(value)) as CanonicalValue
}

function actorClassForExport(
  exportedSubjectUserId: string,
  actorUserId: string | null,
): 'self' | 'local-administrator' | 'system' {
  if (actorUserId === exportedSubjectUserId) return 'self'
  if (actorUserId === null) return 'system'
  return 'local-administrator'
}

export class DataExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DataExportError'
  }
}

export async function createDataExport(actor: {
  readonly userId: string
  readonly name: string
  readonly email: string
}) {
  const files = await getDb().transaction(
    async (transaction) => {
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
        .where(eq(user.id, actor.userId))
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
        .select()
        .from(athleteProfiles)
        .where(eq(athleteProfiles.userId, actor.userId))
        .limit(1)
      const days = await transaction
        .select()
        .from(athleteTrainingDays)
        .where(eq(athleteTrainingDays.userId, actor.userId))
        .orderBy(asc(athleteTrainingDays.ordinal))
      const equipment = await transaction
        .select()
        .from(athleteEquipment)
        .where(eq(athleteEquipment.userId, actor.userId))
        .orderBy(asc(athleteEquipment.equipmentCode))
      const baselines = await transaction
        .select()
        .from(strengthBaselines)
        .where(eq(strengthBaselines.userId, actor.userId))
        .orderBy(asc(strengthBaselines.exerciseCode))
      const holds = await transaction
        .select()
        .from(safetyHolds)
        .where(eq(safetyHolds.userId, actor.userId))
        .orderBy(asc(safetyHolds.createdAt), asc(safetyHolds.id))
      const holdResolutions = await transaction
        .select()
        .from(safetyHoldResolutions)
        .where(eq(safetyHoldResolutions.userId, actor.userId))
        .orderBy(asc(safetyHoldResolutions.createdAt), asc(safetyHoldResolutions.id))

      const ownedPrograms = await transaction
        .select()
        .from(programs)
        .where(eq(programs.userId, actor.userId))
        .orderBy(asc(programs.createdAt), asc(programs.id))
      const programIds = ownedPrograms.map((program) => program.id)
      const revisions =
        programIds.length === 0
          ? []
          : await transaction
              .select()
              .from(programRevisions)
              .where(inArray(programRevisions.programId, programIds))
              .orderBy(
                asc(programRevisions.programId),
                asc(programRevisions.revisionNumber),
              )
      const revisionIds = revisions.map((revision) => revision.id)
      const revisionContentRevocations =
        revisionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(contentReleaseRevocations)
              .where(sql`EXISTS (
                SELECT 1
                FROM ${programRevisions} AS revision
                WHERE revision.id IN (${sql.join(
                  revisionIds.map((revisionId) => sql`${revisionId}`),
                  sql`, `,
                )})
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
              .orderBy(
                asc(contentReleaseRevocations.createdAt),
                asc(contentReleaseRevocations.id),
              )
      const revisionLineage =
        revisionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(programRevisionLineage)
              .where(inArray(programRevisionLineage.revisionId, revisionIds))
              .orderBy(asc(programRevisionLineage.createdAt))
      const workouts =
        revisionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(plannedWorkouts)
              .where(inArray(plannedWorkouts.revisionId, revisionIds))
              .orderBy(asc(plannedWorkouts.revisionId), asc(plannedWorkouts.ordinal))
      const workoutIds = workouts.map((workout) => workout.id)
      const exercises =
        workoutIds.length === 0
          ? []
          : await transaction
              .select()
              .from(exercisePrescriptions)
              .where(inArray(exercisePrescriptions.plannedWorkoutId, workoutIds))
              .orderBy(
                asc(exercisePrescriptions.plannedWorkoutId),
                asc(exercisePrescriptions.ordinal),
              )
      const exerciseIds = exercises.map((exercise) => exercise.id)
      const prescriptions =
        exerciseIds.length === 0
          ? []
          : await transaction
              .select()
              .from(setPrescriptions)
              .where(inArray(setPrescriptions.exercisePrescriptionId, exerciseIds))
              .orderBy(
                asc(setPrescriptions.exercisePrescriptionId),
                asc(setPrescriptions.ordinal),
              )

      const ownedSessions = await transaction
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.userId, actor.userId))
        .orderBy(asc(workoutSessions.startedAt), asc(workoutSessions.id))
      const sessionIds = ownedSessions.map((session) => session.id)
      const sessionExerciseRows =
        sessionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(sessionExercises)
              .where(inArray(sessionExercises.sessionId, sessionIds))
              .orderBy(asc(sessionExercises.sessionId), asc(sessionExercises.ordinal))
      const sessionExerciseIds = sessionExerciseRows.map((exercise) => exercise.id)
      const setRows =
        sessionExerciseIds.length === 0
          ? []
          : await transaction
              .select()
              .from(performedSets)
              .where(inArray(performedSets.sessionExerciseId, sessionExerciseIds))
              .orderBy(asc(performedSets.sessionExerciseId), asc(performedSets.ordinal))
      const feedbackRows =
        sessionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(sessionFeedback)
              .where(inArray(sessionFeedback.sessionId, sessionIds))
              .orderBy(asc(sessionFeedback.sessionId))
      const commandReceipts =
        sessionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(trainingCommandReceipts)
              .where(inArray(trainingCommandReceipts.sessionId, sessionIds))
              .orderBy(
                asc(trainingCommandReceipts.createdAt),
                asc(trainingCommandReceipts.commandId),
              )
      const adjustmentRows =
        sessionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(adjustmentDecisions)
              .where(inArray(adjustmentDecisions.sessionId, sessionIds))
              .orderBy(
                asc(adjustmentDecisions.sessionId),
                asc(adjustmentDecisions.exerciseCode),
              )
      const explanationRows =
        sessionIds.length === 0
          ? []
          : await transaction
              .select({
                id: futureLoadExplanationCache.id,
                sessionId: futureLoadExplanationCache.sessionId,
                decisionId: futureLoadExplanationCache.decisionId,
                prose: futureLoadExplanationCache.prose,
                modelId: futureLoadExplanationCache.modelId,
                modelContentDigest: futureLoadExplanationCache.modelContentDigest,
                servedModelName: futureLoadExplanationCache.servedModelName,
                runtimeId: futureLoadExplanationCache.runtimeId,
                runtimeAttestationDigest:
                  futureLoadExplanationCache.runtimeAttestationDigest,
                promptVersion: futureLoadExplanationCache.promptVersion,
                validatorVersion: futureLoadExplanationCache.validatorVersion,
                factBundleHash: futureLoadExplanationCache.factBundleHash,
                generateDurationMs: futureLoadExplanationCache.generateDurationMs,
                createdAt: futureLoadExplanationCache.createdAt,
              })
              .from(futureLoadExplanationCache)
              .where(
                and(
                  eq(futureLoadExplanationCache.userId, actor.userId),
                  inArray(futureLoadExplanationCache.sessionId, sessionIds),
                ),
              )
              .orderBy(
                asc(futureLoadExplanationCache.sessionId),
                asc(futureLoadExplanationCache.decisionId),
                asc(futureLoadExplanationCache.createdAt),
                asc(futureLoadExplanationCache.id),
              )

      const correctionRows =
        sessionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(trainingFactCorrections)
              .where(eq(trainingFactCorrections.userId, actor.userId))
              .orderBy(
                asc(trainingFactCorrections.sessionId),
                asc(trainingFactCorrections.sequence),
                asc(trainingFactCorrections.id),
              )
      const correctionIds = correctionRows.map((correction) => correction.id)
      const feedbackCorrectionRows =
        correctionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(sessionFeedbackCorrections)
              .where(inArray(sessionFeedbackCorrections.correctionId, correctionIds))
      const performedSetCorrectionRows =
        correctionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(performedSetCorrections)
              .where(inArray(performedSetCorrections.correctionId, correctionIds))
      const adjustmentIds = adjustmentRows.map((adjustment) => adjustment.id)
      const adjustmentInvalidationRows =
        adjustmentIds.length === 0
          ? []
          : await transaction
              .select()
              .from(adjustmentDecisionInvalidations)
              .where(inArray(adjustmentDecisionInvalidations.decisionId, adjustmentIds))
              .orderBy(asc(adjustmentDecisionInvalidations.decisionId))
      const revisionInvalidationRows =
        revisionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(programRevisionInvalidations)
              .where(inArray(programRevisionInvalidations.revisionId, revisionIds))
              .orderBy(asc(programRevisionInvalidations.revisionId))

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
        .where(eq(auditEvents.subjectUserId, actor.userId))
        .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))

      const workoutById = new Map(workouts.map((workout) => [workout.id, workout]))
      const revisionById = new Map(revisions.map((revision) => [revision.id, revision]))
      const programById = new Map(ownedPrograms.map((program) => [program.id, program]))
      const exportedContentRevocations = revisionContentRevocations.map(
        ({ actorUserId, ...revocation }) => ({
          ...revocation,
          actorClass: actorClassForExport(actor.userId, actorUserId),
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

      return {
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
                  explanations: explanationRows.filter(
                    (explanation) => explanation.decisionId === adjustment.id,
                  ),
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
        auditEvents: auditRows.map(({ actorUserId, ...event }) => ({
          ...event,
          actorClass: actorClassForExport(actor.userId, actorUserId),
        })),
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
            'actorClass is self, local-administrator, or system. Other local account identifiers are intentionally not disclosed.',
        },
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )

  const hashes = Object.fromEntries(
    Object.entries(files).map(([name, value]) => [
      name,
      canonicalSha256(canonical(value)),
    ]),
  )

  return {
    manifest: {
      schemaVersion: exportSchemaVersion,
      product: 'indigo-synthesis',
      generatedAt: new Date().toISOString(),
      subjectUserId: actor.userId,
      scope: 'authenticated-subject',
      format: 'application/json',
      hashAlgorithm: 'SHA-256',
      hashes,
      omissions: [
        {
          category: 'authentication-material',
          reason:
            'Password hashes, credential-provider records, active sessions, recovery codes, verification values, and tokens are never exported.',
        },
        {
          category: 'other-local-users',
          reason:
            'Other accounts and their product records are outside this subject-scoped archive.',
        },
        {
          category: 'methodology-and-template-source-material',
          reason:
            'Installed source libraries and release documents are not redistributed. Every owned prescription retains the versions, review status, hashes, and generated output needed to interpret it.',
        },
        {
          category: 'administrative-workflow-state',
          reason:
            'Installation bootstrap state, deletion previews, and non-personal deletion tombstones are operational records rather than subject data.',
        },
      ],
    },
    ...files,
  }
}
