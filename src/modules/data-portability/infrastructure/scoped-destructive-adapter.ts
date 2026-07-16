import { and, eq, gt, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  type CanonicalValue,
  canonicalSha256,
} from '@/modules/methodology/domain/canonical'
import {
  account,
  adjustmentDecisionInvalidations,
  adjustmentDecisions,
  athleteEquipment,
  athleteProfiles,
  athleteTrainingDays,
  auditEvents,
  contentReleaseRevocations,
  deletionPlans,
  deletionTombstones,
  destructiveReauthenticationStates,
  exercisePrescriptions,
  futureLoadExplanationCache,
  installationState,
  memberResetStates,
  performedSetCorrections,
  performedSets,
  plannedWorkouts,
  programRevisionInvalidations,
  programRevisionLineage,
  programRevisions,
  programs,
  safetyHoldResolutions,
  safetyHolds,
  session,
  sessionExercises,
  sessionFeedback,
  sessionFeedbackCorrections,
  setPrescriptions,
  strengthBaselines,
  trainingCommandReceipts,
  trainingFactCorrections,
  user,
  verification,
  webRecoveryRateLimitBuckets,
  workoutSessions,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  countInstanceRows,
  countSubjectRows,
  DeletionError,
  digestInstanceResetPlan,
  digestSubjectDeletionPlan,
} from '../application/deletion'
import { exportSchemaVersion } from '../application/export'

const maximumBindingBytes = 512

export interface ScopedDeletionAttemptGateway {
  invalidatePreviewAfterDenial(): Promise<void>
}

export interface ScopedSubjectDeletionGateway {
  execute(): Promise<void>
}

export interface ScopedInstanceResetGateway {
  execute(): Promise<void>
}

export class ScopedDestructiveAdapterInvariantError extends Error {
  constructor() {
    super('The scoped destructive Data Portability operation is no longer coherent.')
    this.name = 'ScopedDestructiveAdapterInvariantError'
  }
}

type SubjectDeletionBinding = Readonly<{
  actorUserId: string
  actorEmail: string
  actorRole: 'owner' | 'member'
  planId: string
  planDigest: string
}>

type InstanceResetBinding = Readonly<{
  actorUserId: string
  planId: string
  planDigest: string
}>

function invariant(): never {
  throw new ScopedDestructiveAdapterInvariantError()
}

function boundedText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumBindingBytes
  ) {
    return invariant()
  }
  return value
}

function exactBinding(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invariant()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  const expected = new Set<PropertyKey>(expectedKeys)
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    return invariant()
  }
  const captured: Record<string, unknown> = {}
  for (const key of expectedKeys) {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      return invariant()
    }
    captured[key] = descriptor.value
  }
  return Object.freeze(captured)
}

function captureSubjectBinding(value: SubjectDeletionBinding): SubjectDeletionBinding {
  const binding = exactBinding(value, [
    'actorUserId',
    'actorEmail',
    'actorRole',
    'planId',
    'planDigest',
  ])
  const actorRole = binding.actorRole
  if (actorRole !== 'owner' && actorRole !== 'member') return invariant()
  return Object.freeze({
    actorUserId: boundedText(binding.actorUserId),
    actorEmail: boundedText(binding.actorEmail),
    actorRole,
    planId: boundedText(binding.planId),
    planDigest: boundedText(binding.planDigest),
  })
}

function captureInstanceBinding(value: InstanceResetBinding): InstanceResetBinding {
  const binding = exactBinding(value, ['actorUserId', 'planId', 'planDigest'])
  return Object.freeze({
    actorUserId: boundedText(binding.actorUserId),
    planId: boundedText(binding.planId),
    planDigest: boundedText(binding.planDigest),
  })
}

function captureActorUserId(value: { readonly actorUserId: string }): string {
  const binding = exactBinding(value, ['actorUserId'])
  return boundedText(binding.actorUserId)
}

function captureWriteAuthorizer(value: unknown): () => void {
  if (typeof value !== 'function') return invariant()
  return value as () => void
}

