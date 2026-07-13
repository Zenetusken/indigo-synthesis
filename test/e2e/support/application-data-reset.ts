/**
 * Referentially safe clear order for the disposable E2E database.
 *
 * Keep this aligned with executeInstanceReset: application-owned rows are removed
 * before identity, while E2E additionally removes the installation singleton and
 * prior non-identifying tombstones to restore a genuinely clean bootstrap state.
 */
export const e2eApplicationDataResetTableOrder = [
  'installation_state',
  'adjustment_decision_invalidation',
  'program_revision_invalidation',
  'session_feedback_correction',
  'performed_set_correction',
  'training_fact_correction',
  'future_load_explanation_cache',
  'training_command_receipt',
  'program_revision_lineage',
  'safety_hold_resolution',
  'safety_hold',
  'workout_session',
  'program',
  'adjustment_decision',
  'performed_set',
  'session_exercise',
  'session_feedback',
  'set_prescription',
  'exercise_prescription',
  'planned_workout',
  'program_revision',
  'strength_baseline',
  'athlete_equipment',
  'athlete_training_day',
  'athlete_profile',
  'content_release_revocation',
  'audit_event',
  'deletion_plan',
  'destructive_reauthentication_state',
  'member_reset_state',
  'web_recovery_rate_limit_bucket',
  'verification',
  'session',
  'account',
  'user',
  'deletion_tombstone',
] as const
