import { and, eq, gt, sql } from 'drizzle-orm'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import { assertOwner } from '@/modules/identity/application/actor'
import {
  type CanonicalValue,
  canonicalSha256,
} from '@/modules/methodology/domain/canonical'
import { getDb } from '@/platform/db/client'
import { deletionPlans } from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import { exportSchemaVersion } from './export'

export type InstanceResetCounts = {
  readonly installationStates: number
  readonly users: number
  readonly authSessions: number
  readonly authAccounts: number
  readonly authVerifications: number
  readonly destructiveReauthenticationStates: number
  readonly memberResetStates: number
  readonly webRecoveryRateLimitBuckets: number
  readonly athleteProfiles: number
  readonly athleteTrainingDays: number
  readonly athleteEquipment: number
  readonly strengthBaselines: number
  readonly safetyHolds: number
  readonly safetyHoldResolutions: number
  readonly programs: number
  readonly programRevisions: number
  readonly programRevisionLineage: number
  readonly plannedWorkouts: number
  readonly exercisePrescriptions: number
  readonly setPrescriptions: number
  readonly workoutSessions: number
  readonly sessionExercises: number
  readonly performedSets: number
  readonly trainingCommandReceipts: number
  readonly sessionFeedback: number
  readonly adjustmentDecisions: number
  readonly trainingFactCorrections: number
  readonly sessionFeedbackCorrections: number
  readonly performedSetCorrections: number
  readonly adjustmentDecisionInvalidations: number
  readonly programRevisionInvalidations: number
  readonly contentReleaseRevocations: number
  readonly futureLoadExplanationCache: number
  readonly auditEvents: number
  readonly deletionPlans: number
}

export type InstanceResetPlan = {
  readonly id: string
  readonly digest: string
  readonly expiresAt: Date
  readonly counts: InstanceResetCounts
}

export type SubjectDeletionCounts = {
  readonly users: number
  readonly authSessions: number
  readonly authAccounts: number
  readonly authVerifications: number
  readonly memberResetStates: number
  readonly athleteProfiles: number
  readonly athleteTrainingDays: number
  readonly athleteEquipment: number
  readonly strengthBaselines: number
  readonly safetyHolds: number
  readonly safetyHoldResolutions: number
  readonly programs: number
  readonly programRevisions: number
  readonly programRevisionLineage: number
  readonly plannedWorkouts: number
  readonly exercisePrescriptions: number
  readonly setPrescriptions: number
  readonly workoutSessions: number
  readonly sessionExercises: number
  readonly performedSets: number
  readonly trainingCommandReceipts: number
  readonly sessionFeedback: number
  readonly adjustmentDecisions: number
  readonly trainingFactCorrections: number
  readonly sessionFeedbackCorrections: number
  readonly performedSetCorrections: number
  readonly adjustmentDecisionInvalidations: number
  readonly programRevisionInvalidations: number
  readonly futureLoadExplanationCache: number
  readonly auditEventsDeleted: number
  readonly auditActorReferencesRedacted: number
  readonly deletionPlans: number
}

export type SubjectDeletionPlan = {
  readonly id: string
  readonly digest: string
  readonly expiresAt: Date
  readonly counts: SubjectDeletionCounts
}

export class DeletionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DeletionError'
  }
}

type DeletionPlanExecutable = {
  execute: ReturnType<typeof getDb>['execute']
}

