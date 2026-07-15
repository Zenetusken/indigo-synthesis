# Calibration engine + module boundary (arc spec)

Status: **draft for review** — measure-first; grounded in the prior-iteration methodology
docs and a census of the current tree; boundary revised after two adversarial-review rounds
Scope owner: architecture / product (methodology numbers gated by Gate 0)
Relates to: [ADR 0001 modular monolith](adr/0001-modular-monolith.md) (the `UnitOfWork` this
arc builds), [ADR 0003 deterministic methodology](adr/0003-deterministic-methodology.md),
[ADR 0006 optional grounded language](adr/0006-optional-local-grounded-language.md),
[ADR 0007 schema/table write-fence](adr/0007-schema-table-ownership.md), proposed
[ADR 0008 calibration module boundary](adr/0008-calibration-module-boundary.md), and the
[Methodology v1 decision pack](../product/METHODOLOGY_V1_DECISION_PACK.md) (Gate 0).

**Calibration** is the missing engine of the `profile → plan → train → learn` loop: it turns
an athlete's attested baseline into working loads and **recalibrates them from performed
work**. With neurotype excluded, this per-athlete adaptation is the product's
personalization mechanism — so it is built as a centerpiece.

## What this spec is, and is NOT

- It specifies the **engine and its seams**: the deterministic decision shapes, the safety
  clamp, the LLM explanation seam, and the module boundary (including the `UnitOfWork` it
  requires). This is architecture.
- It does **NOT** decide reviewed coaching methodology. **Every numeric rule below is
  labeled development configuration** carried on a `rule_version`, visibly unreviewed, and
  swappable at Gate 0. The development fixture is replaced through review, never relabeled.
- **Paradigm vs. numbers.** Choosing the *adaptive, continuously-recalibrated* direction is
  a **product-direction decision made by the owner**, recorded here, not a reviewed clinical
  claim. Gate 0 retains authority over the paradigm; the engine expresses fixed-linear as a
  degenerate config (§4.1). The **numbers** are Gate 0 outputs; this spec only says where
  they plug in.

---

## 1. Grounding (census, not intent)

**Prior iterations** (`/home/drei/project/{Indigo, project-synthesis-training}`) documented a
neurotype-free reusable core: e1RM estimation, an `e1RM × intensity%` anchor, phase
structure, a completion-rate + effort progression tree, an auto-regulation model, load
rounding, a plate model, and a re-test cadence. Everything neurotype-scoped is dropped.

**Current app** has the *plumbing* but no engine. Critically, the future-load **decision is a
training-internal atomic concern**: its active-vs-invalidated status is decided by a single
locked read (`future-load-explanation-cache.ts`, one `pg_advisory_xact_lock(userId)`) that
joins `adjustment_decision`, `workout_session.status`, `session_feedback`, and
`training_fact_correction`. Three of those are training's session-lifecycle tables — so the
**decision gate cannot leave training** without violating the fence or shearing that
linearized read. This drives the boundary in §8. Loads today come from
`UNREVIEWED_DEVELOPMENT_TEMPLATE`; there is **no calibration math** in the codebase.

---

## 2. Scope and non-goals

In scope: a new `calibration` module (a deterministic engine + derived state, invoked via a
compute port); the engine (§4); the safety clamp (§5); the dev-config boundary (§6); the LLM
seam (§7); the module boundary, its `UnitOfWork`, and its write-fence integration (§8).

Out of scope: closing Gate 0; reviewed numbers; a Progress read-model; velocity capture;
plateau detection; unifying `safety_hold`'s writers (pre-existing, separate debt). Model-driven
*decisions* are out (§7).

---

## 3. The calibration loop

1. **Anchor** — calibration derives an **e1RM per lift** from the attested `strength_baseline`
   (passed to it); working weight = `e1RM × phase-intensity%` (§4.1). An **input gate**
   rejects an implausible derived e1RM before any load is computed (§5).
2. **Recalibrate** — each performed set (handed to calibration) updates the e1RM estimate.
3. **Decide next load** — training calls the calibration **compute port** with the facts; the
   layered rules return a decision (§4.2); **training records it** in `adjustment_decision`.
4. **Recover** — scheduled-backstop + triggered deloads (§4.3).
5. **Interrupt** — a layoff backs loads off by time away (§4.4).
6. **Re-test** — at phase transitions, re-anchor from a fresh attested max test (§4.1). A
   re-anchor may raise the target, but the **prescribed session-to-session load still ramps
   under the per-session output clamp** (§5) — no unbounded single-session jump.

The on-completion recalibration (steps 3–5 → next revision) runs inside a `UnitOfWork` (§8).

---

## 4. The deterministic engine (normative shapes; dev-config numbers)

### 4.1 Anchor — e1RM-anchored (owner product direction; Gate-0-revisable)

The engine is **e1RM-anchored**: the adaptive progression (§4.2) re-estimates the max every
session. This is the owner's recorded product direction, not a Gate-0 claim; Gate 0 may
prefer fixed-linear, expressed as a degenerate config (constant anchor + fixed step).

