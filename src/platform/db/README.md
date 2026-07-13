# Database adapter

PostgreSQL 18 with Drizzle and `pg` is the live persistence boundary. The committed
schema includes Better Auth/installation state plus the generic athlete, program
snapshot, workout, safety, audit, portability, and optional explanation-cache entities
needed by the engineering MVP. It does not include the future reviewed-content/evidence
catalog, and the bundled development fixture does not close Methodology Gate 0.

The live contract has:

- one schema authority;
- one ordered committed SQL migration ledger with 17 current entries;
- Better Auth's Drizzle schema checked into that same schema authority;
- only a project-owned migration command applying committed SQL before startup;
- no Better Auth runtime migration, production CLI generation, or schema push;
- no runtime schema push;
- no seed data inside migrations;
- fresh-database and additive-upgrade migration tests; and
- startup preflight for PostgreSQL 18 or newer, every current committed migration hash,
  canonical 0004 ledger provenance, required columns/indexes, the access/recovery state
  and keyed rate-limit contract, the explanation-cache contract, all 28 exact enabled
  trigger/table/function bindings, and reviewed-mode content eligibility. Extra
  historical ledger rows from a development branch do not false-fail when every current
  hash and concrete invariant still holds.
