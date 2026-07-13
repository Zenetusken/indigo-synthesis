# Identity

Owns first-owner bootstrap, local accounts, sessions, signup policy, and actor context.
Better Auth with its Drizzle adapter is selected. Auth tables participate in the one
reviewed Drizzle schema/migration ledger. Better Auth schema generation feeds that
project-owned schema during development; only committed Drizzle SQL is applied in an
installation. Better Auth runtime migration and production CLI generation are disabled.
Product use cases normally receive a server-derived authenticated actor ID. The current
Data Portability deletion/export transaction is the documented cross-table exception and
directly coordinates Identity rows until public module ports exist.

First-owner bootstrap requires a host-issued capability and locks the singleton
installation plus capability row while it atomically creates the credential, consumes the
capability, and closes bootstrap. Generic signup is disabled; database user insertion is
limited to explicit `bootstrap-owner` and `owner-admin` transaction modes. Unsupported
Better Auth signup, password-reset, password/email-change, user-update, and user-delete
routes are blocked rather than becoming a second identity authority.

Credential lifecycle operations share an email-first, account-scoped advisory-lock order
with password sign-in. Owner-created local users require current-password
reauthentication. An owner can issue an expiring, one-use reset code for a non-owner
account; the trainee chooses the replacement password through `/reset`. Sole-owner
recovery keeps host-only issuance and protected CLI redemption while also supporting
`/recover`. Both recovery flows revoke every affected database session and record
redacted, channel-aware audit events.

Web sign-in/recovery admission uses identity-owned, HMAC-keyed fixed-window buckets with
bounded cleanup; advisory-lock connections and both waiter classes are separately
bounded, and trusted host/account work receives released capacity first. Member-code
guesses add a capped, non-destructive backoff. Raw emails, codes, passwords, bucket keys,
and full client addresses do not enter audit. Session reads disable cookie caching, and
credential accounts do not expose browser bearer or refresh tokens, so
recovery-triggered revocation takes effect at the next request. When a session is absent
mid-workout, the cause-neutral sign-in path carries only a validated, server-derived
workout return; after sign-in, committed PostgreSQL state resumes exactly.

Standalone session management, sign-in-failure auditing/security-event presentation,
second factors, and multiple profiles per account are deferred. See
[`docs/product/ACCESS_AND_RECOVERY_SPEC.md`](../../../docs/product/ACCESS_AND_RECOVERY_SPEC.md)
for the threat model and explicit boundaries.
