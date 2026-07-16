# ADR 0007: Schema/table write-fence and residual boundary debt

- Status: **Part A accepted & shipped (#9); Part B decided — build the proper boundary**
  (2026-07-15). The maintainer chose to build Part B (module ports + a shared `UnitOfWork`,
  pursued via [ADR 0008](0008-calibration-module-boundary.md)) rather than accept this ADR's
  *provisional debt ratification* option as the terminal boundary. The write-fence (Part A) is
  confirmed the **interim** guardrail; its Programs↔Training `additionalWriters` debt grants are
  targeted for removal as Part B lands ([development roadmap](../DEVELOPMENT_ROADMAP.md)
  Stages 6/9). AGENTS.md / ARCHITECTURE.md remain the binding target — not silently rewritten;
  O6 doc convergence happens when Part B lands.
- Date: 2026-07-14 (revised same day after adversarial review)
- Relates to: [ADR 0001](0001-modular-monolith.md) (modular monolith deployment shape only)
- Disposition: Part A remains the interim fence; the maintainer selected the proper Part B
  boundary rather than provisional debt ratification. Historical option analysis below is retained
  as decision provenance; the active implementation sequence is the
  [development roadmap](../DEVELOPMENT_ROADMAP.md).
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

## Decision

This ADR's binding disposition is:

1. **Ship and keep Part A** of the spec: a checked-in **write-authority fence**
   (`tableWriteFence` + `crossCuttingOperator`) and local/pre-merge architecture suite (O1–O5).
   Write sites are fenced; they are **not** redefined as domain ownership.
2. **Build Part B's proper public boundary.** Public module ports, workflow composition, and a
   shared `UnitOfWork` retire the Programs/Training co-write, audit/safety grants, and Data
   Portability operator; private-import and peer-table-read guards make the boundary executable.
   ADRs [0008](0008-calibration-module-boundary.md) and
   [0009](0009-calibration-live-contract.md) plus the
   [development roadmap](../DEVELOPMENT_ROADMAP.md) are the implementation record.
3. **Treat every residual co-write/operator allowance as temporary declared debt only.** Existing
   `debt: true` grants and verb-scoped operator entries must match live code until their sequenced
   removal. They are not a terminal exception model and may not silently expand.
4. **Better Auth** adapter registration under `identity` counts as write authority for
   `user` / `session` / `account` / `verification` (O5). No second adapter elsewhere.
5. **Blocker 4** closes only after Part B removes the current grants/operator, all O1–O6 proof is
   green, and AGENTS/ARCHITECTURE/MVP status converge. The decision alone does not close it.

**Primary owners for co-written tables** (migration checklist defaults; see spec seed):

| Table | owner | debt writers |
| --- | --- | --- |
| `audit_event` | identity | athletes, programs, training (insert) |
| Programs↔Training cluster (4) | programs | training (insert) |
| `safety_hold` | athletes | training (insert for session-pain path) |

## Consequences

### Active Part B consequence

- The Part A fence remains; undeclared writes fail.
- AGENTS.md and ARCHITECTURE.md **remain the target** for public APIs / UnitOfWork /
  "no cross-module tables."
- The development roadmap implements the Programs completion port, audit port, safety-hold owner
  API, Data Portability ports, and `UnitOfWork`; none remains an optional maintainer fork.
- `MVP_STATUS` blocker 4 stays open until the current grants/operator are gone and O6 converges.
- New `additionalWriters` debt grants require: non-empty reason, `debt: true`, and
  reviewer answers (why not owner API? new cluster? transaction? DP order? sunset?).
  Expanding an existing reason string to add a **third** module counts as a new cluster
  pressure (re-entry), not free growth.

### Historical provisional alternative (not selected)

Before Part B was selected, provisional debt ratification was considered. Had that alternative
become the production boundary, the same change would have needed to amend:

- AGENTS.md architecture bullets (exported API only; UnitOfWork; never private tables) —
  suspend or rewrite for the declared debt set only;
- ARCHITECTURE.md dependency rules, Data Portability target, and "public-gateway
  enforcement still required" notes;
- MVP_STATUS known-architecture-debt and Maintainability row;
- relevant `src/modules/*/README.md` target-boundary sentences.

Without those amends, accepting a narrower boundary while leaving the higher-precedence contract
unchanged would create a dual source of truth. That packaging was rejected; it is not an active
closure path.

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
- **C1 — Programs completion write API.** Training calls Programs to append future
  revision + prescriptions; Programs remains sole aggregate writer. Bounded cost vs A;
  addresses the highest-churn debt class. Selected as part of Part B.
- **C2 — audit append port.** Selected; removes four-way `audit_event` inserts.
- **C3 — safety_hold single-owner API.** Selected; matches DB's two-policy model.
- **C4 — Data Portability per-module ports.** Selected; matches ARCHITECTURE target;
  independent of Programs↔Training.
- **C5 — UnitOfWork for multi-module writes only.** Selected; implemented first as neutral
  contracts under `src/application/coordination/`, the Drizzle adapter under
  `src/platform/application-coordination/`, and cross-module wiring under `src/composition/`.
- **Import-presence ownership as primary enforcement.** Rejected: punishes legitimate
  reads; blind to raw SQL and adapters; wrong invariant. Declared readers may be a
  follow-on (Part A2), not a substitute for the write fence.
- **Do nothing (no Part A).** Rejected: silent co-write growth continues with no automated
  signal; blocker 4 measurement debt remains.

## Notes on measurement

Primary enforcement is write-call AST + raw SQL by SQL table name + adapter registration
+ verb-scoped operator matrix, as specified in the arc spec §5. CASCADE, triggers, and
hostile dynamic SQL remain residual limits and must be documented as such when Part A
ships.
