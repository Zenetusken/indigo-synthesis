# PostgreSQL backup and restore

Status: supported manual operator procedure; backup scheduling and retention automation
remain deployment concerns.

## Boundary and safety

The current application has one authoritative data boundary: PostgreSQL. Local media is
not implemented. If a writable media directory is added later, its contents must be
captured alongside PostgreSQL while application writes are stopped; a database-only
backup would then be incomplete.

A database archive contains sensitive account material, password digests, live session
tokens, recovery state, health context, and training history. Store it with mode `0600`
inside a mode-`0700` directory, encrypt it at rest and in transit, and keep an off-host
copy under the operator's retention policy. Runtime secrets such as
`BETTER_AUTH_SECRET` are configuration rather than product data, but disaster recovery
also requires a separately protected copy of that configuration. Never place plaintext
secrets in a command argument or in this repository.

Use `pg_dump` and `pg_restore` from the same PostgreSQL major version as the server, or a
newer supported client. The supported baseline is PostgreSQL 18 or newer.

Run every fenced production procedure below from the repository root in Bash, as the
same POSIX user that runs Indigo's packaged host commands. Each procedure joins the exact
same per-UID, non-blocking host-command lock used by migrations, preflight, bootstrap,
recovery, and maintenance. Do not run a second manual or automated Indigo host database
job in parallel. A different UID has a different lock namespace and therefore is not a
safe way to run concurrent work. If the lock is occupied, the procedure prints an error
and exits with status `75`; wait for the active job to finish rather than bypassing the
lock. The lock scopes below are deliberately bounded subshells so file descriptor `9` is
closed before a separately wrapped `pnpm` host command acquires the same lock.

## Create a backup

For the current database-only boundary, `pg_dump` takes a transactionally consistent
snapshot while the application is running. Stopping the application first gives the
clearest operational checkpoint and becomes mandatory if local media is ever enabled.

Configure libpq without putting the password on the command line. The examples below
assume a protected `PGPASSFILE` (mode `0600`) or an interactive password prompt. They
discard ambient password, service, host-address, and option overrides, pass the intended
endpoint explicitly, and verify the connected database, role, server address, and port
before touching data:

```sh
set -euo pipefail

export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER=indigo
export PGDATABASE=indigo_synthesis
export EXPECTED_PG_SERVER_ADDRESS=127.0.0.1
export BACKUP_DIRECTORY=/absolute/private/path/indigo-backups
export BACKUP_BASENAME="indigo-$(date -u +%Y%m%dT%H%M%SZ).dump"
export BACKUP_FILE="$BACKUP_DIRECTORY/$BACKUP_BASENAME"

unset PGPASSWORD PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS

umask 077
mkdir -p "$BACKUP_DIRECTORY"
chmod 700 "$BACKUP_DIRECTORY"

(
if ! command -v flock >/dev/null 2>&1; then
  echo "ERROR: flock is required to serialize Indigo host database commands" >&2
  exit 2
fi
source scripts/lib/host-lock.sh
LOCK_PATH="$(indigo_host_lock_dir)/database-external-host.lock"
exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "ERROR: another Indigo host database command is active ($LOCK_PATH)" >&2
  exit 75
fi

SOURCE_IDENTITY="$({
  psql --no-psqlrc \
    --host="$PGHOST" \
    --port="$PGPORT" \
    --username="$PGUSER" \
    --dbname="$PGDATABASE" \
    --tuples-only --no-align \
    --command="SELECT current_database() || '|' || current_user || '|' ||
      COALESCE(inet_server_addr()::text, '') || '|' || inet_server_port()::text"
} | tr -d '\r\n')"
test "$SOURCE_IDENTITY" = \
  "$PGDATABASE|$PGUSER|$EXPECTED_PG_SERVER_ADDRESS|$PGPORT"

pg_dump \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --dbname="$PGDATABASE" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" >"$BACKUP_FILE.list"
(
  cd "$BACKUP_DIRECTORY"
  sha256sum "$BACKUP_BASENAME" >"$BACKUP_BASENAME.sha256"
)
)
# The bounded backup lock scope has exited; file descriptor 9 is closed here.
```

Copy the archive, checksum, and inventory to the protected backup destination. Verify
the copied checksum there. A successful `pg_dump` is not restore evidence; run the drill
below regularly and before a release.

## Restore without overwriting the live database

Restore into a newly created empty database first. Do not drop, truncate, or restore over
the only live copy. Start this sequence in a fresh shell; `set -euo pipefail` is
load-bearing because any failed guard must stop the restore. The example target name is
deliberately distinct:

