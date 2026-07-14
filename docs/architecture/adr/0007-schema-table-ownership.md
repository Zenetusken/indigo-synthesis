# ADR 0007: Schema/table ownership boundary

- Status: **proposed** — awaiting maintainer decision. Drafts the "accept a narrower
  boundary" option of production-release blocker 4; the alternative (build public module
  gateways) is described and not chosen here.
- Date: 2026-07-14
- Supplements: [ADR 0001](0001-modular-monolith.md)
- Spec: [Schema ownership enforcement spec](../SCHEMA_OWNERSHIP_SPEC.md)

## Context

[ADR 0001](0001-modular-monolith.md) describes a modular monolith with module-owned
gateways and a shared `UnitOfWork`. The vertical slice never built those gateways; modules
coordinate through direct Drizzle queries over a shared schema. `MVP_STATUS.md` tracks this
as debt and blocker 5 requires either building the gateways or accepting a narrower
boundary in an ADR.

A measured write-authority census of the 36 tables (see the
[spec](../SCHEMA_OWNERSHIP_SPEC.md)) found that, excluding the
deliberately cross-cutting Data Portability module, **28 of 34 tables already have a single
writer**. Only 6 are genuinely co-written, in three explainable buckets:

- `audit_event` — a cross-cutting append-only log written by four modules by design;
- the Programs↔Training cluster (`exercise_prescription`, `planned_workout`,
  `program_revision`, `set_prescription`) — the documented coordination debt;
- `safety_hold` — the athlete/training shared hold lifecycle.

Full gateways (Option A) would untangle those 6 tables plus Data Portability's export and
ordered-deletion transaction and resolve the `UnitOfWork` question — a Phase-3-scale
refactor. None of it blocks the beta.

## Decision (proposed)

Accept single-writer table ownership as the enforced boundary, with declared exceptions,
rather than building module gateways now.

1. A checked-in ownership manifest maps each table to one owner module.
2. Six co-writes are declared `sharedWriters` with reasons; the Programs↔Training cluster
   is explicitly labeled gateway-target debt so it is fenced against growth, not blessed.
3. Data Portability is the single declared whole-schema reader/deleter; no other module
   may take that breadth.
4. An architecture test enforces the manifest against a write-authority census (Drizzle
   writes and raw SQL), failing on any undeclared write, unmanifested table, or stale
   exception.

## Consequences

- The invariant is captured and CI-enforced immediately (~a day), ratifying near-clean
  reality rather than papering over sprawl.
- The Programs↔Training coupling remains direct-Drizzle but is now declared and fenced: a
  *new* cross-module write requires a manifest change and reviewer sign-off.
- Gateways are deferred, not abandoned. Re-entry triggers: a Progress read-model, a second
  co-ownership cluster, or a transactional boundary that direct Drizzle cannot express
  safely. At that point the manifest is the migration checklist.
- If the maintainer instead chooses Option A (gateways), this ADR is rejected and the spec's
  Part A manifest becomes the refactor's target-state checklist rather than the terminal
  boundary.

## Alternatives considered

- **Build public module gateways now (Option A).** Structurally strongest; realizes
  ADR 0001 fully. Rejected for this arc because the census shows the costly part applies to
  6 tables in 3 buckets, none beta-blocking, while the manifest+test captures the invariant
  today.
- **Import-presence ownership.** Rejected: forbidding non-owner *imports* punishes
  legitimate reads and is blind to raw SQL; it asserts the wrong invariant. Ownership is
  write authority.
