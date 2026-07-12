import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { user } from './auth'

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull()

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull()

export const athleteProfiles = pgTable(
  'athlete_profile',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    units: text('units').notNull(),
    timezone: text('timezone').notNull(),
    goal: text('goal').notNull(),
    experience: text('experience').notNull(),
    sessionMinutes: smallint('session_minutes').notNull(),
    adultAttested: boolean('adult_attested').notNull(),
    techniqueAttested: boolean('technique_attested').notNull(),
    restrictionStatus: text('restriction_status').notNull(),
    limitations: text('limitations'),
    confirmedAt: timestamp('confirmed_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('athlete_profile_units_check', sql`${table.units} IN ('metric', 'imperial')`),
    check('athlete_profile_goal_check', sql`${table.goal} = 'general-strength'`),
    check(
      'athlete_profile_experience_check',
      sql`${table.experience} IN ('familiar', 'experienced')`,
    ),
    check(
      'athlete_profile_session_minutes_check',
      sql`${table.sessionMinutes} BETWEEN 30 AND 120`,
    ),
    check(
      'athlete_profile_restriction_check',
      sql`${table.restrictionStatus} IN ('none', 'present', 'uncertain')`,
    ),
  ],
)

export const athleteTrainingDays = pgTable(
  'athlete_training_day',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    weekday: smallint('weekday').notNull(),
    ordinal: smallint('ordinal').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.weekday] }),
    uniqueIndex('athlete_training_day_ordinal_uidx').on(table.userId, table.ordinal),
    check('athlete_training_day_weekday_check', sql`${table.weekday} BETWEEN 0 AND 6`),
    check('athlete_training_day_ordinal_check', sql`${table.ordinal} BETWEEN 1 AND 3`),
  ],
)

export const athleteEquipment = pgTable(
  'athlete_equipment',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    equipmentCode: text('equipment_code').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.equipmentCode] }),
    check(
      'athlete_equipment_code_check',
      sql`${table.equipmentCode} IN ('barbell', 'rack', 'bench', 'plates')`,
    ),
  ],
)

export const strengthBaselines = pgTable(
  'strength_baseline',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    exerciseCode: text('exercise_code').notNull(),
    loadGrams: integer('load_grams').notNull(),
    repetitions: smallint('repetitions').notNull(),
    protocol: text('protocol').notNull(),
    testedOn: date('tested_on', { mode: 'string' }).notNull(),
    provenance: text('provenance').default('user-attested').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('strength_baseline_user_exercise_uidx').on(
      table.userId,
      table.exerciseCode,
    ),
    check('strength_baseline_load_check', sql`${table.loadGrams} BETWEEN 0 AND 1000000`),
    check(
      'strength_baseline_repetitions_check',
      sql`${table.repetitions} BETWEEN 1 AND 100`,
    ),
  ],
)

export const safetyHolds = pgTable(
  'safety_hold',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceSessionId: text('source_session_id'),
    reasonCode: text('reason_code').notNull(),
    details: text('details'),
    createdAt: createdAt(),
    clearedAt: timestamp('cleared_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('safety_hold_id_user_uidx').on(table.id, table.userId),
    uniqueIndex('safety_hold_source_session_uidx')
      .on(table.sourceSessionId)
      .where(sql`${table.sourceSessionId} IS NOT NULL`),
    index('safety_hold_user_id_idx').on(table.userId),
    index('safety_hold_source_session_id_idx').on(table.sourceSessionId),
    foreignKey({
      name: 'safety_hold_source_session_user_fk',
      columns: [table.sourceSessionId, table.userId],
      foreignColumns: [workoutSessions.id, workoutSessions.userId],
    }).onDelete('restrict'),
    check(
      'safety_hold_clearance_shape_check',
      sql`${table.clearedAt} IS NULL OR (${table.reasonCode} = 'eligibility-restriction' AND ${table.sourceSessionId} IS NULL)`,
    ),
  ],
)