```sh
set -euo pipefail

: "${PGHOST:?Set PGHOST}"
: "${PGPORT:?Set PGPORT}"
: "${PGUSER:?Set PGUSER}"
: "${PGDATABASE:?Set the source/live database name}"
: "${EXPECTED_PG_SERVER_ADDRESS:?Set the expected literal PostgreSQL server address}"
: "${BACKUP_FILE:?Set BACKUP_FILE}"

export RESTORE_DATABASE=indigo_synthesis_restore_20260713
test "$RESTORE_DATABASE" != "$PGDATABASE"
unset PGPASSWORD PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS

(
if ! command -v flock >/dev/null 2>&1; then
  echo "ERROR: flock is required to serialize Indigo host database commands" >&2
  exit 2
fi
source scripts/lib/host-lock.sh
LOCK_PATH="$(indigo_host_lock_dir)/database-external-host.lock"
exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "ERROR: another Indigo host database command is active ($LOCK_PATH)" >&2
  exit 75
fi

(
  cd "$(dirname "$BACKUP_FILE")"
  sha256sum --check "$(basename "$BACKUP_FILE").sha256"
)
pg_restore --list "$BACKUP_FILE" >/dev/null

createdb \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --template=template0 \
  --owner="$PGUSER" \
  "$RESTORE_DATABASE"

RESTORE_IDENTITY="$({
  psql --no-psqlrc \
    --host="$PGHOST" \
    --port="$PGPORT" \
    --username="$PGUSER" \
    --dbname="$RESTORE_DATABASE" \
    --tuples-only --no-align \
    --command="SELECT current_database() || '|' || current_user || '|' ||
      COALESCE(inet_server_addr()::text, '') || '|' || inet_server_port()::text"
} | tr -d '\r\n')"
test "$RESTORE_IDENTITY" = \
  "$RESTORE_DATABASE|$PGUSER|$EXPECTED_PG_SERVER_ADDRESS|$PGPORT"

RESTORE_RELATIONS="$({
  psql --no-psqlrc \
    --host="$PGHOST" \
    --port="$PGPORT" \
    --username="$PGUSER" \
    --dbname="$RESTORE_DATABASE" \
    --tuples-only --no-align \
    --command="SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')"
} | tr -d '[:space:]')"
test "$RESTORE_RELATIONS" = 0

pg_restore \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --dbname="$RESTORE_DATABASE" \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges \
  "$BACKUP_FILE"
)
# The bounded restore lock scope has exited; file descriptor 9 is closed here.
```

`createdb` must fail if the target already exists. Do not add `--clean`, `--if-exists`, or
an error-ignoring fallback: those options would turn a typo into an overwrite path. If a
failed attempt leaves a disposable restore target, inspect it, drop that target explicitly,
and restart this section from the checksum gate.

Load a protected restore-check environment into the shell, with `DATABASE_URL` pointing
at the restored database and the required runtime configuration present. Existing shell
values take precedence over `.env.local`; keep the restore credentials out of shell
history. Then run the current code against that target:

```sh
# The shared restore lock is already released; this command acquires it independently.
pnpm db:preflight
```

Then verify the expected owner/member counts, sign-in, active-workout resume, History,
export, and any deployment-specific media paths. These checks may temporarily use the
snapshot's original `BETTER_AUTH_SECRET` only while the restored instance is isolated on
loopback and unavailable to users.

## Reconcile the recovery point before cutover

A restore rolls every product fact back to the snapshot time. Before exposure, identify
the archive timestamp and reconcile every externally recorded change after that point.
At minimum this includes account and subject deletions, privacy erasures, password or
credential incidents, pain/safety holds and resolutions, fact corrections, content
revocations, and operator configuration changes. Reapply those changes while the restore
is isolated, then rerun preflight and the affected product checks. Training entries after
the snapshot are an explicit recovery-point loss and must be disclosed to the affected
operator/users.

This is a hard gate, not a checklist suggestion. If there is no trustworthy incident,
privacy, and safety change record with which to prove the restored state is acceptable,
do not expose the snapshot. Recover from a newer trustworthy source or rebuild the
installation and import only reviewed data.

## Invalidate restored authority before cutover

Before exposing or cutting over to the restored database, stop every application process
that can reach it. Invalidate every snapshot-era session, one-use/destructive capability,
recovery throttle, provider token, and password credential. Qualifying `public` relations,
disabling `psqlrc`, setting a local search path, and the post-transaction assertion keep
this step independent of ambient SQL configuration. The connection identity is checked
again immediately before this destructive operation so a stale shell or endpoint change
cannot redirect it:

```sh
set -euo pipefail

: "${PGHOST:?Set PGHOST}"
: "${PGPORT:?Set PGPORT}"
: "${PGUSER:?Set PGUSER}"
: "${RESTORE_DATABASE:?Set RESTORE_DATABASE}"
: "${EXPECTED_PG_SERVER_ADDRESS:?Set the expected literal PostgreSQL server address}"

unset PGPASSWORD PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS

(
if ! command -v flock >/dev/null 2>&1; then
  echo "ERROR: flock is required to serialize Indigo host database commands" >&2
  exit 2
fi
source scripts/lib/host-lock.sh
LOCK_PATH="$(indigo_host_lock_dir)/database-external-host.lock"
exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "ERROR: another Indigo host database command is active ($LOCK_PATH)" >&2
  exit 75
fi

CUTOVER_IDENTITY="$({
  psql --no-psqlrc \
    --host="$PGHOST" \
    --port="$PGPORT" \
    --username="$PGUSER" \
    --dbname="$RESTORE_DATABASE" \
    --tuples-only --no-align \
    --command="SELECT current_database() || '|' || current_user || '|' ||
      COALESCE(inet_server_addr()::text, '') || '|' || inet_server_port()::text"
} | tr -d '\r\n')"
test "$CUTOVER_IDENTITY" = \
  "$RESTORE_DATABASE|$PGUSER|$EXPECTED_PG_SERVER_ADDRESS|$PGPORT"

psql --no-psqlrc \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --dbname="$RESTORE_DATABASE" \
  --set=ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL search_path = pg_catalog, public;
DELETE FROM public.destructive_reauthentication_state;
DELETE FROM public.member_reset_state;
DELETE FROM public.web_recovery_rate_limit_bucket;
DELETE FROM public.deletion_plan;
DELETE FROM public.verification;
DELETE FROM public.session;
UPDATE public.account
SET password = NULL,
    access_token = NULL,
    refresh_token = NULL,
    id_token = NULL,
    access_token_expires_at = NULL,
    refresh_token_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP;

DO $rotate_installation_epoch$
DECLARE
  previous_epoch uuid;
  rotated_epoch uuid;
BEGIN
  SELECT product_mutation_epoch
  INTO previous_epoch
  FROM public.installation_state
  WHERE singleton = 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'secure restore installation singleton is missing';
  END IF;

  UPDATE public.installation_state
  SET product_mutation_epoch = gen_random_uuid(),
      updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1
  RETURNING product_mutation_epoch INTO rotated_epoch;

  IF rotated_epoch IS NULL OR rotated_epoch = previous_epoch THEN
    RAISE EXCEPTION 'secure restore installation epoch did not rotate exactly once';
  END IF;
END
$rotate_installation_epoch$;
COMMIT;

DO $secure_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM public.destructive_reauthentication_state)
     OR EXISTS (SELECT 1 FROM public.member_reset_state)
     OR EXISTS (SELECT 1 FROM public.web_recovery_rate_limit_bucket)
     OR EXISTS (SELECT 1 FROM public.deletion_plan)
     OR EXISTS (SELECT 1 FROM public.verification)
     OR EXISTS (SELECT 1 FROM public.session)
     OR EXISTS (
       SELECT 1 FROM public.account
       WHERE password IS NOT NULL
          OR access_token IS NOT NULL
          OR refresh_token IS NOT NULL
          OR id_token IS NOT NULL
          OR access_token_expires_at IS NOT NULL
          OR refresh_token_expires_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'secure restore authority invalidation did not reach zero';
  END IF;
END
$secure_restore$;
SQL
)
# The authority-invalidation lock scope has exited; file descriptor 9 is closed here.
```

Generate a new auth secret into protected storage without printing it or placing it in a
command argument. `mktemp` creates the destination exclusively, so this does not overwrite
an existing file or follow an attacker-supplied final-component symlink. Install that
value as the restored deployment's `BETTER_AUTH_SECRET`:

```sh
set -euo pipefail

export RESTORED_AUTH_SECRET_DIRECTORY=/absolute/private/path/restored-secrets
umask 077
mkdir -p "$RESTORED_AUTH_SECRET_DIRECTORY"
chmod 700 "$RESTORED_AUTH_SECRET_DIRECTORY"
RESTORED_AUTH_SECRET_FILE="$(mktemp \
  "$RESTORED_AUTH_SECRET_DIRECTORY/better-auth-secret.XXXXXX")"
openssl rand -base64 48 >"$RESTORED_AUTH_SECRET_FILE"
chmod 600 "$RESTORED_AUTH_SECRET_FILE"
export RESTORED_AUTH_SECRET_FILE
```

