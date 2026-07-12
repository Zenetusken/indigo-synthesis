CREATE TABLE "adjustment_decision_invalidation" (
	"decision_id" text PRIMARY KEY NOT NULL,
	"correction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performed_set_correction" (
	"correction_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"performed_set_id" text NOT NULL,
	"status" text NOT NULL,
	"actual_load_grams" integer,
	"actual_repetitions" smallint,
	"rpe" smallint,
	"load_provenance" text,
	"repetitions_provenance" text,
	"explicitly_confirmed" boolean NOT NULL,
	"confirmed_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"skip_reason" text,
	"note" text,
	CONSTRAINT "performed_set_correction_status_check" CHECK ("performed_set_correction"."status" IN ('performed', 'skipped')),
	CONSTRAINT "performed_set_correction_actual_load_check" CHECK ("performed_set_correction"."actual_load_grams" IS NULL OR "performed_set_correction"."actual_load_grams" BETWEEN 0 AND 1000000),
	CONSTRAINT "performed_set_correction_actual_repetitions_check" CHECK ("performed_set_correction"."actual_repetitions" IS NULL OR "performed_set_correction"."actual_repetitions" BETWEEN 1 AND 100),
	CONSTRAINT "performed_set_correction_rpe_check" CHECK ("performed_set_correction"."rpe" IS NULL OR "performed_set_correction"."rpe" BETWEEN 1 AND 10),
	CONSTRAINT "performed_set_correction_provenance_check" CHECK (("performed_set_correction"."load_provenance" IS NULL OR "performed_set_correction"."load_provenance" IN ('copied-target', 'edited'))
        AND ("performed_set_correction"."repetitions_provenance" IS NULL OR "performed_set_correction"."repetitions_provenance" IN ('copied-target', 'edited'))),
	CONSTRAINT "performed_set_correction_state_shape_check" CHECK (("performed_set_correction"."status" = 'performed'
          AND "performed_set_correction"."actual_load_grams" IS NOT NULL
          AND "performed_set_correction"."actual_repetitions" IS NOT NULL
          AND "performed_set_correction"."load_provenance" IS NOT NULL
          AND "performed_set_correction"."repetitions_provenance" IS NOT NULL
          AND "performed_set_correction"."explicitly_confirmed" = true
          AND "performed_set_correction"."confirmed_at" IS NOT NULL
          AND "performed_set_correction"."skipped_at" IS NULL
          AND "performed_set_correction"."skip_reason" IS NULL)
        OR ("performed_set_correction"."status" = 'skipped'
          AND "performed_set_correction"."actual_load_grams" IS NULL
          AND "performed_set_correction"."actual_repetitions" IS NULL
          AND "performed_set_correction"."rpe" IS NULL
          AND "performed_set_correction"."load_provenance" IS NULL
          AND "performed_set_correction"."repetitions_provenance" IS NULL
          AND "performed_set_correction"."explicitly_confirmed" = false
          AND "performed_set_correction"."confirmed_at" IS NULL
          AND "performed_set_correction"."skipped_at" IS NOT NULL
          AND "performed_set_correction"."skip_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "program_revision_invalidation" (
	"revision_id" text PRIMARY KEY NOT NULL,
	"correction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_feedback_correction" (
	"correction_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"pain_reported" boolean NOT NULL,
	"details" text,
	"answered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_feedback_correction_pain_check" CHECK ("session_feedback_correction"."pain_reported" = true)
);
--> statement-breakpoint
CREATE TABLE "training_fact_correction" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"command_id" text NOT NULL,
	"correction_kind" text NOT NULL,
	"sequence" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_fact_correction_command_id_unique" UNIQUE("command_id"),
	CONSTRAINT "training_fact_correction_kind_check" CHECK ("training_fact_correction"."correction_kind" IN ('session-feedback', 'performed-set')),
	CONSTRAINT "training_fact_correction_self_actor_check" CHECK ("training_fact_correction"."actor_user_id" = "training_fact_correction"."user_id"),
	CONSTRAINT "training_fact_correction_sequence_check" CHECK ("training_fact_correction"."sequence" > 0),
	CONSTRAINT "training_fact_correction_reason_check" CHECK (char_length("training_fact_correction"."reason") BETWEEN 1 AND 500
        AND left("training_fact_correction"."reason", 1) !~ '[[:space:]]'
        AND right("training_fact_correction"."reason", 1) !~ '[[:space:]]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "training_fact_correction_id_session_user_uidx" ON "training_fact_correction" USING btree ("id","session_id","user_id");--> statement-breakpoint
ALTER TABLE "performed_set" DROP CONSTRAINT "performed_set_state_shape_check";--> statement-breakpoint
ALTER TABLE "training_command_receipt" DROP CONSTRAINT "training_command_receipt_type_check";--> statement-breakpoint
ALTER TABLE "workout_session" DROP CONSTRAINT "workout_session_status_check";--> statement-breakpoint
ALTER TABLE "workout_session" DROP CONSTRAINT "workout_session_lifecycle_shape_check";--> statement-breakpoint
DROP INDEX "workout_session_active_user_uidx";--> statement-breakpoint
ALTER TABLE "workout_session" ALTER COLUMN "status" SET DEFAULT 'initializing';--> statement-breakpoint
ALTER TABLE "workout_session" ADD COLUMN "snapshot_finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workout_session" DISABLE TRIGGER "workout_session_terminal_guard";--> statement-breakpoint
UPDATE "workout_session"
SET "snapshot_finalized_at" = "created_at"
WHERE "snapshot_finalized_at" IS NULL;--> statement-breakpoint
ALTER TABLE "workout_session" ENABLE TRIGGER "workout_session_terminal_guard";--> statement-breakpoint
ALTER TABLE "adjustment_decision_invalidation" ADD CONSTRAINT "adjustment_decision_invalidation_decision_id_adjustment_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."adjustment_decision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_decision_invalidation" ADD CONSTRAINT "adjustment_decision_invalidation_correction_id_training_fact_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."training_fact_correction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performed_set_correction" ADD CONSTRAINT "performed_set_correction_performed_set_id_performed_set_id_fk" FOREIGN KEY ("performed_set_id") REFERENCES "public"."performed_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performed_set_correction" ADD CONSTRAINT "performed_set_correction_root_fk" FOREIGN KEY ("correction_id","session_id","user_id") REFERENCES "public"."training_fact_correction"("id","session_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_revision_invalidation" ADD CONSTRAINT "program_revision_invalidation_revision_id_program_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."program_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_revision_invalidation" ADD CONSTRAINT "program_revision_invalidation_correction_id_training_fact_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."training_fact_correction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_feedback_correction" ADD CONSTRAINT "session_feedback_correction_root_fk" FOREIGN KEY ("correction_id","session_id","user_id") REFERENCES "public"."training_fact_correction"("id","session_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_fact_correction" ADD CONSTRAINT "training_fact_correction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_fact_correction" ADD CONSTRAINT "training_fact_correction_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_fact_correction" ADD CONSTRAINT "training_fact_correction_session_user_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."workout_session"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adjustment_decision_invalidation_correction_idx" ON "adjustment_decision_invalidation" USING btree ("correction_id");--> statement-breakpoint
CREATE INDEX "performed_set_correction_set_idx" ON "performed_set_correction" USING btree ("performed_set_id");--> statement-breakpoint
CREATE INDEX "program_revision_invalidation_correction_idx" ON "program_revision_invalidation" USING btree ("correction_id");--> statement-breakpoint
CREATE INDEX "session_feedback_correction_session_idx" ON "session_feedback_correction" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "training_fact_correction_session_sequence_uidx" ON "training_fact_correction" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "training_fact_correction_user_idx" ON "training_fact_correction" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "training_fact_correction_session_idx" ON "training_fact_correction" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_session_active_user_uidx" ON "workout_session" USING btree ("user_id") WHERE "workout_session"."status" IN ('initializing', 'active', 'paused');--> statement-breakpoint
ALTER TABLE "performed_set" ADD CONSTRAINT "performed_set_state_shape_check" CHECK (("performed_set"."status" = 'pending'
          AND "performed_set"."actual_load_grams" IS NULL
          AND "performed_set"."actual_repetitions" IS NULL
          AND "performed_set"."rpe" IS NULL
          AND "performed_set"."load_provenance" IS NULL
          AND "performed_set"."repetitions_provenance" IS NULL
          AND "performed_set"."explicitly_confirmed" = false
          AND "performed_set"."confirmed_at" IS NULL
          AND "performed_set"."skipped_at" IS NULL
          AND "performed_set"."skip_reason" IS NULL
          AND "performed_set"."note" IS NULL
          AND "performed_set"."command_id" IS NULL)
        OR ("performed_set"."status" = 'performed'
          AND "performed_set"."actual_load_grams" IS NOT NULL
          AND "performed_set"."actual_repetitions" IS NOT NULL
          AND "performed_set"."load_provenance" IS NOT NULL
          AND "performed_set"."repetitions_provenance" IS NOT NULL
          AND "performed_set"."explicitly_confirmed" = true
          AND "performed_set"."confirmed_at" IS NOT NULL
          AND "performed_set"."skipped_at" IS NULL
          AND "performed_set"."skip_reason" IS NULL
          AND "performed_set"."command_id" IS NOT NULL)
        OR ("performed_set"."status" = 'skipped'
          AND "performed_set"."actual_load_grams" IS NULL
          AND "performed_set"."actual_repetitions" IS NULL
          AND "performed_set"."rpe" IS NULL
          AND "performed_set"."load_provenance" IS NULL
          AND "performed_set"."repetitions_provenance" IS NULL
          AND "performed_set"."explicitly_confirmed" = false
          AND "performed_set"."confirmed_at" IS NULL
          AND "performed_set"."skipped_at" IS NOT NULL
          AND "performed_set"."skip_reason" IS NOT NULL
          AND "performed_set"."note" IS NULL
          AND "performed_set"."command_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "training_command_receipt" ADD CONSTRAINT "training_command_receipt_type_check" CHECK ("training_command_receipt"."command_type" IN ('complete-set', 'skip-set', 'complete-workout', 'report-pain', 'resolve-safety-hold', 'correct-performed-set'));--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_status_check" CHECK ("workout_session"."status" IN ('initializing', 'active', 'paused', 'completed', 'abandoned'));--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_lifecycle_shape_check" CHECK (("workout_session"."status" = 'initializing'
          AND "workout_session"."snapshot_finalized_at" IS NULL
          AND "workout_session"."paused_at" IS NULL
          AND "workout_session"."completed_at" IS NULL
          AND "workout_session"."abandoned_at" IS NULL)
        OR ("workout_session"."status" = 'active'
          AND "workout_session"."snapshot_finalized_at" IS NOT NULL
          AND "workout_session"."paused_at" IS NULL
          AND "workout_session"."completed_at" IS NULL
          AND "workout_session"."abandoned_at" IS NULL)
        OR ("workout_session"."status" = 'paused'
          AND "workout_session"."snapshot_finalized_at" IS NOT NULL
          AND "workout_session"."paused_at" IS NOT NULL
          AND "workout_session"."completed_at" IS NULL
          AND "workout_session"."abandoned_at" IS NULL)
        OR ("workout_session"."status" = 'completed'
          AND "workout_session"."snapshot_finalized_at" IS NOT NULL
          AND "workout_session"."paused_at" IS NULL
          AND "workout_session"."completed_at" IS NOT NULL
          AND "workout_session"."abandoned_at" IS NULL)
        OR ("workout_session"."status" = 'abandoned'
          AND "workout_session"."snapshot_finalized_at" IS NOT NULL
          AND "workout_session"."paused_at" IS NULL
          AND "workout_session"."completed_at" IS NULL
          AND "workout_session"."abandoned_at" IS NOT NULL));
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM session_feedback AS feedback
    JOIN workout_session AS session ON session.id = feedback.session_id
    WHERE session.status = 'completed'
      AND feedback.pain_reported = true
      AND NOT EXISTS (
        SELECT 1
        FROM training_command_receipt AS receipt
        WHERE receipt.user_id = session.user_id
          AND receipt.session_id = session.id
          AND receipt.target_id = session.id
          AND receipt.command_type = 'report-pain'
      )
  ) THEN
    RAISE EXCEPTION 'Cannot migrate completed pain feedback without an attributable report-pain receipt.'
      USING ERRCODE = '55000';
  END IF;
END;
$$;--> statement-breakpoint

WITH legacy_feedback AS (
  SELECT
    feedback.session_id,
    feedback.details,
    feedback.answered_at,
    session.user_id,
    receipt.command_id
  FROM session_feedback AS feedback
  JOIN workout_session AS session ON session.id = feedback.session_id
  JOIN LATERAL (
    SELECT candidate.command_id
    FROM training_command_receipt AS candidate
    WHERE candidate.user_id = session.user_id
      AND candidate.session_id = session.id
      AND candidate.target_id = session.id
      AND candidate.command_type = 'report-pain'
    ORDER BY candidate.created_at DESC, candidate.command_id DESC
    LIMIT 1
  ) AS receipt ON true
  WHERE session.status = 'completed'
    AND feedback.pain_reported = true
)
INSERT INTO training_fact_correction (
  id,
  user_id,
  session_id,
  actor_user_id,
  command_id,
  correction_kind,
  sequence,
  reason,
  created_at
)
SELECT
  'legacy-h1-feedback:' || session_id,
  user_id,
  session_id,
  user_id,
  command_id,
  'session-feedback',
  1,
  'Legacy post-completion safety report migrated to an append-only correction.',
  answered_at
FROM legacy_feedback;--> statement-breakpoint

INSERT INTO session_feedback_correction (
  correction_id,
  session_id,
  user_id,
  pain_reported,
  details,
  answered_at
)
SELECT
  correction.id,
  correction.session_id,
  correction.user_id,
  true,
  feedback.details,
  feedback.answered_at
FROM training_fact_correction AS correction
JOIN session_feedback AS feedback ON feedback.session_id = correction.session_id
WHERE correction.id = 'legacy-h1-feedback:' || correction.session_id;--> statement-breakpoint

WITH RECURSIVE affected_revision(correction_id, revision_id) AS (
  SELECT DISTINCT correction.id, decision.applied_revision_id
  FROM training_fact_correction AS correction
  JOIN adjustment_decision AS decision ON decision.session_id = correction.session_id
  WHERE correction.id = 'legacy-h1-feedback:' || correction.session_id
    AND decision.applied_revision_id IS NOT NULL
  UNION
  SELECT affected.correction_id, lineage.revision_id
  FROM affected_revision AS affected
  JOIN program_revision_lineage AS lineage
    ON lineage.parent_revision_id = affected.revision_id
)
INSERT INTO program_revision_invalidation (revision_id, correction_id, created_at)
SELECT revision_id, correction_id, now()
FROM affected_revision
ON CONFLICT (revision_id) DO NOTHING;--> statement-breakpoint

WITH RECURSIVE affected_revision(correction_id, source_session_id, revision_id) AS (
  SELECT DISTINCT correction.id, correction.session_id, decision.applied_revision_id
  FROM training_fact_correction AS correction
  JOIN adjustment_decision AS decision ON decision.session_id = correction.session_id
  WHERE correction.id = 'legacy-h1-feedback:' || correction.session_id
    AND decision.applied_revision_id IS NOT NULL
  UNION
  SELECT affected.correction_id, affected.source_session_id, lineage.revision_id
  FROM affected_revision AS affected
  JOIN program_revision_lineage AS lineage
    ON lineage.parent_revision_id = affected.revision_id
), affected_decision AS (
  SELECT DISTINCT correction.id AS correction_id, decision.id AS decision_id
  FROM training_fact_correction AS correction
  JOIN adjustment_decision AS decision ON decision.session_id = correction.session_id
  WHERE correction.id = 'legacy-h1-feedback:' || correction.session_id
  UNION
  SELECT DISTINCT affected.correction_id, decision.id
  FROM affected_revision AS affected
  JOIN planned_workout AS workout ON workout.revision_id = affected.revision_id
  JOIN workout_session AS session ON session.planned_workout_id = workout.id
  JOIN adjustment_decision AS decision ON decision.session_id = session.id
)
INSERT INTO adjustment_decision_invalidation (decision_id, correction_id, created_at)
SELECT decision_id, correction_id, now()
FROM affected_decision
ON CONFLICT (decision_id) DO NOTHING;--> statement-breakpoint

UPDATE workout_session AS session
SET status = 'paused',
    paused_at = now(),
    optimistic_version = session.optimistic_version + 1,
    updated_at = now()
FROM planned_workout AS workout
JOIN program_revision_invalidation AS invalidation
  ON invalidation.revision_id = workout.revision_id
JOIN training_fact_correction AS correction
  ON correction.id = invalidation.correction_id
WHERE workout.id = session.planned_workout_id
  AND correction.id = 'legacy-h1-feedback:' || correction.session_id
  AND session.status = 'active';--> statement-breakpoint

WITH superseded AS (
  UPDATE program_revision AS revision
  SET status = 'superseded'
  FROM program_revision_invalidation AS invalidation
  JOIN training_fact_correction AS correction
    ON correction.id = invalidation.correction_id
  WHERE revision.id = invalidation.revision_id
    AND correction.id = 'legacy-h1-feedback:' || correction.session_id
    AND revision.status = 'active'
  RETURNING revision.program_id
)
UPDATE program AS aggregate
SET status = 'retired', updated_at = now()
WHERE aggregate.status = 'active'
  AND aggregate.id IN (SELECT program_id FROM superseded);--> statement-breakpoint

INSERT INTO audit_event (
  id,
  actor_user_id,
  subject_user_id,
  event_type,
  entity_type,
  entity_id,
  metadata,
  created_at
)
SELECT
  'legacy-h1-audit:' || correction.session_id,
  correction.user_id,
  correction.user_id,
  'training-fact-migrated',
  'workout-session',
  correction.session_id,
  jsonb_build_object('correctionId', correction.id, 'migration', '0011'),
  now()
FROM training_fact_correction AS correction
WHERE correction.id = 'legacy-h1-feedback:' || correction.session_id;--> statement-breakpoint

ALTER TABLE session_feedback DISABLE TRIGGER session_feedback_terminal_guard;--> statement-breakpoint
ALTER TABLE session_feedback DISABLE TRIGGER session_feedback_monotonicity_guard;--> statement-breakpoint
UPDATE session_feedback AS feedback
SET pain_reported = false,
    details = NULL,
    answered_at = session.completed_at
FROM workout_session AS session
WHERE session.id = feedback.session_id
  AND session.status = 'completed'
  AND feedback.pain_reported = true;--> statement-breakpoint
ALTER TABLE session_feedback ENABLE TRIGGER session_feedback_monotonicity_guard;--> statement-breakpoint
ALTER TABLE session_feedback ENABLE TRIGGER session_feedback_terminal_guard;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM program_revision_lineage AS lineage
    JOIN program_revision AS child ON child.id = lineage.revision_id
    JOIN program_revision AS parent ON parent.id = lineage.parent_revision_id
    JOIN program AS aggregate ON aggregate.id = parent.program_id
    JOIN workout_session AS session ON session.id = lineage.source_session_id
    JOIN planned_workout AS workout ON workout.id = session.planned_workout_id
    WHERE child.program_id <> parent.program_id
      OR child.revision_number <= parent.revision_number
      OR session.user_id <> aggregate.user_id
      OR workout.revision_id <> parent.id
      OR workout.program_ordinal <> lineage.source_program_ordinal
  ) THEN
    RAISE EXCEPTION 'Existing program revision lineage violates ownership or monotonicity.'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_program_aggregate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id, 0));
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'program aggregates must be inserted as draft'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF current_setting('indigo.deletion_mode', true)
      IN ('instance-reset', 'trainee-data') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'program aggregates may be deleted only by an authorized deletion workflow'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id, 0));

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'program identity and ownership are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = NEW.status THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'program updates require a monotonic state transition'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('active', 'retired'))
    OR (OLD.status = 'active' AND NEW.status = 'retired')
  ) OR (to_jsonb(NEW) - ARRAY['status', 'updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at']) THEN
    RAISE EXCEPTION 'invalid program state transition'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM safety_hold AS hold
    WHERE hold.user_id = NEW.user_id
      AND hold.cleared_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM safety_hold_resolution AS resolution
        WHERE resolution.hold_id = hold.id
      )
  ) THEN
    RAISE EXCEPTION 'programs cannot activate while a safety hold is active'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER program_aggregate_guard