export const safetyHoldResolutions = pgTable(
  'safety_hold_resolution',
  {
    id: text('id').primaryKey(),
    holdId: text('hold_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    acknowledged: boolean('acknowledged').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('safety_hold_resolution_hold_id_uidx').on(table.holdId),
    index('safety_hold_resolution_user_id_idx').on(table.userId),
    foreignKey({
      name: 'safety_hold_resolution_hold_user_fk',
      columns: [table.holdId, table.userId],
      foreignColumns: [safetyHolds.id, safetyHolds.userId],
    }).onDelete('restrict'),
    check(
      'safety_hold_resolution_reason_check',
      sql`char_length(${table.reason}) BETWEEN 1 AND 300
        AND left(${table.reason}, 1) !~ '[[:space:]]'
        AND right(${table.reason}, 1) !~ '[[:space:]]'`,
    ),
    check('safety_hold_resolution_acknowledged_check', sql`${table.acknowledged} = true`),
  ],
)

export const programs = pgTable(
  'program',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status').default('draft').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('program_active_user_uidx')
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('program_draft_user_uidx')
      .on(table.userId)
      .where(sql`${table.status} = 'draft'`),
    check('program_status_check', sql`${table.status} IN ('draft', 'active', 'retired')`),
  ],
)

export const programRevisions = pgTable(
  'program_revision',
  {
    id: text('id').primaryKey(),
    programId: text('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    status: text('status').default('draft').notNull(),
    engineVersion: text('engine_version').notNull(),
    methodologyId: text('methodology_id').notNull(),
    methodologyVersion: text('methodology_version').notNull(),
    methodologyReviewStatus: text('methodology_review_status').notNull(),
    templateId: text('template_id').notNull(),
    templateVersion: text('template_version').notNull(),
    templateReviewStatus: text('template_review_status').notNull(),
    normalizedInputHash: text('normalized_input_hash').notNull(),
    outputHash: text('output_hash').notNull(),
    normalizedInput: jsonb('normalized_input').notNull(),
    outputSnapshot: jsonb('output_snapshot').notNull(),
    warnings: jsonb('warnings').default([]).notNull(),
    manualReviewRequired: boolean('manual_review_required').default(false).notNull(),
    createdAt: createdAt(),
    activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('program_revision_number_uidx').on(table.programId, table.revisionNumber),
    uniqueIndex('program_revision_active_uidx')
      .on(table.programId)
      .where(sql`${table.status} = 'active'`),
    check(
      'program_revision_status_check',
      sql`${table.status} IN ('draft', 'active', 'superseded')`,
    ),
    check(
      'program_revision_methodology_review_check',
      sql`${table.methodologyReviewStatus} IN ('development', 'reviewed', 'expired', 'prohibited')`,
    ),
    check(
      'program_revision_template_review_check',
      sql`${table.templateReviewStatus} IN ('development', 'reviewed', 'expired', 'prohibited')`,
    ),
  ],
)

export const plannedWorkouts = pgTable(
  'planned_workout',
  {
    id: text('id').primaryKey(),
    revisionId: text('revision_id')
      .notNull()
      .references(() => programRevisions.id, { onDelete: 'cascade' }),
    scheduledDate: date('scheduled_date', { mode: 'string' }).notNull(),
    ordinal: integer('ordinal').notNull(),
    programOrdinal: integer('program_ordinal').notNull(),
    slotCode: text('slot_code').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('planned_workout_revision_ordinal_uidx').on(
      table.revisionId,
      table.ordinal,
    ),
    uniqueIndex('planned_workout_revision_date_uidx').on(
      table.revisionId,
      table.scheduledDate,
    ),
    uniqueIndex('planned_workout_revision_program_ordinal_uidx').on(
      table.revisionId,
      table.programOrdinal,
    ),
    check('planned_workout_ordinal_check', sql`${table.ordinal} > 0`),
    check('planned_workout_program_ordinal_check', sql`${table.programOrdinal} > 0`),
    check('planned_workout_slot_check', sql`${table.slotCode} IN ('A', 'B', 'C')`),
  ],
)

export const exercisePrescriptions = pgTable(
  'exercise_prescription',
  {
    id: text('id').primaryKey(),
    plannedWorkoutId: text('planned_workout_id')
      .notNull()
      .references(() => plannedWorkouts.id, { onDelete: 'cascade' }),
    exerciseCode: text('exercise_code').notNull(),
    exerciseName: text('exercise_name').notNull(),
    ordinal: smallint('ordinal').notNull(),
    safetyTier: text('safety_tier').default('standard').notNull(),
    rationaleCode: text('rationale_code').notNull(),
  },
  (table) => [
    uniqueIndex('exercise_prescription_workout_ordinal_uidx').on(
      table.plannedWorkoutId,
      table.ordinal,
    ),
    check('exercise_prescription_ordinal_check', sql`${table.ordinal} > 0`),
    check(
      'exercise_prescription_safety_tier_check',
      sql`${table.safetyTier} IN ('standard', 'advanced', 'prohibited')`,
    ),
  ],
)

export const setPrescriptions = pgTable(
  'set_prescription',
  {
    id: text('id').primaryKey(),
    exercisePrescriptionId: text('exercise_prescription_id')
      .notNull()
      .references(() => exercisePrescriptions.id, { onDelete: 'cascade' }),
    ordinal: smallint('ordinal').notNull(),
    setKind: text('set_kind').default('working').notNull(),
    targetLoadGrams: integer('target_load_grams').notNull(),
    targetRepetitions: smallint('target_repetitions').notNull(),
    restSeconds: integer('rest_seconds').notNull(),
  },
  (table) => [
    uniqueIndex('set_prescription_exercise_ordinal_uidx').on(
      table.exercisePrescriptionId,
      table.ordinal,
    ),
    check('set_prescription_ordinal_check', sql`${table.ordinal} > 0`),
    check('set_prescription_kind_check', sql`${table.setKind} IN ('warmup', 'working')`),
    check(
      'set_prescription_load_check',
      sql`${table.targetLoadGrams} BETWEEN 0 AND 1000000`,
    ),
    check(
      'set_prescription_repetitions_check',
      sql`${table.targetRepetitions} BETWEEN 1 AND 100`,
    ),
    check('set_prescription_rest_check', sql`${table.restSeconds} BETWEEN 0 AND 900`),
  ],
)

export const workoutSessions = pgTable(
  'workout_session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    plannedWorkoutId: text('planned_workout_id')
      .notNull()
      .references(() => plannedWorkouts.id, { onDelete: 'restrict' }),
    plannedWorkoutName: text('planned_workout_name').notNull(),
    scheduledDate: date('scheduled_date', { mode: 'string' }).notNull(),
    slotCode: text('slot_code').notNull(),
    status: text('status').default('active').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    pausedAt: timestamp('paused_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    abandonedAt: timestamp('abandoned_at', { withTimezone: true, mode: 'date' }),
    abandonedReason: text('abandoned_reason'),
    optimisticVersion: integer('optimistic_version').default(1).notNull(),
    startCommandId: text('start_command_id').notNull().unique(),
    completionCommandId: text('completion_command_id').unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('workout_session_id_user_uidx').on(table.id, table.userId),
    uniqueIndex('workout_session_planned_workout_uidx').on(table.plannedWorkoutId),
    uniqueIndex('workout_session_active_user_uidx')
      .on(table.userId)
      .where(sql`${table.status} IN ('active', 'paused')`),
    check(
      'workout_session_status_check',
      sql`${table.status} IN ('active', 'paused', 'completed', 'abandoned')`,
    ),
    check('workout_session_version_check', sql`${table.optimisticVersion} > 0`),
    check('workout_session_slot_check', sql`${table.slotCode} IN ('A', 'B', 'C')`),
    check(
      'workout_session_lifecycle_shape_check',
      sql`(${table.status} = 'active'
          AND ${table.pausedAt} IS NULL
          AND ${table.completedAt} IS NULL
          AND ${table.abandonedAt} IS NULL)
        OR (${table.status} = 'paused'
          AND ${table.pausedAt} IS NOT NULL
          AND ${table.completedAt} IS NULL
          AND ${table.abandonedAt} IS NULL)
        OR (${table.status} = 'completed'
          AND ${table.pausedAt} IS NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.abandonedAt} IS NULL)
        OR (${table.status} = 'abandoned'
          AND ${table.pausedAt} IS NULL
          AND ${table.completedAt} IS NULL
          AND ${table.abandonedAt} IS NOT NULL)`,
    ),
  ],
)

export const sessionExercises = pgTable(
  'session_exercise',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => workoutSessions.id, { onDelete: 'cascade' }),
    exerciseCode: text('exercise_code').notNull(),
    exerciseName: text('exercise_name').notNull(),
    ordinal: smallint('ordinal').notNull(),
    safetyTier: text('safety_tier').notNull(),
    rationaleCode: text('rationale_code').notNull(),
    originalExerciseCode: text('original_exercise_code').notNull(),
    substitutionReason: text('substitution_reason'),
  },
  (table) => [
    uniqueIndex('session_exercise_session_ordinal_uidx').on(
      table.sessionId,
      table.ordinal,
    ),
    check('session_exercise_ordinal_check', sql`${table.ordinal} > 0`),
    check(
      'session_exercise_safety_tier_check',
      sql`${table.safetyTier} IN ('standard', 'advanced', 'prohibited')`,
    ),
  ],
)

