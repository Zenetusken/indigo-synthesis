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
limited to explicit `bootstrap-owner` and `owner-admin` transaction modes. Sole-owner
recovery is an out-of-band, host-local, expiring one-use code flow that shares a
per-credential advisory lock with password sign-in, revokes existing sessions, and records
a redacted audit event.
