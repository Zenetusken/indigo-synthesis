# Database adapter

PostgreSQL 18 with Drizzle and `pg` is the live persistence boundary. The committed
schema includes Better Auth/installation state plus the generic athlete, program
snapshot, workout, safety, audit, portability, and optional explanation-cache entities
needed by the engineering MVP. It does not include the future reviewed-content/evidence
catalog, and the bundled development fixture does not close Methodology Gate 0.

The live contract has:

- one schema authority;
- one ordered committed SQL migration ledger with 19 current entries;
- Better Auth's Drizzle schema checked into that same schema authority;
- only a project-owned migration command applying committed SQL before startup;
- no Better Auth runtime migration, production CLI generation, or schema push;
- no runtime schema push;
- no product/demo seed data inside migrations; migration 0017 creates only the required
  singleton installation coordination row;
- fresh-database and additive-upgrade migration tests; and
- startup preflight for PostgreSQL 18 or newer, every current committed migration hash,
  canonical 0004 ledger provenance, required columns/indexes, the access/recovery state
  and keyed rate-limit contract, installation mutation-epoch/default/singleton integrity,
  the explanation-cache contract, all 28 exact enabled
  trigger/table/function bindings, and reviewed-mode content eligibility. Extra
  historical ledger rows from a development branch do not false-fail when every current
  hash and concrete invariant still holds.

## Connection topology

`INDIGO_DATABASE_POOL_MAX` is the total supported single-instance connection budget. It
accepts 6–64 and defaults to 10. The live allocation is exact:

- ordinary application work: `poolMax - 4`;
- credential control: 2;
- credential capture: 1; and
- serialized external-host work: 1.

The three application pools therefore sum to `poolMax - 1`. The external slot is not a
pool: each supported migration or preflight process constructs one dedicated `pg.Client`
after inheriting the common nonblocking host lock. It never constructs the ordinary,
control, or capture pools, and an in-process owner lease prevents a wrapped process from
opening a second external-host client. The one-shot normalizes `search_path` to
`pg_catalog, public` before exposing its scoped query surface. Migration, preflight,
startup preflight, owner bootstrap/recovery, and expired-session maintenance all share
the same per-UID lock.

Preflight also verifies that `session_user` has `rolconnlimit = -1` (unlimited) or a
limit at least as large as `INDIGO_DATABASE_POOL_MAX`. This is a role-level allowance,
not proof of cluster-wide `max_connections`, currently free capacity, or capacity for
multiple application instances.

Transaction-scoped application coordination is implemented separately in
`src/platform/application-coordination/`; product composition lives in `src/composition/`.
Neither layer may turn the connection topology above into an unbounded or raw-client escape.

`pnpm db:backup-restore-drill` is a test-only disposable-database acceptance harness. It
may use application-pool test helpers and proves restore/schema invariants; it is not a
production one-shot topology proof. Production backup/restore follows the shared-lock
procedure in [`docs/operations/BACKUP_RESTORE.md`](../../../docs/operations/BACKUP_RESTORE.md).
