# Schema/table ownership enforcement (arc spec)

Status: **draft for review** — engineering arc spec, measure-first
Scope owner: architecture / platform

This specifies production-release blocker 4 in
[MVP_STATUS.md](../MVP_STATUS.md#production-release-blockers) ("Extend architecture
enforcement to schema/table ownership and either implement the intended public module
gateways or accept a narrower boundary in an ADR"). The blocker is deliberately two
things, and this spec keeps them separate:

- **Part A (mandatory, fork-independent):** a declared table-ownership manifest and an
  architecture test that enforces it. Wanted no matter which fork wins.
- **Part B (the decision):** build public module gateways **or** accept the narrower
  boundary in an ADR. This is a genuine fork and is **not** resolved here — it is drafted
  as a proposed ADR ([0007](adr/0007-schema-table-ownership.md), status *proposed*) for the
  maintainer to accept or reject.

Every claim below is grounded in a measured census of the current `main`+branch tree, not
intent.

---

## 1. What the architecture docs already claim

`MVP_STATUS.md` records this exact gap: "The architecture suite proves the current module
graph is acyclic and enforces several import/runtime dependency rules, but it does not yet
prove schema/table ownership or require all cross-module work to use public gateways." It
also names two deliberate cross-cutting exceptions: Programs and Training "coordinate
through direct Drizzle queries over the shared schema," and Data Portability "intentionally
uses a direct, repeatable-read projection and ordered deletion transaction."

The target architecture ([ADR 0001](adr/0001-modular-monolith.md)) describes module-owned
gateways and a shared `UnitOfWork`; the vertical slice has not built them. This spec turns
that prose into a measured, enforceable invariant.

---

## 2. Measurement method

Schema: 36 tables across `src/platform/db/schema/{auth,installation,product}.ts` (7 + 1 +
28). For each product module under `src/modules/*`, a static census classified its access
to each table:

- **write** — a Drizzle `.insert(SYM)` / `.update(SYM)` / `.delete(SYM)` on the table's
  schema symbol, **or** a raw `sql\`…\`` `INSERT INTO` / `UPDATE` / `DELETE FROM <table>`;
- **read** — `.from(SYM)` / `.select` only.

Ownership is defined by **write authority**, not import presence: a module that only
`.select()`s a table is a consumer, not an owner. An earlier import-presence census
(counting any schema-symbol import) reported 34/36 tables "shared" and even attributed 3
tables to `methodology`, which on refinement writes **zero** tables — those were local
variables named `session`/`performed_set`, not schema references. The write-authority
census below is the corrected, decision-grade measurement.

**Fidelity notes (carried into the enforcement design, §5):**
- The census scans both Drizzle write calls and raw-SQL string literals. Raw SQL matters:
  `identity` writes `web_recovery_rate_limit_bucket` only via raw `sql\`…\``, invisible to
  an import-only scan.
- Test files are excluded.
- Spot-checked against real query sites: `program_revision` co-written by
  `programs.ts:228` and `training/workouts.ts:2331`; `safety_hold` by
  `athletes/profile.ts:221` and `training/workouts.ts:1664`; `audit_event` inserted in all
  four of athletes/identity/programs/training. Census confirmed accurate.

---

## 3. Measured ownership census (write authority)

**Data Portability is a whole-schema reader/deleter by design** — it writes (deletes or
redacts) nearly every table as the export/deletion boundary. It is treated as a declared
exception throughout, not an owner; the numbers below **exclude** it to reveal real
product-module ownership.

Excluding Data Portability: **28 of 34 candidate tables have a single writer** (clean
ownership); **6 are genuinely co-written**. The 6 fall into three explainable buckets:

| Co-written table | Writers | Bucket |
| --- | --- | --- |
| `audit_event` | athletes, identity, programs, training | Cross-cutting append-only log — many writers by design |
| `exercise_prescription` | programs, training | Programs↔Training cluster (documented gateway debt) |
| `planned_workout` | programs, training | Programs↔Training cluster |
| `program_revision` | programs, training | Programs↔Training cluster (Training writes the new future revision on completion) |
| `set_prescription` | programs, training | Programs↔Training cluster |
| `safety_hold` | athletes, training | Shared hold lifecycle |

Single-writer owners (28 tables): **identity** (8: account, session, user, verification,
installation_state, member_reset_state, destructive_reauthentication_state,
web_recovery_rate_limit_bucket), **training** (14: workout_session, performed_set,
session_exercise, session_feedback, adjustment_decision, the correction/invalidation
ledgers, training_command_receipt, future_load_explanation_cache, safety_hold_resolution,
…), **athletes** (4: athlete_profile, athlete_equipment, athlete_training_day,
strength_baseline), **programs** (2: program, content_release_revocation), and
**data-portability** (2: deletion_plan, deletion_tombstone).

`exercises`, `methodology`, and `progress` write **zero** tables (pure domain / not yet
built). That is itself an enforceable fact.

**The decision-relevant conclusion:** clean single-writer ownership is already the reality
for 82% of tables. The residual co-ownership is small, clustered, and explainable — which
is exactly the condition under which the ADR-path (declare + enforce now, formalize readers
and the Programs↔Training gateway later) dominates a large up-front gateway refactor.

---

## 4. Part A — the ownership manifest (mandatory)

A single checked-in manifest (`src/platform/db/schema/ownership.ts`, new) maps every table
to exactly one **owner module** plus explicitly declared exceptions:

- `owner` — the one module permitted to write the table.
- `sharedWriters` — additional modules permitted to write, each with a required
  `reason`. Seeded from the measured 6: the `audit_event` append-log writers, the
  Programs↔Training cluster (reason: "gateway-target debt, ADR 0007"), and `safety_hold`.
- `wholeSchemaReaderDeleter` — the single declared cross-cutting module
  (`data-portability`), permitted to read all tables and delete/redact in its ordered
  transaction, with no other module granted its breadth.

The manifest is exhaustive: every one of the 36 tables must appear exactly once, asserted
by the test in §5 (a new table with no manifest entry fails CI).

---

## 5. Part A — the enforcement invariant (falsifiable)

**Invariant:** *No module writes a table it does not own, is not a declared `sharedWriter`
of, and is not the declared whole-schema reader/deleter.*

Enforced by a new `test/architecture/schema-ownership.test.ts` that reproduces the §2
census (Drizzle write calls **and** raw-SQL write literals) and asserts every observed
(module, table) write is authorized by the manifest, and that the manifest covers all 36
tables with no stale entries.

*Falsified by:* a module gaining an undeclared write to a table it does not own; a new
table without a manifest entry; a manifest exception whose writer no longer writes the
table (stale grant).

**Enforcement-mechanism design point (open):**
- **(i) write-call + raw-SQL scan** (recommended) — mirrors the census; catches the real
  violation (an unauthorized *write*) and the raw-SQL path that an import scan misses. Cost:
  regex/AST over write calls plus a raw-SQL literal scan, with the known limit that
  dynamically-constructed SQL is not statically visible.
- **(ii) import-with-declared-readers** — forbid importing a non-owned table symbol unless
  declared a reader. Simpler, but punishes legitimate reads and is blind to raw SQL — it
  would assert the wrong invariant. Rejected as the primary mechanism.

The recommended test uses (i); a follow-on may add a lint forbidding *new* raw-SQL writes
outside a table's owner to keep the static scan honest.

The census in §2–§3 was computed with a symbol-matching regex, which is sound for this tree
(schema symbols like `programRevisions` never collide with JS collection-method arguments —
verified: no `.delete(`/`.insert(` call on a Map/Set argument matches a schema symbol). The
*production* test must instead use the TypeScript AST already available in
`test/architecture/boundaries.test.ts` (`ts.Node`), so a future `someMap.delete(programs)`
cannot masquerade as a schema write and the invariant stays robust as the tree grows.

---

## 6. Part B — the decision pack (gateways vs ADR) — NOT resolved here

The blocker's fork. This spec does **not** choose; it presents both with the census as the
tiebreak, and drafts the ADR as *proposed*.

- **Option A — build public module gateways.** Each module exposes a public port; all
  cross-module data access (notably the Programs↔Training cluster and Data Portability's
  whole-schema projection) routes through ports, not shared Drizzle. Fully realizes
  [ADR 0001](adr/0001-modular-monolith.md). Cost: a Phase-3-scale refactor touching the 6
  co-written tables, Data Portability's export/deletion transaction, and the
  transactional-boundary/`UnitOfWork` question. Benefit: the boundary is structural, not
  merely asserted.
- **Option B — accept the narrower boundary in an ADR (recommended).** Ratify the measured
  reality: single-writer ownership enforced by the Part A manifest+test, with the 6
  co-writes and Data Portability declared as reasoned exceptions. Defer gateways until a
  concrete Phase-3 read-model or a second co-ownership pressure appears. Cost: the
  Programs↔Training coupling remains direct-Drizzle (but now *declared and fenced* against
  growth). Benefit: locks the invariant now at ~a day of work; 82% single-writer ownership
  means the ADR is ratifying near-clean reality, not papering over sprawl.

**Recommendation: Option B**, because the census shows the expensive part of Option A
(untangling co-ownership) applies to only 6 tables in 3 explainable buckets, none of which
blocks the beta, while Part A captures the actual invariant immediately. The proposed ADR
is [0007](adr/0007-schema-table-ownership.md) (status *proposed* — awaiting the
maintainer's decision; this arc does not self-accept it, unlike the delegated nginx choice).

## 7. Out of scope

The `UnitOfWork`/transactional-boundary refactor, a Progress read-model, splitting History
out of Training, the Exercises content module, and any change to Data Portability's export
shape. Part A adds a manifest + test; Part B is a decision, not code.
