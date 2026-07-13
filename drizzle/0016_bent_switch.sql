CREATE TABLE "member_reset_state" (
	"target_user_id" text PRIMARY KEY NOT NULL,
	"active_verification_id" text,
	"last_issued_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"retry_after" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_reset_state_attempts_check" CHECK ("member_reset_state"."failed_attempts" >= 0),
	CONSTRAINT "member_reset_state_attempt_shape_check" CHECK (("member_reset_state"."failed_attempts" = 0 AND "member_reset_state"."last_attempt_at" IS NULL AND "member_reset_state"."retry_after" IS NULL)
        OR ("member_reset_state"."failed_attempts" > 0 AND "member_reset_state"."last_attempt_at" IS NOT NULL)),
	CONSTRAINT "member_reset_state_attempt_order_check" CHECK ("member_reset_state"."last_attempt_at" IS NULL OR "member_reset_state"."last_attempt_at" >= "member_reset_state"."last_issued_at"),
	CONSTRAINT "member_reset_state_retry_check" CHECK ("member_reset_state"."retry_after" IS NULL OR "member_reset_state"."retry_after" > "member_reset_state"."last_attempt_at")
);
--> statement-breakpoint
CREATE TABLE "web_recovery_rate_limit_bucket" (
	"scope" text NOT NULL,
	"bucket_key" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempt_count" integer NOT NULL,
	"retry_after" timestamp with time zone,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_recovery_rate_limit_bucket_pk" PRIMARY KEY("scope","bucket_key"),
	CONSTRAINT "web_recovery_rate_limit_bucket_scope_check" CHECK ("web_recovery_rate_limit_bucket"."scope" IN (
        'sign-in:email',
        'sign-in:address',
        'member-reset:email',
        'member-reset:address',
        'owner-recovery:email',
        'owner-recovery:address'
      )),
	CONSTRAINT "web_recovery_rate_limit_bucket_key_check" CHECK ("web_recovery_rate_limit_bucket"."bucket_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "web_recovery_rate_limit_bucket_attempts_check" CHECK ("web_recovery_rate_limit_bucket"."attempt_count" >= 1),
	CONSTRAINT "web_recovery_rate_limit_bucket_window_check" CHECK ("web_recovery_rate_limit_bucket"."window_started_at" <= "web_recovery_rate_limit_bucket"."last_attempt_at"),
	CONSTRAINT "web_recovery_rate_limit_bucket_retry_check" CHECK ("web_recovery_rate_limit_bucket"."retry_after" IS NULL OR "web_recovery_rate_limit_bucket"."retry_after" > "web_recovery_rate_limit_bucket"."last_attempt_at")
);
--> statement-breakpoint
ALTER TABLE "destructive_reauthentication_state" DROP CONSTRAINT "destructive_reauthentication_purpose_check";--> statement-breakpoint
ALTER TABLE "member_reset_state" ADD CONSTRAINT "member_reset_state_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_reset_state" ADD CONSTRAINT "member_reset_state_active_verification_id_verification_id_fk" FOREIGN KEY ("active_verification_id") REFERENCES "public"."verification"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_reset_state_active_verification_uidx" ON "member_reset_state" USING btree ("active_verification_id");--> statement-breakpoint
CREATE INDEX "web_recovery_rate_limit_bucket_updated_idx" ON "web_recovery_rate_limit_bucket" USING btree ("updated_at","scope","bucket_key");--> statement-breakpoint
ALTER TABLE "destructive_reauthentication_state" ADD CONSTRAINT "destructive_reauthentication_purpose_check" CHECK ("destructive_reauthentication_state"."purpose" IN (
        'trainee-data-deletion',
        'instance-reset',
        'member-reset-issue',
        'local-user-create'
      ));