BEFORE INSERT OR UPDATE OR DELETE ON program
FOR EACH ROW EXECUTE FUNCTION indigo_guard_program_aggregate();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_program_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_user_id text;
  hold_active boolean;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    SELECT aggregate.user_id
    INTO revision_user_id
    FROM program AS aggregate
    WHERE aggregate.id = NEW.program_id;
    IF revision_user_id IS NULL THEN
      RAISE EXCEPTION 'program revision owner is unavailable' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(revision_user_id, 0));
    SELECT EXISTS (
      SELECT 1 FROM safety_hold AS hold
      WHERE hold.user_id = revision_user_id
        AND hold.cleared_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM safety_hold_resolution AS resolution
          WHERE resolution.hold_id = hold.id
        )
    ) INTO hold_active;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.activated_at IS NOT NULL
      OR NEW.revision_number <= 0 THEN
      RAISE EXCEPTION 'program revisions must be inserted as an unactivated positive-numbered draft'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF current_setting('indigo.deletion_mode', true)
      IN ('instance-reset', 'trainee-data') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'program revisions may be deleted only by an authorized deletion workflow'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.program_id IS DISTINCT FROM NEW.program_id
    OR OLD.revision_number IS DISTINCT FROM NEW.revision_number
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'program revision identity and ownership are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'superseded program revisions are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = NEW.status THEN
    IF OLD.status = 'draft' AND OLD.activated_at IS NOT DISTINCT FROM NEW.activated_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'released program revision content is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'active' THEN
    IF hold_active THEN
      RAISE EXCEPTION 'program revisions cannot activate while a safety hold is active'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.activated_at IS NOT NULL OR NEW.activated_at IS NULL
      OR (to_jsonb(NEW) - ARRAY['status', 'activated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'activated_at']) THEN
      RAISE EXCEPTION 'program revision activation may change only lifecycle facts'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM program_revision_invalidation
      WHERE revision_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'invalidated program revisions cannot be activated'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'superseded'
    AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid program revision state transition'
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
DROP TRIGGER program_revision_immutability_guard ON program_revision;--> statement-breakpoint
CREATE TRIGGER program_revision_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON program_revision
FOR EACH ROW EXECUTE FUNCTION indigo_guard_program_revision();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_prescription_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_status text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('indigo.deletion_mode', true)
    IN ('instance-reset', 'trainee-data') THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'prescription row identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'planned_workout' THEN
      IF OLD.revision_id IS DISTINCT FROM NEW.revision_id THEN
        RAISE EXCEPTION 'planned workout revision ownership is immutable'
          USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'exercise_prescription' THEN
      IF OLD.planned_workout_id IS DISTINCT FROM NEW.planned_workout_id THEN
        RAISE EXCEPTION 'exercise prescription ownership is immutable'
          USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'set_prescription' THEN
      IF OLD.exercise_prescription_id IS DISTINCT FROM NEW.exercise_prescription_id THEN
        RAISE EXCEPTION 'set prescription ownership is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'planned_workout' THEN
    SELECT status INTO revision_status FROM program_revision
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
  ELSIF TG_TABLE_NAME = 'exercise_prescription' THEN
    SELECT revision.status INTO revision_status
    FROM planned_workout AS workout
    JOIN program_revision AS revision ON revision.id = workout.revision_id
    WHERE workout.id = CASE
      WHEN TG_OP = 'DELETE' THEN OLD.planned_workout_id
      ELSE NEW.planned_workout_id
    END;
  ELSE
    SELECT revision.status INTO revision_status
    FROM exercise_prescription AS exercise
    JOIN planned_workout AS workout ON workout.id = exercise.planned_workout_id
    JOIN program_revision AS revision ON revision.id = workout.revision_id
    WHERE exercise.id = CASE
      WHEN TG_OP = 'DELETE' THEN OLD.exercise_prescription_id
      ELSE NEW.exercise_prescription_id
    END;
  END IF;

  IF revision_status IN ('active', 'superseded') THEN
    RAISE EXCEPTION 'released prescription rows are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prescription rows may be deleted only by an authorized deletion workflow'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_assert_workout_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_user_id text;
  program_status text;
  revision_status text;
  invalidated boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id, 0));
  SELECT aggregate.user_id, aggregate.status, revision.status,
    EXISTS (
      SELECT 1 FROM program_revision_invalidation AS invalidation
      WHERE invalidation.revision_id = revision.id
    )
  INTO expected_user_id, program_status, revision_status, invalidated
  FROM planned_workout AS workout
  JOIN program_revision AS revision ON revision.id = workout.revision_id
  JOIN program AS aggregate ON aggregate.id = revision.program_id
  WHERE workout.id = NEW.planned_workout_id;

  IF expected_user_id IS NULL OR expected_user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'workout session owner does not own planned workout'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND (
    program_status <> 'active'
    OR revision_status <> 'active'
    OR invalidated
    OR NEW.status <> 'initializing'
    OR NEW.snapshot_finalized_at IS NOT NULL
    OR NEW.optimistic_version <> 1
    OR NEW.paused_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR NEW.abandoned_at IS NOT NULL
    OR NEW.abandoned_reason IS NOT NULL
    OR NEW.completion_command_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM safety_hold AS hold
      WHERE hold.user_id = NEW.user_id
        AND hold.cleared_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM safety_hold_resolution AS resolution
          WHERE resolution.hold_id = hold.id
        )
    )
  ) THEN
    RAISE EXCEPTION 'workout sessions must begin as an unfinalized initializing snapshot on an active prescription'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_terminal_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_invalidated boolean;
  hold_active boolean;
  completion_ready boolean;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id, 0));
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'initializing'
      OR NEW.snapshot_finalized_at IS NOT NULL
      OR NEW.optimistic_version <> 1
      OR NEW.paused_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.abandoned_at IS NOT NULL
      OR NEW.abandoned_reason IS NOT NULL
      OR NEW.completion_command_id IS NOT NULL THEN
      RAISE EXCEPTION 'workout sessions must be inserted in initializing state'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF current_setting('indigo.deletion_mode', true)
      IN ('instance-reset', 'trainee-data') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'workout sessions may be deleted only by an authorized deletion workflow'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.planned_workout_id IS DISTINCT FROM NEW.planned_workout_id
    OR OLD.planned_workout_name IS DISTINCT FROM NEW.planned_workout_name
    OR OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date
    OR OLD.slot_code IS DISTINCT FROM NEW.slot_code
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR OLD.start_command_id IS DISTINCT FROM NEW.start_command_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'workout session ownership and snapshot facts are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('completed', 'abandoned') THEN
    RAISE EXCEPTION 'terminal workout sessions are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'initializing' AND NEW.status = 'active'
    AND OLD.snapshot_finalized_at IS NULL
    AND NEW.snapshot_finalized_at IS NOT NULL
    AND NEW.optimistic_version = OLD.optimistic_version
    AND (to_jsonb(NEW) - ARRAY['status', 'snapshot_finalized_at', 'updated_at'])
      = (to_jsonb(OLD) - ARRAY['status', 'snapshot_finalized_at', 'updated_at']) THEN
    IF EXISTS (
      SELECT 1 FROM safety_hold AS hold
      WHERE hold.user_id = NEW.user_id
        AND hold.cleared_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM safety_hold_resolution AS resolution
          WHERE resolution.hold_id = hold.id
        )
    ) THEN
      RAISE EXCEPTION 'session snapshot cannot finalize while a safety hold is active'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM planned_workout AS workout
      JOIN program_revision_invalidation AS invalidation
        ON invalidation.revision_id = workout.revision_id
      WHERE workout.id = NEW.planned_workout_id
    ) THEN
      RAISE EXCEPTION 'session snapshot cannot finalize on an invalidated revision'
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM session_exercise WHERE session_id = NEW.id
    ) OR EXISTS (
      SELECT 1
      FROM session_exercise AS exercise
      WHERE exercise.session_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM performed_set AS performed
          WHERE performed.session_exercise_id = exercise.id
        )
    ) THEN
      RAISE EXCEPTION 'session snapshot cannot finalize without exercises and sets'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'initializing' THEN
    RAISE EXCEPTION 'initializing sessions may only finalize to active'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.snapshot_finalized_at IS DISTINCT FROM OLD.snapshot_finalized_at THEN
    RAISE EXCEPTION 'finalized session snapshot marker is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = NEW.status THEN
    IF OLD.status = 'active'
      AND NEW.optimistic_version = OLD.optimistic_version + 1
      AND (to_jsonb(NEW) - ARRAY['optimistic_version', 'updated_at'])
        = (to_jsonb(OLD) - ARRAY['optimistic_version', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'session versions advance exactly once with a supported mutation'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.optimistic_version <> OLD.optimistic_version + 1 THEN
    RAISE EXCEPTION 'session lifecycle transitions must increment version exactly once'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM planned_workout AS workout
    JOIN program_revision_invalidation AS invalidation
      ON invalidation.revision_id = workout.revision_id
    WHERE workout.id = NEW.planned_workout_id
  ) INTO revision_invalidated;
  SELECT EXISTS (
    SELECT 1
    FROM safety_hold AS hold
    WHERE hold.user_id = NEW.user_id
      AND hold.cleared_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM safety_hold_resolution AS resolution
        WHERE resolution.hold_id = hold.id
      )
  ) INTO hold_active;

  IF OLD.status = 'active' AND NEW.status = 'paused'
    AND NEW.paused_at IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY['status', 'paused_at', 'optimistic_version', 'updated_at'])
      = (to_jsonb(OLD) - ARRAY['status', 'paused_at', 'optimistic_version', 'updated_at']) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'paused' AND NEW.status = 'active'
    AND NEW.paused_at IS NULL
    AND (to_jsonb(NEW) - ARRAY['status', 'paused_at', 'optimistic_version', 'updated_at'])
      = (to_jsonb(OLD) - ARRAY['status', 'paused_at', 'optimistic_version', 'updated_at']) THEN
    IF revision_invalidated OR hold_active THEN
      RAISE EXCEPTION 'paused sessions cannot resume under an invalidation or safety hold'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'completed'
    AND NEW.completed_at IS NOT NULL
    AND NEW.completion_command_id IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY['status', 'completed_at', 'completion_command_id', 'optimistic_version', 'updated_at'])
      = (to_jsonb(OLD) - ARRAY['status', 'completed_at', 'completion_command_id', 'optimistic_version', 'updated_at']) THEN
    SELECT
      NOT EXISTS (
        SELECT 1
        FROM performed_set AS performed
        JOIN session_exercise AS exercise
          ON exercise.id = performed.session_exercise_id
        WHERE exercise.session_id = NEW.id
          AND performed.status = 'pending'
      )
      AND EXISTS (
        SELECT 1 FROM session_feedback AS feedback
        WHERE feedback.session_id = NEW.id
          AND feedback.pain_reported = false
      )
      AND EXISTS (
        SELECT 1 FROM training_command_receipt AS receipt
        WHERE receipt.command_id = NEW.completion_command_id
          AND receipt.user_id = NEW.user_id
          AND receipt.session_id = NEW.id
          AND receipt.target_id = NEW.id
          AND receipt.command_type = 'complete-workout'
      )
    INTO completion_ready;
    IF revision_invalidated OR hold_active OR NOT completion_ready THEN
      RAISE EXCEPTION 'workout completion requires resolved sets, no-pain feedback, a receipt, and no safety block'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('active', 'paused') AND NEW.status = 'abandoned'
    AND NEW.paused_at IS NULL
    AND NEW.abandoned_at IS NOT NULL
    AND char_length(btrim(NEW.abandoned_reason)) BETWEEN 1 AND 300
    AND (to_jsonb(NEW) - ARRAY['status', 'paused_at', 'abandoned_at', 'abandoned_reason', 'optimistic_version', 'updated_at'])
      = (to_jsonb(OLD) - ARRAY['status', 'paused_at', 'abandoned_at', 'abandoned_reason', 'optimistic_version', 'updated_at']) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid workout session state transition'
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
DROP TRIGGER workout_session_terminal_guard ON workout_session;--> statement-breakpoint
CREATE TRIGGER workout_session_terminal_guard
BEFORE INSERT OR UPDATE OR DELETE ON workout_session
FOR EACH ROW EXECUTE FUNCTION indigo_guard_terminal_session();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_assert_finalized_workout_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status text;
  finalized_at timestamptz;