export async function countInstanceRows(
  database: DeletionPlanExecutable,
  actorUserId: string,
): Promise<InstanceResetCounts> {
  const result = await database.execute<InstanceResetCounts>(sql`
    SELECT
      (SELECT count(*)::int FROM installation_state) AS "installationStates",
      (SELECT count(*)::int FROM "user") AS users,
      (SELECT count(*)::int FROM "session") AS "authSessions",
      (SELECT count(*)::int FROM account) AS "authAccounts",
      (SELECT count(*)::int FROM verification) AS "authVerifications",
      (SELECT count(*)::int
        FROM destructive_reauthentication_state drs
        JOIN account dra ON dra.id = drs.account_id
        WHERE NOT (
          dra.user_id = ${actorUserId}
          AND drs.purpose = 'instance-reset'
        )) AS "destructiveReauthenticationStates",
      (SELECT count(*)::int FROM member_reset_state) AS "memberResetStates",
      (SELECT count(*)::int
        FROM web_recovery_rate_limit_bucket) AS "webRecoveryRateLimitBuckets",
      (SELECT count(*)::int FROM athlete_profile) AS "athleteProfiles",
      (SELECT count(*)::int FROM athlete_training_day) AS "athleteTrainingDays",
      (SELECT count(*)::int FROM athlete_equipment) AS "athleteEquipment",
      (SELECT count(*)::int FROM strength_baseline) AS "strengthBaselines",
      (SELECT count(*)::int FROM safety_hold) AS "safetyHolds",
      (SELECT count(*)::int FROM safety_hold_resolution) AS "safetyHoldResolutions",
      (SELECT count(*)::int FROM program) AS programs,
      (SELECT count(*)::int FROM program_revision) AS "programRevisions",
      (SELECT count(*)::int FROM program_revision_lineage) AS "programRevisionLineage",
      (SELECT count(*)::int FROM planned_workout) AS "plannedWorkouts",
      (SELECT count(*)::int FROM exercise_prescription) AS "exercisePrescriptions",
      (SELECT count(*)::int FROM set_prescription) AS "setPrescriptions",
      (SELECT count(*)::int FROM workout_session) AS "workoutSessions",
      (SELECT count(*)::int FROM session_exercise) AS "sessionExercises",
      (SELECT count(*)::int FROM performed_set) AS "performedSets",
      (SELECT count(*)::int FROM training_command_receipt) AS "trainingCommandReceipts",
      (SELECT count(*)::int FROM session_feedback) AS "sessionFeedback",
      (SELECT count(*)::int FROM adjustment_decision) AS "adjustmentDecisions",
      (SELECT count(*)::int FROM training_fact_correction) AS "trainingFactCorrections",
      (SELECT count(*)::int FROM session_feedback_correction) AS "sessionFeedbackCorrections",
      (SELECT count(*)::int FROM performed_set_correction) AS "performedSetCorrections",
      (SELECT count(*)::int FROM adjustment_decision_invalidation) AS "adjustmentDecisionInvalidations",
      (SELECT count(*)::int FROM program_revision_invalidation) AS "programRevisionInvalidations",
      (SELECT count(*)::int FROM content_release_revocation) AS "contentReleaseRevocations",
      (SELECT count(*)::int FROM future_load_explanation_cache) AS "futureLoadExplanationCache",
      (SELECT count(*)::int FROM audit_event) AS "auditEvents",
      (SELECT count(*)::int FROM deletion_plan) AS "deletionPlans"
  `)
  const counts = result.rows[0]
  if (!counts) {
    throw new DeletionError('deletion.count-failed', 'Could not count instance data.')
  }
  return counts
}

