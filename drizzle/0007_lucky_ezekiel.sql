CREATE TABLE "safety_hold_resolution" (
	"id" text PRIMARY KEY NOT NULL,
	"hold_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"acknowledged" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "training_command_receipt" DROP CONSTRAINT "training_command_receipt_type_check";--> statement-breakpoint
DROP INDEX "safety_hold_active_user_uidx";--> statement-breakpoint
ALTER TABLE "safety_hold" ADD COLUMN "source_session_id" text;--> statement-breakpoint
ALTER TABLE "safety_hold_resolution" ADD CONSTRAINT "safety_hold_resolution_hold_id_safety_hold_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."safety_hold"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_hold_resolution" ADD CONSTRAINT "safety_hold_resolution_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "safety_hold_resolution_hold_id_uidx" ON "safety_hold_resolution" USING btree ("hold_id");--> statement-breakpoint
CREATE INDEX "safety_hold_resolution_user_id_idx" ON "safety_hold_resolution" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "safety_hold" ADD CONSTRAINT "safety_hold_source_session_id_workout_session_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."workout_session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "safety_hold_source_session_id_idx" ON "safety_hold" USING btree ("source_session_id");--> statement-breakpoint
ALTER TABLE "training_command_receipt" ADD CONSTRAINT "training_command_receipt_type_check" CHECK ("training_command_receipt"."command_type" IN ('complete-set', 'skip-set', 'complete-workout', 'report-pain', 'resolve-safety-hold'));