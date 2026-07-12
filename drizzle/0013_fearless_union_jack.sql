CREATE TABLE "content_release_revocation" (
	"id" text PRIMARY KEY NOT NULL,
	"content_kind" text NOT NULL,
	"content_id" text NOT NULL,
	"content_version" text NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_release_revocation_kind_check" CHECK ("content_release_revocation"."content_kind" IN ('methodology', 'template')),
	CONSTRAINT "content_release_revocation_reason_check" CHECK (char_length("content_release_revocation"."reason") BETWEEN 1 AND 300
        AND left("content_release_revocation"."reason", 1) !~ '[[:space:]]'
        AND right("content_release_revocation"."reason", 1) !~ '[[:space:]]')
);
--> statement-breakpoint
ALTER TABLE "content_release_revocation" ADD CONSTRAINT "content_release_revocation_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_release_revocation_exact_uidx" ON "content_release_revocation" USING btree ("content_kind","content_id","content_version");--> statement-breakpoint
CREATE INDEX "content_release_revocation_actor_idx" ON "content_release_revocation" USING btree ("actor_user_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION indigo_guard_content_release_revocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting('indigo.deletion_mode', true) = 'instance-reset' THEN
    RETURN OLD;
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
$$;--> statement-breakpoint
CREATE TRIGGER content_release_revocation_append_only_guard
BEFORE UPDATE OR DELETE ON content_release_revocation
FOR EACH ROW EXECUTE FUNCTION indigo_guard_content_release_revocation();
