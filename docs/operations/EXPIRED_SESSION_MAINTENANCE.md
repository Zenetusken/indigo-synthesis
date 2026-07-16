# Expired-session maintenance

Status: supported bounded host-operator procedure

## Purpose and boundary

PostgreSQL sessions remain authoritative for authentication and revocation. Normal
requests reject expired sessions, but expired rows can accumulate when an installation
has little traffic. This command removes them in bounded pages without making cleanup
part of a user request or a browser journey:

```sh
pnpm identity:cleanup-expired-sessions --batch-size 64
```

This is deliberately a host-only maintenance surface. There is no user-facing session
manager or cleanup UI, and successful maintenance does not change active credentials or
application facts. The package command enters the same non-blocking, per-UID host lock as
owner bootstrap and recovery. If another Indigo host database command owns that lock,
the wrapper exits with status `75` before the TypeScript entrypoint runs.

Run migrations and preflight with the application version that will perform cleanup:

```sh
pnpm db:migrate
pnpm db:preflight
```

The application may remain online. Product coordination serializes each selected page
against the affected accounts while allowing unrelated accounts to continue.

## Page and cursor contract

The command accepts a whole-number batch size from 1 through 64. One invocation deletes
at most one page and prints exactly one compact JSON object followed by one newline. A
successful page has one of these shapes:

```json
{"status":"continue","deletedCount":64,"nextCursor":"OPAQUE_CURSOR"}
```

```json
{"status":"complete","deletedCount":12,"nextCursor":null}
```

The first page fixes one sweep cutoff. When more rows remain, its returned cursor carries
that cutoff and every continuation page reuses it, so sessions that expire during a sweep
are left for the next sweep. Rows are ordered by expiration time and stable session-row
identity. A page may contain sessions from multiple accounts, and a large backlog for one
account may span several pages. `complete` means the captured page was shorter than the
requested batch for that fixed cutoff; it does not promise that no session will expire
later.

`nextCursor` is an opaque, canonical, base64url-encoded continuation value. It is bounded
to 8 KiB of ASCII and contains internal timing and session-row position metadata. The bound
is large enough to represent every session-row identity accepted by the maintenance reader.
It is not a login credential, but treat it as sensitive operational state: keep it out
of public logs, tickets, analytics, and shell tracing. Preserve its exact bytes, quote it
as one argument, and never decode, edit, combine, or invent one.

## Continue a sweep safely

Run the first page without a cursor. After an exit status of zero, capture the entire JSON
line through a protected local mechanism and inspect `status` and `nextCursor`. When the
status is `continue`, run exactly one next page with the returned value:

```sh
pnpm identity:cleanup-expired-sessions \
  --batch-size 64 \
  --cursor 'OPAQUE_CURSOR'
```

Advance only after the command exits successfully and its complete JSON line is
available. Do not infer success from an empty output stream, a partial line, or a database
observation made while the process is still running.

If the outcome is ambiguous—for example, the terminal disconnects after the database may
have committed but before the JSON line is retained—retry the same **input** cursor. Do
not guess the missing output cursor. Replaying a cursor is safe: already deleted rows
stay absent, and the retry either confirms completion or returns a trustworthy cursor for
the next remaining page. If the ambiguous invocation was the no-cursor first page, retry
without a cursor; that safely starts with a fresh cutoff because the unconfirmed cutoff
cannot be recovered.

Stop when `status` is `complete` and `nextCursor` is `null`. Start a later sweep without a
cursor; do not reuse a completed sweep's cursor as a permanent schedule token.

## Failure handling

Argument, cursor, coordination, and database failures exit with status `1`, write only to
standard error, and produce no JSON on standard output. The supplied cursor is never
included in an error message. Preserve the same input cursor, correct the reported
environmental or invocation problem, and retry it. Lock contention is the wrapper-level
exception described above: it exits `75`; wait for the active host command to finish and
then retry unchanged.

An invalid or non-canonical cursor must not be repaired manually. Return to the last
confirmed successful output. If no such output exists, begin a new sweep without a
cursor; the new fixed cutoff and idempotent deletion preserve correctness, although its
page boundary will differ. A cursor whose cutoff is later than the current invocation is
also refused, so edited input cannot classify an active session as expired.

This command is retention hygiene, not incident response. Credential compromise still
requires the applicable owner or member recovery flow, which replaces the credential and
revokes that account's sessions transactionally.