Secret rotation is mandatory for the secure-default cutover. Reusing the snapshot secret
can resurrect a session that was revoked after the backup or a one-use recovery code that
was consumed after it. A restored deletion plan can likewise revive an already-consumed
destructive command, and password hashes do not depend on `BETTER_AUTH_SECRET`; preserving
them could reactivate a password superseded after the snapshot. The invalidation therefore
keeps account rows but disables every password and token. With the new secret configured,
recover the owner through `pnpm owner:recover issue` plus `pnpm owner:recover redeem` while
the service remains loopback-only. The recovered owner can then issue fresh one-use member
reset codes. Members without a fresh reset remain unable to sign in; no snapshot-era
credential or capability is accepted.

The recovery commands below are separately wrapped package commands. Run them only after
the authority-invalidation subshell above has exited and the restored deployment is using
the new protected secret; otherwise they would correctly contend on the same non-reentrant
lock. Supply protected absolute paths as described in the owner-recovery contract:

```sh
# The shared authority lock is already released; this command acquires it independently.
pnpm owner:recover issue \
  --owner-email owner@example.test \
  --code-file /absolute/private/path/recovery-code \
  --ttl-minutes 15

pnpm owner:recover redeem \
  --owner-email owner@example.test \
  --code-file /absolute/private/path/recovery-code \
  --password-file /absolute/private/path/new-password
```

After owner recovery and every isolated check passes, cut over explicitly: stop the
application, select the restored `DATABASE_URL` and the restored deployment's newly generated
`BETTER_AUTH_SECRET` together, and start the application on loopback. Run the post-cutover
check against that exact process before allowing any external or user access.

Keep the original database and its original protected secret configuration unchanged and
network-isolated until the restored instance has passed its isolated checks. A simple rollback to
that original database and its matching original secret is permitted only **before the restored
deployment is exposed to any user and before it accepts any non-prescribed post-restore
mutation**. Recovery-point reconciliation, authority invalidation, and owner recovery are the only
prescribed mutations during that window. Never mix either database with the other environment's
secret, and never run both installations concurrently.

After the restored deployment has been exposed, returning to the original database is a new
recovery cutover, not a rollback shortcut. Stop both installations, reconcile every accepted change
since cutover into the selected database, rerun the complete authority-invalidation transaction
above (including installation-epoch rotation), provision another fresh auth secret, recover the
owner, and repeat all isolated verification before exposure. Reusing the original secret or its
pre-cutover epoch after exposure can resurrect stale credentials and browser commands and is
forbidden. When the pre-exposure rollback window closes, securely drop the losing database, destroy
its no-longer-needed secret material, and retire temporary archives according to the documented
retention policy.

## Guarded repository drill

The repository drill is a test-only, disposable integration proof. It is not a production
backup command, a production restore procedure, or permission to use a live/shared server.
It never reads `DATABASE_URL` as a destructive target. It requires
`INTEGRATION_ADMIN_DATABASE_URL` on literal loopback, creates a 96-bit-random database
named `indigo_backup_restore_<24 lowercase hex>_integration`, and rechecks that exact
shape immediately before its only wipe. It then:

1. applies every committed migration;
2. creates the open installation singleton and captures its opaque mutation epoch;
3. inserts a known append-only audit marker;
4. creates a custom-format archive with no ownership or privilege statements;
5. wipes the disposable database's application and migration schemas;
6. restores the archive in one transaction;
7. verifies the exact installation epoch and audit marker, then proves the restored append-only trigger rejects an
   update with SQLSTATE `55000`;
8. runs the full database preflight; and
9. removes the archive and drops the disposable database in `finally`.

With PostgreSQL 18+ client tools installed on the host:

```sh
pnpm db:backup-restore-drill
```

If the matching client tools exist only inside the same container as PostgreSQL, opt in
to the development-only adapter. It permits only that container's literal loopback
endpoint and does not make Docker part of the application runtime:

```sh
INDIGO_BACKUP_DRILL_PG_CONTAINER=indigo-synthesis-postgres \
  pnpm db:backup-restore-drill
```

The optional defaults are `INDIGO_BACKUP_DRILL_CONTAINER_HOST=127.0.0.1` and
`INDIGO_BACKUP_DRILL_CONTAINER_PORT=5432`. Container names/IDs, host, port, database
name, and administration URL are validated before any destructive statement. The
password crosses the container boundary on standard input, not as a process argument.

This drill proves logical dump/restore, committed schema/data recovery, trigger behavior,
and startup preflight on a real disposable PostgreSQL database. It does not prove an
operator's encryption, off-host storage, retention, media copying, recovery-time target,
or cold-install procedure; those remain deployment evidence and, where appropriate,
human-operated checks.

See the [latest retained checkpoint evidence](evidence/2026-07-16-backup-restore-drill.md).
