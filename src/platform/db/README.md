# Database adapter

PostgreSQL 18 with Drizzle and `pg` is the live persistence boundary. The committed
schema includes Better Auth/installation state plus the generic athlete, program
snapshot, workout, safety, audit, and portability entities needed by the engineering
MVP. It does not include the future reviewed-content/evidence catalog, and the bundled
development fixture does not close Methodology Gate 0.

There will be:

- one schema authority;
- one ordered committed SQL migration ledger;
- Better Auth's Drizzle schema checked into that same schema authority;
- only a project-owned migration command applying committed SQL before startup;
- no Better Auth runtime migration, production CLI generation, or schema push;
- no runtime schema push;
- no seed data inside migrations; and
- fresh-database migration tests; and
- startup preflight for the ledger, PostgreSQL version, required columns, exact enabled
  trigger/table/function bindings, and reviewed-mode content eligibility.
