CREATE TABLE "future_load_explanation_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"cache_key" text NOT NULL,
	"prose" text NOT NULL,
	"model_id" text NOT NULL,
	"model_content_digest" text NOT NULL,
	"served_model_name" text NOT NULL,
	"runtime_id" text NOT NULL,
	"runtime_attestation_digest" text NOT NULL,
	"prompt_version" text NOT NULL,
	"validator_version" text NOT NULL,
	"fact_bundle_hash" text NOT NULL,
	"generate_duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "future_load_explanation_cache_hashes_check" CHECK ("future_load_explanation_cache"."cache_key" ~ '^[0-9a-f]{64}$'
        AND "future_load_explanation_cache"."model_content_digest" ~ '^[0-9a-f]{64}$'
        AND "future_load_explanation_cache"."runtime_attestation_digest" ~ '^[0-9a-f]{64}$'
        AND "future_load_explanation_cache"."fact_bundle_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "future_load_explanation_cache_identity_check" CHECK (char_length("future_load_explanation_cache"."prose") BETWEEN 1 AND 8000
        AND "future_load_explanation_cache"."prose" ~ '[^[:space:]]'
        AND char_length("future_load_explanation_cache"."model_id") BETWEEN 1 AND 512
        AND "future_load_explanation_cache"."model_id" ~ '[^[:space:]]'
        AND char_length("future_load_explanation_cache"."served_model_name") BETWEEN 1 AND 256
        AND "future_load_explanation_cache"."served_model_name" ~ '[^[:space:]]'
        AND char_length("future_load_explanation_cache"."runtime_id") BETWEEN 1 AND 1024
        AND "future_load_explanation_cache"."runtime_id" ~ '[^[:space:]]'
        AND char_length("future_load_explanation_cache"."prompt_version") BETWEEN 1 AND 128
        AND "future_load_explanation_cache"."prompt_version" ~ '[^[:space:]]'
        AND char_length("future_load_explanation_cache"."validator_version") BETWEEN 1 AND 128
        AND "future_load_explanation_cache"."validator_version" ~ '[^[:space:]]'),
	CONSTRAINT "future_load_explanation_cache_duration_check" CHECK ("future_load_explanation_cache"."generate_duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "future_load_explanation_cache" ADD CONSTRAINT "future_load_explanation_cache_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adjustment_decision_id_session_uidx" ON "adjustment_decision" USING btree ("id","session_id");--> statement-breakpoint
ALTER TABLE "future_load_explanation_cache" ADD CONSTRAINT "future_load_explanation_cache_session_user_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."workout_session"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "future_load_explanation_cache" ADD CONSTRAINT "future_load_explanation_cache_decision_session_fk" FOREIGN KEY ("decision_id","session_id") REFERENCES "public"."adjustment_decision"("id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "future_load_explanation_cache_key_uidx" ON "future_load_explanation_cache" USING btree ("cache_key");--> statement-breakpoint
CREATE INDEX "future_load_explanation_cache_user_idx" ON "future_load_explanation_cache" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "future_load_explanation_cache_session_idx" ON "future_load_explanation_cache" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "future_load_explanation_cache_decision_uidx" ON "future_load_explanation_cache" USING btree ("decision_id");