export async function countSubjectRows(
  database: DeletionPlanExecutable,
  userId: string,
  email: string,
  preserveIdentity: boolean,
): Promise<SubjectDeletionCounts> {
  const recoveryIdentifier = `indigo:owner-recovery:${userId}`
  const memberResetIdentifier = `indigo:member-reset:${userId}`
  const result = await database.execute<SubjectDeletionCounts>(sql`
    SELECT
      CASE WHEN ${preserveIdentity} THEN 0 ELSE
        (SELECT count(*)::int FROM "user" WHERE id = ${userId}) END AS users,
      CASE WHEN ${preserveIdentity} THEN 0 ELSE
        (SELECT count(*)::int FROM "session" WHERE user_id = ${userId}) END AS "authSessions",
      CASE WHEN ${preserveIdentity} THEN 0 ELSE
        (SELECT count(*)::int FROM account WHERE user_id = ${userId}) END AS "authAccounts",
      CASE WHEN ${preserveIdentity} THEN 0 ELSE
        (SELECT count(*)::int FROM verification
          WHERE identifier = ${email}
            OR identifier = ${recoveryIdentifier}
            OR identifier = ${memberResetIdentifier})
        END AS "authVerifications",
      (SELECT count(*)::int FROM member_reset_state
        WHERE target_user_id = ${userId}) AS "memberResetStates",
      (SELECT count(*)::int FROM athlete_profile WHERE user_id = ${userId}) AS "athleteProfiles",
      (SELECT count(*)::int FROM athlete_training_day WHERE user_id = ${userId}) AS "athleteTrainingDays",
      (SELECT count(*)::int FROM athlete_equipment WHERE user_id = ${userId}) AS "athleteEquipment",
      (SELECT count(*)::int FROM strength_baseline WHERE user_id = ${userId}) AS "strengthBaselines",
      (SELECT count(*)::int FROM safety_hold WHERE user_id = ${userId}) AS "safetyHolds",
      (SELECT count(*)::int FROM safety_hold_resolution
        WHERE user_id = ${userId}) AS "safetyHoldResolutions",
      (SELECT count(*)::int FROM program WHERE user_id = ${userId}) AS programs,
      (SELECT count(*)::int FROM program_revision pr
        JOIN program p ON p.id = pr.program_id WHERE p.user_id = ${userId}) AS "programRevisions",
      (SELECT count(*)::int FROM program_revision_lineage prl
        JOIN program_revision pr ON pr.id = prl.revision_id
        JOIN program p ON p.id = pr.program_id WHERE p.user_id = ${userId}) AS "programRevisionLineage",
      (SELECT count(*)::int FROM planned_workout pw
        JOIN program_revision pr ON pr.id = pw.revision_id
        JOIN program p ON p.id = pr.program_id WHERE p.user_id = ${userId}) AS "plannedWorkouts",
      (SELECT count(*)::int FROM exercise_prescription ep
        JOIN planned_workout pw ON pw.id = ep.planned_workout_id
        JOIN program_revision pr ON pr.id = pw.revision_id
        JOIN program p ON p.id = pr.program_id WHERE p.user_id = ${userId}) AS "exercisePrescriptions",
      (SELECT count(*)::int FROM set_prescription sp
        JOIN exercise_prescription ep ON ep.id = sp.exercise_prescription_id
        JOIN planned_workout pw ON pw.id = ep.planned_workout_id
        JOIN program_revision pr ON pr.id = pw.revision_id
        JOIN program p ON p.id = pr.program_id WHERE p.user_id = ${userId}) AS "setPrescriptions",
      (SELECT count(*)::int FROM workout_session WHERE user_id = ${userId}) AS "workoutSessions",
      (SELECT count(*)::int FROM session_exercise se
        JOIN workout_session ws ON ws.id = se.session_id WHERE ws.user_id = ${userId}) AS "sessionExercises",
      (SELECT count(*)::int FROM performed_set ps
        JOIN session_exercise se ON se.id = ps.session_exercise_id
        JOIN workout_session ws ON ws.id = se.session_id WHERE ws.user_id = ${userId}) AS "performedSets",
      (SELECT count(*)::int FROM training_command_receipt
        WHERE user_id = ${userId}) AS "trainingCommandReceipts",
      (SELECT count(*)::int FROM session_feedback sf
        JOIN workout_session ws ON ws.id = sf.session_id WHERE ws.user_id = ${userId}) AS "sessionFeedback",
      (SELECT count(*)::int FROM adjustment_decision ad
        JOIN workout_session ws ON ws.id = ad.session_id WHERE ws.user_id = ${userId}) AS "adjustmentDecisions",
      (SELECT count(*)::int FROM training_fact_correction
        WHERE user_id = ${userId}) AS "trainingFactCorrections",
      (SELECT count(*)::int FROM session_feedback_correction
        WHERE user_id = ${userId}) AS "sessionFeedbackCorrections",
      (SELECT count(*)::int FROM performed_set_correction
        WHERE user_id = ${userId}) AS "performedSetCorrections",
      (SELECT count(*)::int FROM adjustment_decision_invalidation invalidation
        JOIN training_fact_correction correction
          ON correction.id = invalidation.correction_id
        WHERE correction.user_id = ${userId}) AS "adjustmentDecisionInvalidations",
      (SELECT count(*)::int FROM program_revision_invalidation invalidation
        JOIN training_fact_correction correction
          ON correction.id = invalidation.correction_id
        WHERE correction.user_id = ${userId}) AS "programRevisionInvalidations",
      (SELECT count(*)::int FROM future_load_explanation_cache
        WHERE user_id = ${userId}) AS "futureLoadExplanationCache",
      (SELECT count(*)::int FROM audit_event WHERE subject_user_id = ${userId}) AS "auditEventsDeleted",
      CASE WHEN ${preserveIdentity} THEN 0 ELSE
        (SELECT count(*)::int FROM audit_event
          WHERE actor_user_id = ${userId} AND subject_user_id IS DISTINCT FROM ${userId})
        END AS "auditActorReferencesRedacted",
      (SELECT count(*)::int FROM deletion_plan WHERE user_id = ${userId}) AS "deletionPlans"
  `)
  const counts = result.rows[0]
  if (!counts) {
    throw new DeletionError('deletion.count-failed', 'Could not count subject data.')
  }
  return counts
}

