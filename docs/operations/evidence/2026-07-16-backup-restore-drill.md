# Backup/restore drill evidence — 2026-07-16

Scope: serialized host-preflight/migration and 19-migration checkpoint proof at committed
product tree `131222a112287921dbf811784fddf6e2f7bfaec4`. Rerun after any later migration or
pre-release database-contract change.

Command (credentials loaded from the ignored `.env.local`):

```sh
INDIGO_BACKUP_DRILL_PG_CONTAINER=indigo-synthesis-postgres \
  pnpm db:backup-restore-drill
```

Environment and safety facts:

- PostgreSQL server and client tools: 18.4;
- client adapter: explicitly selected same-server container, loopback port 5432;
- target: generated `indigo_backup_restore_<96-bit nonce>_integration` database;
- archive: custom format, `--no-owner`, `--no-privileges`, temporary mode `0600` file;
- cleanup: temporary archive removed and disposable database dropped in `finally`;
- restored preflight: all 19 committed migration hashes, 28 required integrity-trigger
  bindings, and authenticated-role allowance for the configured pool budget passed.

Retained result:

```text
Backup/restore drill passed.
PostgreSQL clients: pg_dump (PostgreSQL) 18.4; pg_restore (PostgreSQL) 18.4
Disposable target: indigo_backup_restore_8f29d89f481a130c19b26bc6_integration
Archive: 176840 bytes, sha256 da88858f1a010d27e0022d381d970906127dfb114916ed903314ad5dc2e2e72c
Restored preflight: PostgreSQL 18.4 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
Proof: installation epoch and exact audit row restored; append-only trigger rejected mutation (SQLSTATE 55000).
```

This is a test-only repository acceptance harness. It may use application-pool helpers
inside its random disposable database and therefore does not prove the production
one-shot connection topology. It also does not claim operator media encryption, off-host
retention, recovery-time objectives, or a human cold install.
