# Identity

Owns first-owner bootstrap, local accounts, sessions, signup policy, and actor context.
Better Auth with its Drizzle adapter is selected. Auth tables participate in the one
reviewed Drizzle schema/migration ledger. Better Auth schema generation feeds that
project-owned schema during development; only committed Drizzle SQL is applied in an
installation. Better Auth runtime migration and production CLI generation are disabled.
Product use cases normally receive a server-derived authenticated actor ID. The current
Data Portability deletion/export transaction is the documented cross-table exception and
directly coordinates Identity rows until public module ports exist.

First-owner bootstrap locks a singleton installation row and atomically creates the
owner/closes bootstrap. Sole-owner recovery is an out-of-band, host-local, expiring
single-use-code workflow with session revocation and a redacted audit event.
