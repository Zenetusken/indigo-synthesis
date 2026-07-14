# ADR 0007: Schema/table write-fence and residual boundary debt

- Status: **proposed** — awaiting maintainer decision. This revision is a *provisional
  debt ratification* template (post adversarial review). It is **not** accepted and must
  **not** be treated as a silent rewrite of AGENTS.md / ARCHITECTURE.md.
- Date: 2026-07-14 (revised same day after adversarial review)
- Relates to: [ADR 0001](0001-modular-monolith.md) (modular monolith deployment shape only)
- Amends (only if this ADR is **accepted**): see [Consequences](#consequences) — either
  explicit doc amends **or** residual tracker with AGENTS/ARCHITECTURE left as binding
  target and this ADR limited to the write fence
- Spec: [Schema ownership / write-fence enforcement](../SCHEMA_OWNERSHIP_SPEC.md)
- Review: [Adversarial swarm review](../../reviews/SCHEMA_OWNERSHIP_ADVERSARIAL_REVIEW.md)

## Context

Production-release **blocker 4** in `MVP_STATUS.md` requires extending architecture
enforcement to schema/table ownership **and either** implementing the intended public
module gateways **or** accepting a narrower boundary in an ADR. (Blocker **5** is the
independent product/security/privacy and operator cold-install/restore review — do not
confuse the numbers.)

[ADR 0001](0001-modular-monolith.md) chooses a modular monolith without internal HTTP. The
stronger rules — public application APIs, no reaching across another module's tables,
multi-module writes via a shared `UnitOfWork` — live in [AGENTS.md](../../../AGENTS.md)
and [ARCHITECTURE.md](../ARCHITECTURE.md). The vertical slice never built those gateways;
Programs and Training co-write via direct Drizzle; Data Portability uses a whole-schema
projection and ordered deletion **while per-module ports are still absent** (tracked debt
in `MVP_STATUS.md`, not a completed target).

A measured write-authority census of the **36** tables (see the
[spec](../SCHEMA_OWNERSHIP_SPEC.md)) found that, excluding Data Portability's non-owned
operator DML, **28 of 34** tables already have a single product-module writer. **Six**
are co-written, in distinct debt classes (not one homogeneous "exception"):

1. `audit_event` — four modules insert; needs an audit **port**, not eternal multi-writer
   domain ownership.
2. Programs↔Training cluster (`program_revision`, `planned_workout`,
   `exercise_prescription`, `set_prescription`) — Training constructs Program aggregate
   rows on completion (product spine), then activates via Programs API.
3. `safety_hold` — two lifecycles (eligibility vs session-pain), already split in DB policy.

Those six include high-churn and safety-critical paths. Table-count "82% single-writer"
justifies a **cheap write fence**; it does **not** by itself prove that declaring the
residual forever is the best production architecture.

Full gateways (Option A) bundle several independent interventions. Targeted intermediates
(C1–C5 in the spec) exist and must be considered on their own costs.

## Decision (proposed)

**If accepted, this ADR decides the following — and only this:**

1. **Ship and keep Part A** of the spec: a checked-in **write-authority fence**
   (`tableWriteFence` + `crossCuttingOperator`) and a CI architecture test (O1–O5).
   Write sites are fenced; they are **not** redefined as domain ownership.
2. **Treat residual co-writes and Data Portability operator breadth as declared debt**,
   with `debt: true` grants and verb-scoped operator allow-lists matching live code
   (including Data Portability `UPDATE` of `installation_state` on instance reset).
3. **Do not treat this ADR as terminal modular-boundary architecture** unless the
   maintainer also completes the [doc convergence](#doc-convergence-required-if-accepted-as-production-boundary)
   path below. Preferred packaging: **provisional debt ratification** — AGENTS/ARCHITECTURE
   remain the binding *target*; residual work is refiled under an explicit tracker item;
   Part A prevents *silent* growth of undeclared writers.
4. **Better Auth** adapter registration under `identity` counts as write authority for
   `user` / `session` / `account` / `verification` (O5). No second adapter elsewhere.
5. **Blocker 4** is not closed by merging this ADR alone. Closure requires the spec's
   [O1–O6](../SCHEMA_OWNERSHIP_SPEC.md#8-definition-of-done-o1o6) plus an explicit Part B
   disposition (this ADR accepted as provisional **or** a gateway/intermediate option
   chosen) and honest `MVP_STATUS` updates.

**Primary owners for co-written tables** (migration checklist defaults; see spec seed):

| Table | owner | debt writers |
| --- | --- | --- |
| `audit_event` | identity | athletes, programs, training (insert) |
| Programs↔Training cluster (4) | programs | training (insert) |
| `safety_hold` | athletes | training (insert for session-pain path) |

## Consequences

### If accepted as provisional debt ratification (recommended packaging)

- Part A CI fence lands; undeclared writes fail.
- AGENTS.md and ARCHITECTURE.md **remain the target** for public APIs / UnitOfWork /
  "no cross-module tables."
- A **residual tracker item** is filed (Phase 3 / maintainability), naming at least:
  Programs↔Training completion write path, audit port, safety_hold API, DP ports,
  UnitOfWork — or a subset the maintainer prioritizes.
- `MVP_STATUS` blocker 4 may close **only** if product owners agree provisional fence +
  residual item satisfies the production-release bar; the Maintainability row is rewritten
  so "resolve gateway debt" is not falsely marked done.
- New `additionalWriters` debt grants require: non-empty reason, `debt: true`, and
  reviewer answers (why not owner API? new cluster? transaction? DP order? sunset?).
  Expanding an existing reason string to add a **third** module counts as a new cluster
  pressure (re-entry), not free growth.

### Doc convergence required if accepted as production boundary

If the maintainer instead wants this ADR to **be** the production module-boundary rule
(not merely a fence), the **same change** must amend:

- AGENTS.md architecture bullets (exported API only; UnitOfWork; never private tables) —
  suspend or rewrite for the declared debt set only;
- ARCHITECTURE.md dependency rules, Data Portability target, and "public-gateway
  enforcement still required" notes;
- MVP_STATUS known-architecture-debt and Maintainability row;
- relevant `src/modules/*/README.md` target-boundary sentences.

Without those amends, accepting a "narrower boundary" while leaving the higher-precedence
contract unchanged creates dual source of truth — **rejected packaging**.

### Re-entry / revisit triggers (objective enough to avoid permanence-by-default)

Any of:

1. New `additionalWriters` module on a table, or a new co-written table.
2. Expansion of Training program-tree construction (new write shapes on the four cluster
   tables) without a Programs API.
3. Progress (or another module) needs stable cross-module reads/writes that Part A cannot
   express safely.
4. A multi-module write that cannot share the initiator's transaction without a
   UnitOfWork/port.
5. Timebox: revisit before Phase 3 close / before second-person beta expansion — whichever
   comes first — even if (1)–(4) have not fired.

At re-entry, the Part A manifest is the migration checklist.

### If rejected

- Mark this ADR `rejected`.
- Part A (write fence) may still ship — it is fork-independent.
- Blocker 4 stays open until gateways or an intermediate (e.g. C1) or a replacement ADR
  lands.
- Part A seed remains the target-state checklist for removing debt writers.

### What this ADR does not do

- Does not implement C1–C5 or full Option A.
- Does not authorize arbitrary cross-module **reads** (Progress SELECT sprawl stays an
  ARCHITECTURE debt).
- Does not claim "~a day" is a hard estimate for a hardened AST+adapter scanner; DoD is
  O1–O6, not a calendar claim.

## Alternatives considered

- **Option A — full public module gateways + DP ports + UnitOfWork.** Structurally
  strongest; realizes AGENTS/ARCHITECTURE fully. Cost is the **bundle** of C1–C5 plus
  composition — large. Not required to ship the Part A fence. Still available; not
  rejected as architecture, only as "must block Part A."
- **Option B (pre-review packaging) — terminal narrower ownership boundary without doc
  amends.** Rejected: dual source of truth; confuses write fence with domain ownership;
  underweights product-spine co-writes; moral hazard (`additionalWriters` cheaper than
  ports forever).
- **C1 — Programs completion write API only.** Training calls Programs to append future
  revision + prescriptions; Programs remains sole aggregate writer. Bounded cost vs A;
  addresses the highest-churn debt class. **Open maintainer choice** — this ADR does not
  select C1 by default.
- **C2 — audit append port.** Small; removes four-way `audit_event` inserts.
- **C3 — safety_hold single-owner API.** Small–medium; matches DB's two-policy model.
- **C4 — Data Portability per-module ports.** Medium; matches ARCHITECTURE target;
  independent of Programs↔Training.
- **C5 — UnitOfWork for multi-module writes only.** Medium; currently no implementation
  under `src/application/workflows/`.
- **Import-presence ownership as primary enforcement.** Rejected: punishes legitimate
  reads; blind to raw SQL and adapters; wrong invariant. Declared readers may be a
  follow-on (Part A2), not a substitute for the write fence.
- **Do nothing (no Part A).** Rejected: silent co-write growth continues with no CI
  signal; blocker 4 measurement debt remains.

## Notes on measurement

Primary enforcement is write-call AST + raw SQL by SQL table name + adapter registration
+ verb-scoped operator matrix, as specified in the arc spec §5. CASCADE, triggers, and
hostile dynamic SQL remain residual limits and must be documented as such when Part A
ships.