BEGIN
  SELECT status, snapshot_finalized_at
  INTO current_status, finalized_at
  FROM workout_session
  WHERE id = NEW.id;
  IF FOUND AND (current_status = 'initializing' OR finalized_at IS NULL) THEN
    RAISE EXCEPTION 'workout session snapshot must be finalized before commit'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workout_session_snapshot_finalized_guard
AFTER INSERT OR UPDATE ON workout_session
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION indigo_assert_finalized_workout_snapshot();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_terminal_session_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  finalized_at timestamptz;
  parent_session_id text;
  parent_user_id text;
  session_revision_id text;
  revision_invalidated boolean;
  hold_active boolean;
  receipt_matches boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('indigo.deletion_mode', true)
      IN ('instance-reset', 'trainee-data') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'session facts may be deleted only by an authorized deletion workflow'
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME IN ('session_exercise', 'adjustment_decision') THEN
    parent_session_id := NEW.session_id;
  ELSE
    SELECT exercise.session_id INTO parent_session_id
    FROM session_exercise AS exercise
    WHERE exercise.id = CASE
      WHEN TG_OP = 'UPDATE' THEN OLD.session_exercise_id
      ELSE NEW.session_exercise_id
    END;
  END IF;

  SELECT user_id INTO parent_user_id
  FROM workout_session
  WHERE id = parent_session_id;
  IF parent_user_id IS NULL THEN
    RAISE EXCEPTION 'parent workout session is unavailable' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(parent_user_id, 0));

  SELECT session.status, session.snapshot_finalized_at, session.user_id, workout.revision_id,
    EXISTS (
      SELECT 1 FROM program_revision_invalidation AS invalidation
      WHERE invalidation.revision_id = workout.revision_id
    ),
    EXISTS (
      SELECT 1
      FROM safety_hold AS hold
      WHERE hold.user_id = session.user_id
        AND hold.cleared_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM safety_hold_resolution AS resolution
          WHERE resolution.hold_id = hold.id
        )
    )
  INTO parent_status, finalized_at, parent_user_id, session_revision_id,
    revision_invalidated, hold_active
  FROM workout_session AS session
  JOIN planned_workout AS workout ON workout.id = session.planned_workout_id
  WHERE session.id = parent_session_id;

  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'session_exercise' THEN
      IF parent_status = 'initializing' AND finalized_at IS NULL THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'performed_set' THEN
      IF parent_status = 'initializing'
        AND finalized_at IS NULL
        AND NEW.status = 'pending'
        AND NEW.actual_load_grams IS NULL
        AND NEW.actual_repetitions IS NULL
        AND NEW.rpe IS NULL
        AND NEW.load_provenance IS NULL
        AND NEW.repetitions_provenance IS NULL
        AND NEW.explicitly_confirmed = false
        AND NEW.confirmed_at IS NULL
        AND NEW.skipped_at IS NULL
        AND NEW.skip_reason IS NULL
        AND NEW.note IS NULL
        AND NEW.command_id IS NULL THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'adjustment_decision' THEN
      IF parent_status = 'active' AND finalized_at IS NOT NULL
        AND NOT revision_invalidated AND NOT hold_active THEN
        IF NEW.applied_revision_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
          FROM program_revision_lineage AS lineage
          JOIN program_revision AS child ON child.id = lineage.revision_id
          JOIN program_revision AS parent ON parent.id = lineage.parent_revision_id
          WHERE lineage.revision_id = NEW.applied_revision_id
            AND lineage.source_session_id = NEW.session_id
            AND lineage.parent_revision_id = session_revision_id
            AND child.program_id = parent.program_id
        ) THEN
          RAISE EXCEPTION 'applied adjustment revision is not sourced from this session'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'session facts may be inserted only in their authorized lifecycle phase'
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'performed_set' THEN
    IF OLD.id IS DISTINCT FROM NEW.id
      OR OLD.session_exercise_id IS DISTINCT FROM NEW.session_exercise_id
      OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
      OR OLD.target_load_grams IS DISTINCT FROM NEW.target_load_grams
      OR OLD.target_repetitions IS DISTINCT FROM NEW.target_repetitions
      OR OLD.rest_seconds IS DISTINCT FROM NEW.rest_seconds
      OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'performed set identity, ownership, and targets are immutable'
        USING ERRCODE = '55000';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM training_command_receipt AS receipt
      WHERE receipt.command_id = NEW.command_id
        AND receipt.user_id = parent_user_id
        AND receipt.session_id = parent_session_id
        AND receipt.target_id = NEW.id
        AND receipt.command_type = CASE
          WHEN NEW.status = 'performed' THEN 'complete-set'
          ELSE 'skip-set'
        END
    ) INTO receipt_matches;
    IF parent_status <> 'active'
      OR revision_invalidated
      OR hold_active
      OR OLD.status <> 'pending'
      OR NEW.status NOT IN ('performed', 'skipped')
      OR NOT receipt_matches THEN
      RAISE EXCEPTION 'performed sets resolve once with an attributed command while training is eligible'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% facts are immutable after insertion', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS session_feedback_monotonicity_guard ON session_feedback;--> statement-breakpoint