- e1RM is **derived** on a dev-config formula (default candidate: Brzycki), carried on
  `rule_version`; freshness and upward-ratchet rules are dev-config. Formula choice is a
  Gate 0 output; no accuracy claim is asserted here.

### 4.2 Progression — layered (base + adaptive override)

- **Base:** a predictable step (dev-config).
- **Adaptive override:** reads completion-rate + effort (RPE; optional readiness) and
  overrides up / hold / down (dev-config bands).

Returns a decision whose `reason_code` names the branch that fired.

### 4.3 Deload — scheduled backstop + triggered

- **Backstop (safety floor):** never exceed a max interval without an easy week (dev-config).
- **Triggered:** an earlier deload on fatigue signs (dev-config thresholds).

### 4.4 Layoff — auto-back-off by time away

Absence beyond a dev-config threshold reduces working loads by time away, then rebuilds.

---

## 5. Safety — input gates + an outermost output clamp (normative)

**Safety outranks every other rule** (Gate 0 §F). Two layers, both always applied:

**Input gate (at anchor time, before loads are computed):**
- **Baseline sanity** — a derived e1RM outside plausible bounds is rejected, not prescribed.

**Output clamp (applied last, wrapping every §4 branch — and every prescribed load delta):**
- **Max per-session load increase** — bounds the **session-to-session prescribed delta on
  every path, including after a phase-transition re-anchor.** A raised anchor is approached by
  ramping across sessions under this cap; there is **no re-anchor exemption** (a fresh max
  test raises the target, not the single-session jump).
- **Max absolute load / volume / frequency** per lift and session.
- **Never-to-failure / RIR floor.**
- **Deload floor** — the §4.3 backstop cannot be disabled by the adaptive path.

A clamp or gate hit is a `reason_code` (e.g. `safety.capped`) and, when training must be
suspended, calibration **signals `raise_hold`** in its decision; the completion workflow
raises the hold through the athletes owner path in the `UnitOfWork` (§8) — calibration never
writes `safety_hold`. Safety *values* are dev-config; the *mechanism* is unconditional and
proven by fixtures (§10, K4).

---

## 6. Dev-config vs. reviewed methodology

Every number in §4–§5 lives in a labeled **development configuration** on a `rule_version`;
output is labeled development and production rejects the dev config. This spec commits the
**engine, seams, safety clamp, and boundary** — no reviewed prescription and no clinical
accuracy claim. Replacing the dev config is a Gate 0 deliverable. The adaptive *paradigm* is
an owner product-direction choice (§4.1), Gate-0-revisable.

---

## 7. The LLM explanation seam (explains, never decides)

Per [ADR 0006](adr/0006-optional-local-grounded-language.md):

- The **decision record is authoritative** (the "codes path"), computed by the calibration
  engine and **recorded by training**. The model never chooses a load, deload, or back-off.
- The explanation cache + fact bundle **stay in training** with the decision, so the existing
  single linearized invalidation gate is untouched — an explanation is never served for an
  invalidated decision. The LLM narrates the training-held decision, off by default, with
  journeys intact. Every explanation shows the `reason_code` and `rule_version`.
- Model-*decided* prescription remains behind the deferred bar (DEFERRED.md).

---

## 8. Module boundary, the `UnitOfWork`, and write-fence integration

Corrected after two adversarial rounds: the future-load decision's correctness gate is
entangled with training's session lifecycle (§1), so the decision **stays in training** and
calibration is the **engine training calls** — not the decision's owner.

### 8.1 What calibration owns and exposes

- **Owns:** the deterministic engine (rules + safety clamp) and derived **e1RM / working-max
  state** (new calibration tables).
- **Compute port:** `computeNextLoad(facts) → { next_load_grams, reason_code, rule_version,
  raise_hold? }`, pure over inputs. The caller **passes** performed-set, phase, and baseline
  facts, so **calibration never reads a peer module's tables** — sidestepping the read a
  write-only fence cannot police.
- Updates its own e1RM state when training hands it performed sets via a port (calibration
  writes only its own tables).

### 8.2 What stays in training

The **decision record** (`adjustment_decision`), its **invalidation ledger**
(`adjustment_decision_invalidation`), the **explanation cache**
(`future_load_explanation_cache`), and the **atomic read-time gate** — all stay training-owned.
Training records the calibration-computed decision in its own transaction; the
correction-driven invalidation (`program_revision_invalidation` +
`adjustment_decision_invalidation`, `workouts.ts:243-266`) stays atomic **within training**.
No cross-module split of any atomic write.

### 8.3 Ownership map