function oneUse<Result>(operation: () => Promise<Result>): () => Promise<Result> {
  let claimed = false
  return async () => {
    if (claimed) return invariant()
    claimed = true
    return operation()
  }
}

function completionDigest(input: {
  readonly tombstoneId: string
  readonly scope: 'trainee-data' | 'instance-reset'
  readonly completedAt: Date
  readonly counts: Readonly<Record<string, number>>
}): string {
  return canonicalSha256({
    eventId: input.tombstoneId,
    scope: input.scope,
    schemaVersion: exportSchemaVersion,
    completedAt: input.completedAt.toISOString(),
    counts: input.counts,
  } as unknown as CanonicalValue)
}

async function invalidatePreviewAfterDenial<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  actorUserId: string,
  scope: 'trainee-data' | 'instance-reset',
  requireWriteAuthorized: () => void,
): Promise<void> {
  requireWriteAuthorized()
  await database
    .delete(deletionPlans)
    .where(and(eq(deletionPlans.userId, actorUserId), eq(deletionPlans.scope, scope)))
}

async function executeSubjectDeletion<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  binding: SubjectDeletionBinding,
  requireWriteAuthorized: () => void,
): Promise<void> {
  const [plan] = await database
    .select({
      id: deletionPlans.id,
      consumedAt: deletionPlans.consumedAt,
      planDigest: deletionPlans.planDigest,
      expiresAt: deletionPlans.expiresAt,
    })
    .from(deletionPlans)
    .where(
      and(
        eq(deletionPlans.id, binding.planId),
        eq(deletionPlans.userId, binding.actorUserId),
        eq(deletionPlans.scope, 'trainee-data'),
        gt(deletionPlans.expiresAt, sql`CURRENT_TIMESTAMP`),
      ),
    )
    .for('update')
    .limit(1)
  if (!plan || plan.consumedAt || plan.planDigest !== binding.planDigest) {
    throw new DeletionError(
      'deletion.plan-invalid',
      'The deletion preview expired or no longer matches.',
    )
  }

  const currentCounts = await countSubjectRows(
    database,
    binding.actorUserId,
    binding.actorEmail,
    binding.actorRole === 'owner',
  )
  const currentDigest = digestSubjectDeletionPlan({
    planId: plan.id,
    actorUserId: binding.actorUserId,
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
  const tombstoneId = newUuidV7(completedAt.getTime())

  const digest = completionDigest({
    tombstoneId,
    scope: 'trainee-data',
    completedAt,
    counts: currentCounts,
  })

  requireWriteAuthorized()
  await database.execute(sql`
    DELETE FROM adjustment_decision_invalidation
    WHERE correction_id IN (
      SELECT id FROM training_fact_correction
      WHERE user_id = ${binding.actorUserId}
    )
  `)
  await database.execute(sql`
    DELETE FROM program_revision_invalidation
    WHERE correction_id IN (
      SELECT id FROM training_fact_correction
      WHERE user_id = ${binding.actorUserId}
    )
  `)
  await database
    .delete(sessionFeedbackCorrections)
    .where(eq(sessionFeedbackCorrections.userId, binding.actorUserId))
  await database
    .delete(performedSetCorrections)
    .where(eq(performedSetCorrections.userId, binding.actorUserId))
  await database
    .delete(trainingFactCorrections)
    .where(eq(trainingFactCorrections.userId, binding.actorUserId))
  await database
    .delete(futureLoadExplanationCache)
    .where(eq(futureLoadExplanationCache.userId, binding.actorUserId))
  await database
    .delete(trainingCommandReceipts)
    .where(eq(trainingCommandReceipts.userId, binding.actorUserId))
  await database.execute(sql`
    DELETE FROM program_revision_lineage
    WHERE revision_id IN (
      SELECT pr.id
      FROM program_revision pr
      JOIN program p ON p.id = pr.program_id
      WHERE p.user_id = ${binding.actorUserId}
    )
  `)
  await database
    .delete(safetyHoldResolutions)
    .where(eq(safetyHoldResolutions.userId, binding.actorUserId))
  await database.delete(safetyHolds).where(eq(safetyHolds.userId, binding.actorUserId))
  await database
    .delete(workoutSessions)
    .where(eq(workoutSessions.userId, binding.actorUserId))
  await database.delete(programs).where(eq(programs.userId, binding.actorUserId))
  await database
    .delete(strengthBaselines)
    .where(eq(strengthBaselines.userId, binding.actorUserId))
  await database
    .delete(athleteEquipment)
    .where(eq(athleteEquipment.userId, binding.actorUserId))
  await database
    .delete(athleteTrainingDays)
    .where(eq(athleteTrainingDays.userId, binding.actorUserId))
  await database
    .delete(athleteProfiles)
    .where(eq(athleteProfiles.userId, binding.actorUserId))
  await database
    .delete(auditEvents)
    .where(eq(auditEvents.subjectUserId, binding.actorUserId))
  await database
    .delete(memberResetStates)
    .where(eq(memberResetStates.targetUserId, binding.actorUserId))

  if (binding.actorRole === 'owner') {
    // Subject deletion preserves the owner's Identity credential and sessions so
    // the same local administrator can rebuild their training profile.
    await database
      .delete(deletionPlans)
      .where(eq(deletionPlans.userId, binding.actorUserId))
  } else {
    const recoveryIdentifier = `indigo:owner-recovery:${binding.actorUserId}`
    const memberResetIdentifier = `indigo:member-reset:${binding.actorUserId}`
    await database.delete(verification).where(
      sql`${verification.identifier} = ${binding.actorEmail}
        OR ${verification.identifier} = ${recoveryIdentifier}
        OR ${verification.identifier} = ${memberResetIdentifier}`,
    )
    await database.delete(session).where(eq(session.userId, binding.actorUserId))
    await database.delete(account).where(eq(account.userId, binding.actorUserId))
    await database.delete(user).where(eq(user.id, binding.actorUserId))
  }

  await database.insert(deletionTombstones).values({
    id: tombstoneId,
    actorClass: binding.actorRole === 'owner' ? 'owner' : 'trainee',
    scope: 'trainee-data',
    schemaVersion: exportSchemaVersion,
    rowCounts: currentCounts,
    completionDigest: digest,
    createdAt: completedAt,
  })
}

async function executeInstanceReset<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  binding: InstanceResetBinding,
  requireWriteAuthorized: () => void,
): Promise<void> {
  const [plan] = await database
    .select({
      id: deletionPlans.id,
      consumedAt: deletionPlans.consumedAt,
      planDigest: deletionPlans.planDigest,
      expiresAt: deletionPlans.expiresAt,
    })
    .from(deletionPlans)
    .where(
      and(
        eq(deletionPlans.id, binding.planId),
        eq(deletionPlans.userId, binding.actorUserId),
        eq(deletionPlans.scope, 'instance-reset'),
        gt(deletionPlans.expiresAt, sql`CURRENT_TIMESTAMP`),
      ),
    )
    .for('update')
    .limit(1)
  if (!plan || plan.consumedAt || plan.planDigest !== binding.planDigest) {
    throw new DeletionError(
      'deletion.plan-invalid',
      'The reset preview expired or no longer matches.',
    )
  }

  const currentCounts = await countInstanceRows(database, binding.actorUserId)
  const currentDigest = digestInstanceResetPlan({
    planId: plan.id,
    actorUserId: binding.actorUserId,
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
  const tombstoneId = newUuidV7(completedAt.getTime())

  const digest = completionDigest({
    tombstoneId,
    scope: 'instance-reset',
    completedAt,
    counts: currentCounts,
  })

  requireWriteAuthorized()
  const rotatedInstallation = await database
    .update(installationState)
    .set({
      ownerUserId: null,
      bootstrapClosedAt: null,
      productMutationEpoch: sql`gen_random_uuid()`,
      updatedAt: completedAt,
    })
    .where(eq(installationState.singleton, 1))
    .returning({ singleton: installationState.singleton })
  if (rotatedInstallation.length !== 1) {
    throw new DeletionError(
      'deletion.installation-state-invalid',
      'The installation state could not be rotated exactly once.',
    )
  }

  // Product modules first, in referential order. Identity is deliberately last.
  await database.delete(adjustmentDecisionInvalidations)
  await database.delete(programRevisionInvalidations)
  await database.delete(sessionFeedbackCorrections)
  await database.delete(performedSetCorrections)
  await database.delete(trainingFactCorrections)
  await database.delete(futureLoadExplanationCache)
  await database.delete(trainingCommandReceipts)
  await database.delete(programRevisionLineage)
  await database.delete(safetyHoldResolutions)
  await database.delete(safetyHolds)
  await database.delete(workoutSessions)
  await database.delete(programs)
  await database.delete(adjustmentDecisions)
  await database.delete(performedSets)
  await database.delete(sessionExercises)
  await database.delete(sessionFeedback)
  await database.delete(setPrescriptions)
  await database.delete(exercisePrescriptions)
  await database.delete(plannedWorkouts)
  await database.delete(programRevisions)
  await database.delete(strengthBaselines)
  await database.delete(athleteEquipment)
  await database.delete(athleteTrainingDays)
  await database.delete(athleteProfiles)
  await database.delete(contentReleaseRevocations)
  await database.delete(auditEvents)
  await database.delete(deletionPlans)

  await database.delete(destructiveReauthenticationStates)
  await database.delete(memberResetStates)
  await database.delete(webRecoveryRateLimitBuckets)
  await database.delete(verification)
  await database.delete(session)
  await database.delete(account)
  await database.delete(user)

  await database.insert(deletionTombstones).values({
    id: tombstoneId,
    actorClass: 'owner',
    scope: 'instance-reset',
    schemaVersion: exportSchemaVersion,
    rowCounts: currentCounts,
    completionDigest: digest,
    createdAt: completedAt,
  })
}

export function createScopedSubjectDeletionAttemptGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  binding: { readonly actorUserId: string },
  requireWriteAuthorized: () => void,
): ScopedDeletionAttemptGateway {
  const actorUserId = captureActorUserId(binding)
  const authorize = captureWriteAuthorizer(requireWriteAuthorized)
  const invoke = oneUse(() =>
    invalidatePreviewAfterDenial(database, actorUserId, 'trainee-data', authorize),
  )
  return Object.freeze({ invalidatePreviewAfterDenial: invoke })
}

export function createScopedInstanceResetAttemptGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  binding: { readonly actorUserId: string },
  requireWriteAuthorized: () => void,
): ScopedDeletionAttemptGateway {
  const actorUserId = captureActorUserId(binding)
  const authorize = captureWriteAuthorizer(requireWriteAuthorized)
  const invoke = oneUse(() =>
    invalidatePreviewAfterDenial(database, actorUserId, 'instance-reset', authorize),
  )
  return Object.freeze({ invalidatePreviewAfterDenial: invoke })
}

export function createScopedSubjectDeletionGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  binding: SubjectDeletionBinding,
  requireWriteAuthorized: () => void,
): ScopedSubjectDeletionGateway {
  const captured = captureSubjectBinding(binding)
  const authorize = captureWriteAuthorizer(requireWriteAuthorized)
  const invoke = oneUse(() => executeSubjectDeletion(database, captured, authorize))
  return Object.freeze({ execute: invoke })
}

export function createScopedInstanceResetGateway<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  binding: InstanceResetBinding,
  requireWriteAuthorized: () => void,
): ScopedInstanceResetGateway {
  const captured = captureInstanceBinding(binding)
  const authorize = captureWriteAuthorizer(requireWriteAuthorized)
  const invoke = oneUse(() => executeInstanceReset(database, captured, authorize))
  return Object.freeze({ execute: invoke })
}