CREATE OR REPLACE FUNCTION indigo_guard_terminal_session_feedback()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('indigo.deletion_mode', true)
    IN ('instance-reset', 'trainee-data') THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'session feedback is an immutable original fact; append a correction'
      USING ERRCODE = '55000';
  END IF;
  SELECT status INTO parent_status
  FROM workout_session
  WHERE id = NEW.session_id;
  IF parent_status NOT IN ('active', 'paused') THEN
    RAISE EXCEPTION 'terminal session feedback requires an append-only correction'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_program_revision_lineage_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  child_program_id text;
  child_status text;
  child_number integer;
  parent_program_id text;
  parent_status text;
  parent_number integer;
  program_user_id text;
  source_user_id text;
  source_status text;
  source_revision_id text;
  source_program_ordinal integer;
  parent_invalidated boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('indigo.deletion_mode', true)
      IN ('instance-reset', 'trainee-data') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'program revision lineage is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'program revision lineage is immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT aggregate.user_id
  INTO program_user_id
  FROM program_revision AS parent
  JOIN program AS aggregate ON aggregate.id = parent.program_id
  WHERE parent.id = NEW.parent_revision_id;
  IF program_user_id IS NULL THEN
    RAISE EXCEPTION 'program revision lineage parent is unavailable'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(program_user_id, 0));

  SELECT child.program_id, child.status, child.revision_number,
    parent.program_id, parent.status, parent.revision_number,
    aggregate.user_id,
    EXISTS (
      SELECT 1 FROM program_revision_invalidation AS invalidation
      WHERE invalidation.revision_id = parent.id
    )
  INTO child_program_id, child_status, child_number,
    parent_program_id, parent_status, parent_number,
    program_user_id, parent_invalidated
  FROM program_revision AS child
  JOIN program_revision AS parent ON parent.id = NEW.parent_revision_id
  JOIN program AS aggregate ON aggregate.id = parent.program_id
  WHERE child.id = NEW.revision_id;

  SELECT session.user_id, session.status, workout.revision_id, workout.program_ordinal
  INTO source_user_id, source_status, source_revision_id, source_program_ordinal
  FROM workout_session AS session
  JOIN planned_workout AS workout ON workout.id = session.planned_workout_id
  WHERE session.id = NEW.source_session_id;

  IF child_program_id IS NULL
    OR child_program_id <> parent_program_id
    OR child_status <> 'draft'
    OR parent_status <> 'active'
    OR child_number <= parent_number
    OR source_user_id <> program_user_id
    OR source_status <> 'active'
    OR source_revision_id <> NEW.parent_revision_id
    OR source_program_ordinal <> NEW.source_program_ordinal
    OR parent_invalidated THEN
    RAISE EXCEPTION 'program revision lineage ownership, order, or source facts are inconsistent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER program_revision_lineage_provenance_guard
