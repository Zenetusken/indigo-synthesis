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

	IF creation_mode IS DISTINCT FROM 'bootstrap-owner' THEN
		RAISE EXCEPTION 'user creation requires an explicit authorized mode'
			USING ERRCODE = 'P0001';
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
