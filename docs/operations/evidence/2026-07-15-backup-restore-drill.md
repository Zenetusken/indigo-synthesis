# Backup/restore drill evidence — 2026-07-15

Scope: installation mutation-epoch migration checkpoint proof. Rerun after any later migration or
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
- cleanup: temporary archive removed and disposable database dropped in `finally`.

Retained result:

```text
Backup/restore drill passed.
PostgreSQL clients: pg_dump (PostgreSQL) 18.4; pg_restore (PostgreSQL) 18.4
Disposable target: indigo_backup_restore_c01e90508d2a80cfdfe0dfb6_integration
Archive: 176482 bytes, sha256 f071f5aa1943759cd2a06d0578575a51af7f6e67bff879ec97c9f657d55b8cf7
Restored preflight: PostgreSQL 18.4 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
Proof: installation epoch and exact audit row restored; append-only trigger rejected mutation (SQLSTATE 55000).
```

This proves the pre-existing installation epoch survives logical backup/restore exactly. It does
not claim operator media encryption, off-host retention, recovery-time objectives, or a human cold
install.