BEFORE INSERT ON program_revision_lineage
FOR EACH ROW EXECUTE FUNCTION indigo_guard_program_revision_lineage_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_training_fact_correction_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_status text;
  expected_user_id text;
  receipt_type text;
  receipt_user_id text;
  receipt_session_id text;
  receipt_target_id text;
  receipt_status text;
  expected_sequence integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id, 0));
  SELECT status, user_id
  INTO session_status, expected_user_id
  FROM workout_session
  WHERE id = NEW.session_id;
  SELECT command_type, user_id, session_id, target_id,
    result_snapshot ->> 'status'
  INTO receipt_type, receipt_user_id, receipt_session_id, receipt_target_id,
    receipt_status
  FROM training_command_receipt
  WHERE command_id = NEW.command_id;
  SELECT COALESCE(MAX(sequence), 0)::integer + 1
  INTO expected_sequence
  FROM training_fact_correction
  WHERE session_id = NEW.session_id;

  IF expected_user_id IS NULL
    OR expected_user_id <> NEW.user_id
    OR NEW.actor_user_id <> NEW.user_id
    OR session_status <> 'completed'
    OR receipt_user_id IS DISTINCT FROM NEW.user_id
    OR receipt_session_id IS DISTINCT FROM NEW.session_id
    OR receipt_status IS DISTINCT FROM 'succeeded'
    OR receipt_type IS DISTINCT FROM (CASE
      WHEN NEW.correction_kind = 'session-feedback' THEN 'report-pain'
      ELSE 'correct-performed-set'
    END)
    OR (NEW.correction_kind = 'session-feedback'
      AND receipt_target_id IS DISTINCT FROM NEW.session_id)
    OR NEW.sequence <> expected_sequence THEN
    RAISE EXCEPTION 'correction provenance, receipt, or sequence is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER training_fact_correction_provenance_guard
