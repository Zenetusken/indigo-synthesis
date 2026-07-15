# ADR 0008: Calibration as an engine training calls, with a UnitOfWork

- Status: **proposed** — awaiting maintainer decision. Defines the boundary for the
  calibration engine and commits to building the `UnitOfWork` it requires; the reviewed
  methodology numbers remain a Gate 0 deliverable and are not decided here.
- Date: 2026-07-14 (boundary inverted after two adversarial-review rounds — see Alternatives)
- Relates to: [ADR 0001 modular monolith](0001-modular-monolith.md) (the `UnitOfWork`),
  [ADR 0003 deterministic methodology](0003-deterministic-methodology.md),
  [ADR 0006 optional grounded language](0006-optional-local-grounded-language.md),
  [ADR 0007 schema/table write-fence](0007-schema-table-ownership.md)
- Spec: [Calibration engine + module boundary](../CALIBRATION_SPEC.md)

## Context

The `profile → plan → train → learn` loop has no engine that turns an athlete's attested
baseline into working loads and recalibrates them from performed work. The future-load
**decision is a training-internal atomic concern**: its active-vs-invalidated status is
decided by one locked read (`future-load-explanation-cache.ts`) joining `adjustment_decision`,
`adjustment_decision_invalidation`, `workout_session.status`, `session_feedback`, and
`training_fact_correction` — all training-owned session-lifecycle tables. That gate **cannot
leave training** without violating the ADR 0007 write-fence or shearing the linearized read
(two adversarial reviews confirmed this). With neurotype excluded, per-athlete load
calibration is the product's personalization mechanism.

Separately, `training` writes the four-table `program_revision` / prescription cluster
directly on completion — the Programs↔Training co-write ADR 0007 fenced as `additionalWriters`
debt (`program_revision_lineage` is training's own provenance table, read by training's
correction path — not part of that debt). Retiring it properly is a multi-module atomic write,
which requires the `UnitOfWork` [ADR 0001](0001-modular-monolith.md) describes and that has
been deferred.

## Decision (proposed)

Introduce a `calibration` module that is a **deterministic engine plus derived state, invoked
by training** — not the owner of the decision — and **build the `UnitOfWork`** the completion
write requires.

1. **Calibration owns** the engine (rules + safety clamp) and derived e1RM / working-max state
   (new tables), exposed as a **compute port** `computeNextLoad(facts) → {next_load,
   reason_code, rule_version, raise_hold?}`. The caller passes the facts, so calibration never
   reads a peer module's tables.
2. **The decision cluster stays `training`** — `adjustment_decision`, its invalidation ledger,
   the explanation cache, and the atomic read-time gate. Training records the
   calibration-computed decision in its own transaction; correction-driven invalidation stays
   atomic within training.
3. The engine is **deterministic** ([ADR 0003](0003-deterministic-methodology.md)): layered
   base + adaptive-override progression, scheduled-backstop-plus-triggered deload, layoff
   back-off, wrapped by an input gate + an **unconditional output clamp** that bounds every
   prescribed session-to-session delta (including after a re-anchor — no exemption).
4. Every numeric rule is **labeled development configuration** on a `rule_version`, swappable
   at Gate 0. The adaptive *paradigm* is an owner product-direction choice, Gate-0-revisable.
5. The LLM **explains** each decision and never makes one
   ([ADR 0006](0006-optional-local-grounded-language.md)); journeys work with it off.
6. On completion, a `src/application/workflows/` workflow opens a **`UnitOfWork`**: training
   records the decision and writes its own `program_revision_lineage`, a **Programs write
   port** persists the revision + prescriptions, the **calibration port** updates e1RM state,
   and the **athletes owner path** raises `safety_hold` when signaled — one transaction,
   atomic. `training` stops writing the prescription cluster; nothing reaches across tables.

## Consequences

- **We build the `UnitOfWork`** (ADR 0001's target); calibration is the re-entry trigger ADR
  0007 named. A real scope commitment, chosen because the multi-module atomic completion write
  cannot be expressed without it.
- **The Programs↔Training co-write retires when this lands — verified, not asserted.** The four
  `training` `additionalWriters` grants are removed; the **landed** O2/O3 checks
  (`schema-ownership.test.ts`, #9, run by `pnpm test` / `pnpm validate` — there is no in-repo
  CI) fail if `training` still writes the cluster or a grant is left stale.
  `program_revision_lineage` stays `training` (its own provenance table). `safety_hold`'s
  pre-existing training debt is not retired here.
- `ownership.ts` gains `'calibration'` in `ModuleId`, a new schema file, and the four removed
  debt grants. The decision cluster and `program_revision_lineage` are unchanged (`training`).
- Reviewed numbers stay Gate 0; production still rejects the dev config.

## Alternatives considered

- **Calibration *owns* the decision cluster (the earlier draft of this ADR).** Rejected after
  review: the decision's active/invalid gate atomically reads three training session-lifecycle
  tables under one lock; moving the decision to calibration forces either a direct cross-module
  read (fence violation) or a split of the linearized gate (serving explanations for
  invalidated decisions) and a non-atomic correction path. The decision cannot cleanly leave
  training; calibration is the engine it calls.
- **Keep everything in `training` (status quo).** Rejected: no module owns load calibration and
  the co-write the fence flags as debt is entrenched.
- **Persist the revision by direct table write (no `UnitOfWork`).** Rejected: that is the
  reaching the fence forbids; the atomic completion write needs the `UnitOfWork`.
- **Model-decided loads.** Rejected here (safety); available only via the DEFERRED.md bar.
- **8RM × 0.72 fixed-linear anchor.** Not the chosen product direction, but expressible as a
  degenerate engine config if Gate 0 prefers it (spec §4.1).
