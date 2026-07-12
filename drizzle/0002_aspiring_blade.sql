ALTER TABLE "adjustment_decision" ADD COLUMN "applied_revision_id" text;--> statement-breakpoint
ALTER TABLE "workout_session" ADD COLUMN "planned_workout_name" text;--> statement-breakpoint
ALTER TABLE "workout_session" ADD COLUMN "scheduled_date" date;--> statement-breakpoint
ALTER TABLE "workout_session" ADD COLUMN "slot_code" text;--> statement-breakpoint
UPDATE "workout_session" AS ws
SET "planned_workout_name" = pw."name",
    "scheduled_date" = pw."scheduled_date",
    "slot_code" = pw."slot_code"
FROM "planned_workout" AS pw
WHERE pw."id" = ws."planned_workout_id";--> statement-breakpoint
ALTER TABLE "workout_session" ALTER COLUMN "planned_workout_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_session" ALTER COLUMN "scheduled_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_session" ALTER COLUMN "slot_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "adjustment_decision" ADD CONSTRAINT "adjustment_decision_applied_revision_id_program_revision_id_fk" FOREIGN KEY ("applied_revision_id") REFERENCES "public"."program_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "program_draft_user_uidx" ON "program" USING btree ("user_id") WHERE "program"."status" = 'draft';--> statement-breakpoint
ALTER TABLE "session_exercise" ADD CONSTRAINT "session_exercise_safety_tier_check" CHECK ("session_exercise"."safety_tier" IN ('standard', 'advanced', 'prohibited'));--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_slot_check" CHECK ("workout_session"."slot_code" IN ('A', 'B', 'C'));--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_lifecycle_shape_check" CHECK (("workout_session"."status" = 'active'
          AND "workout_session"."paused_at" IS NULL
          AND "workout_session"."completed_at" IS NULL
          AND "workout_session"."abandoned_at" IS NULL)
        OR ("workout_session"."status" = 'paused'
          AND "workout_session"."paused_at" IS NOT NULL
          AND "workout_session"."completed_at" IS NULL
          AND "workout_session"."abandoned_at" IS NULL)
        OR ("workout_session"."status" = 'completed'
          AND "workout_session"."paused_at" IS NULL
          AND "workout_session"."completed_at" IS NOT NULL
          AND "workout_session"."abandoned_at" IS NULL)
        OR ("workout_session"."status" = 'abandoned'
          AND "workout_session"."paused_at" IS NULL
          AND "workout_session"."completed_at" IS NULL
          AND "workout_session"."abandoned_at" IS NOT NULL));--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_assert_workout_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_user_id text;
BEGIN
  SELECT p.user_id
  INTO expected_user_id
  FROM planned_workout pw
  JOIN program_revision pr ON pr.id = pw.revision_id
  JOIN program p ON p.id = pr.program_id
  WHERE pw.id = NEW.planned_workout_id;

  IF expected_user_id IS NULL OR expected_user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'workout session owner does not own planned workout'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER workout_session_owner_guard
BEFORE INSERT OR UPDATE OF user_id, planned_workout_id ON workout_session
FOR EACH ROW EXECUTE FUNCTION indigo_assert_workout_owner();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_terminal_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('indigo.deletion_mode', true)
    IN ('instance-reset', 'trainee-data') THEN
    RETURN OLD;
  END IF;
  IF OLD.status IN ('completed', 'abandoned') THEN
    RAISE EXCEPTION 'terminal workout sessions are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER workout_session_terminal_guard
BEFORE UPDATE OR DELETE ON workout_session
FOR EACH ROW EXECUTE FUNCTION indigo_guard_terminal_session();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_terminal_session_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  exercise_id text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('indigo.deletion_mode', true)
    IN ('instance-reset', 'trainee-data') THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'session_exercise' THEN
      IF OLD.session_id IS DISTINCT FROM NEW.session_id THEN
        RAISE EXCEPTION 'session exercise ownership is immutable' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'performed_set' THEN
      IF OLD.session_exercise_id IS DISTINCT FROM NEW.session_exercise_id THEN
        RAISE EXCEPTION 'performed set ownership is immutable' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'adjustment_decision' THEN
      IF OLD.session_id IS DISTINCT FROM NEW.session_id THEN
        RAISE EXCEPTION 'adjustment ownership is immutable' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'session_exercise' THEN
    SELECT status INTO parent_status
    FROM workout_session
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.session_id ELSE NEW.session_id END;
  ELSIF TG_TABLE_NAME = 'adjustment_decision' THEN
    SELECT status INTO parent_status
    FROM workout_session
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.session_id ELSE NEW.session_id END;
  ELSE
    exercise_id := CASE
      WHEN TG_OP = 'DELETE' THEN OLD.session_exercise_id
      ELSE NEW.session_exercise_id
    END;
    SELECT ws.status INTO parent_status
    FROM session_exercise se
    JOIN workout_session ws ON ws.id = se.session_id
    WHERE se.id = exercise_id;
  END IF;

  IF parent_status IN ('completed', 'abandoned') THEN
    RAISE EXCEPTION 'terminal workout facts are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER session_exercise_terminal_guard