BEFORE INSERT ON training_fact_correction
FOR EACH ROW EXECUTE FUNCTION indigo_guard_training_fact_correction_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_training_fact_specialization_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  root_kind text;
  root_session_id text;
  root_user_id text;
  root_command_id text;
  receipt_target_id text;
  original_pain boolean;
  target_session_id text;
BEGIN
  SELECT correction.correction_kind, correction.session_id,
    correction.user_id, correction.command_id, receipt.target_id
  INTO root_kind, root_session_id, root_user_id, root_command_id, receipt_target_id
  FROM training_fact_correction AS correction
  JOIN training_command_receipt AS receipt
    ON receipt.command_id = correction.command_id
  WHERE correction.id = NEW.correction_id;
  IF root_session_id IS DISTINCT FROM NEW.session_id
    OR root_user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'correction specialization does not match its root owner and session'
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'session_feedback_correction' THEN
    SELECT pain_reported INTO original_pain
    FROM session_feedback WHERE session_id = NEW.session_id;
    IF root_kind <> 'session-feedback'
      OR original_pain IS DISTINCT FROM false
      OR NEW.pain_reported IS DISTINCT FROM true
      OR receipt_target_id IS DISTINCT FROM NEW.session_id THEN
      RAISE EXCEPTION 'feedback corrections require an attributed original no-pain completion fact'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT exercise.session_id INTO target_session_id
    FROM performed_set AS performed
    JOIN session_exercise AS exercise ON exercise.id = performed.session_exercise_id
    WHERE performed.id = NEW.performed_set_id
      AND performed.status IN ('performed', 'skipped');
    IF root_kind <> 'performed-set'
      OR target_session_id IS DISTINCT FROM NEW.session_id
      OR receipt_target_id IS DISTINCT FROM NEW.performed_set_id THEN
      RAISE EXCEPTION 'performed-set correction target or receipt is inconsistent'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER session_feedback_correction_provenance_guard
