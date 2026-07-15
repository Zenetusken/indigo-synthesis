# ADR 0008: Calibration as an owned module that decides load

- Status: **proposed** — awaiting maintainer decision. Defines the boundary for the
  calibration engine; the reviewed methodology numbers it will carry remain a Gate 0
  deliverable and are not decided here.
- Date: 2026-07-14
- Relates to: [ADR 0001 modular monolith](0001-modular-monolith.md),
  [ADR 0003 deterministic methodology](0003-deterministic-methodology.md),
  [ADR 0006 optional grounded language](0006-optional-local-grounded-language.md),
  [ADR 0007 schema/table write-fence](0007-schema-table-ownership.md)
- Spec: [Calibration engine + module boundary](../CALIBRATION_SPEC.md)

## Context

The `profile → plan → train → learn` loop has no engine that turns an athlete's attested
baseline into working loads and recalibrates them from performed work. Loads come from
`UNREVIEWED_DEVELOPMENT_TEMPLATE`; `adjustment_decision` already records a future-load
decision (`next_load_grams` + `reason_code` + `rule_version`) but nothing computes it, and
`future_load_explanation_cache` narrates a decision the "codes path" is meant to own. With
neurotype excluded, per-athlete load calibration is the product's personalization mechanism.

Today `training` writes `program_revision` and the prescription cluster directly on
completion — the Programs↔Training co-write that [ADR 0007](0007-schema-table-ownership.md)
fenced as declared debt. Whatever owns the load *decision* is what dissolves or entrenches
that debt.

## Decision (proposed)

Introduce a new `calibration` module that **owns the load decision and the derived
calibration state**, with all cross-module access through ports (not table reaching),
enforced by the ADR 0007 write-fence.

1. Calibration owns derived e1RM / working-max state (new tables) and the future-load
   **decision** (`adjustment_decision` and its invalidation ledger move to it). It reads
   session facts from `training` and the applied revision from `programs` through ports.
2. `strength_baseline` **stays** with `athletes` (attested input); calibration reads it via
   an `athletes` port.
3. The engine is **deterministic** ([ADR 0003](0003-deterministic-methodology.md)): a
   layered base + adaptive-override progression, a scheduled-backstop-plus-triggered deload,
   and a time-away layoff back-off, all wrapped by an **unconditional safety clamp** that no
   branch can exceed (safety outranks all).
4. Every numeric rule is **labeled development configuration** on a `rule_version`, swappable
   at Gate 0; this ADR commits no reviewed prescription.
5. The LLM layer **explains** each calibration decision and never makes one
   ([ADR 0006](0006-optional-local-grounded-language.md)); journeys work with it off.
6. On completion, calibration computes the next loads and calls a **Programs write port** to
   persist the new revision. `training` stops writing `program_revision`.

## Consequences

- **The Programs↔Training co-write retires when this lands — proven, not asserted.** Point 6
  removes the reason `training` writes the cluster; the ADR 0007 manifest's `sharedWriters`
  debt grants for that cluster drop to zero and the O3 stale-grant check enforces it. Until
  the slice lands, this ADR is a *target*; the fence is the verifier.
- Calibration becomes the first real consumer that exercises the write-fence, and the
  largest consumer of the grounded-explanation layer.
- `ownership.ts` gains `'calibration'` in `ModuleId`, a new schema file (auto-covered by the
  schema-derived `SqlTableName` and the glob scanner), new owned tables, and re-homed
  decision tables. These are ordinary fence edits.
- Reviewed numbers stay Gate 0; production still rejects the dev config. This ADR does not
  advance product-truth methodology.

## Alternatives considered

- **Keep the decision in `training` (status quo).** Rejected: entrenches the co-write the
  fence flags as debt; no module owns load calibration; the "decider" stays smeared across
  Programs/Training.
- **Put calibration inside `programs`.** Rejected: it must read performed work (`training`)
  and athlete baselines (`athletes`) as much as it writes prescriptions; folding it into
  `programs` recreates cross-reaching rather than resolving it. A dedicated module with ports
  is the clean owner.
- **Model-decided loads.** Rejected here: prescription/deload are safety decisions; an
  unevaluated model in that seat violates product truth and safety. Available only via the
  DEFERRED.md bar (consented data, evaluation, safety ADR).
- **8RM × 0.72 fixed-linear anchor.** Rejected: cannot express the chosen adaptive,
  continuously-recalibrated model (see spec §4.1).
