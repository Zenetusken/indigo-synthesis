CREATE TABLE "adjustment_decision" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"exercise_code" text NOT NULL,
	"decision" text NOT NULL,
	"current_load_grams" integer,
	"next_load_grams" integer,
	"reason_code" text NOT NULL,
	"rule_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustment_decision_kind_check" CHECK ("adjustment_decision"."decision" IN ('increase', 'hold', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "athlete_equipment" (
	"user_id" text NOT NULL,
	"equipment_code" text NOT NULL,
	CONSTRAINT "athlete_equipment_user_id_equipment_code_pk" PRIMARY KEY("user_id","equipment_code"),
	CONSTRAINT "athlete_equipment_code_check" CHECK ("athlete_equipment"."equipment_code" IN ('barbell', 'rack', 'bench', 'plates'))
);
--> statement-breakpoint
CREATE TABLE "athlete_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"units" text NOT NULL,
	"timezone" text NOT NULL,
	"goal" text NOT NULL,
	"experience" text NOT NULL,
	"session_minutes" smallint NOT NULL,
	"adult_attested" boolean NOT NULL,
	"technique_attested" boolean NOT NULL,
	"restriction_status" text NOT NULL,
	"limitations" text,
	"confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "athlete_profile_units_check" CHECK ("athlete_profile"."units" IN ('metric', 'imperial')),
	CONSTRAINT "athlete_profile_goal_check" CHECK ("athlete_profile"."goal" = 'general-strength'),
	CONSTRAINT "athlete_profile_experience_check" CHECK ("athlete_profile"."experience" IN ('familiar', 'experienced')),
	CONSTRAINT "athlete_profile_session_minutes_check" CHECK ("athlete_profile"."session_minutes" BETWEEN 30 AND 120),
	CONSTRAINT "athlete_profile_restriction_check" CHECK ("athlete_profile"."restriction_status" IN ('none', 'present', 'uncertain'))
);
--> statement-breakpoint
CREATE TABLE "athlete_training_day" (
	"user_id" text NOT NULL,
	"weekday" smallint NOT NULL,
	"ordinal" smallint NOT NULL,
	CONSTRAINT "athlete_training_day_user_id_weekday_pk" PRIMARY KEY("user_id","weekday"),
	CONSTRAINT "athlete_training_day_weekday_check" CHECK ("athlete_training_day"."weekday" BETWEEN 0 AND 6),
	CONSTRAINT "athlete_training_day_ordinal_check" CHECK ("athlete_training_day"."ordinal" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"subject_user_id" text,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"plan_digest" text NOT NULL,
	"row_counts" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_plan_scope_check" CHECK ("deletion_plan"."scope" IN ('trainee-data', 'instance-reset'))
);
--> statement-breakpoint
CREATE TABLE "deletion_tombstone" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_class" text NOT NULL,
	"scope" text NOT NULL,
	"schema_version" text NOT NULL,
	"row_counts" jsonb NOT NULL,
	"completion_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercise_prescription" (
	"id" text PRIMARY KEY NOT NULL,
	"planned_workout_id" text NOT NULL,
	"exercise_code" text NOT NULL,
	"exercise_name" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"safety_tier" text DEFAULT 'standard' NOT NULL,
	"rationale_code" text NOT NULL,
	CONSTRAINT "exercise_prescription_ordinal_check" CHECK ("exercise_prescription"."ordinal" > 0),
	CONSTRAINT "exercise_prescription_safety_tier_check" CHECK ("exercise_prescription"."safety_tier" IN ('standard', 'advanced', 'prohibited'))
);
--> statement-breakpoint
CREATE TABLE "performed_set" (
	"id" text PRIMARY KEY NOT NULL,
	"session_exercise_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"target_load_grams" integer NOT NULL,
	"target_repetitions" smallint NOT NULL,
	"rest_seconds" integer NOT NULL,
	"actual_load_grams" integer,
	"actual_repetitions" smallint,
	"rpe" smallint,
	"load_provenance" text,
	"repetitions_provenance" text,
	"explicitly_confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"skip_reason" text,
	"note" text,
	"command_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performed_set_command_id_unique" UNIQUE("command_id"),
	CONSTRAINT "performed_set_ordinal_check" CHECK ("performed_set"."ordinal" > 0),
	CONSTRAINT "performed_set_status_check" CHECK ("performed_set"."status" IN ('pending', 'performed', 'skipped')),
	CONSTRAINT "performed_set_actual_load_check" CHECK ("performed_set"."actual_load_grams" IS NULL OR "performed_set"."actual_load_grams" BETWEEN 0 AND 1000000),
	CONSTRAINT "performed_set_actual_repetitions_check" CHECK ("performed_set"."actual_repetitions" IS NULL OR "performed_set"."actual_repetitions" BETWEEN 1 AND 100),
	CONSTRAINT "performed_set_rpe_check" CHECK ("performed_set"."rpe" IS NULL OR "performed_set"."rpe" BETWEEN 1 AND 10),
	CONSTRAINT "performed_set_provenance_check" CHECK (("performed_set"."load_provenance" IS NULL OR "performed_set"."load_provenance" IN ('copied-target', 'edited'))
        AND ("performed_set"."repetitions_provenance" IS NULL OR "performed_set"."repetitions_provenance" IN ('copied-target', 'edited'))),
	CONSTRAINT "performed_set_state_shape_check" CHECK (("performed_set"."status" = 'pending'
          AND "performed_set"."actual_load_grams" IS NULL
          AND "performed_set"."actual_repetitions" IS NULL
          AND "performed_set"."confirmed_at" IS NULL
          AND "performed_set"."skipped_at" IS NULL)
        OR ("performed_set"."status" = 'performed'
          AND "performed_set"."actual_load_grams" IS NOT NULL
          AND "performed_set"."actual_repetitions" IS NOT NULL
          AND "performed_set"."explicitly_confirmed" = true
          AND "performed_set"."confirmed_at" IS NOT NULL
          AND "performed_set"."skipped_at" IS NULL
          AND "performed_set"."skip_reason" IS NULL)
        OR ("performed_set"."status" = 'skipped'
          AND "performed_set"."actual_load_grams" IS NULL
          AND "performed_set"."actual_repetitions" IS NULL
          AND "performed_set"."explicitly_confirmed" = false
          AND "performed_set"."confirmed_at" IS NULL
          AND "performed_set"."skipped_at" IS NOT NULL
          AND "performed_set"."skip_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "planned_workout" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"scheduled_date" date NOT NULL,
	"ordinal" integer NOT NULL,
	"slot_code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planned_workout_ordinal_check" CHECK ("planned_workout"."ordinal" > 0),
	CONSTRAINT "planned_workout_slot_check" CHECK ("planned_workout"."slot_code" IN ('A', 'B', 'C'))
);
--> statement-breakpoint
CREATE TABLE "program_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"engine_version" text NOT NULL,
	"methodology_id" text NOT NULL,
	"methodology_version" text NOT NULL,
	"methodology_review_status" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"template_review_status" text NOT NULL,
	"normalized_input_hash" text NOT NULL,
	"output_hash" text NOT NULL,
	"normalized_input" jsonb NOT NULL,
	"output_snapshot" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manual_review_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "program_revision_status_check" CHECK ("program_revision"."status" IN ('draft', 'active', 'superseded')),
	CONSTRAINT "program_revision_methodology_review_check" CHECK ("program_revision"."methodology_review_status" IN ('development', 'reviewed', 'expired', 'prohibited')),
	CONSTRAINT "program_revision_template_review_check" CHECK ("program_revision"."template_review_status" IN ('development', 'reviewed', 'expired', 'prohibited'))
);
--> statement-breakpoint
CREATE TABLE "program" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_status_check" CHECK ("program"."status" IN ('draft', 'active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "safety_hold" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_exercise" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"exercise_code" text NOT NULL,
	"exercise_name" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"safety_tier" text NOT NULL,
	"rationale_code" text NOT NULL,
	"original_exercise_code" text NOT NULL,
	"substitution_reason" text,
	CONSTRAINT "session_exercise_ordinal_check" CHECK ("session_exercise"."ordinal" > 0)
);
--> statement-breakpoint
CREATE TABLE "session_feedback" (
	"session_id" text PRIMARY KEY NOT NULL,
	"pain_reported" boolean NOT NULL,
	"details" text,
	"answered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "set_prescription" (
	"id" text PRIMARY KEY NOT NULL,
	"exercise_prescription_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"set_kind" text DEFAULT 'working' NOT NULL,
	"target_load_grams" integer NOT NULL,
	"target_repetitions" smallint NOT NULL,
	"rest_seconds" integer NOT NULL,
	CONSTRAINT "set_prescription_ordinal_check" CHECK ("set_prescription"."ordinal" > 0),
	CONSTRAINT "set_prescription_kind_check" CHECK ("set_prescription"."set_kind" IN ('warmup', 'working')),
	CONSTRAINT "set_prescription_load_check" CHECK ("set_prescription"."target_load_grams" BETWEEN 0 AND 1000000),
	CONSTRAINT "set_prescription_repetitions_check" CHECK ("set_prescription"."target_repetitions" BETWEEN 1 AND 100),
	CONSTRAINT "set_prescription_rest_check" CHECK ("set_prescription"."rest_seconds" BETWEEN 0 AND 900)
);
--> statement-breakpoint
CREATE TABLE "strength_baseline" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"exercise_code" text NOT NULL,
	"load_grams" integer NOT NULL,
	"repetitions" smallint NOT NULL,
	"protocol" text NOT NULL,
	"tested_on" date NOT NULL,
	"provenance" text DEFAULT 'user-attested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strength_baseline_load_check" CHECK ("strength_baseline"."load_grams" BETWEEN 0 AND 1000000),
	CONSTRAINT "strength_baseline_repetitions_check" CHECK ("strength_baseline"."repetitions" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "workout_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"planned_workout_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"optimistic_version" integer DEFAULT 1 NOT NULL,
	"start_command_id" text NOT NULL,
	"completion_command_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workout_session_start_command_id_unique" UNIQUE("start_command_id"),
	CONSTRAINT "workout_session_completion_command_id_unique" UNIQUE("completion_command_id"),
	CONSTRAINT "workout_session_status_check" CHECK ("workout_session"."status" IN ('active', 'paused', 'completed', 'abandoned')),
	CONSTRAINT "workout_session_version_check" CHECK ("workout_session"."optimistic_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "adjustment_decision" ADD CONSTRAINT "adjustment_decision_session_id_workout_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_equipment" ADD CONSTRAINT "athlete_equipment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_profile" ADD CONSTRAINT "athlete_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_training_day" ADD CONSTRAINT "athlete_training_day_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_plan" ADD CONSTRAINT "deletion_plan_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_prescription" ADD CONSTRAINT "exercise_prescription_planned_workout_id_planned_workout_id_fk" FOREIGN KEY ("planned_workout_id") REFERENCES "public"."planned_workout"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performed_set" ADD CONSTRAINT "performed_set_session_exercise_id_session_exercise_id_fk" FOREIGN KEY ("session_exercise_id") REFERENCES "public"."session_exercise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_workout" ADD CONSTRAINT "planned_workout_revision_id_program_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."program_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_revision" ADD CONSTRAINT "program_revision_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program" ADD CONSTRAINT "program_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_hold" ADD CONSTRAINT "safety_hold_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exercise" ADD CONSTRAINT "session_exercise_session_id_workout_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_feedback" ADD CONSTRAINT "session_feedback_session_id_workout_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_prescription" ADD CONSTRAINT "set_prescription_exercise_prescription_id_exercise_prescription_id_fk" FOREIGN KEY ("exercise_prescription_id") REFERENCES "public"."exercise_prescription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_baseline" ADD CONSTRAINT "strength_baseline_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_planned_workout_id_planned_workout_id_fk" FOREIGN KEY ("planned_workout_id") REFERENCES "public"."planned_workout"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adjustment_decision_session_exercise_uidx" ON "adjustment_decision" USING btree ("session_id","exercise_code");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_training_day_ordinal_uidx" ON "athlete_training_day" USING btree ("user_id","ordinal");--> statement-breakpoint
CREATE INDEX "audit_event_subject_idx" ON "audit_event" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "audit_event_actor_idx" ON "audit_event" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "deletion_plan_user_idx" ON "deletion_plan" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_prescription_workout_ordinal_uidx" ON "exercise_prescription" USING btree ("planned_workout_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "performed_set_exercise_ordinal_uidx" ON "performed_set" USING btree ("session_exercise_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "planned_workout_revision_ordinal_uidx" ON "planned_workout" USING btree ("revision_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "planned_workout_revision_date_uidx" ON "planned_workout" USING btree ("revision_id","scheduled_date");--> statement-breakpoint
CREATE UNIQUE INDEX "program_revision_number_uidx" ON "program_revision" USING btree ("program_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "program_revision_active_uidx" ON "program_revision" USING btree ("program_id") WHERE "program_revision"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "program_active_user_uidx" ON "program" USING btree ("user_id") WHERE "program"."status" = 'active';--> statement-breakpoint
CREATE INDEX "safety_hold_user_id_idx" ON "safety_hold" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_hold_active_user_uidx" ON "safety_hold" USING btree ("user_id") WHERE "safety_hold"."cleared_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_exercise_session_ordinal_uidx" ON "session_exercise" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "set_prescription_exercise_ordinal_uidx" ON "set_prescription" USING btree ("exercise_prescription_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "strength_baseline_user_exercise_uidx" ON "strength_baseline" USING btree ("user_id","exercise_code");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_session_planned_workout_uidx" ON "workout_session" USING btree ("planned_workout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_session_active_user_uidx" ON "workout_session" USING btree ("user_id") WHERE "workout_session"."status" IN ('active', 'paused');