BEFORE INSERT ON session_feedback_correction
FOR EACH ROW EXECUTE FUNCTION indigo_guard_training_fact_specialization_insert();--> statement-breakpoint
CREATE TRIGGER performed_set_correction_provenance_guard
BEFORE INSERT ON performed_set_correction
FOR EACH ROW EXECUTE FUNCTION indigo_guard_training_fact_specialization_insert();--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM adjustment_decision AS decision
    JOIN workout_session AS session ON session.id = decision.session_id
    JOIN planned_workout AS source_workout
      ON source_workout.id = session.planned_workout_id
    WHERE decision.applied_revision_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM program_revision_lineage AS lineage
        JOIN program_revision AS child ON child.id = lineage.revision_id
        JOIN program_revision AS parent ON parent.id = lineage.parent_revision_id
        WHERE lineage.revision_id = decision.applied_revision_id
          AND lineage.source_session_id = decision.session_id
          AND lineage.parent_revision_id = source_workout.revision_id
          AND child.program_id = parent.program_id
      )
  ) THEN
    RAISE EXCEPTION 'Existing adjustment decisions contain invalid applied-revision provenance.'
      USING ERRCODE = '55000';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_training_invalidation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  correction_user_id text;
  correction_session_id text;
  target_valid boolean;
BEGIN
  SELECT user_id, session_id
  INTO correction_user_id, correction_session_id
  FROM training_fact_correction
  WHERE id = NEW.correction_id;
  IF correction_user_id IS NULL THEN
    RAISE EXCEPTION 'training invalidation correction root is unavailable'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(correction_user_id, 0));

  IF TG_TABLE_NAME = 'program_revision_invalidation' THEN
    WITH RECURSIVE affected_revision(revision_id) AS (
      SELECT DISTINCT decision.applied_revision_id
      FROM adjustment_decision AS decision
      WHERE decision.session_id = correction_session_id
        AND decision.applied_revision_id IS NOT NULL
      UNION
      SELECT lineage.revision_id
      FROM affected_revision AS affected
      JOIN program_revision_lineage AS lineage
        ON lineage.parent_revision_id = affected.revision_id
    )
    SELECT EXISTS (
      SELECT 1 FROM affected_revision WHERE revision_id = NEW.revision_id
    ) INTO target_valid;
  ELSE
    WITH RECURSIVE affected_revision(revision_id) AS (
      SELECT DISTINCT decision.applied_revision_id
      FROM adjustment_decision AS decision
      WHERE decision.session_id = correction_session_id
        AND decision.applied_revision_id IS NOT NULL
      UNION
      SELECT lineage.revision_id
      FROM affected_revision AS affected
      JOIN program_revision_lineage AS lineage
        ON lineage.parent_revision_id = affected.revision_id
    )
    SELECT EXISTS (
      SELECT 1
      FROM adjustment_decision AS decision
      LEFT JOIN workout_session AS session ON session.id = decision.session_id
      LEFT JOIN planned_workout AS workout ON workout.id = session.planned_workout_id
      WHERE decision.id = NEW.decision_id
        AND (
          decision.session_id = correction_session_id
          OR workout.revision_id IN (SELECT revision_id FROM affected_revision)
        )
    ) INTO target_valid;
  END IF;

  IF NOT COALESCE(target_valid, false) THEN
    RAISE EXCEPTION 'training invalidation target is not causally affected by its correction'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER adjustment_decision_invalidation_provenance_guard
BEFORE INSERT ON adjustment_decision_invalidation
FOR EACH ROW EXECUTE FUNCTION indigo_guard_training_invalidation_insert();--> statement-breakpoint
CREATE TRIGGER program_revision_invalidation_provenance_guard
BEFORE INSERT ON program_revision_invalidation
FOR EACH ROW EXECUTE FUNCTION indigo_guard_training_invalidation_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_apply_program_revision_invalidation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_program_id text;
  revision_was_active boolean;
BEGIN
  SELECT program_id, status = 'active'
  INTO affected_program_id, revision_was_active
  FROM program_revision
  WHERE id = NEW.revision_id;

  UPDATE workout_session AS session
  SET status = 'paused',
      paused_at = NEW.created_at,
      optimistic_version = session.optimistic_version + 1,
      updated_at = NEW.created_at
  FROM planned_workout AS workout
  WHERE workout.id = session.planned_workout_id
    AND workout.revision_id = NEW.revision_id
    AND session.status = 'active';

  IF revision_was_active THEN
    UPDATE program_revision
    SET status = 'superseded'
    WHERE id = NEW.revision_id AND status = 'active';
    UPDATE program
    SET status = 'retired', updated_at = NEW.created_at
    WHERE id = affected_program_id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER program_revision_invalidation_effect_guard
