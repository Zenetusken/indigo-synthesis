CREATE TABLE "program_revision_lineage" (
	"revision_id" text PRIMARY KEY NOT NULL,
	"parent_revision_id" text NOT NULL,
	"source_session_id" text NOT NULL,
	"source_program_ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_revision_lineage_source_session_id_unique" UNIQUE("source_session_id"),
	CONSTRAINT "program_revision_lineage_distinct_revision_check" CHECK ("program_revision_lineage"."revision_id" <> "program_revision_lineage"."parent_revision_id"),
	CONSTRAINT "program_revision_lineage_source_ordinal_check" CHECK ("program_revision_lineage"."source_program_ordinal" > 0)
);
--> statement-breakpoint
CREATE TABLE "training_command_receipt" (
	"command_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"command_type" text NOT NULL,
	"session_id" text NOT NULL,
	"target_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_command_receipt_type_check" CHECK ("training_command_receipt"."command_type" IN ('complete-set', 'skip-set', 'complete-workout', 'report-pain'))
);
--> statement-breakpoint
ALTER TABLE "planned_workout" ADD COLUMN "program_ordinal" integer;--> statement-breakpoint
-- The 0002 release guard correctly blocks every prescription-row update below an
-- active or superseded revision. This migration already holds an ACCESS EXCLUSIVE
-- table lock, so suspend only that guard for the deterministic ordinal backfill and
-- restore it before the transaction can commit.
ALTER TABLE "planned_workout" DISABLE TRIGGER "planned_workout_immutability_guard";--> statement-breakpoint
UPDATE "planned_workout" SET "program_ordinal" = "ordinal";--> statement-breakpoint
ALTER TABLE "planned_workout" ENABLE TRIGGER "planned_workout_immutability_guard";--> statement-breakpoint
ALTER TABLE "planned_workout" ALTER COLUMN "program_ordinal" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "program_revision_lineage" ADD CONSTRAINT "program_revision_lineage_revision_id_program_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."program_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_revision_lineage" ADD CONSTRAINT "program_revision_lineage_parent_revision_id_program_revision_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."program_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_revision_lineage" ADD CONSTRAINT "program_revision_lineage_source_session_id_workout_session_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."workout_session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_command_receipt" ADD CONSTRAINT "training_command_receipt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_command_receipt" ADD CONSTRAINT "training_command_receipt_session_id_workout_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_command_receipt_user_idx" ON "training_command_receipt" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "training_command_receipt_session_idx" ON "training_command_receipt" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "planned_workout_revision_program_ordinal_uidx" ON "planned_workout" USING btree ("revision_id","program_ordinal");--> statement-breakpoint
ALTER TABLE "planned_workout" ADD CONSTRAINT "planned_workout_program_ordinal_check" CHECK ("planned_workout"."program_ordinal" > 0);--> statement-breakpoint

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
CREATE TRIGGER program_revision_lineage_immutability_guard
BEFORE UPDATE OR DELETE ON program_revision_lineage
FOR EACH ROW EXECUTE FUNCTION indigo_guard_append_only_training_fact();--> statement-breakpoint
CREATE TRIGGER training_command_receipt_immutability_guard
BEFORE UPDATE OR DELETE ON training_command_receipt
FOR EACH ROW EXECUTE FUNCTION indigo_guard_append_only_training_fact();
