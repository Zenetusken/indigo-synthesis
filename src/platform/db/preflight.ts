import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from './client'

export type DatabasePreflight = {
  readonly databaseVersion: string
  readonly databaseVersionNumber: number
  readonly migrationLedgerPresent: boolean
  readonly migrationLedgerCanonical: boolean
  readonly appliedMigrationCount: number
  readonly committedMigrationCount: number
  readonly appliedCommittedMigrationCount: number
  readonly latestCommittedMigrationApplied: boolean
  readonly bootstrapTriggerPresent: boolean
  readonly workoutSnapshotColumnsPresent: boolean
  readonly safetyHoldIntegrityPresent: boolean
  readonly trainingCorrectionIntegrityPresent: boolean
  readonly contentRevocationIntegrityPresent: boolean
  readonly llmCacheContractPresent: boolean
  readonly integrityTriggerCount: number
  readonly ineligibleContentRevisionCount: number
}

export const expectedMigrationCount = 15
const canonicalProgramOrdinalMigration = {
  createdAt: 1_783_823_225_722,
  hash: 'e5d7105d56a02ba8874fef8f2a724981363e74f809b22d909a0e7cec75564ba0',
} as const
const requiredIntegrityTriggers = [
  {
    name: 'program_aggregate_guard',
    table: 'program',
    function: 'indigo_guard_program_aggregate',
  },
  {
    name: 'workout_session_owner_guard',
    table: 'workout_session',
    function: 'indigo_assert_workout_owner',
  },
  {
    name: 'workout_session_terminal_guard',
    table: 'workout_session',
    function: 'indigo_guard_terminal_session',
  },
  {
    name: 'session_exercise_terminal_guard',
    table: 'session_exercise',
    function: 'indigo_guard_terminal_session_child',
  },
  {
    name: 'performed_set_terminal_guard',
    table: 'performed_set',
    function: 'indigo_guard_terminal_session_child',
  },
  {
    name: 'adjustment_decision_terminal_guard',
    table: 'adjustment_decision',
    function: 'indigo_guard_terminal_session_child',
  },
  {
    name: 'program_revision_immutability_guard',
    table: 'program_revision',
    function: 'indigo_guard_program_revision',
  },
  {
    name: 'planned_workout_immutability_guard',
    table: 'planned_workout',
    function: 'indigo_guard_prescription_child',
  },
  {
    name: 'exercise_prescription_immutability_guard',
    table: 'exercise_prescription',
    function: 'indigo_guard_prescription_child',
  },
  {
    name: 'set_prescription_immutability_guard',
    table: 'set_prescription',
    function: 'indigo_guard_prescription_child',
  },
  {
    name: 'audit_event_immutability_guard',
    table: 'audit_event',
    function: 'indigo_guard_audit_event',
  },
  {
    name: 'session_feedback_terminal_guard',
    table: 'session_feedback',
    function: 'indigo_guard_terminal_session_feedback',
  },
  {
    name: 'program_revision_lineage_immutability_guard',
    table: 'program_revision_lineage',
    function: 'indigo_guard_append_only_training_fact',
  },
  {
    name: 'program_revision_lineage_provenance_guard',
    table: 'program_revision_lineage',
    function: 'indigo_guard_program_revision_lineage_insert',
  },
  {
    name: 'training_command_receipt_immutability_guard',
    table: 'training_command_receipt',
    function: 'indigo_guard_append_only_training_fact',
  },
  {
    name: 'safety_hold_provenance_guard',
    table: 'safety_hold',
    function: 'indigo_guard_safety_hold_provenance',
  },
  {
    name: 'safety_hold_resolution_append_only_guard',
    table: 'safety_hold_resolution',
    function: 'indigo_guard_safety_hold_resolution',
  },
  {
    name: 'training_fact_correction_provenance_guard',
    table: 'training_fact_correction',
    function: 'indigo_guard_training_fact_correction_insert',
  },
  {
    name: 'session_feedback_correction_provenance_guard',
    table: 'session_feedback_correction',
    function: 'indigo_guard_training_fact_specialization_insert',
  },
  {
    name: 'performed_set_correction_provenance_guard',
    table: 'performed_set_correction',
    function: 'indigo_guard_training_fact_specialization_insert',
  },
  {
    name: 'adjustment_decision_invalidation_provenance_guard',
    table: 'adjustment_decision_invalidation',
    function: 'indigo_guard_training_invalidation_insert',
  },
  {
    name: 'program_revision_invalidation_provenance_guard',
    table: 'program_revision_invalidation',
    function: 'indigo_guard_training_invalidation_insert',
  },
  {
    name: 'training_fact_correction_immutability_guard',
    table: 'training_fact_correction',
    function: 'indigo_guard_append_only_training_fact',
  },
  {
    name: 'session_feedback_correction_immutability_guard',
    table: 'session_feedback_correction',
    function: 'indigo_guard_append_only_training_fact',
  },
  {
    name: 'performed_set_correction_immutability_guard',
    table: 'performed_set_correction',
    function: 'indigo_guard_append_only_training_fact',
  },
  {
    name: 'adjustment_decision_invalidation_immutability_guard',
    table: 'adjustment_decision_invalidation',
    function: 'indigo_guard_append_only_training_fact',
  },
  {
    name: 'program_revision_invalidation_immutability_guard',
    table: 'program_revision_invalidation',
    function: 'indigo_guard_append_only_training_fact',
  },
  {
    name: 'content_release_revocation_append_only_guard',
    table: 'content_release_revocation',
    function: 'indigo_guard_content_release_revocation',
  },
] as const

