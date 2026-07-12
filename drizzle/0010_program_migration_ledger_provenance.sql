DO $$
DECLARE
  migration_row_count integer;
  observed_hash text;
  origin_lf_hash constant text := 'a24d202530eb7b4179a65c0708a43b14cdd7f021bb8b5d082413148150f51c21';
  origin_crlf_hash constant text := '2900f743e521aa432d1fc6568aad04617cb89f6b9bccfb088c94ad6d23e04287';
  corrected_lf_hash constant text := 'e5d7105d56a02ba8874fef8f2a724981363e74f809b22d909a0e7cec75564ba0';
  corrected_crlf_hash constant text := 'd6267bcf692cdb7646813f1fa277d8e18b3fe495d267a342cd29e94700018431';
  migration_created_at constant bigint := 1783823225722;
BEGIN
  SELECT count(*)::integer, min(hash)
  INTO migration_row_count, observed_hash
  FROM drizzle.__drizzle_migrations
  WHERE created_at = migration_created_at;

  IF migration_row_count = 0 THEN
    RAISE EXCEPTION 'migration ledger is missing the canonical 0004 provenance row'
      USING ERRCODE = '55000';
  END IF;

  IF migration_row_count <> 1 THEN
    RAISE EXCEPTION 'migration ledger contains % rows for 0004 provenance', migration_row_count
      USING ERRCODE = '55000';
  END IF;

  IF observed_hash IN (origin_lf_hash, origin_crlf_hash, corrected_crlf_hash) THEN
    UPDATE drizzle.__drizzle_migrations
    SET hash = corrected_lf_hash
    WHERE created_at = migration_created_at
      AND hash = observed_hash;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'migration ledger 0004 provenance changed during normalization'
        USING ERRCODE = '55000';
    END IF;
  ELSIF observed_hash = corrected_lf_hash THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'migration ledger contains an unknown 0004 provenance hash: %', observed_hash
      USING ERRCODE = '55000';
  END IF;
END;
$$;
