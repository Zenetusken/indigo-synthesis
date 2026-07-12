import { sql } from 'drizzle-orm'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from './client'

export type DatabasePreflight = {
  readonly databaseVersion: string
  readonly databaseVersionNumber: number
  readonly migrationLedgerPresent: boolean
  readonly appliedMigrationCount: number
  readonly bootstrapTriggerPresent: boolean
  readonly workoutSnapshotColumnsPresent: boolean
  readonly integrityTriggerCount: number
  readonly ineligibleContentRevisionCount: number
}

const expectedMigrationCount = 7
const requiredIntegrityTriggers = [
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
    name: 'session_feedback_monotonicity_guard',
    table: 'session_feedback',
    function: 'indigo_guard_feedback_monotonicity',
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
    name: 'training_command_receipt_immutability_guard',
    table: 'training_command_receipt',
    function: 'indigo_guard_append_only_training_fact',
  },
] as const

export async function inspectDatabase(): Promise<DatabasePreflight> {
  const db = getDb()
  const [
    versionResult,
    migrationResult,
    triggerResult,
    columnsResult,
    integrityResult,
    contentResult,
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
              AND column_name IN ('planned_workout_name', 'scheduled_date', 'slot_code')
          ) = 3
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
          ) = 7 AS present
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'workout_session',
            'adjustment_decision',
            'planned_workout',
            'program_revision_lineage',
            'training_command_receipt'
          )
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
    db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count
        FROM program_revision
        WHERE methodology_review_status <> 'reviewed'
           OR template_review_status <> 'reviewed'
      `),
  ])

  const migrationLedgerPresent = migrationResult.rows[0]?.present ?? false
  const appliedMigrationCount = migrationLedgerPresent
    ? Number(
        (
          await db.execute<{ count: number }>(
            sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
          )
        ).rows[0]?.count ?? 0,
      )
    : 0

  return {
    databaseVersion: versionResult.rows[0]?.version ?? 'unknown',
    databaseVersionNumber: Number(versionResult.rows[0]?.versionNumber ?? 0),
    migrationLedgerPresent,
    appliedMigrationCount,
    bootstrapTriggerPresent: triggerResult.rows[0]?.present ?? false,
    workoutSnapshotColumnsPresent: columnsResult.rows[0]?.present ?? false,
    integrityTriggerCount: integrityResult.rows[0]?.count ?? 0,
    ineligibleContentRevisionCount: contentResult.rows[0]?.count ?? 0,
  }
}

export async function assertDatabaseReady(): Promise<DatabasePreflight> {
  const result = await inspectDatabase()
  const failures: string[] = []

  if (!result.migrationLedgerPresent) failures.push('Drizzle migration ledger is absent')
  if (result.appliedMigrationCount !== expectedMigrationCount) {
    failures.push(
      `expected ${expectedMigrationCount} applied migrations, found ${result.appliedMigrationCount}`,
    )
  }
  if (!result.bootstrapTriggerPresent) {
    failures.push('explicit-mode owner bootstrap trigger is absent')
  }
  if (!result.workoutSnapshotColumnsPresent) {
    failures.push('latest workout snapshot and revision-lineage columns are absent')
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
