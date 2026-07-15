# Calibration engine + module boundary (arc spec)

Status: **draft for review** — measure-first; grounded in the prior-iteration methodology
docs and a census of the current tree; revised after adversarial review
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
- **Paradigm vs. numbers.** Choosing the *adaptive, continuously-recalibrated* direction
  (over fixed-linear) is a **product-direction decision made by the owner** and recorded
  here — not a reviewed clinical claim. Gate 0's reviewers retain authority over the
  paradigm; the engine is built so a Gate 0 decision to prefer fixed-linear is expressible
  as configuration (§4.1). The **numbers** (formulas, bands, increments, thresholds, safety
  bounds) are Gate 0 outputs; this spec only says where they plug in.

---

## 1. Grounding (census, not intent)

**Prior iterations** (`/home/drei/project/{Indigo, project-synthesis-training}`) documented
most of the machinery, fragmented and never unified. The **neurotype-free reusable core**:
e1RM estimation, an `e1RM × intensity%` anchor, phase intensity/rep structure, a
completion-rate + effort progression tree, an auto-regulation model, load rounding, a plate
model, and a re-test-at-phase-transition cadence. Everything neurotype-scoped is dropped.

**Current app** has the *plumbing* but no engine. Critically, the future-load **decision**
already exists as an atomic cluster: `adjustment_decision` (the decision:
`next_load_grams` + `reason_code` + `rule_version`), `adjustment_decision_invalidation` (its
invalidation ledger), and `future_load_explanation_cache` (the LLM narration) — joined in a
single linearized query so an explanation is never served for a superseded decision. Loads
today come from `UNREVIEWED_DEVELOPMENT_TEMPLATE`; there is **no calibration math** in the
codebase.

---

## 2. Scope and non-goals

In scope: a new `calibration` module; the deterministic engine (§4); the safety clamp (§5);
the dev-config boundary (§6); the LLM explanation seam (§7); the module boundary, its
`UnitOfWork`, and its write-fence integration (§8).

Out of scope: closing Gate 0; reviewed numbers; a Progress read-model; velocity capture;
plateau detection. Model-driven *decisions* are explicitly out (§7).

---

## 3. The calibration loop

1. **Anchor** — derive an **e1RM per lift** from the attested `strength_baseline`; working
   weight = `e1RM × phase-intensity%` (§4.1). An **input gate** rejects an implausible
   derived e1RM *before* any load is computed (§5).
2. **Recalibrate** — each performed set updates the e1RM estimate.
3. **Decide next load** — the layered rules choose the next load (§4.2).
4. **Recover** — scheduled-backstop + triggered deloads insert easy weeks (§4.3).
5. **Interrupt** — a layoff backs loads off by time away (§4.4).
6. **Re-test** — at phase transitions, re-anchor from a fresh attested max test (§4.1); this
   is an *anchor* path, not a progression step, and is bounded by input gates + absolute
   caps, not the per-session rate cap (§5).

Steps 3–5 emit a **decision record** (`adjustment_decision` shape) that is authoritative and
drives §7. The on-completion recalibration (steps 3–5 → next revision) runs inside a
`UnitOfWork` (§8).

---

## 4. The deterministic engine (normative shapes; dev-config numbers)

### 4.1 Anchor — e1RM-anchored (owner product direction; Gate-0-revisable)

The prior digests left the anchor OPEN between `working = 8RM × 0.72` (fixed-linear) and
`working = e1RM × intensity%` (continuously re-estimated). The chosen progression model
(§4.2) is *adaptive*, which requires re-estimating the max every session — so the engine is
**e1RM-anchored**. This is the owner's product-direction choice, recorded here, not a
Gate-0 methodology claim; Gate 0 may prefer fixed-linear, which the engine expresses as a
degenerate config (a constant anchor + fixed step).

- e1RM is **derived** on a dev-config formula (default candidate: Brzycki), carried on
  `rule_version`; freshness and upward-ratchet rules are dev-config. Formula choice is a
  Gate 0 output; no accuracy claim is asserted here.
- The attested `strength_baseline` is the seed; performed sets recalibrate.

### 4.2 Progression — layered (base + adaptive override)

- **Base:** a predictable step (dev-config).
- **Adaptive override:** reads completion-rate + effort (RPE; optional readiness) and
  overrides up / hold / down (dev-config bands).

Output: a decision record whose `reason_code` names the branch that fired.

### 4.3 Deload — scheduled backstop + triggered

- **Backstop (safety floor):** never exceed a max interval without an easy week (dev-config
  cadence) — a safety mechanism (§5), not a preference.
- **Triggered:** an earlier deload on fatigue signs (dev-config thresholds).

