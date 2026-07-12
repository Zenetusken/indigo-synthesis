CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installation_state" (
	"singleton" smallint PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"bootstrap_closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_state_owner_user_id_unique" UNIQUE("owner_user_id"),
	CONSTRAINT "installation_state_singleton_check" CHECK ("installation_state"."singleton" = 1),
	CONSTRAINT "installation_state_owner_closed_check" CHECK (("installation_state"."owner_user_id" IS NULL AND "installation_state"."bootstrap_closed_at" IS NULL)
        OR ("installation_state"."owner_user_id" IS NOT NULL AND "installation_state"."bootstrap_closed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_state" ADD CONSTRAINT "installation_state_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_uidx" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_indigo_user_creation_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	claimed integer;
	creation_mode text;
BEGIN
	creation_mode := current_setting('indigo.user_creation_mode', true);

	IF creation_mode = 'owner-admin' THEN
		PERFORM 1
		FROM installation_state
		WHERE singleton = 1
			AND owner_user_id IS NOT NULL
			AND bootstrap_closed_at IS NOT NULL
		FOR UPDATE;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'local user creation requires a bootstrapped instance'
				USING ERRCODE = 'P0001';
		END IF;

		RETURN NEW;
	END IF;

	INSERT INTO installation_state (singleton, created_at, updated_at)
	VALUES (1, now(), now())
	ON CONFLICT (singleton) DO NOTHING;

	UPDATE installation_state
	SET owner_user_id = NEW.id,
		bootstrap_closed_at = now(),
		updated_at = now()
	WHERE singleton = 1
		AND owner_user_id IS NULL
		AND bootstrap_closed_at IS NULL;

	GET DIAGNOSTICS claimed = ROW_COUNT;

	IF claimed <> 1 THEN
		RAISE EXCEPTION 'owner bootstrap is closed' USING ERRCODE = 'P0001';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_creation_policy
AFTER INSERT ON "user"
FOR EACH ROW
EXECUTE FUNCTION enforce_indigo_user_creation_policy();