export async function inspectDatabase(): Promise<DatabasePreflight> {
  const db = getDb()
  const committedMigrations = readMigrationFiles({ migrationsFolder: './drizzle' })
  const committedHashes = committedMigrations.map((migration) => migration.hash)
  const [
    versionResult,
    migrationResult,
    triggerResult,
    columnsResult,
    safetyHoldResult,
    trainingCorrectionResult,
    contentRevocationResult,
    llmCacheResult,
    integrityResult,
  ] = await Promise.all([
    db.execute<{ version: string; versionNumber: string }>(sql`
        SELECT version(), current_setting('server_version_num') AS "versionNumber"
      `),
    db.execute<{ present: boolean }>(sql`
      SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present
    `),
    db.execute<{ present: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_trigger AS trigger
        JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_proc AS trigger_function ON trigger_function.oid = trigger.tgfoid
        WHERE trigger.tgname = 'user_creation_policy'
          AND relation.relname = 'user'
          AND namespace.nspname = 'public'
          AND trigger_function.proname = 'enforce_indigo_user_creation_policy'
          AND pg_get_functiondef(trigger_function.oid) LIKE '%bootstrap-owner%'
          AND pg_get_functiondef(trigger_function.oid) LIKE '%owner-admin%'
          AND pg_get_functiondef(trigger_function.oid) LIKE '%explicit authorized mode%'
          AND NOT trigger.tgisinternal
          AND trigger.tgenabled = 'O'
      ) AS present
    `),
    db.execute<{ present: boolean }>(sql`
        SELECT
          count(*) FILTER (
            WHERE table_name = 'workout_session'
              AND column_name IN (
                'planned_workout_name',
                'scheduled_date',
                'slot_code',
                'snapshot_finalized_at'
              )
          ) = 4
          AND count(*) FILTER (
            WHERE table_name = 'adjustment_decision'
              AND column_name = 'applied_revision_id'
          ) = 1
          AND count(*) FILTER (
            WHERE table_name = 'planned_workout'
              AND column_name = 'program_ordinal'
          ) = 1
          AND count(*) FILTER (
            WHERE table_name = 'program_revision_lineage'
              AND column_name IN (
                'revision_id',
                'parent_revision_id',
                'source_session_id',
                'source_program_ordinal'
              )
          ) = 4
          AND count(*) FILTER (
            WHERE table_name = 'training_command_receipt'
              AND column_name IN (
                'command_id',
                'user_id',
                'command_type',
                'session_id',
                'target_id',
                'request_hash',
                'result_snapshot'
              )
          ) = 7
          AND count(*) FILTER (
            WHERE table_name = 'safety_hold'
              AND column_name = 'source_session_id'
          ) = 1
          AND count(*) FILTER (
            WHERE table_name = 'safety_hold_resolution'
              AND column_name IN ('hold_id', 'user_id', 'reason', 'acknowledged')
          ) = 4 AS present
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'workout_session',
            'adjustment_decision',
            'planned_workout',
            'program_revision_lineage',
            'training_command_receipt',
            'safety_hold',
            'safety_hold_resolution'
          )
      `),
    db.execute<{ present: boolean }>(sql`
      SELECT
        EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass('public.workout_session_id_user_uidx')
            AND indrelid = 'public.workout_session'::regclass
            AND indisunique AND indisvalid AND indisready
            AND indpred IS NULL
            AND (
              SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[]
              FROM unnest(indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = indrelid
               AND attribute.attnum = key.attnum
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY['id', 'user_id']
        )
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass('public.safety_hold_id_user_uidx')
            AND indrelid = 'public.safety_hold'::regclass
            AND indisunique AND indisvalid AND indisready
            AND indpred IS NULL
            AND (
              SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[]
              FROM unnest(indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = indrelid
               AND attribute.attnum = key.attnum
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY['id', 'user_id']
        )
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass('public.safety_hold_source_session_uidx')
            AND indrelid = 'public.safety_hold'::regclass
            AND indisunique AND indisvalid AND indisready
            AND indpred IS NOT NULL
            AND pg_get_expr(indpred, indrelid) = '(source_session_id IS NOT NULL)'
            AND (
              SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[]
              FROM unnest(indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = indrelid
               AND attribute.attnum = key.attnum
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY['source_session_id']
        )
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass('public.safety_hold_resolution_hold_id_uidx')
            AND indrelid = 'public.safety_hold_resolution'::regclass
            AND indisunique AND indisvalid AND indisready
            AND indpred IS NULL
            AND (
              SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[]
              FROM unnest(indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = indrelid
               AND attribute.attnum = key.attnum
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY['hold_id']
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.safety_hold'::regclass
            AND conname = 'safety_hold_source_session_user_fk'
            AND contype = 'f'
            AND convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.safety_hold_resolution'::regclass
            AND conname = 'safety_hold_resolution_hold_user_fk'
            AND contype = 'f'
            AND convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.safety_hold_resolution'::regclass
            AND conname = 'safety_hold_resolution_reason_check'
            AND contype = 'c'
            AND convalidated
            AND pg_get_constraintdef(oid) LIKE '%char_length%'
            AND pg_get_constraintdef(oid) LIKE '%[[:space:]]%'
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.safety_hold_resolution'::regclass
            AND conname = 'safety_hold_resolution_acknowledged_check'
            AND contype = 'c'
            AND convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.safety_hold'::regclass
            AND conname = 'safety_hold_clearance_shape_check'
            AND contype = 'c'
            AND convalidated
        )
        AND EXISTS (
          SELECT 1
          FROM pg_trigger AS trigger
          JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
          JOIN pg_namespace AS relation_namespace
            ON relation_namespace.oid = relation.relnamespace
          JOIN pg_proc AS trigger_function ON trigger_function.oid = trigger.tgfoid
          JOIN pg_namespace AS function_namespace
            ON function_namespace.oid = trigger_function.pronamespace
          WHERE trigger.tgname = 'safety_hold_provenance_guard'
            AND relation.relname = 'safety_hold'
            AND relation_namespace.nspname = 'public'
            AND trigger_function.proname = 'indigo_guard_safety_hold_provenance'
            AND function_namespace.nspname = 'public'
            AND NOT trigger.tgisinternal
            AND trigger.tgenabled = 'O'
            AND trigger.tgtype = 31
            AND pg_get_functiondef(trigger_function.oid)
              LIKE '%New safety holds cannot be inserted pre-cleared.%'
            AND pg_get_functiondef(trigger_function.oid)
              LIKE '%Only a source-less eligibility restriction hold may be cleared once.%'
        ) AS present
    `),
    db.execute<{ present: boolean }>(sql`
      SELECT
        to_regclass('public.training_fact_correction') IS NOT NULL
        AND to_regclass('public.session_feedback_correction') IS NOT NULL
        AND to_regclass('public.performed_set_correction') IS NOT NULL
        AND to_regclass('public.adjustment_decision_invalidation') IS NOT NULL
        AND to_regclass('public.program_revision_invalidation') IS NOT NULL
        AND (
          SELECT count(*)
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'training_fact_correction'
            AND column_name IN (
              'id', 'user_id', 'session_id', 'actor_user_id', 'command_id',
              'correction_kind', 'sequence', 'reason', 'created_at'
            )
        ) = 9
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.training_fact_correction'::regclass
            AND conname = 'training_fact_correction_session_user_fk'
            AND contype = 'f' AND convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.training_fact_correction'::regclass
            AND conname = 'training_fact_correction_reason_check'
            AND contype = 'c' AND convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass(
            'public.training_fact_correction_session_sequence_uidx'
          )
            AND indisunique AND indisvalid AND indisready
        ) AS present
    `),
    db.execute<{ present: boolean }>(sql`
      SELECT
        to_regclass('public.content_release_revocation') IS NOT NULL
        AND (
          SELECT count(*)
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'content_release_revocation'
            AND column_name IN (
              'id', 'content_kind', 'content_id', 'content_version',
              'reason', 'actor_user_id', 'created_at'
            )
        ) = 7
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass(
            'public.content_release_revocation_exact_uidx'
          )
            AND indrelid = to_regclass('public.content_release_revocation')
            AND indisunique AND indisvalid AND indisready
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.content_release_revocation')
            AND conname = 'content_release_revocation_kind_check'
            AND contype = 'c' AND convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.content_release_revocation')
            AND conname = 'content_release_revocation_reason_check'
            AND contype = 'c' AND convalidated
            AND pg_get_constraintdef(oid) LIKE '%char_length%'
            AND pg_get_constraintdef(oid) LIKE '%[[:space:]]%'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_trigger AS trigger
          JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
          JOIN pg_namespace AS relation_namespace
            ON relation_namespace.oid = relation.relnamespace
          JOIN pg_proc AS trigger_function ON trigger_function.oid = trigger.tgfoid
          JOIN pg_namespace AS function_namespace
            ON function_namespace.oid = trigger_function.pronamespace
          WHERE trigger.tgname = 'content_release_revocation_append_only_guard'
            AND relation.relname = 'content_release_revocation'
            AND relation_namespace.nspname = 'public'
            AND trigger_function.proname = 'indigo_guard_content_release_revocation'
            AND function_namespace.nspname = 'public'
            AND NOT trigger.tgisinternal
            AND trigger.tgenabled = 'O'
            AND trigger.tgtype = 27
            AND pg_get_functiondef(trigger_function.oid)
              LIKE '%Content release revocations are append-only.%'
        ) AS present
    `),
    db.execute<{ present: boolean }>(sql`
      SELECT
        (
          SELECT count(*) = 4
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'future_load_explanation_cache'
            AND column_name IN (
              'served_model_name',
              'runtime_id',
              'runtime_attestation_digest',
              'validator_version'
            )
        )
        AND to_regclass('public.future_load_explanation_cache_session_idx') IS NOT NULL
        AS present
    `),
    db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count
        FROM pg_trigger AS trigger
        JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_proc AS trigger_function ON trigger_function.oid = trigger.tgfoid
        WHERE (trigger.tgname, relation.relname, trigger_function.proname) IN (${sql.join(
          requiredIntegrityTriggers.map(
            ({ name, table, function: functionName }) =>
              sql`(${name}, ${table}, ${functionName})`,
          ),
          sql`, `,
        )})
          AND namespace.nspname = 'public'
          AND NOT trigger.tgisinternal
          AND trigger.tgenabled = 'O'
      `),
  ])

  const migrationLedgerPresent = migrationResult.rows[0]?.present ?? false
  const migrationLedgerState = migrationLedgerPresent
    ? (
        await db.execute<{ canonical: boolean; count: number }>(sql`
          SELECT
            count(*)::int AS count,
            count(*) FILTER (
              WHERE created_at = ${canonicalProgramOrdinalMigration.createdAt}
                AND hash = ${canonicalProgramOrdinalMigration.hash}
            ) = 1
            AND count(*) FILTER (
              WHERE created_at = ${canonicalProgramOrdinalMigration.createdAt}
            ) = 1 AS canonical
          FROM drizzle.__drizzle_migrations
        `)
      ).rows[0]
    : undefined
  const appliedMigrationCount = Number(migrationLedgerState?.count ?? 0)
  const migrationLedgerCanonical = migrationLedgerState?.canonical ?? false
  const appliedCommittedMigrationCount = migrationLedgerPresent
    ? Number(
        (
          await db.execute<{ count: number }>(sql`
            SELECT count(DISTINCT hash)::int AS count
            FROM drizzle.__drizzle_migrations
            WHERE hash IN (${sql.join(
              committedHashes.map((hash) => sql`${hash}`),
              sql`, `,
            )})
          `)
        ).rows[0]?.count ?? 0,
      )
    : 0
  const latestCommittedMigration = committedMigrations.at(-1)
  const latestCommittedMigrationApplied =
    migrationLedgerPresent && latestCommittedMigration
      ? Boolean(
          (
            await db.execute<{ present: boolean }>(sql`
              SELECT EXISTS (
                SELECT 1 FROM drizzle.__drizzle_migrations
                WHERE hash = ${latestCommittedMigration.hash}
              ) AS present
            `)
          ).rows[0]?.present,
        )
      : false
  const contentRevocationIntegrityPresent =
    contentRevocationResult.rows[0]?.present ?? false
  const contentResult = await db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count
        FROM program_revision
        WHERE methodology_review_status <> 'reviewed'
           OR template_review_status <> 'reviewed'
      `)

  return {
    databaseVersion: versionResult.rows[0]?.version ?? 'unknown',
    databaseVersionNumber: Number(versionResult.rows[0]?.versionNumber ?? 0),
    migrationLedgerPresent,
    migrationLedgerCanonical,
    appliedMigrationCount,
    committedMigrationCount: committedMigrations.length,
    appliedCommittedMigrationCount,
    latestCommittedMigrationApplied,
    bootstrapTriggerPresent: triggerResult.rows[0]?.present ?? false,
    workoutSnapshotColumnsPresent: columnsResult.rows[0]?.present ?? false,
    safetyHoldIntegrityPresent: safetyHoldResult.rows[0]?.present ?? false,
    trainingCorrectionIntegrityPresent:
      trainingCorrectionResult.rows[0]?.present ?? false,
    contentRevocationIntegrityPresent,
    llmCacheContractPresent: llmCacheResult.rows[0]?.present ?? false,
    integrityTriggerCount: integrityResult.rows[0]?.count ?? 0,
    ineligibleContentRevisionCount: contentResult.rows[0]?.count ?? 0,
  }
}

export async function assertDatabaseReady(): Promise<DatabasePreflight> {
  const result = await inspectDatabase()
  const failures: string[] = []

  if (!result.migrationLedgerPresent) failures.push('Drizzle migration ledger is absent')
  if (!result.migrationLedgerCanonical) {
    failures.push('program-ordinal migration ledger provenance is not canonical')
  }
  if (
    !result.latestCommittedMigrationApplied ||
    result.appliedCommittedMigrationCount !== result.committedMigrationCount
  ) {
    failures.push(
      `current committed migrations are incomplete (${result.appliedCommittedMigrationCount}/${result.committedMigrationCount} current hashes present; ${result.appliedMigrationCount} total historical rows)`,
    )
  }
  if (!result.bootstrapTriggerPresent) {
    failures.push('explicit-mode owner bootstrap trigger is absent')
  }
  if (!result.workoutSnapshotColumnsPresent) {
    failures.push('latest workout snapshot and revision-lineage columns are absent')
  }
  if (!result.safetyHoldIntegrityPresent) {
    failures.push(
      'safety-hold ownership, provenance, and resolution constraints are absent',
    )
  }
  if (!result.trainingCorrectionIntegrityPresent) {
    failures.push(
      'training correction, invalidation, and finalized-snapshot structures are absent',
    )
  }
  if (!result.contentRevocationIntegrityPresent) {
    failures.push('content release revocation structures are absent')
  }
  if (!result.llmCacheContractPresent) {
    failures.push(
      'latest explanation-cache provenance columns or session index are absent',
    )
  }
  if (result.integrityTriggerCount !== requiredIntegrityTriggers.length) {
    failures.push(
      `expected ${requiredIntegrityTriggers.length} integrity triggers, found ${result.integrityTriggerCount}`,
    )
  }
  if (result.databaseVersionNumber < 180_000) {
    failures.push('PostgreSQL 18 or newer is required')
  }
  if (
    getServerConfig().contentMode === 'reviewed' &&
    result.ineligibleContentRevisionCount > 0
  ) {
    failures.push(
      `reviewed content mode cannot start with ${result.ineligibleContentRevisionCount} unreviewed program revisions`,
    )
  }

  if (failures.length > 0) {
    throw new Error(`Database preflight failed: ${failures.join('; ')}`)
  }

  return result
}