### 4.4 Layoff — auto-back-off by time away

Absence beyond a dev-config threshold reduces working loads as a function of time away, then
rebuilds. Emits a decision record with a layoff `reason_code`.

---

## 5. Safety — input gates + an outermost output clamp (normative)

**Safety outranks every other rule** (Gate 0 §F). Two distinct safety layers:

**Input gates (applied at anchor time, before loads are computed — §3 step 1):**
- **Baseline sanity** — a derived e1RM outside plausible bounds is rejected, not prescribed.

**Output clamp (applied last, wrapping every §4 progression/deload/layoff branch — no branch
can exceed it):**
- **Max per-session load increase** (dev-config; carried from prior iterations' `maxIncrease`).
  Applies to session-to-session progression; the phase-transition **re-anchor** (§3 step 6)
  is exempt from this rate cap and bounded instead by the input gate + absolute caps.
- **Max absolute load / volume / frequency** per lift and session.
- **Never-to-failure / RIR floor.**
- **Deload floor** — the §4.3 backstop cannot be disabled by the adaptive path.

A clamp or gate hit is itself a `reason_code` (e.g. `safety.capped`) and, when it must
suspend training, **raises a `safety_hold` through the athletes safety-hold port inside the
completion `UnitOfWork`** (§8) — never by writing the athletes table directly. Safety
*values* are dev-config; the *mechanism* is unconditional and proven by fixtures (§10, K4).

---

## 6. Dev-config vs. reviewed methodology

- Every number in §4–§5 lives in a labeled **development configuration** on a `rule_version`;
  calibration output is labeled development content and production rejects the dev config.
- This spec commits the **engine, seams, safety clamp, and boundary** — no reviewed
  prescription. Replacing the dev config (baseline/TM formula, bands, increments, thresholds,
  back-off rates, safety bounds, golden vectors) is a Gate 0 deliverable, not a relabel.
- The adaptive *paradigm* is an owner product-direction choice (§4.1), Gate-0-revisable.

---

## 7. The LLM explanation seam (explains, never decides)

Per [ADR 0006](adr/0006-optional-local-grounded-language.md) (*"without giving the model
authority over training decisions"*; journeys "remain complete when generation is
disabled"):

- The **calibration decision record is authoritative** (the "codes path"). The model never
  chooses a load, deload, or back-off.
- The explanation cache + fact bundle **move with the decision into `calibration`** (§8) so
  the single linearized invalidation gate (decision ⋈ invalidation ⋈ explanation) stays
  inside one module — an explanation is never served for an invalidated decision. Calibration
  is the LLM's caller; the LLM is off by default and journeys are intact.
- Every explanation shows the `reason_code` and `rule_version`.
- Model-*decided* prescription remains behind the deferred bar (DEFERRED.md).

---

## 8. Module boundary, the `UnitOfWork`, and write-fence integration

Calibration is a new module; cross-module access is via **ports**, never table reaching,
enforced by the ADR 0007 write-fence (landed in #9; O1 at compile, O2–O5 in CI). This
section is corrected after review: the future-load **decision is an atomic cluster** and
must move as a unit, and the on-completion write spans modules and therefore requires the
`UnitOfWork`.

### 8.1 Ownership map (corrected)

| Concern | Owner (target) | Access seam |
| --- | --- | --- |
| `strength_baseline` (attested test) | stays `athletes` | calibration reads via an `athletes` port |
| derived e1RM / working-max state | **new, `calibration`** | owned |
| future-load **decision cluster** — `adjustment_decision`, `adjustment_decision_invalidation`, `future_load_explanation_cache` (+ its fact bundle) | **moves as a unit to `calibration`** | keeps the atomic invalidation gate inside one module (§7) |
| `training_fact_correction` (correction source) | stays `training` | a fact correction invalidates affected calibration decisions via a **calibration invalidation port** (replaces training's direct write of the invalidation ledger) |
| prescription cluster — `program_revision`, `planned_workout`, `exercise_prescription`, `set_prescription`, and `program_revision_lineage` | stays / consolidates under `programs` | calibration persists the next revision through a **Programs write port** inside the `UnitOfWork`; `program_revision_lineage` moves to `programs` and is written by that port with the revision |
| `safety_hold` | stays `athletes` | calibration raises a hold via an **athletes safety-hold port** inside the `UnitOfWork` (§5) |

### 8.2 The `UnitOfWork` (ADR 0001, built by this arc)

On-completion recalibration is a **multi-module write** (calibration's decision cluster +
programs' revision cluster + optionally athletes' `safety_hold`) that must be atomic. This is
the `UnitOfWork` ([ADR 0001](adr/0001-modular-monolith.md); ARCHITECTURE.md "Cross-module
composition"): a `src/application/workflows/` completion workflow opens a `UnitOfWork` and,
within one transaction, invokes calibration (which writes its own cluster, calls the Programs
write port to persist the revision + lineage + prescriptions, and calls the athletes
safety-hold port if the clamp fired). All participants bind to the same transaction; it
commits or rolls back as one. **Calibration is the re-entry trigger ADR 0007 named for
building the `UnitOfWork`.**

### 8.3 The trigger seam

Nothing "reaches across": the **completion workflow** (application layer, no owned tables)
composes public module ports in `UnitOfWork` order — training publishes the completed session
as a fact, calibration decides and persists. This matches ARCHITECTURE's cross-module
composition rule and gives the on-completion recalibration a named seam.

### 8.4 How the debt retires (target; the landed fence verifies)

Today `training` directly writes the four-table Programs↔Training cluster on completion — the
`additionalWriters` debt grants (`module: 'training', ops: ['insert'], debt: true`) on
`program_revision`, `planned_workout`, `exercise_prescription`, `set_prescription` in
`ownership.ts`. Built this way, those writes move behind the Programs write port + `UnitOfWork`,
so the four debt grants are **removed**. The **landed** O2/O3 checks
(`schema-ownership.test.ts`, #9) verify it: O2 fails if `training` still writes the cluster;
O3 fails if a debt grant is left stale. This spec defines the target; the merged fence is the
verifier — the debt is not asserted retired until the slice lands green.

### 8.5 Required `ownership.ts` changes

Add `'calibration'` to `ModuleId`; add the calibration schema file (auto-covered by the
schema-derived `SqlTableName` + glob scanner); re-home the decision-cluster tables
(`adjustment_decision`, `adjustment_decision_invalidation`, `future_load_explanation_cache`)
and `program_revision_lineage`; remove the four Programs↔Training `additionalWriters` debt
grants; calibration is a writer (not in `NON_WRITING_MODULES`).

---

## 9. What exists vs. net-new

- **Exists:** `strength_baseline`, the prescription tables, the decision cluster
  (`adjustment_decision` + invalidation + explanation), the fact-bundle/explanation pattern,
  the dev-fixture generator, and the ADR-0007 write-fence.
- **Net-new:** the `calibration` module + engine; its derived e1RM / working-max schema; the
  `UnitOfWork` and the completion workflow; the ports (athletes read + safety-hold, training
  fact→invalidation, Programs write); the layered/deload/layoff rules; the safety clamp; real
  plate math wired to the athlete's captured equipment; e1RM derivation; calibration
  `reason_code`s.

---

## 10. Definition of done (falsifiable — the K-series)

| ID | Claim | Proof |
| --- | --- | --- |
| **K1** | Engine deterministic and total | Golden vectors incl. progress/hold/deload(both paths)/layoff/**phase-transition re-anchor**; same input → same decision + `reason_code` + `rule_version` |
| **K2** | Journeys survive LLM off | J1–J6 green with generation disabled; explanation absence never blocks a decision |
| **K3** | Numbers are dev-config, not reviewed | Every rule carries a `rule_version`; output labeled development; production rejects dev values; no reviewed prescription or clinical accuracy claim asserted |
| **K4** | Safety layers hold | Fixtures: no §4 branch exceeds the output clamp; a super-cap progression is clamped and emits `safety.capped`; a **re-anchor** jump passes the rate cap but is bounded by the input gate + absolute caps; an implausible baseline is rejected at anchor time; the deload backstop cannot be disabled |
| **K5** | Boundary holds under the landed fence | `calibration` owns its tables; cross-module access via ports; the write-fence O2/O3 (landed #9) is green; the four Programs↔Training `additionalWriters` debt grants are removed and O3 enforces no stale grant remains |
| **K6** | Decisions traceable | Every prescribed load traces to a decision record → source performed sets + `rule_version`; e1RM derivations reproducible |
| **K7** | Multi-module writes are atomic | The completion `UnitOfWork` commits the decision cluster + revision cluster (+ `safety_hold` when raised) together, or rolls back together; an injected mid-transaction failure leaves no partial revision and no orphaned explanation |

Blocker-4 note: this arc does not reopen the schema-ownership blocker; it is the first real
consumer that *exercises* the landed fence, and K5 is where the Programs↔Training debt
actually retires — via the `UnitOfWork`, the mechanism ADR 0007 predicted would trigger it.

---

## 11. Deferred (with conditions)

Reviewed methodology numbers (Gate 0); velocity capture; plateau detection; model-decided
prescription (deferred bar); a Progress read-model. Each named so its absence is explicit.