BEFORE INSERT OR UPDATE OR DELETE ON session_exercise
FOR EACH ROW EXECUTE FUNCTION indigo_guard_terminal_session_child();--> statement-breakpoint
CREATE TRIGGER performed_set_terminal_guard
BEFORE INSERT OR UPDATE OR DELETE ON performed_set
FOR EACH ROW EXECUTE FUNCTION indigo_guard_terminal_session_child();--> statement-breakpoint
CREATE TRIGGER adjustment_decision_terminal_guard
BEFORE INSERT OR UPDATE OR DELETE ON adjustment_decision
FOR EACH ROW EXECUTE FUNCTION indigo_guard_terminal_session_child();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_program_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('indigo.deletion_mode', true)
      IN ('instance-reset', 'trainee-data') THEN
      RETURN OLD;
    END IF;
    IF OLD.status IN ('active', 'superseded') THEN
      RAISE EXCEPTION 'released program revisions are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'superseded program revisions are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'active' AND NOT (
    NEW.status = 'superseded'
    AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')
  ) THEN
    RAISE EXCEPTION 'active program revision content is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER program_revision_immutability_guard
BEFORE UPDATE OR DELETE ON program_revision
FOR EACH ROW EXECUTE FUNCTION indigo_guard_program_revision();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_prescription_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_status text;
  row_id text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('indigo.deletion_mode', true)
    IN ('instance-reset', 'trainee-data') THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
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

  row_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  IF TG_TABLE_NAME = 'planned_workout' THEN
    SELECT status INTO revision_status
    FROM program_revision
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
  ELSIF TG_TABLE_NAME = 'exercise_prescription' THEN
    SELECT pr.status INTO revision_status
    FROM planned_workout pw
    JOIN program_revision pr ON pr.id = pw.revision_id
    WHERE pw.id = CASE
      WHEN TG_OP = 'DELETE' THEN OLD.planned_workout_id
      ELSE NEW.planned_workout_id
    END;
  ELSE
    SELECT pr.status INTO revision_status
    FROM exercise_prescription ep
    JOIN planned_workout pw ON pw.id = ep.planned_workout_id
    JOIN program_revision pr ON pr.id = pw.revision_id
    WHERE ep.id = CASE
      WHEN TG_OP = 'DELETE' THEN OLD.exercise_prescription_id
      ELSE NEW.exercise_prescription_id
    END;
  END IF;

  IF revision_status IN ('active', 'superseded') THEN
    RAISE EXCEPTION 'released prescription rows are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER planned_workout_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON planned_workout
FOR EACH ROW EXECUTE FUNCTION indigo_guard_prescription_child();--> statement-breakpoint
CREATE TRIGGER exercise_prescription_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON exercise_prescription
FOR EACH ROW EXECUTE FUNCTION indigo_guard_prescription_child();--> statement-breakpoint
CREATE TRIGGER set_prescription_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON set_prescription
FOR EACH ROW EXECUTE FUNCTION indigo_guard_prescription_child();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('indigo.deletion_mode', true)
    IN ('instance-reset', 'trainee-data') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_event_immutability_guard
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION indigo_guard_audit_event();--> statement-breakpoint

CREATE OR REPLACE FUNCTION indigo_guard_feedback_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.pain_reported = true AND NEW.pain_reported = false THEN
    RAISE EXCEPTION 'pain reports cannot be cleared by session completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER session_feedback_monotonicity_guard
BEFORE UPDATE ON session_feedback
FOR EACH ROW EXECUTE FUNCTION indigo_guard_feedback_monotonicity();
