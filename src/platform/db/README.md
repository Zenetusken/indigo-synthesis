# Database adapter

PostgreSQL 18 with Drizzle and `pg` is selected. Product/program schema is intentionally
absent until the Methodology v1 decision pack closes and the first vertical-slice entity
model is reviewed. Phase 1 may add only Better Auth tables and the singleton installation
state required to prove bootstrap, sessions, and the migration path.

There will be:

- one schema authority;
- one ordered committed SQL migration ledger;
- Better Auth's Drizzle schema checked into that same schema authority;
- only a project-owned migration command applying committed SQL before startup;
- no Better Auth runtime migration, production CLI generation, or schema push;
- no runtime schema push;
- no seed data inside migrations; and
- fresh-database migration tests.
