import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { QueryArrayResult, QueryResult, QueryResultRow } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  digestInstanceResetPlan,
  digestSubjectDeletionPlan,
  type InstanceResetCounts,
  type SubjectDeletionCounts,
} from '@/modules/data-portability/application/deletion'
import { exportSchemaVersion } from '@/modules/data-portability/application/export'
import { canonicalSha256 } from '@/modules/methodology/domain/canonical'
import type { ScopedTransactionClient } from '@/platform/application-coordination/postgres-unit-of-work'
import { createScopedDrizzleDatabase } from '@/platform/application-coordination/scoped-drizzle'
import {
  createScopedInstanceResetAttemptGateway,
  createScopedInstanceResetGateway,
  createScopedSubjectDeletionAttemptGateway,
  createScopedSubjectDeletionGateway,
  ScopedDestructiveAdapterInvariantError,
} from './scoped-destructive-adapter'

function objectResult<Row extends QueryResultRow>(
  rows: readonly Row[] = [],
  command = 'DELETE',
): QueryResult<Row> {
  return { command, fields: [], oid: 0, rowCount: rows.length, rows: [...rows] }
}

function arrayResult<Row extends unknown[]>(
  rows: readonly Row[] = [],
): QueryArrayResult<Row> {
  return { command: 'SELECT', fields: [], oid: 0, rowCount: rows.length, rows: [...rows] }
}

function databaseHarness() {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) =>
    objectResult(),
  )
  const queryArray = vi.fn(async (_sql: string, _values?: readonly unknown[]) =>
    arrayResult(),
  )
  const client = { query, queryArray } as unknown as ScopedTransactionClient
  return { database: createScopedDrizzleDatabase(client), query, queryArray }
}

type RecordedQuery = Readonly<{
  sql: string
  values: readonly unknown[]
}>

function successfulDatabaseHarness(input: {
  readonly plan: unknown[]
  readonly counts: QueryResultRow
  readonly reset: boolean
}) {
  const queries: RecordedQuery[] = []
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values })
    if (/^\s*SELECT\s+[\s\S]*count\(\*\)/i.test(sql)) {
      return objectResult([input.counts], 'SELECT')
    }
    return objectResult()
  })
  const queryArray = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values })
    if (/\bfrom "deletion_plan"(?:\s|$)/i.test(sql)) {
      return arrayResult([input.plan])
    }
    if (input.reset && /^\s*update "installation_state"(?:\s|$)/i.test(sql)) {
      return arrayResult([[1]])
    }
    return arrayResult()
  })
  const client = { query, queryArray } as unknown as ScopedTransactionClient
  return {
    database: createScopedDrizzleDatabase(client),
    queries,
  }
}

function mutation(sql: string): string | null {
  const match = sql.match(
    /\b(insert\s+into|update|delete\s+from)\s+"?([a-z_][a-z0-9_]*)"?/i,
  )
  if (!match?.[1] || !match[2]) return null
  const verb = match[1].toLowerCase().split(/\s+/)[0]
  return `${verb}:${match[2].toLowerCase()}`
}

function mutations(queries: readonly RecordedQuery[]): string[] {
  return queries.flatMap(({ sql }) => {
    const operation = mutation(sql)
    return operation ? [operation] : []
  })
}

function zeroSubjectCounts(): SubjectDeletionCounts {
  return {
    users: 1,
    authSessions: 1,
    authAccounts: 1,
    authVerifications: 1,
    memberResetStates: 1,
    athleteProfiles: 1,
    athleteTrainingDays: 0,
    athleteEquipment: 0,
    strengthBaselines: 0,
    safetyHolds: 0,
    safetyHoldResolutions: 0,
    programs: 0,
    programRevisions: 0,
    programRevisionLineage: 0,
    plannedWorkouts: 0,
    exercisePrescriptions: 0,
    setPrescriptions: 0,
    workoutSessions: 0,
    sessionExercises: 0,
    performedSets: 0,
    trainingCommandReceipts: 0,
    sessionFeedback: 0,
    adjustmentDecisions: 0,
    trainingFactCorrections: 0,
    sessionFeedbackCorrections: 0,
    performedSetCorrections: 0,
    adjustmentDecisionInvalidations: 0,
    programRevisionInvalidations: 0,
    futureLoadExplanationCache: 0,
    auditEventsDeleted: 0,
    auditActorReferencesRedacted: 0,
    deletionPlans: 1,
  }
}

