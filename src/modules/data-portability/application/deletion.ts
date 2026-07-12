import { verifyPassword } from 'better-auth/crypto'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import { assertOwner } from '@/modules/identity/application/actor'
import {
  type CanonicalValue,
  canonicalSha256,
} from '@/modules/methodology/domain/canonical'
import { getDb } from '@/platform/db/client'
import {
  account,
  adjustmentDecisions,
  athleteEquipment,
  athleteProfiles,
  athleteTrainingDays,
  auditEvents,
  deletionPlans,
  deletionTombstones,
  exercisePrescriptions,
  installationState,
  performedSets,
  plannedWorkouts,
  programRevisionLineage,
  programRevisions,
  programs,
  safetyHolds,
  session,
  sessionExercises,
  sessionFeedback,
  setPrescriptions,
  strengthBaselines,
  trainingCommandReceipts,
  user,
  verification,
  workoutSessions,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import { exportSchemaVersion } from './export'

export type InstanceResetCounts = {
  readonly installationStates: number
  readonly users: number
  readonly authSessions: number
  readonly authAccounts: number
  readonly authVerifications: number
  readonly athleteProfiles: number
  readonly athleteTrainingDays: number
  readonly athleteEquipment: number
  readonly strengthBaselines: number
  readonly safetyHolds: number
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
  readonly athleteProfiles: number
  readonly athleteTrainingDays: number
  readonly athleteEquipment: number
  readonly strengthBaselines: number
  readonly safetyHolds: number
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

type Executable = {
  execute: ReturnType<typeof getDb>['execute']
}

async function countInstanceRows(database: Executable): Promise<InstanceResetCounts> {
  const result = await database.execute<InstanceResetCounts>(sql`
    SELECT
      (SELECT count(*)::int FROM installation_state) AS "installationStates",
      (SELECT count(*)::int FROM "user") AS users,
      (SELECT count(*)::int FROM "session") AS "authSessions",
      (SELECT count(*)::int FROM account) AS "authAccounts",
      (SELECT count(*)::int FROM verification) AS "authVerifications",
      (SELECT count(*)::int FROM athlete_profile) AS "athleteProfiles",
      (SELECT count(*)::int FROM athlete_training_day) AS "athleteTrainingDays",
      (SELECT count(*)::int FROM athlete_equipment) AS "athleteEquipment",
      (SELECT count(*)::int FROM strength_baseline) AS "strengthBaselines",
      (SELECT count(*)::int FROM safety_hold) AS "safetyHolds",
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
      (SELECT count(*)::int FROM audit_event) AS "auditEvents",
      (SELECT count(*)::int FROM deletion_plan) AS "deletionPlans"
  `)
  const counts = result.rows[0]
  if (!counts) {
    throw new DeletionError('deletion.count-failed', 'Could not count instance data.')
  }
  return counts
}

async function countSubjectRows(
  database: Executable,
  userId: string,
  email: string,
): Promise<SubjectDeletionCounts> {
  const recoveryIdentifier = `indigo:owner-recovery:${userId}`
  const result = await database.execute<SubjectDeletionCounts>(sql`
    SELECT
      (SELECT count(*)::int FROM "user" WHERE id = ${userId}) AS users,
      (SELECT count(*)::int FROM "session" WHERE user_id = ${userId}) AS "authSessions",
      (SELECT count(*)::int FROM account WHERE user_id = ${userId}) AS "authAccounts",
      (SELECT count(*)::int FROM verification
        WHERE identifier = ${email} OR identifier = ${recoveryIdentifier}) AS "authVerifications",
      (SELECT count(*)::int FROM athlete_profile WHERE user_id = ${userId}) AS "athleteProfiles",
      (SELECT count(*)::int FROM athlete_training_day WHERE user_id = ${userId}) AS "athleteTrainingDays",
      (SELECT count(*)::int FROM athlete_equipment WHERE user_id = ${userId}) AS "athleteEquipment",
      (SELECT count(*)::int FROM strength_baseline WHERE user_id = ${userId}) AS "strengthBaselines",
      (SELECT count(*)::int FROM safety_hold WHERE user_id = ${userId}) AS "safetyHolds",
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
      (SELECT count(*)::int FROM audit_event WHERE subject_user_id = ${userId}) AS "auditEventsDeleted",
      (SELECT count(*)::int FROM audit_event
        WHERE actor_user_id = ${userId} AND subject_user_id IS DISTINCT FROM ${userId}) AS "auditActorReferencesRedacted",
      (SELECT count(*)::int FROM deletion_plan WHERE user_id = ${userId}) AS "deletionPlans"
  `)
  const counts = result.rows[0]
  if (!counts) {
    throw new DeletionError('deletion.count-failed', 'Could not count subject data.')
  }
  return counts
}

function digestPlan(input: {
  readonly planId: string
  readonly actorUserId: string
  readonly scope: 'instance-reset'
  readonly schemaVersion: string
  readonly counts: InstanceResetCounts
  readonly expiresAt: string
}): string {
  return canonicalSha256(input as unknown as CanonicalValue)
}

function digestSubjectPlan(input: {
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

      const counts = await countInstanceRows(transaction)
      const digest = digestPlan({
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
  if (actor.role === 'owner') {
    throw new DeletionError(
      'deletion.owner-requires-instance-reset',
      'The sole owner must use the instance-reset workflow.',
    )
  }
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
      const counts = await countSubjectRows(transaction, actor.userId, actor.email)
      const digest = digestSubjectPlan({
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
  if (actor.role === 'owner') return null
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

export async function executeSubjectDeletion(input: {
  readonly actor: AuthenticatedActor
  readonly planId: string
  readonly planDigest: string
  readonly password: string
  readonly typedConfirmation: string
  readonly acknowledged: boolean
}): Promise<void> {
  if (input.actor.role === 'owner') {
    throw new DeletionError(
      'deletion.owner-requires-instance-reset',
      'The sole owner must use the instance-reset workflow.',
    )
  }
  if (!input.acknowledged || input.typedConfirmation !== 'DELETE') {
    throw new DeletionError(
      'deletion.confirmation-invalid',
      'Acknowledge the consequences and type DELETE exactly.',
    )
  }

  await getDb().transaction(
    async (transaction) => {
      await transaction.execute(sql`SET LOCAL indigo.deletion_mode = 'trainee-data'`)
      const [credential] = await transaction
        .select({ password: account.password })
        .from(account)
        .where(
          and(
            eq(account.userId, input.actor.userId),
            eq(account.providerId, 'credential'),
          ),
        )
        .for('update')
        .limit(1)
      if (
        !credential?.password ||
        !(await verifyPassword({
          hash: credential.password,
          password: input.password,
        }))
      ) {
        throw new DeletionError(
          'deletion.reauthentication-failed',
          'Password was not accepted.',
        )
      }

      const [plan] = await transaction
        .select()
        .from(deletionPlans)
        .where(
          and(
            eq(deletionPlans.id, input.planId),
            eq(deletionPlans.userId, input.actor.userId),
            eq(deletionPlans.scope, 'trainee-data'),
          ),
        )
        .for('update')
        .limit(1)
      if (
        !plan ||
        plan.consumedAt ||
        plan.expiresAt <= new Date() ||
        plan.planDigest !== input.planDigest
      ) {
        throw new DeletionError(
          'deletion.plan-invalid',
          'The deletion preview expired or no longer matches.',
        )
      }

      const currentCounts = await countSubjectRows(
        transaction,
        input.actor.userId,
        input.actor.email,
      )
      const currentDigest = digestSubjectPlan({
        planId: plan.id,
        actorUserId: input.actor.userId,
        scope: 'trainee-data',
        schemaVersion: exportSchemaVersion,
        counts: currentCounts,
        expiresAt: plan.expiresAt.toISOString(),
      })
      if (currentDigest !== plan.planDigest) {
        throw new DeletionError(
          'deletion.plan-changed',
          'Subject data changed after preview. Generate a new preview.',
        )
      }

      const completedAt = new Date()
      const tombstoneId = newUuidV7()
      const completionDigest = canonicalSha256({
        eventId: tombstoneId,
        scope: 'trainee-data',
        schemaVersion: exportSchemaVersion,
        completedAt: completedAt.toISOString(),
        counts: currentCounts,
      } as unknown as CanonicalValue)

      await transaction
        .delete(trainingCommandReceipts)
        .where(eq(trainingCommandReceipts.userId, input.actor.userId))
      await transaction.execute(sql`
        DELETE FROM program_revision_lineage
        WHERE revision_id IN (
          SELECT pr.id
          FROM program_revision pr
          JOIN program p ON p.id = pr.program_id
          WHERE p.user_id = ${input.actor.userId}
        )
      `)
      await transaction
        .delete(workoutSessions)
        .where(eq(workoutSessions.userId, input.actor.userId))
      await transaction.delete(programs).where(eq(programs.userId, input.actor.userId))
      await transaction
        .delete(auditEvents)
        .where(eq(auditEvents.subjectUserId, input.actor.userId))
      const recoveryIdentifier = `indigo:owner-recovery:${input.actor.userId}`
      await transaction.delete(verification).where(
        sql`${verification.identifier} = ${input.actor.email}
            OR ${verification.identifier} = ${recoveryIdentifier}`,
      )
      await transaction.delete(session).where(eq(session.userId, input.actor.userId))
      await transaction.delete(account).where(eq(account.userId, input.actor.userId))
      await transaction.delete(user).where(eq(user.id, input.actor.userId))

      await transaction.insert(deletionTombstones).values({
        id: tombstoneId,
        actorClass: 'trainee',
        scope: 'trainee-data',
        schemaVersion: exportSchemaVersion,
        rowCounts: currentCounts,
        completionDigest,
        createdAt: completedAt,
      })
    },
    { isolationLevel: 'serializable' },
  )
}

export async function executeInstanceReset(input: {
  readonly actor: AuthenticatedActor
  readonly planId: string
  readonly planDigest: string
  readonly password: string
  readonly typedConfirmation: string
  readonly acknowledged: boolean
}): Promise<void> {
  assertOwner(input.actor)
  if (!input.acknowledged || input.typedConfirmation !== 'RESET') {
    throw new DeletionError(
      'deletion.confirmation-invalid',
      'Acknowledge the consequences and type RESET exactly.',
    )
  }

  await getDb().transaction(
    async (transaction) => {
      await transaction.execute(sql`SET LOCAL indigo.deletion_mode = 'instance-reset'`)
      const [installation] = await transaction
        .select({ ownerUserId: installationState.ownerUserId })
        .from(installationState)
        .where(eq(installationState.singleton, 1))
        .for('update')
        .limit(1)
      if (installation?.ownerUserId !== input.actor.userId) {
        throw new DeletionError('deletion.owner-changed', 'Instance ownership changed.')
      }

      const [credential] = await transaction
        .select({ password: account.password })
        .from(account)
        .where(
          and(
            eq(account.userId, input.actor.userId),
            eq(account.providerId, 'credential'),
          ),
        )
        .for('update')
        .limit(1)
      if (
        !credential?.password ||
        !(await verifyPassword({
          hash: credential.password,
          password: input.password,
        }))
      ) {
        throw new DeletionError(
          'deletion.reauthentication-failed',
          'Password was not accepted.',
        )
      }

      const [plan] = await transaction
        .select()
        .from(deletionPlans)
        .where(
          and(
            eq(deletionPlans.id, input.planId),
            eq(deletionPlans.userId, input.actor.userId),
            eq(deletionPlans.scope, 'instance-reset'),
          ),
        )
        .for('update')
        .limit(1)
      if (
        !plan ||
        plan.consumedAt ||
        plan.expiresAt <= new Date() ||
        plan.planDigest !== input.planDigest
      ) {
        throw new DeletionError(
          'deletion.plan-invalid',
          'The reset preview expired or no longer matches.',
        )
      }

      const currentCounts = await countInstanceRows(transaction)
      const currentDigest = digestPlan({
        planId: plan.id,
        actorUserId: input.actor.userId,
        scope: 'instance-reset',
        schemaVersion: exportSchemaVersion,
        counts: currentCounts,
        expiresAt: plan.expiresAt.toISOString(),
      })
      if (currentDigest !== plan.planDigest) {
        throw new DeletionError(
          'deletion.plan-changed',
          'Instance data changed after preview. Generate a new preview.',
        )
      }

      const completedAt = new Date()
      const tombstoneId = newUuidV7()
      const completionDigest = canonicalSha256({
        eventId: tombstoneId,
        scope: 'instance-reset',
        schemaVersion: exportSchemaVersion,
        completedAt: completedAt.toISOString(),
        counts: currentCounts,
      } as unknown as CanonicalValue)

      await transaction
        .update(installationState)
        .set({ ownerUserId: null, bootstrapClosedAt: null, updatedAt: completedAt })
        .where(eq(installationState.singleton, 1))

      // Product modules first, in referential order. Identity is deliberately last.
      await transaction.delete(trainingCommandReceipts)
      await transaction.delete(programRevisionLineage)
      await transaction.delete(workoutSessions)
      await transaction.delete(programs)
      await transaction.delete(adjustmentDecisions)
      await transaction.delete(performedSets)
      await transaction.delete(sessionExercises)
      await transaction.delete(sessionFeedback)
      await transaction.delete(setPrescriptions)
      await transaction.delete(exercisePrescriptions)
      await transaction.delete(plannedWorkouts)
      await transaction.delete(programRevisions)
      await transaction.delete(safetyHolds)
      await transaction.delete(strengthBaselines)
      await transaction.delete(athleteEquipment)
      await transaction.delete(athleteTrainingDays)
      await transaction.delete(athleteProfiles)
      await transaction.delete(auditEvents)
      await transaction.delete(deletionPlans)

      await transaction.delete(verification)
      await transaction.delete(session)
      await transaction.delete(account)
      await transaction.delete(user)

      await transaction.insert(deletionTombstones).values({
        id: tombstoneId,
        actorClass: 'owner',
        scope: 'instance-reset',
        schemaVersion: exportSchemaVersion,
        rowCounts: currentCounts,
        completionDigest,
        createdAt: completedAt,
      })
    },
    { isolationLevel: 'serializable' },
  )
}