| Concern | Owner (target) | Seam |
| --- | --- | --- |
| `strength_baseline` | stays `athletes` | facts passed to the calibration compute port |
| derived e1RM / working-max state | **new, `calibration`** | owned; updated via a training→calibration port (facts passed in) |
| decision cluster (`adjustment_decision`, `adjustment_decision_invalidation`, `future_load_explanation_cache`) | **stays `training`** | training records the calibration-computed decision; the atomic gate is untouched |
| prescription cluster (`program_revision`, `planned_workout`, `exercise_prescription`, `set_prescription`) | stays `programs` | written via a **Programs write port** inside the `UnitOfWork`; the four `training` debt grants are removed |
| `program_revision_lineage` | **moves `training` → `programs`** | written by the Programs port with the revision (an **owner change**, verified by O1 coverage + O2, not O3) |
| `safety_hold` | unchanged (`athletes` owner + pre-existing `training` session-pain debt) | calibration signals `raise_hold`; the completion workflow raises it via the **athletes owner path** in the `UnitOfWork`; unifying `safety_hold`'s writers is separate debt (out of scope) |

### 8.4 The `UnitOfWork` (ADR 0001, built by this arc)

On completion, a `src/application/workflows/` completion workflow opens a `UnitOfWork` and,
in one transaction: **training** records the decision (computed via the calibration port),
the **Programs write port** persists the revision + `program_revision_lineage` +
prescriptions, the **calibration port** updates e1RM state, and the **athletes owner path**
raises `safety_hold` if `raise_hold` was signaled. All bind to the same transaction and
commit or roll back together (ARCHITECTURE.md "Cross-module composition"). **Calibration is
the re-entry trigger ADR 0007 named for building the `UnitOfWork`.** The workflow composes
public ports; nothing reaches across tables.

### 8.5 How the debt retires (target; the landed fence verifies)

`training` stops writing the four-table cluster (the writes move behind the Programs port), so
its four `additionalWriters` debt grants are **removed** — verified by the **landed** O2
(`training` no longer writes them) and O3 (no stale grant), `schema-ownership.test.ts` (#9).
`program_revision_lineage`'s move is an **owner change** (`training`→`programs`), verified by
O1 coverage + O2, **not** the O3 stale-grant check. `safety_hold`'s pre-existing training debt
is **not** retired here. The debt is not asserted retired until the slice lands green.

### 8.6 Required `ownership.ts` changes

Add `'calibration'` to `ModuleId`; add the calibration schema file (new e1RM/working-max
tables, auto-covered by the schema-derived `SqlTableName` + glob scanner); move
`program_revision_lineage` to `programs`; remove the four Programs↔Training debt grants. The
decision cluster is unchanged (`training`). Calibration is a writer (not in
`NON_WRITING_MODULES`).

---

## 9. What exists vs. net-new

- **Exists:** `strength_baseline`, the prescription tables, the training-internal decision
  cluster + its atomic gate, the fact-bundle/explanation pattern, the dev-fixture generator,
  the ADR-0007 write-fence.
- **Net-new:** the `calibration` module (engine + derived e1RM/working-max state + compute
  port); the `UnitOfWork` and the completion workflow; the ports (athletes baseline read,
  training→calibration compute/estimate, Programs write); the layered/deload/layoff rules; the
  safety clamp; real plate math wired to the athlete's captured equipment; e1RM derivation.

---

## 10. Definition of done (falsifiable — the K-series)

| ID | Claim | Proof |
| --- | --- | --- |
| **K1** | Engine deterministic and total | Golden vectors incl. progress/hold/deload(both)/layoff/**phase-transition re-anchor**; same input → same `{next_load, reason_code, rule_version}` |
| **K2** | Journeys survive LLM off | J1–J6 green with generation disabled; explanation absence never blocks a decision |
| **K3** | Numbers are dev-config, not reviewed | Every rule carries a `rule_version`; output labeled development; production rejects dev values; no reviewed prescription or clinical accuracy claim asserted |
| **K4** | Safety layers hold | Fixtures: no §4 branch exceeds the output clamp; a super-cap progression is clamped and emits `safety.capped`; **a re-anchor with a raised max still ramps under the per-session cap (no single-session spike)**; an implausible baseline is rejected at anchor time; the deload backstop cannot be disabled |
| **K5** | Write boundary holds under the landed fence | `calibration` writes only its own tables; the four Programs↔Training `additionalWriters` debt grants are removed; O2/O3 (landed #9) green. *(Read isolation is by passed-in facts — calibration reads no peer tables — since O2/O3 fence writes only, not reads.)* |
| **K6** | Decisions traceable | Every prescribed load traces to a decision record → source performed sets + `rule_version`; e1RM derivations reproducible |
| **K7** | The completion write is atomic | The `UnitOfWork` commits the decision record + revision cluster + lineage + e1RM update (+ `safety_hold` when raised) together, or rolls back together; an injected mid-transaction failure leaves no partial revision. *(The explanation is written later by the LLM seam and is gated on the decision existing — not part of this transaction.)* |

Blocker-4 note: this arc is the first real consumer that *exercises* the landed fence; K5 is
where the Programs↔Training debt retires — via the `UnitOfWork`, the mechanism ADR 0007
predicted would trigger it.

---

## 11. Deferred (with conditions)

Reviewed methodology numbers (Gate 0); velocity capture; plateau detection; model-decided
prescription (deferred bar); a Progress read-model; unifying `safety_hold`'s writers. Each
named so its absence is explicit.
