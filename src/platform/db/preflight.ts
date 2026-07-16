import { type SQL, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { QueryResult, QueryResultRow } from 'pg'
import { getServerConfig } from '@/platform/config/server'

export type DatabasePreflightQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

const dialect = new PgDialect()

function normalizedRoleConnectionLimit(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return null
}

export function hasSufficientRoleConnectionAllowance(
  value: unknown,
  databasePoolMax: number,
): boolean {
  const limit = normalizedRoleConnectionLimit(value)
  return limit === -1 || (limit !== null && limit >= databasePoolMax)
}

function execute<Row extends QueryResultRow>(
  query: DatabasePreflightQuery,
  statement: SQL,
): Promise<QueryResult<Row>> {
  const compiled = dialect.sqlToQuery(statement)
  return query.query<Row>(compiled.sql, compiled.params)
}

export type DatabasePreflight = {
  readonly databaseVersion: string
  readonly databaseVersionNumber: number
  readonly authenticatedRoleName: string | null
  readonly authenticatedRoleConnectionLimit: number | null
  readonly authenticatedRoleConnectionAllowancePresent: boolean
  readonly migrationLedgerPresent: boolean
  readonly migrationLedgerCanonical: boolean
  readonly appliedMigrationCount: number
  readonly committedMigrationCount: number
  readonly appliedCommittedMigrationCount: number
  readonly latestCommittedMigrationApplied: boolean
  readonly bootstrapTriggerPresent: boolean
  readonly installationMutationEpochPresent: boolean
  readonly workoutSnapshotColumnsPresent: boolean
  readonly safetyHoldIntegrityPresent: boolean
  readonly trainingCorrectionIntegrityPresent: boolean
  readonly contentRevocationIntegrityPresent: boolean
  readonly llmCacheContractPresent: boolean
  readonly accessRecoveryPersistencePresent: boolean
  readonly integrityTriggerCount: number
  readonly ineligibleContentRevisionCount: number
}

export const expectedMigrationCount = 19
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

export async function inspectDatabase(
  query: DatabasePreflightQuery,
): Promise<DatabasePreflight> {
  const committedMigrations = readMigrationFiles({ migrationsFolder: './drizzle' })
  const committedHashes = committedMigrations.map((migration) => migration.hash)
  const versionResult = await execute<{ version: string; versionNumber: string }>(
    query,
    sql`
        SELECT version(), current_setting('server_version_num') AS "versionNumber"
      `,
  )
  const roleResult = await execute<{
    roleName: string
    connectionLimit: number | string
  }>(
    query,
    sql`
      SELECT role.rolname AS "roleName", role.rolconnlimit AS "connectionLimit"
      FROM pg_roles AS role
      WHERE role.rolname = session_user
    `,
  )
  const migrationResult = await execute<{ present: boolean }>(
    query,
    sql`
      SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present
    `,
  )
  const triggerResult = await execute<{ present: boolean }>(
    query,
    sql`
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
    `,
  )
  const installationEpochResult = await execute<{ present: boolean }>(
    query,
    sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'installation_state'
            AND column_name = 'product_mutation_epoch'
            AND data_type = 'uuid'
            AND is_nullable = 'NO'
            AND column_default LIKE '%gen_random_uuid()%'
        )
        AND (SELECT count(*) = 1 FROM installation_state)
        AND (SELECT count(*) = 1 FROM installation_state WHERE singleton = 1)
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.installation_state')
            AND conname = 'installation_state_singleton_check'
            AND contype = 'c' AND convalidated
            AND pg_get_constraintdef(oid) ~ 'singleton[^=]*= 1'
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.installation_state')
            AND conname = 'installation_state_owner_closed_check'
            AND contype = 'c' AND convalidated
            AND pg_get_constraintdef(oid) LIKE '%owner_user_id IS NULL%'
            AND pg_get_constraintdef(oid) LIKE '%bootstrap_closed_at IS NULL%'
            AND pg_get_constraintdef(oid) LIKE '%owner_user_id IS NOT NULL%'
            AND pg_get_constraintdef(oid) LIKE '%bootstrap_closed_at IS NOT NULL%'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM installation_state
          WHERE COALESCE(
            to_jsonb(installation_state)->>'product_mutation_epoch',
            ''
          ) !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ) AS present
    `,
  )
  const columnsResult = await execute<{ present: boolean }>(
    query,
    sql`
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
      `,
  )
  const safetyHoldResult = await execute<{ present: boolean }>(
    query,
    sql`
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
    `,
  )
  const trainingCorrectionResult = await execute<{ present: boolean }>(
    query,
    sql`
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
    `,
  )
  const contentRevocationResult = await execute<{ present: boolean }>(
    query,
    sql`
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
    `,
  )
  const llmCacheResult = await execute<{ present: boolean }>(
    query,
    sql`
      SELECT
        (
          SELECT count(*) = 16
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'future_load_explanation_cache'
            AND column_name IN (
              'id', 'user_id', 'session_id', 'decision_id', 'cache_key', 'prose',
              'model_id', 'model_content_digest', 'served_model_name', 'runtime_id',
              'runtime_attestation_digest', 'prompt_version', 'validator_version',
              'fact_bundle_hash', 'generate_duration_ms', 'created_at'
            )
        )
        AND to_regclass('public.future_load_explanation_cache_session_idx') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass(
            'public.future_load_explanation_cache_key_uidx'
          )
            AND indrelid = to_regclass('public.future_load_explanation_cache')
            AND indisunique AND indisvalid AND indisready
        )
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass(
            'public.future_load_explanation_cache_decision_uidx'
          )
            AND indrelid = to_regclass('public.future_load_explanation_cache')
            AND indisunique AND indisvalid AND indisready
        )
        AND (
          SELECT count(*) = 5
          FROM pg_constraint
          WHERE conrelid = to_regclass('public.future_load_explanation_cache')
            AND convalidated
            AND (
              (conname IN (
                'future_load_explanation_cache_session_user_fk',
                'future_load_explanation_cache_decision_session_fk'
              ) AND contype = 'f')
              OR (conname IN (
                'future_load_explanation_cache_hashes_check',
                'future_load_explanation_cache_identity_check',
                'future_load_explanation_cache_duration_check'
              ) AND contype = 'c')
            )
        )
        AS present
    `,
  )
  const accessRecoveryResult = await execute<{ present: boolean }>(
    query,
    sql`
      SELECT
        to_regclass('public.member_reset_state') IS NOT NULL
        AND to_regclass('public.web_recovery_rate_limit_bucket') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass('public.session_expires_at_id_idx')
            AND indrelid = to_regclass('public.session')
            AND NOT indisunique AND indisvalid AND indisready
            AND indpred IS NULL
            AND indnkeyatts = 2 AND indnatts = 2
            AND (
              SELECT access_method.amname
              FROM pg_class AS index_relation
              JOIN pg_am AS access_method
                ON access_method.oid = index_relation.relam
              WHERE index_relation.oid = indexrelid
            ) = 'btree'
            AND (
              SELECT array_agg(key.option ORDER BY key.ordinality)::smallint[]
              FROM unnest(indoption::smallint[]) WITH ORDINALITY AS key(
                option,
                ordinality
              )
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY[0::smallint, 0::smallint]
            AND (
              SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[]
              FROM unnest(indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = indrelid
               AND attribute.attnum = key.attnum
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY['expires_at', 'id']
            AND (
              SELECT array_agg(
                COALESCE(
                  index_collation_namespace.nspname || '.' || index_collation.collname,
                  ''
                ) ORDER BY key.ordinality
              )::text[]
              FROM unnest(indcollation::oid[]) WITH ORDINALITY AS key(
                collation_oid,
                ordinality
              )
              LEFT JOIN pg_collation AS index_collation
                ON index_collation.oid = key.collation_oid
              LEFT JOIN pg_namespace AS index_collation_namespace
                ON index_collation_namespace.oid = index_collation.collnamespace
            ) = ARRAY['', 'pg_catalog.C']
        )
        AND (
          SELECT count(*) = 8
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'member_reset_state'
            AND column_name IN (
              'target_user_id', 'active_verification_id', 'last_issued_at',
              'failed_attempts', 'retry_after', 'last_attempt_at',
              'created_at', 'updated_at'
            )
        )
        AND (
          SELECT count(*) = 8
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'web_recovery_rate_limit_bucket'
            AND column_name IN (
              'scope', 'bucket_key', 'window_started_at', 'attempt_count',
              'retry_after', 'last_attempt_at', 'created_at', 'updated_at'
            )
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.member_reset_state')
            AND conname = 'member_reset_state_target_user_id_user_id_fk'
            AND contype = 'f'
            AND confrelid = to_regclass('public.user')
            AND confdeltype = 'c' AND convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.member_reset_state')
            AND conname = 'member_reset_state_active_verification_id_verification_id_fk'
            AND contype = 'f'
            AND confrelid = to_regclass('public.verification')
            AND confdeltype = 'n' AND convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass('public.member_reset_state_pkey')
            AND indrelid = to_regclass('public.member_reset_state')
            AND indisprimary AND indisunique AND indisvalid AND indisready
            AND indpred IS NULL
            AND (
              SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[]
              FROM unnest(indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = indrelid
               AND attribute.attnum = key.attnum
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY['target_user_id']
        )
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass(
            'public.member_reset_state_active_verification_uidx'
            )
            AND indrelid = to_regclass('public.member_reset_state')
            AND indisunique AND indisvalid AND indisready
            AND indpred IS NULL
            AND (
              SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[]
              FROM unnest(indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = indrelid
               AND attribute.attnum = key.attnum
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY['active_verification_id']
        )
        AND (
          SELECT count(*) = 4
          FROM pg_constraint
          WHERE conrelid = to_regclass('public.member_reset_state')
            AND contype = 'c' AND convalidated
            AND conname IN (
              'member_reset_state_attempts_check',
              'member_reset_state_attempt_shape_check',
              'member_reset_state_attempt_order_check',
              'member_reset_state_retry_check'
            )
        )
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass(
            'public.web_recovery_rate_limit_bucket_pk'
          )
            AND indrelid = to_regclass('public.web_recovery_rate_limit_bucket')
            AND indisprimary AND indisunique AND indisvalid AND indisready
            AND indpred IS NULL
            AND (
              SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[]
              FROM unnest(indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = indrelid
               AND attribute.attnum = key.attnum
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY['scope', 'bucket_key']
        )
        AND (
          SELECT count(*) = 5
          FROM pg_constraint
          WHERE conrelid = to_regclass('public.web_recovery_rate_limit_bucket')
            AND contype = 'c' AND convalidated
            AND conname IN (
              'web_recovery_rate_limit_bucket_scope_check',
              'web_recovery_rate_limit_bucket_key_check',
              'web_recovery_rate_limit_bucket_attempts_check',
              'web_recovery_rate_limit_bucket_window_check',
              'web_recovery_rate_limit_bucket_retry_check'
            )
        )
        AND EXISTS (
          SELECT 1 FROM pg_index
          WHERE indexrelid = to_regclass(
            'public.web_recovery_rate_limit_bucket_updated_idx'
          )
            AND indrelid = to_regclass('public.web_recovery_rate_limit_bucket')
            AND indisvalid AND indisready AND indpred IS NULL
            AND (
              SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[]
              FROM unnest(indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = indrelid
               AND attribute.attnum = key.attnum
              WHERE key.ordinality <= indnkeyatts
            ) = ARRAY['updated_at', 'scope', 'bucket_key']
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.destructive_reauthentication_state')
            AND conname = 'destructive_reauthentication_purpose_check'
            AND contype = 'c' AND convalidated
            AND pg_get_constraintdef(oid) LIKE '%member-reset-issue%'
            AND pg_get_constraintdef(oid) LIKE '%local-user-create%'
            AND pg_get_constraintdef(oid) NOT LIKE '%session-revoke%'
        ) AS present
    `,
  )
  const integrityResult = await execute<{ count: number }>(
    query,
    sql`
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
      `,
  )

  const migrationLedgerPresent = migrationResult.rows[0]?.present ?? false
  const migrationLedgerState = migrationLedgerPresent
    ? (
        await execute<{ canonical: boolean; count: number }>(
          query,
          sql`
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
        `,
        )
      ).rows[0]
    : undefined
  const appliedMigrationCount = Number(migrationLedgerState?.count ?? 0)
  const migrationLedgerCanonical = migrationLedgerState?.canonical ?? false
  const appliedCommittedMigrationCount = migrationLedgerPresent
    ? Number(
        (
          await execute<{ count: number }>(
            query,
            sql`
            SELECT count(DISTINCT hash)::int AS count
            FROM drizzle.__drizzle_migrations
            WHERE hash IN (${sql.join(
              committedHashes.map((hash) => sql`${hash}`),
              sql`, `,
            )})
          `,
          )
        ).rows[0]?.count ?? 0,
      )
    : 0
  const latestCommittedMigration = committedMigrations.at(-1)
  const latestCommittedMigrationApplied =
    migrationLedgerPresent && latestCommittedMigration
      ? Boolean(
          (
            await execute<{ present: boolean }>(
              query,
              sql`
              SELECT EXISTS (
                SELECT 1 FROM drizzle.__drizzle_migrations
                WHERE hash = ${latestCommittedMigration.hash}
              ) AS present
            `,
            )
          ).rows[0]?.present,
        )
      : false
  const contentRevocationIntegrityPresent =
    contentRevocationResult.rows[0]?.present ?? false
  const contentResult = await execute<{ count: number }>(
    query,
    sql`
        SELECT count(*)::int AS count
        FROM program_revision
        WHERE methodology_review_status <> 'reviewed'
           OR template_review_status <> 'reviewed'
      `,
  )
  const role = roleResult.rows[0]
  const authenticatedRoleConnectionLimit = normalizedRoleConnectionLimit(
    role?.connectionLimit,
  )

  return {
    databaseVersion: versionResult.rows[0]?.version ?? 'unknown',
    databaseVersionNumber: Number(versionResult.rows[0]?.versionNumber ?? 0),
    authenticatedRoleName: role?.roleName ?? null,
    authenticatedRoleConnectionLimit,
    authenticatedRoleConnectionAllowancePresent:
      role !== undefined &&
      hasSufficientRoleConnectionAllowance(
        role.connectionLimit,
        getServerConfig().databasePoolMax,
      ),
    migrationLedgerPresent,
    migrationLedgerCanonical,
    appliedMigrationCount,
    committedMigrationCount: committedMigrations.length,
    appliedCommittedMigrationCount,
    latestCommittedMigrationApplied,
    bootstrapTriggerPresent: triggerResult.rows[0]?.present ?? false,
    installationMutationEpochPresent: installationEpochResult.rows[0]?.present ?? false,
    workoutSnapshotColumnsPresent: columnsResult.rows[0]?.present ?? false,
    safetyHoldIntegrityPresent: safetyHoldResult.rows[0]?.present ?? false,
    trainingCorrectionIntegrityPresent:
      trainingCorrectionResult.rows[0]?.present ?? false,
    contentRevocationIntegrityPresent,
    llmCacheContractPresent: llmCacheResult.rows[0]?.present ?? false,
    accessRecoveryPersistencePresent: accessRecoveryResult.rows[0]?.present ?? false,
    integrityTriggerCount: integrityResult.rows[0]?.count ?? 0,
    ineligibleContentRevisionCount: contentResult.rows[0]?.count ?? 0,
  }
}

export async function assertDatabaseReady(
  query: DatabasePreflightQuery,
): Promise<DatabasePreflight> {
  const result = await inspectDatabase(query)
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
  if (!result.installationMutationEpochPresent) {
    failures.push('installation mutation epoch column/default/backfill is absent')
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
      'latest explanation-cache ownership, provenance, constraint, or index contract is absent',
    )
  }
  if (!result.accessRecoveryPersistencePresent) {
    failures.push(
      'access-recovery state, rate-limit, constraint, or index contract is absent',
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
  if (!result.authenticatedRoleConnectionAllowancePresent) {
    failures.push(
      `authenticated PostgreSQL role connection allowance is below INDIGO_DATABASE_POOL_MAX=${getServerConfig().databasePoolMax} (role ${result.authenticatedRoleName ?? 'unknown'}, rolconnlimit ${result.authenticatedRoleConnectionLimit ?? 'missing or malformed'}; -1 means unlimited)`,
    )
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