function zeroResetCounts(): InstanceResetCounts {
  return {
    installationStates: 1,
    users: 1,
    authSessions: 1,
    authAccounts: 1,
    authVerifications: 1,
    destructiveReauthenticationStates: 0,
    memberResetStates: 0,
    webRecoveryRateLimitBuckets: 0,
    athleteProfiles: 0,
    athleteTrainingDays: 0,
    athleteEquipment: 0,
    strengthBaselines: 0,
    safetyHolds: 0,
    safetyHoldResolutions: 0,
    programs: 0,
    programRevisions: 0,
    programRevisionLineage: 0,
    plannedWorkouts: 0,
    exercisePrescriptions: 0,
    setPrescriptions: 0,
    workoutSessions: 0,
    sessionExercises: 0,
    performedSets: 0,
    trainingCommandReceipts: 0,
    sessionFeedback: 0,
    adjustmentDecisions: 0,
    trainingFactCorrections: 0,
    sessionFeedbackCorrections: 0,
    performedSetCorrections: 0,
    adjustmentDecisionInvalidations: 0,
    programRevisionInvalidations: 0,
    contentReleaseRevocations: 0,
    futureLoadExplanationCache: 0,
    auditEvents: 0,
    deletionPlans: 1,
  }
}

function planRow(input: {
  readonly id: string
  readonly digest: string
  readonly expiresAt: Date
}): unknown[] {
  return [input.id, null, input.digest, input.expiresAt]
}

const completedAt = new Date('2026-07-16T12:00:00.000Z')

function subjectBinding() {
  return {
    actorUserId: 'actor-user-id',
    actorEmail: 'actor@example.test',
    actorRole: 'member' as const,
    planId: 'subject-plan-id',
    planDigest: 'subject-plan-digest',
  }
}

function resetBinding() {
  return {
    actorUserId: 'owner-user-id',
    planId: 'reset-plan-id',
    planDigest: 'reset-plan-digest',
  }
}