export const performedSets = pgTable(
  'performed_set',
  {
    id: text('id').primaryKey(),
    sessionExerciseId: text('session_exercise_id')
      .notNull()
      .references(() => sessionExercises.id, { onDelete: 'cascade' }),
    ordinal: smallint('ordinal').notNull(),
    status: text('status').default('pending').notNull(),
    targetLoadGrams: integer('target_load_grams').notNull(),
    targetRepetitions: smallint('target_repetitions').notNull(),
    restSeconds: integer('rest_seconds').notNull(),
    actualLoadGrams: integer('actual_load_grams'),
    actualRepetitions: smallint('actual_repetitions'),
    rpe: smallint('rpe'),
    loadProvenance: text('load_provenance'),
    repetitionsProvenance: text('repetitions_provenance'),
    explicitlyConfirmed: boolean('explicitly_confirmed').default(false).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    skippedAt: timestamp('skipped_at', { withTimezone: true, mode: 'date' }),
    skipReason: text('skip_reason'),
    note: text('note'),
    commandId: text('command_id').unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('performed_set_exercise_ordinal_uidx').on(
      table.sessionExerciseId,
      table.ordinal,
    ),
    check('performed_set_ordinal_check', sql`${table.ordinal} > 0`),
    check(
      'performed_set_status_check',
      sql`${table.status} IN ('pending', 'performed', 'skipped')`,
    ),
    check(
      'performed_set_actual_load_check',
      sql`${table.actualLoadGrams} IS NULL OR ${table.actualLoadGrams} BETWEEN 0 AND 1000000`,
    ),
    check(
      'performed_set_actual_repetitions_check',
      sql`${table.actualRepetitions} IS NULL OR ${table.actualRepetitions} BETWEEN 1 AND 100`,
    ),
    check(
      'performed_set_rpe_check',
      sql`${table.rpe} IS NULL OR ${table.rpe} BETWEEN 1 AND 10`,
    ),
    check(
      'performed_set_provenance_check',
      sql`(${table.loadProvenance} IS NULL OR ${table.loadProvenance} IN ('copied-target', 'edited'))
        AND (${table.repetitionsProvenance} IS NULL OR ${table.repetitionsProvenance} IN ('copied-target', 'edited'))`,
    ),
    check(
      'performed_set_state_shape_check',
      sql`(${table.status} = 'pending'
          AND ${table.actualLoadGrams} IS NULL
          AND ${table.actualRepetitions} IS NULL
          AND ${table.confirmedAt} IS NULL
          AND ${table.skippedAt} IS NULL)
        OR (${table.status} = 'performed'
          AND ${table.actualLoadGrams} IS NOT NULL
          AND ${table.actualRepetitions} IS NOT NULL
          AND ${table.explicitlyConfirmed} = true
          AND ${table.confirmedAt} IS NOT NULL
          AND ${table.skippedAt} IS NULL
          AND ${table.skipReason} IS NULL)
        OR (${table.status} = 'skipped'
          AND ${table.actualLoadGrams} IS NULL
          AND ${table.actualRepetitions} IS NULL
          AND ${table.explicitlyConfirmed} = false
          AND ${table.confirmedAt} IS NULL
          AND ${table.skippedAt} IS NOT NULL
          AND ${table.skipReason} IS NOT NULL)`,
    ),
  ],
)

