CREATE OR REPLACE FUNCTION indigo_guard_content_release_revocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting('indigo.deletion_mode', true) = 'instance-reset' THEN
    RETURN OLD;
  END IF;

  -- The actor FK declares ON DELETE SET NULL, which PostgreSQL executes as a
  -- row UPDATE through this trigger. Permit exactly that transition — actor
  -- unlink with every fact column unchanged — and only inside a sanctioned
  -- deletion mode (mirroring the 0002 audit-event guard convention). Every
  -- other UPDATE remains append-only.
  IF TG_OP = 'UPDATE'
    AND current_setting('indigo.deletion_mode', true)
      IN ('instance-reset', 'trainee-data')
    AND NEW.id = OLD.id
    AND NEW.content_kind = OLD.content_kind
    AND NEW.content_id = OLD.content_id
    AND NEW.content_version = OLD.content_version
    AND NEW.reason = OLD.reason
    AND NEW.created_at = OLD.created_at
    AND NEW.actor_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Content release revocations are append-only.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Content release revocations are append-only.'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