describe('scoped destructive Data Portability adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(completedAt)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('binds denial invalidation to one exact purpose and permits one use', async () => {
    const subject = databaseHarness()
    const authorizeSubject = vi.fn()
    const subjectGateway = createScopedSubjectDeletionAttemptGateway(
      subject.database,
      { actorUserId: 'subject-id' },
      authorizeSubject,
    )

    await subjectGateway.invalidatePreviewAfterDenial()
    await expect(subjectGateway.invalidatePreviewAfterDenial()).rejects.toBeInstanceOf(
      ScopedDestructiveAdapterInvariantError,
    )
    expect(authorizeSubject).toHaveBeenCalledTimes(1)
    expect(subject.query).toHaveBeenCalledTimes(1)
    expect(subject.query).toHaveBeenCalledWith(
      expect.stringContaining('delete from "deletion_plan"'),
      ['subject-id', 'trainee-data'],
    )

    const reset = databaseHarness()
    const resetGateway = createScopedInstanceResetAttemptGateway(
      reset.database,
      { actorUserId: 'owner-id' },
      vi.fn(),
    )
    await resetGateway.invalidatePreviewAfterDenial()
    expect(reset.query).toHaveBeenCalledWith(
      expect.stringContaining('delete from "deletion_plan"'),
      ['owner-id', 'instance-reset'],
    )
  })

  it('requires write authority immediately before denial-invalidation DML', async () => {
    const harness = databaseHarness()
    const denied = new Error('write authority denied')
    const gateway = createScopedSubjectDeletionAttemptGateway(
      harness.database,
      { actorUserId: 'subject-id' },
      () => {
        throw denied
      },
    )

    await expect(gateway.invalidatePreviewAfterDenial()).rejects.toBe(denied)
    expect(harness.query).not.toHaveBeenCalled()
  })

  it('rejects extra-scope, accessor, role, and completion input before any query', () => {
    const harness = databaseHarness()
    const authorize = vi.fn()
    expect(() =>
      createScopedSubjectDeletionAttemptGateway(
        harness.database,
        { actorUserId: 'subject-id', purpose: 'instance-reset' } as never,
        authorize,
      ),
    ).toThrow(ScopedDestructiveAdapterInvariantError)

    const accessor = Object.defineProperty({}, 'actorUserId', {
      enumerable: true,
      configurable: true,
      get: () => 'subject-id',
    })
    expect(() =>
      createScopedSubjectDeletionAttemptGateway(
        harness.database,
        accessor as never,
        authorize,
      ),
    ).toThrow(ScopedDestructiveAdapterInvariantError)
    expect(() =>
      createScopedSubjectDeletionGateway(
        harness.database,
        { ...subjectBinding(), actorRole: 'owner-ish' } as never,
        authorize,
      ),
    ).toThrow(ScopedDestructiveAdapterInvariantError)
    expect(() =>
      createScopedInstanceResetGateway(
        harness.database,
        { ...resetBinding(), completedAt: new Date(Number.NaN) } as never,
        authorize,
      ),
    ).toThrow(ScopedDestructiveAdapterInvariantError)
    expect(harness.query).not.toHaveBeenCalled()
    expect(harness.queryArray).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
  })

  it('rejects a missing or mismatched subject plan without write authority', async () => {
    const missing = databaseHarness()
    const missingAuthorize = vi.fn()
    const missingGateway = createScopedSubjectDeletionGateway(
      missing.database,
      subjectBinding(),
      missingAuthorize,
    )
    await expect(missingGateway.execute()).rejects.toMatchObject({
      code: 'deletion.plan-invalid',
    })
    await expect(missingGateway.execute()).rejects.toBeInstanceOf(
      ScopedDestructiveAdapterInvariantError,
    )
    expect(missingAuthorize).not.toHaveBeenCalled()
    expect(missing.query).not.toHaveBeenCalled()
    expect(missing.queryArray).toHaveBeenCalledTimes(1)

    const mismatch = databaseHarness()
    mismatch.queryArray.mockResolvedValueOnce(
      arrayResult([
        [
          'subject-plan-id',
          null,
          'different-digest',
          new Date('2026-07-17T12:00:00.000Z'),
        ],
      ]),
    )
    const mismatchAuthorize = vi.fn()
    await expect(
      createScopedSubjectDeletionGateway(
        mismatch.database,
        subjectBinding(),
        mismatchAuthorize,
      ).execute(),
    ).rejects.toMatchObject({ code: 'deletion.plan-invalid' })
    expect(mismatchAuthorize).not.toHaveBeenCalled()
    expect(mismatch.query).not.toHaveBeenCalled()
  })

  it('rejects a changed reset recount before write authority or mutation', async () => {
    const harness = databaseHarness()
    harness.queryArray.mockResolvedValueOnce(
      arrayResult([
        [
          'reset-plan-id',
          null,
          'reset-plan-digest',
          new Date('2026-07-17T12:00:00.000Z'),
        ],
      ]),
    )
    harness.query.mockResolvedValueOnce(
      objectResult(
        [
          {
            installationStates: 1,
            users: 1,
            authSessions: 1,
            authAccounts: 1,
            authVerifications: 1,
            destructiveReauthenticationStates: 0,
            memberResetStates: 0,
            webRecoveryRateLimitBuckets: 0,
            athleteProfiles: 0,
            athleteTrainingDays: 0,
            athleteEquipment: 0,
            strengthBaselines: 0,
            safetyHolds: 0,
            safetyHoldResolutions: 0,
            programs: 0,
            programRevisions: 0,
            programRevisionLineage: 0,
            plannedWorkouts: 0,
            exercisePrescriptions: 0,
            setPrescriptions: 0,
            workoutSessions: 0,
            sessionExercises: 0,
            performedSets: 0,
            trainingCommandReceipts: 0,
            sessionFeedback: 0,
            adjustmentDecisions: 0,
            trainingFactCorrections: 0,
            sessionFeedbackCorrections: 0,
            performedSetCorrections: 0,
            adjustmentDecisionInvalidations: 0,
            programRevisionInvalidations: 0,
            contentReleaseRevocations: 0,
            futureLoadExplanationCache: 0,
            auditEvents: 0,
            deletionPlans: 1,
          },
        ],
        'SELECT',
      ),
    )
    const authorize = vi.fn()
    await expect(
      createScopedInstanceResetGateway(
        harness.database,
        resetBinding(),
        authorize,
      ).execute(),
    ).rejects.toMatchObject({ code: 'deletion.plan-changed' })
    expect(authorize).not.toHaveBeenCalled()
    expect(harness.query).toHaveBeenCalledTimes(1)
  })

  it('records completion inside protected execution after admission and recount', async () => {
    const counts = zeroSubjectCounts()
    const expiresAt = new Date(completedAt.getTime() + 60_000)
    const digest = digestSubjectDeletionPlan({
      planId: 'subject-plan-id',
      actorUserId: 'actor-user-id',
      scope: 'trainee-data',
      schemaVersion: exportSchemaVersion,
      counts,
      expiresAt: expiresAt.toISOString(),
    })
    const harness = successfulDatabaseHarness({
      plan: planRow({
        id: 'subject-plan-id',
        digest,
        expiresAt,
      }),
      counts,
      reset: false,
    })
    const gateway = createScopedSubjectDeletionGateway(
      harness.database,
      { ...subjectBinding(), planDigest: digest },
      vi.fn(),
    )
    const protectedExecutionAt = new Date(completedAt.getTime() + 30_000)

    vi.setSystemTime(protectedExecutionAt)
    await gateway.execute()

    const tombstone = harness.queries.find(
      ({ sql }) => mutation(sql) === 'insert:deletion_tombstone',
    )
    expect(tombstone?.values.at(-1)).toBe(protectedExecutionAt.toISOString())
  })

  it('preserves exact member/owner subject-deletion order and canonical tombstones', async () => {
    const expiresAt = new Date(Date.now() + 60_000)
    const baseCounts = zeroSubjectCounts()
    const commonMutations = [
      'delete:adjustment_decision_invalidation',
      'delete:program_revision_invalidation',
      'delete:session_feedback_correction',
      'delete:performed_set_correction',
      'delete:training_fact_correction',
      'delete:future_load_explanation_cache',
      'delete:training_command_receipt',
      'delete:program_revision_lineage',
      'delete:safety_hold_resolution',
      'delete:safety_hold',
      'delete:workout_session',
      'delete:program',
      'delete:strength_baseline',
      'delete:athlete_equipment',
      'delete:athlete_training_day',
      'delete:athlete_profile',
      'delete:audit_event',
      'delete:member_reset_state',
    ]

    for (const role of ['member', 'owner'] as const) {
      const counts =
        role === 'member'
          ? baseCounts
          : {
              ...baseCounts,
              users: 0,
              authSessions: 0,
              authAccounts: 0,
              authVerifications: 0,
              auditActorReferencesRedacted: 0,
            }
      const digest = digestSubjectDeletionPlan({
        planId: 'subject-plan-id',
        actorUserId: 'actor-user-id',
        scope: 'trainee-data',
        schemaVersion: exportSchemaVersion,
        counts,
        expiresAt: expiresAt.toISOString(),
      })
      const harness = successfulDatabaseHarness({
        plan: planRow({
          id: 'subject-plan-id',
          digest,
          expiresAt,
        }),
        counts,
        reset: false,
      })
      let queriesAtAuthorization = -1
      await createScopedSubjectDeletionGateway(
        harness.database,
        { ...subjectBinding(), actorRole: role, planDigest: digest },
        () => {
          queriesAtAuthorization = harness.queries.length
        },
      ).execute()

      expect(queriesAtAuthorization).toBe(2)
      expect(mutations(harness.queries)).toEqual([
        ...commonMutations,
        ...(role === 'owner'
          ? ['delete:deletion_plan']
          : ['delete:verification', 'delete:session', 'delete:account', 'delete:user']),
        'insert:deletion_tombstone',
      ])
      const tombstone = harness.queries.find(
        ({ sql }) => mutation(sql) === 'insert:deletion_tombstone',
      )
      const tombstoneId = tombstone?.values[0]
      expect(tombstoneId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      const expectedCompletionDigest = canonicalSha256({
        eventId: tombstoneId,
        scope: 'trainee-data',
        schemaVersion: exportSchemaVersion,
        completedAt: completedAt.toISOString(),
        counts,
      } as never)
      expect(tombstone?.values).toEqual([
        tombstoneId,
        role === 'owner' ? 'owner' : 'trainee',
        'trainee-data',
        exportSchemaVersion,
        JSON.stringify(counts),
        expectedCompletionDigest,
        completedAt.toISOString(),
      ])
      expect(JSON.stringify(tombstone?.values)).not.toContain('actor-user-id')
      expect(JSON.stringify(tombstone?.values)).not.toContain('actor@example.test')
    }
  })

  it('rotates the epoch before the exact reset deletion order and canonical tombstone', async () => {
    const counts = zeroResetCounts()
    const expiresAt = new Date(Date.now() + 60_000)
    const digest = digestInstanceResetPlan({
      planId: 'reset-plan-id',
      actorUserId: 'owner-user-id',
      scope: 'instance-reset',
      schemaVersion: exportSchemaVersion,
      counts,
      expiresAt: expiresAt.toISOString(),
    })
    const harness = successfulDatabaseHarness({
      plan: planRow({
        id: 'reset-plan-id',
        digest,
        expiresAt,
      }),
      counts,
      reset: true,
    })
    let queriesAtAuthorization = -1
    await createScopedInstanceResetGateway(
      harness.database,
      { ...resetBinding(), planDigest: digest },
      () => {
        queriesAtAuthorization = harness.queries.length
      },
    ).execute()

    expect(queriesAtAuthorization).toBe(2)
    expect(mutations(harness.queries)).toEqual([
      'update:installation_state',
      'delete:adjustment_decision_invalidation',
      'delete:program_revision_invalidation',
      'delete:session_feedback_correction',
      'delete:performed_set_correction',
      'delete:training_fact_correction',
      'delete:future_load_explanation_cache',
      'delete:training_command_receipt',
      'delete:program_revision_lineage',
      'delete:safety_hold_resolution',
      'delete:safety_hold',
      'delete:workout_session',
      'delete:program',
      'delete:adjustment_decision',
      'delete:performed_set',
      'delete:session_exercise',
      'delete:session_feedback',
      'delete:set_prescription',
      'delete:exercise_prescription',
      'delete:planned_workout',
      'delete:program_revision',
      'delete:strength_baseline',
      'delete:athlete_equipment',
      'delete:athlete_training_day',
      'delete:athlete_profile',
      'delete:content_release_revocation',
      'delete:audit_event',
      'delete:deletion_plan',
      'delete:destructive_reauthentication_state',
      'delete:member_reset_state',
      'delete:web_recovery_rate_limit_bucket',
      'delete:verification',
      'delete:session',
      'delete:account',
      'delete:user',
      'insert:deletion_tombstone',
    ])
    const rotation = harness.queries.find(
      ({ sql }) => mutation(sql) === 'update:installation_state',
    )
    expect(rotation?.sql).toContain('"product_mutation_epoch" = gen_random_uuid()')
    expect(rotation?.values).toEqual([null, null, completedAt.toISOString(), 1])

    const tombstone = harness.queries.find(
      ({ sql }) => mutation(sql) === 'insert:deletion_tombstone',
    )
    const tombstoneId = tombstone?.values[0]
    expect(tombstoneId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const expectedCompletionDigest = canonicalSha256({
      eventId: tombstoneId,
      scope: 'instance-reset',
      schemaVersion: exportSchemaVersion,
      completedAt: completedAt.toISOString(),
      counts,
    } as never)
    expect(tombstone?.values).toEqual([
      tombstoneId,
      'owner',
      'instance-reset',
      exportSchemaVersion,
      JSON.stringify(counts),
      expectedCompletionDigest,
      completedAt.toISOString(),
    ])
    expect(JSON.stringify(tombstone?.values)).not.toContain('owner-user-id')
  })

  it('types the database dependency as scoped Drizzle rather than a client escape', () => {
    const compileTimeOnly = (database: NodePgDatabase, authorize: () => void): void => {
      const gateway = createScopedInstanceResetGateway(
        database,
        resetBinding(),
        authorize,
      )
      // @ts-expect-error The public gateway deliberately has no database/client escape.
      void gateway.database
      // @ts-expect-error The public gateway deliberately has no raw query escape.
      void gateway.query
    }
    void compileTimeOnly
  })
})
