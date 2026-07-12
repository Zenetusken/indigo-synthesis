ALTER TABLE "safety_hold_resolution" DROP CONSTRAINT "safety_hold_resolution_hold_id_safety_hold_id_fk";
--> statement-breakpoint
ALTER TABLE "safety_hold" DROP CONSTRAINT "safety_hold_source_session_id_workout_session_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "safety_hold_id_user_uidx" ON "safety_hold" USING btree ("id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "safety_hold_source_session_uidx" ON "safety_hold" USING btree ("source_session_id") WHERE "safety_hold"."source_session_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "workout_session_id_user_uidx" ON "workout_session" USING btree ("id","user_id");
--> statement-breakpoint
ALTER TABLE "safety_hold_resolution" ADD CONSTRAINT "safety_hold_resolution_hold_user_fk" FOREIGN KEY ("hold_id","user_id") REFERENCES "public"."safety_hold"("id","user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "safety_hold" ADD CONSTRAINT "safety_hold_source_session_user_fk" FOREIGN KEY ("source_session_id","user_id") REFERENCES "public"."workout_session"("id","user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "safety_hold_resolution" ADD CONSTRAINT "safety_hold_resolution_reason_check" CHECK ("safety_hold_resolution"."reason" = btrim("safety_hold_resolution"."reason") AND char_length("safety_hold_resolution"."reason") BETWEEN 1 AND 300);
--> statement-breakpoint
ALTER TABLE "safety_hold_resolution" ADD CONSTRAINT "safety_hold_resolution_acknowledged_check" CHECK ("safety_hold_resolution"."acknowledged" = true);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM safety_hold_resolution AS resolution
    JOIN safety_hold AS hold
      ON hold.id = resolution.hold_id
     AND hold.user_id = resolution.user_id
    LEFT JOIN workout_session AS session
      ON session.id = hold.source_session_id
     AND session.user_id = hold.user_id
    WHERE hold.reason_code <> 'session-pain-reported'
       OR hold.source_session_id IS NULL
       OR session.status IS DISTINCT FROM 'abandoned'
  ) THEN
    RAISE EXCEPTION 'Existing safety hold resolutions violate the fail-closed source-session policy.';
  END IF;
END;
$$;
--> statement-breakpoint
COMMENT ON COLUMN "safety_hold"."source_session_id" IS
  'NULL is retained for non-session and legacy-unlinked holds. No source is fabricated; source-less holds cannot be self-resolved.';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION indigo_guard_safety_hold_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deletion_mode text := current_setting('indigo.deletion_mode', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF deletion_mode IN ('trainee-data', 'instance-reset') THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION 'Safety hold facts may only be deleted by an authorized deletion workflow.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.reason_code = 'session-pain-reported' AND NEW.source_session_id IS NULL THEN
      RAISE EXCEPTION 'A session pain hold requires its real source workout session.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.reason_code <> 'session-pain-reported' AND NEW.source_session_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only a session pain hold may carry workout-session provenance.'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.source_session_id IS DISTINCT FROM OLD.source_session_id
    OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.details IS DISTINCT FROM OLD.details
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Safety hold provenance is immutable.'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.cleared_at IS NOT NULL AND NEW.cleared_at IS DISTINCT FROM OLD.cleared_at THEN
    RAISE EXCEPTION 'A cleared safety hold cannot be reopened or recleared.'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER safety_hold_provenance_guard
BEFORE INSERT OR UPDATE OR DELETE ON safety_hold
FOR EACH ROW
EXECUTE FUNCTION indigo_guard_safety_hold_provenance();
--> statement-breakpoint
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
    IF deletion_mode IN ('trainee-data', 'instance-reset') THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION 'Safety hold resolutions may only be deleted by an authorized deletion workflow.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Safety hold resolutions are append-only.'
      USING ERRCODE = '55000';
  END IF;

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
    RAISE EXCEPTION 'Legacy or non-session safety holds require an administrator-managed transition and cannot be self-resolved.'
      USING ERRCODE = '23514';
  END IF;

  IF source_session_status IS DISTINCT FROM 'abandoned' THEN
    RAISE EXCEPTION 'The source workout session must be abandoned before resolving its safety hold.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER safety_hold_resolution_append_only_guard
BEFORE INSERT OR UPDATE OR DELETE ON safety_hold_resolution
FOR EACH ROW
EXECUTE FUNCTION indigo_guard_safety_hold_resolution();
