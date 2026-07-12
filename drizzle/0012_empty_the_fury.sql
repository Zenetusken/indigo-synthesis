CREATE TABLE "destructive_reauthentication_state" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"purpose" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer NOT NULL,
	"locked_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destructive_reauthentication_purpose_check" CHECK ("destructive_reauthentication_state"."purpose" IN ('trainee-data-deletion', 'instance-reset')),
	CONSTRAINT "destructive_reauthentication_attempts_check" CHECK ("destructive_reauthentication_state"."failed_attempts" BETWEEN 1 AND 5),
	CONSTRAINT "destructive_reauthentication_window_check" CHECK ("destructive_reauthentication_state"."window_started_at" <= "destructive_reauthentication_state"."last_attempt_at"),
	CONSTRAINT "destructive_reauthentication_lock_check" CHECK (("destructive_reauthentication_state"."failed_attempts" < 5 AND "destructive_reauthentication_state"."locked_until" IS NULL)
        OR ("destructive_reauthentication_state"."failed_attempts" = 5
          AND "destructive_reauthentication_state"."locked_until" IS NOT NULL
          AND "destructive_reauthentication_state"."locked_until" > "destructive_reauthentication_state"."window_started_at"))
);
--> statement-breakpoint
ALTER TABLE "destructive_reauthentication_state" ADD CONSTRAINT "destructive_reauthentication_state_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "destructive_reauthentication_account_purpose_uidx" ON "destructive_reauthentication_state" USING btree ("account_id","purpose");