export function digestInstanceResetPlan(input: {
  readonly planId: string
  readonly actorUserId: string
  readonly scope: 'instance-reset'
  readonly schemaVersion: string
  readonly counts: InstanceResetCounts
  readonly expiresAt: string
}): string {
  return canonicalSha256(input as unknown as CanonicalValue)
}

export function digestSubjectDeletionPlan(input: {
  readonly planId: string
  readonly actorUserId: string
  readonly scope: 'trainee-data'
  readonly schemaVersion: string
  readonly counts: SubjectDeletionCounts
  readonly expiresAt: string
}): string {
  return canonicalSha256(input as unknown as CanonicalValue)
}

export async function createInstanceResetPlan(
  actor: AuthenticatedActor,
): Promise<InstanceResetPlan> {
  assertOwner(actor)
  const id = newUuidV7()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1_000)

  return getDb().transaction(
    async (transaction) => {
      await transaction
        .delete(deletionPlans)
        .where(
          and(
            eq(deletionPlans.userId, actor.userId),
            eq(deletionPlans.scope, 'instance-reset'),
          ),
        )
      // The preview is itself resettable state. Insert it before counting so its row is
      // represented in both the exact preview and the retained aggregate tombstone.
      await transaction.insert(deletionPlans).values({
        id,
        userId: actor.userId,
        scope: 'instance-reset',
        planDigest: 'pending',
        rowCounts: {},
        expiresAt,
      })

      const counts = await countInstanceRows(transaction, actor.userId)
      const digest = digestInstanceResetPlan({
        planId: id,
        actorUserId: actor.userId,
        scope: 'instance-reset',
        schemaVersion: exportSchemaVersion,
        counts,
        expiresAt: expiresAt.toISOString(),
      })
      await transaction
        .update(deletionPlans)
        .set({ planDigest: digest, rowCounts: counts })
        .where(eq(deletionPlans.id, id))

      return { id, digest, expiresAt, counts }
    },
    { isolationLevel: 'serializable' },
  )
}

export async function getActiveInstanceResetPlan(
  actor: AuthenticatedActor,
): Promise<InstanceResetPlan | null> {
  assertOwner(actor)
  const [plan] = await getDb()
    .select()
    .from(deletionPlans)
    .where(
      and(
        eq(deletionPlans.userId, actor.userId),
        eq(deletionPlans.scope, 'instance-reset'),
        gt(deletionPlans.expiresAt, new Date()),
      ),
    )
    .limit(1)
  if (!plan) return null
  return {
    id: plan.id,
    digest: plan.planDigest,
    expiresAt: plan.expiresAt,
    counts: plan.rowCounts as InstanceResetCounts,
  }
}

export async function createSubjectDeletionPlan(
  actor: AuthenticatedActor,
): Promise<SubjectDeletionPlan> {
  const id = newUuidV7()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1_000)

  return getDb().transaction(
    async (transaction) => {
      await transaction
        .delete(deletionPlans)
        .where(
          and(
            eq(deletionPlans.userId, actor.userId),
            eq(deletionPlans.scope, 'trainee-data'),
          ),
        )
      await transaction.insert(deletionPlans).values({
        id,
        userId: actor.userId,
        scope: 'trainee-data',
        planDigest: 'pending',
        rowCounts: {},
        expiresAt,
      })
      const counts = await countSubjectRows(
        transaction,
        actor.userId,
        actor.email,
        actor.role === 'owner',
      )
      const digest = digestSubjectDeletionPlan({
        planId: id,
        actorUserId: actor.userId,
        scope: 'trainee-data',
        schemaVersion: exportSchemaVersion,
        counts,
        expiresAt: expiresAt.toISOString(),
      })
      await transaction
        .update(deletionPlans)
        .set({ planDigest: digest, rowCounts: counts })
        .where(eq(deletionPlans.id, id))
      return { id, digest, expiresAt, counts }
    },
    { isolationLevel: 'serializable' },
  )
}

export async function getActiveSubjectDeletionPlan(
  actor: AuthenticatedActor,
): Promise<SubjectDeletionPlan | null> {
  const [plan] = await getDb()
    .select()
    .from(deletionPlans)
    .where(
      and(
        eq(deletionPlans.userId, actor.userId),
        eq(deletionPlans.scope, 'trainee-data'),
        gt(deletionPlans.expiresAt, new Date()),
      ),
    )
    .limit(1)
  if (!plan) return null
  return {
    id: plan.id,
    digest: plan.planDigest,
    expiresAt: plan.expiresAt,
    counts: plan.rowCounts as SubjectDeletionCounts,
  }
}
