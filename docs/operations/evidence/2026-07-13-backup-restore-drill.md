# Backup/restore drill evidence — 2026-07-13

Scope: local checkpoint proof against the current access/recovery working tree. Rerun
the command after any later migration or pre-release database-contract change.

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
- cleanup: temporary archive removed and disposable database dropped in `finally`.

Retained result:

```text
Backup/restore drill passed.
PostgreSQL clients: pg_dump (PostgreSQL) 18.4; pg_restore (PostgreSQL) 18.4
Archive: 176276 bytes, sha256 379194e4fce3c2371be68a47119b676e40a77633470ca093e96a5e51fe2a42b3
Restored preflight: PostgreSQL 18.4 on x86_64-pc-linux-musl, 64-bit
Proof: exact audit row restored; append-only trigger rejected mutation (SQLSTATE 55000).
```

The first attempted restore exposed a legitimate drill defect: wiping only `public`
left the `drizzle` migration schema in place, so `pg_restore --exit-on-error` rejected
`CREATE SCHEMA drizzle`. The drill now wipes and verifies absence of both application and
migration schemas before restore. The passing result above is from the corrected path
and was rerun after the access/recovery restore-hardening changes.

This is repository-level technical evidence, not the second-person cold-install check,
an off-host retention audit, or a recovery-time guarantee.
