CREATE OR REPLACE FUNCTION indigo_guard_terminal_session_feedback()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  write_mode text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('indigo.deletion_mode', true)
    IN ('instance-reset', 'trainee-data') THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.session_id IS DISTINCT FROM NEW.session_id THEN
    RAISE EXCEPTION 'session feedback ownership is immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT status INTO parent_status
  FROM workout_session
  WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.session_id ELSE NEW.session_id END;

  IF parent_status IN ('completed', 'abandoned') THEN
    write_mode := current_setting('indigo.session_feedback_write_mode', true);
    IF write_mode = 'post-completion-safety-report'
      AND TG_OP IN ('INSERT', 'UPDATE') THEN
      IF NEW.pain_reported = true THEN
        RETURN NEW;
      END IF;
    END IF;

    RAISE EXCEPTION 'terminal session feedback is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER session_feedback_terminal_guard
BEFORE INSERT OR UPDATE OR DELETE ON session_feedback
FOR EACH ROW EXECUTE FUNCTION indigo_guard_terminal_session_feedback();