export const sessionFeedback = pgTable('session_feedback', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => workoutSessions.id, { onDelete: 'cascade' }),
  painReported: boolean('pain_reported').notNull(),
  details: text('details'),
  answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'date' }).notNull(),
})

export const programRevisionLineage = pgTable(
  'program_revision_lineage',
  {
    revisionId: text('revision_id')
      .primaryKey()
      .references(() => programRevisions.id, { onDelete: 'cascade' }),
    parentRevisionId: text('parent_revision_id')
      .notNull()
      .references(() => programRevisions.id, { onDelete: 'restrict' }),
    sourceSessionId: text('source_session_id')
      .notNull()
      .unique()
      .references(() => workoutSessions.id, { onDelete: 'restrict' }),
    sourceProgramOrdinal: integer('source_program_ordinal').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'program_revision_lineage_distinct_revision_check',
      sql`${table.revisionId} <> ${table.parentRevisionId}`,
    ),
    check(
      'program_revision_lineage_source_ordinal_check',
      sql`${table.sourceProgramOrdinal} > 0`,
    ),
  ],
)

export const trainingCommandReceipts = pgTable(
  'training_command_receipt',
  {
    commandId: text('command_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    commandType: text('command_type').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => workoutSessions.id, { onDelete: 'cascade' }),
    targetId: text('target_id').notNull(),
    requestHash: text('request_hash').notNull(),
    resultSnapshot: jsonb('result_snapshot').default({}).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('training_command_receipt_user_idx').on(table.userId),
    index('training_command_receipt_session_idx').on(table.sessionId),
    check(
      'training_command_receipt_type_check',
      sql`${table.commandType} IN ('complete-set', 'skip-set', 'complete-workout', 'report-pain', 'resolve-safety-hold')`,
    ),
  ],
)

export const adjustmentDecisions = pgTable(
  'adjustment_decision',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => workoutSessions.id, { onDelete: 'cascade' }),
    appliedRevisionId: text('applied_revision_id').references(() => programRevisions.id, {
      onDelete: 'set null',
    }),
    exerciseCode: text('exercise_code').notNull(),
    decision: text('decision').notNull(),
    currentLoadGrams: integer('current_load_grams'),
    nextLoadGrams: integer('next_load_grams'),
    reasonCode: text('reason_code').notNull(),
    ruleVersion: text('rule_version').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('adjustment_decision_session_exercise_uidx').on(
      table.sessionId,
      table.exerciseCode,
    ),
    check(
      'adjustment_decision_kind_check',
      sql`${table.decision} IN ('increase', 'hold', 'unavailable')`,
    ),
  ],
)

export const auditEvents = pgTable(
  'audit_event',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    subjectUserId: text('subject_user_id').references(() => user.id, {
      onDelete: 'cascade',
    }),
    eventType: text('event_type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_event_subject_idx').on(table.subjectUserId),
    index('audit_event_actor_idx').on(table.actorUserId),
  ],
)

export const deletionPlans = pgTable(
  'deletion_plan',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    planDigest: text('plan_digest').notNull(),
    rowCounts: jsonb('row_counts').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('deletion_plan_user_idx').on(table.userId),
    check(
      'deletion_plan_scope_check',
      sql`${table.scope} IN ('trainee-data', 'instance-reset')`,
    ),
  ],
)

export const deletionTombstones = pgTable('deletion_tombstone', {
  id: text('id').primaryKey(),
  actorClass: text('actor_class').notNull(),
  scope: text('scope').notNull(),
  schemaVersion: text('schema_version').notNull(),
  rowCounts: jsonb('row_counts').notNull(),
  completionDigest: text('completion_digest').notNull(),
  createdAt: createdAt(),
})
