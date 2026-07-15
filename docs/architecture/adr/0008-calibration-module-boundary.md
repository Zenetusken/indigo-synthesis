# ADR 0008: Calibration as an owned module that decides load, with a UnitOfWork

- Status: **proposed** — awaiting maintainer decision. Defines the boundary for the
  calibration engine and commits to building the `UnitOfWork` it requires; the reviewed
  methodology numbers remain a Gate 0 deliverable and are not decided here.
- Date: 2026-07-14 (revised after adversarial review)
- Relates to: [ADR 0001 modular monolith](0001-modular-monolith.md) (the `UnitOfWork`),
  [ADR 0003 deterministic methodology](0003-deterministic-methodology.md),
  [ADR 0006 optional grounded language](0006-optional-local-grounded-language.md),
  [ADR 0007 schema/table write-fence](0007-schema-table-ownership.md)
- Spec: [Calibration engine + module boundary](../CALIBRATION_SPEC.md)

## Context

The `profile → plan → train → learn` loop has no engine that turns an athlete's attested
baseline into working loads and recalibrates them from performed work. The future-load
**decision already exists as an atomic cluster** — `adjustment_decision` (the decision) +
`adjustment_decision_invalidation` + `future_load_explanation_cache` — joined in one
linearized query so an explanation is never served for a superseded decision, but nothing
computes the decision. With neurotype excluded, per-athlete load calibration is the
product's personalization mechanism.

Today `training` writes the four-table `program_revision` / prescription cluster (and
`program_revision_lineage`) directly on completion — the Programs↔Training co-write that
[ADR 0007](0007-schema-table-ownership.md) fenced as `additionalWriters` debt. Whatever owns
the load *decision* is what dissolves or entrenches that debt. Doing it properly is a
multi-module atomic write, which requires the `UnitOfWork` that [ADR 0001](0001-modular-monolith.md)
describes and that has been deferred.

## Decision (proposed)

Introduce a new `calibration` module that **owns the load decision and derived calibration
state**, with all cross-module access through ports, enforced by the landed ADR 0007
write-fence — and **build the `UnitOfWork`** the boundary requires.

1. Calibration owns derived e1RM / working-max state (new tables) and the **future-load
   decision cluster moved as a unit** (`adjustment_decision`,
   `adjustment_decision_invalidation`, `future_load_explanation_cache`), keeping the atomic
   invalidation gate inside one module.
2. `strength_baseline` stays with `athletes` (attested input); calibration reads it via an
   `athletes` port. A `training` fact correction invalidates affected calibration decisions
   via a **calibration invalidation port** (not a direct ledger write).
3. The engine is **deterministic** ([ADR 0003](0003-deterministic-methodology.md)): layered
   base + adaptive-override progression, scheduled-backstop-plus-triggered deload, time-away
   layoff back-off, wrapped by input gates + an **unconditional output clamp** (safety
   outranks all).
4. Every numeric rule is **labeled development configuration** on a `rule_version`, swappable
   at Gate 0. The adaptive *paradigm* is an owner product-direction choice, Gate-0-revisable;
   this ADR commits no reviewed prescription.
5. The LLM layer **explains** each decision and never makes one
   ([ADR 0006](0006-optional-local-grounded-language.md)); journeys work with it off.
6. On completion, a `src/application/workflows/` completion workflow opens a **`UnitOfWork`**
   and, in one transaction, invokes calibration, which persists the four-table revision
   cluster + `program_revision_lineage` through a **Programs write port** and raises a
   `safety_hold` through an **athletes port** when the clamp fires. `training` stops writing
   the cluster; nothing reaches across.

## Consequences

- **We build the `UnitOfWork`** (ADR 0001's target). Calibration is the re-entry trigger
  ADR 0007 named. This is a real scope commitment, chosen because proper module ownership of
  a multi-module atomic write cannot be expressed without it.
- **The Programs↔Training co-write retires when this lands — verified, not asserted.** The
  four `additionalWriters` debt grants (`module: 'training'`, on `program_revision`,
  `planned_workout`, `exercise_prescription`, `set_prescription`) are removed; the **landed**
  O2/O3 checks (`schema-ownership.test.ts`, #9) fail if `training` still writes the cluster or
  a debt grant is left stale. Until the slice lands green, this is a target.
- Calibration becomes the first real consumer to exercise the write-fence and the largest
  consumer of the grounded-explanation layer.
- `ownership.ts` gains `'calibration'` in `ModuleId`, a new schema file (auto-covered by the
  schema-derived `SqlTableName` + glob scanner), re-homed decision-cluster and lineage
  tables, and the four removed debt grants.
- Reviewed numbers stay Gate 0; production still rejects the dev config.

## Alternatives considered

- **Keep the decision cluster in `training` (status quo).** Rejected: entrenches the
  co-write the fence flags as debt; no module owns load calibration.
- **Move only `adjustment_decision`, leave the invalidation/explanation in `training`.**
  Rejected: shears the atomic invalidation gate across a module boundary — an explanation
  could be served for an already-invalidated decision. The cluster must move as a unit.
- **Persist the revision by direct table write (no `UnitOfWork`).** Rejected: that is the
  reaching the fence forbids; a multi-module atomic write needs the `UnitOfWork`.
- **Put calibration inside `programs`.** Rejected: it reads performed work (`training`) and
  baselines (`athletes`) as much as it writes prescriptions; folding it in recreates
  cross-reaching.
- **Model-decided loads.** Rejected here (safety); available only via the DEFERRED.md bar.
- **8RM × 0.72 fixed-linear anchor.** Not chosen as the product direction, but expressible as
  a degenerate engine config if Gate 0 prefers it (spec §4.1).
