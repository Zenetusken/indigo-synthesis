ALTER TABLE "safety_hold_resolution" DROP CONSTRAINT "safety_hold_resolution_reason_check";--> statement-breakpoint
ALTER TABLE "safety_hold_resolution" ADD CONSTRAINT "safety_hold_resolution_reason_check" CHECK (char_length("safety_hold_resolution"."reason") BETWEEN 1 AND 300
        AND left("safety_hold_resolution"."reason", 1) !~ '[[:space:]]'
        AND right("safety_hold_resolution"."reason", 1) !~ '[[:space:]]');--> statement-breakpoint
ALTER TABLE "safety_hold" ADD CONSTRAINT "safety_hold_clearance_shape_check" CHECK ("safety_hold"."cleared_at" IS NULL OR ("safety_hold"."reason_code" = 'eligibility-restriction' AND "safety_hold"."source_session_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "safety_hold" DISABLE TRIGGER safety_hold_provenance_guard;
--> statement-breakpoint
WITH legacy_hold_candidates AS (
  SELECT user_id, min(id) AS hold_id
  FROM safety_hold
  WHERE reason_code = 'session-pain-reported'
    AND source_session_id IS NULL
  GROUP BY user_id
  HAVING count(*) = 1
),
owned_safety_stop_events AS (
  SELECT event.subject_user_id AS user_id, event.entity_id AS session_id, event.metadata
  FROM audit_event AS event
  JOIN workout_session AS session
    ON session.id = event.entity_id
   AND session.user_id = event.subject_user_id
  WHERE event.event_type = 'session-safety-stop'
    AND event.entity_type = 'workout-session'
),
unique_creation_audit_sources AS (
  SELECT event.user_id, min(event.session_id) AS session_id
  FROM owned_safety_stop_events AS event
  JOIN session_feedback AS feedback
    ON feedback.session_id = event.session_id
   AND feedback.pain_reported = true
  WHERE event.metadata ->> 'coalescedWithExistingHold' = 'false'
  GROUP BY event.user_id
  HAVING count(*) = 1
),
fallback_pain_session_candidates AS (
  SELECT session.user_id, min(session.id) AS session_id
  FROM workout_session AS session
  JOIN session_feedback AS feedback ON feedback.session_id = session.id
  WHERE feedback.pain_reported = true
    AND NOT EXISTS (
      SELECT 1
      FROM owned_safety_stop_events AS event
      WHERE event.user_id = session.user_id
    )
  GROUP BY session.user_id
  HAVING count(*) = 1
),
proven_source_candidates AS (
  SELECT user_id, session_id
  FROM unique_creation_audit_sources
  UNION ALL
  SELECT user_id, session_id
  FROM fallback_pain_session_candidates
),
unambiguous_legacy_sources AS (
  SELECT hold.hold_id, source.session_id
  FROM legacy_hold_candidates AS hold
  JOIN proven_source_candidates AS source USING (user_id)
  WHERE NOT EXISTS (
    SELECT 1
    FROM safety_hold AS linked_hold
    WHERE linked_hold.source_session_id = source.session_id
  )
)
UPDATE safety_hold AS hold
SET source_session_id = source.session_id
FROM unambiguous_legacy_sources AS source
WHERE hold.id = source.hold_id;
--> statement-breakpoint
ALTER TABLE "safety_hold" ENABLE TRIGGER safety_hold_provenance_guard;
--> statement-breakpoint
COMMENT ON COLUMN "safety_hold"."source_session_id" IS
  'NULL on a session-pain-reported hold means the legacy source could not be proven unambiguously. It remains fail-closed for explicit administrator remediation; migrations never guess or fabricate a source.';
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
    IF NEW.cleared_at IS NOT NULL THEN
      RAISE EXCEPTION 'New safety holds cannot be inserted pre-cleared.'
        USING ERRCODE = '23514';
    END IF;

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

  IF NEW.cleared_at IS DISTINCT FROM OLD.cleared_at THEN
    IF OLD.reason_code <> 'eligibility-restriction'
      OR OLD.source_session_id IS NOT NULL
      OR OLD.cleared_at IS NOT NULL
      OR NEW.cleared_at IS NULL THEN
      RAISE EXCEPTION 'Only a source-less eligibility restriction hold may be cleared once.'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
COMMENT ON COLUMN "safety_hold"."cleared_at" IS
  'Monotonic administrative clearance for a source-less eligibility-restriction hold only. Session-pain holds are resolved exclusively through append-only safety_hold_resolution facts.';