AFTER INSERT ON program_revision_invalidation
FOR EACH ROW EXECUTE FUNCTION indigo_apply_program_revision_invalidation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_assert_complete_training_fact_correction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  root_kind text;
  root_session_id text;
  specialization_exists boolean;
  invalidation_complete boolean;
BEGIN
  SELECT correction_kind, session_id
  INTO root_kind, root_session_id
  FROM training_fact_correction
  WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF root_kind = 'session-feedback' THEN
    SELECT EXISTS (
      SELECT 1 FROM session_feedback_correction
      WHERE correction_id = NEW.id
    ) INTO specialization_exists;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM performed_set_correction
      WHERE correction_id = NEW.id
    ) INTO specialization_exists;
  END IF;

  WITH RECURSIVE affected_revision(revision_id) AS (
    SELECT DISTINCT decision.applied_revision_id
    FROM adjustment_decision AS decision
    WHERE decision.session_id = root_session_id
      AND decision.applied_revision_id IS NOT NULL
    UNION
    SELECT lineage.revision_id
    FROM affected_revision AS affected
    JOIN program_revision_lineage AS lineage
      ON lineage.parent_revision_id = affected.revision_id
  ), affected_decision(decision_id) AS (
    SELECT decision.id
    FROM adjustment_decision AS decision
    WHERE decision.session_id = root_session_id
    UNION
    SELECT decision.id
    FROM affected_revision AS affected
    JOIN planned_workout AS workout ON workout.revision_id = affected.revision_id
    JOIN workout_session AS session ON session.planned_workout_id = workout.id
    JOIN adjustment_decision AS decision ON decision.session_id = session.id
  )
  SELECT
    NOT EXISTS (
      SELECT 1 FROM affected_revision AS affected
      LEFT JOIN program_revision_invalidation AS invalidation
        ON invalidation.revision_id = affected.revision_id
      WHERE invalidation.revision_id IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM affected_decision AS affected
      LEFT JOIN adjustment_decision_invalidation AS invalidation
        ON invalidation.decision_id = affected.decision_id
      WHERE invalidation.decision_id IS NULL
    )
  INTO invalidation_complete;

  IF NOT specialization_exists OR NOT invalidation_complete THEN
    RAISE EXCEPTION 'training correction must commit with its specialization and complete invalidations'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER training_fact_correction_complete_guard
AFTER INSERT ON training_fact_correction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION indigo_assert_complete_training_fact_correction();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_append_only_training_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('indigo.deletion_mode', true)
    IN ('instance-reset', 'trainee-data') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER training_fact_correction_immutability_guard
BEFORE UPDATE OR DELETE ON training_fact_correction
FOR EACH ROW EXECUTE FUNCTION indigo_guard_append_only_training_fact();--> statement-breakpoint
CREATE TRIGGER session_feedback_correction_immutability_guard
BEFORE UPDATE OR DELETE ON session_feedback_correction
FOR EACH ROW EXECUTE FUNCTION indigo_guard_append_only_training_fact();--> statement-breakpoint
CREATE TRIGGER performed_set_correction_immutability_guard
BEFORE UPDATE OR DELETE ON performed_set_correction
FOR EACH ROW EXECUTE FUNCTION indigo_guard_append_only_training_fact();--> statement-breakpoint
CREATE TRIGGER adjustment_decision_invalidation_immutability_guard
BEFORE UPDATE OR DELETE ON adjustment_decision_invalidation
FOR EACH ROW EXECUTE FUNCTION indigo_guard_append_only_training_fact();--> statement-breakpoint
CREATE TRIGGER program_revision_invalidation_immutability_guard
BEFORE UPDATE OR DELETE ON program_revision_invalidation
FOR EACH ROW EXECUTE FUNCTION indigo_guard_append_only_training_fact();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_completed_session_invalidation_is_durable(
  source_session_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE affected_revision(revision_id) AS (
    SELECT DISTINCT decision.applied_revision_id
    FROM adjustment_decision AS decision
    WHERE decision.session_id = source_session_id
      AND decision.applied_revision_id IS NOT NULL
    UNION
    SELECT lineage.revision_id
    FROM affected_revision AS affected
    JOIN program_revision_lineage AS lineage
      ON lineage.parent_revision_id = affected.revision_id
  ), affected_decision(decision_id) AS (
    SELECT decision.id
    FROM adjustment_decision AS decision
    WHERE decision.session_id = source_session_id
    UNION
    SELECT decision.id
    FROM affected_revision AS affected
    JOIN planned_workout AS workout ON workout.revision_id = affected.revision_id
    JOIN workout_session AS session ON session.planned_workout_id = workout.id
    JOIN adjustment_decision AS decision ON decision.session_id = session.id
  )
  SELECT
    EXISTS (
      SELECT 1
      FROM training_fact_correction AS correction
      JOIN session_feedback_correction AS feedback
        ON feedback.correction_id = correction.id
      WHERE correction.session_id = source_session_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM affected_revision AS affected
      LEFT JOIN program_revision_invalidation AS invalidation
        ON invalidation.revision_id = affected.revision_id
      WHERE invalidation.revision_id IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM affected_decision AS affected
      LEFT JOIN adjustment_decision_invalidation AS invalidation
        ON invalidation.decision_id = affected.decision_id
      WHERE invalidation.decision_id IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM affected_revision AS affected
      JOIN planned_workout AS workout ON workout.revision_id = affected.revision_id
      JOIN workout_session AS session ON session.planned_workout_id = workout.id
      WHERE session.status IN ('initializing', 'active', 'paused')
    );
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_safety_hold_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deletion_mode text := current_setting('indigo.deletion_mode', true);
  source_reason text;
  source_session_id text;
  source_session_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF deletion_mode IN ('trainee-data', 'instance-reset') THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Safety hold resolutions may only be deleted by an authorized deletion workflow.'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Safety hold resolutions are append-only.'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id, 0));

  SELECT hold.reason_code, hold.source_session_id, session.status
  INTO source_reason, source_session_id, source_session_status
  FROM safety_hold AS hold
  LEFT JOIN workout_session AS session
    ON session.id = hold.source_session_id
   AND session.user_id = hold.user_id
  WHERE hold.id = NEW.hold_id
    AND hold.user_id = NEW.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A safety hold resolution must belong to the same user as its hold.'
      USING ERRCODE = '23503';
  END IF;
  IF source_reason <> 'session-pain-reported' OR source_session_id IS NULL THEN
    RAISE EXCEPTION 'Legacy or non-session safety holds cannot be self-resolved.'
      USING ERRCODE = '23514';
  END IF;
  IF source_session_status = 'abandoned' THEN RETURN NEW; END IF;
  IF source_session_status = 'completed'
    AND indigo_completed_session_invalidation_is_durable(source_session_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The source and every affected workout must be terminal after complete invalidation.'
    USING ERRCODE = '23514';
END;
$$;
