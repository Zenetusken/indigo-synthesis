# Calibration engine + module boundary (arc spec)

Status: **draft for review** — measure-first; grounded in the prior-iteration methodology
docs and a census of the current tree
Scope owner: architecture / product (methodology numbers gated by Gate 0)
Relates to: [ADR 0003 deterministic methodology](adr/0003-deterministic-methodology.md),
[ADR 0006 optional grounded language](adr/0006-optional-local-grounded-language.md),
[ADR 0007 schema/table write-fence](adr/0007-schema-table-ownership.md), proposed
[ADR 0008 calibration module boundary](adr/0008-calibration-module-boundary.md), and the
[Methodology v1 decision pack](../product/METHODOLOGY_V1_DECISION_PACK.md) (Gate 0).

**Calibration** is the missing engine of the `profile → plan → train → learn` loop: it turns
an athlete's attested baseline into working loads and **recalibrates them from performed
work**. With neurotype excluded, this per-athlete adaptation is the product's
personalization mechanism — so it is built as a centerpiece, not a side feature.

## What this spec is, and is NOT

- It specifies the **engine and its seams**: the deterministic decision shapes, the safety
  clamp, the LLM explanation seam, and the module boundary. This is architecture.
- It does **NOT** decide reviewed coaching methodology. **Every numeric rule below is
  labeled development configuration** carried on a `ruleVersion`, visibly unreviewed, and
  swappable at Gate 0. The development fixture is replaced through review, never relabeled
  (product truth: *"forbids calling rules AI"*; *"deterministic rules suffice"*). Where a
  number appears, it is an example dev-config value, not an approved prescription.
- The **reviewed numbers** (baseline/training-max formula, intensity bands, increments,
  deload thresholds, back-off rates, and all safety bounds) are Gate 0 outputs — a separate,
  human-gated process (named reviewers, rights matrix, golden vectors). This spec defines
  where they plug in, not what they are.

---

## 1. Grounding (census, not intent)

**Prior iterations** (`/home/drei/project/{Indigo, project-synthesis-training}`) documented
most of the machinery, fragmented across neurotype-first and generic designs and never
unified. The **neurotype-free reusable core** (extracted, cited): e1RM estimation
(Epley/Brzycki), an `e1RM × intensity%` anchor, phase intensity/rep structure, a
completion-rate + effort progression tree, an auto-regulation model (effort/velocity/
readiness/trend with clamps), load rounding, a plate model, and a re-test-at-phase-transition
cadence. Everything neurotype-scoped is dropped.

**Current app** has the *plumbing* but no engine: the input (`strength_baseline`: attested
`load×reps×protocol`), the output (`programs` prescription tables), the feedback and
**decision** records (`adjustment_decision` already carries `next_load_grams` + `reason_code`
+ `rule_version`), and the LLM explanation over the decision
(`future_load_explanation_cache` + fact bundle, which *"does not invent loads or reason
codes"*). Loads today come from `UNREVIEWED_DEVELOPMENT_TEMPLATE`; there is **no calibration
math** in the codebase. Calibration is exactly that missing engine.

---

## 2. Scope and non-goals

In scope: a new `calibration` module; the deterministic decision engine (§4); the safety
clamp (§5); the dev-config boundary (§6); the LLM explanation seam (§7); the module boundary
and its write-fence integration (§8).

Out of scope: closing Gate 0; reviewed numbers; a Progress read-model; video/velocity
capture hardware; anything the roadmap defers. Model-driven decisions are explicitly out —
see §7.

---

## 3. The calibration loop

1. **Anchor** — derive an **e1RM per lift** from the attested `strength_baseline`; working
   weight = `e1RM × phase-intensity%` (fork resolved in §4.1).
2. **Recalibrate** — each performed set updates the e1RM estimate (the continuous
   calibration; §4.1).
3. **Decide next load** — the layered rules read completion-rate + effort and choose the
   next load (§4.2).
4. **Recover** — scheduled-backstop + triggered deloads insert easy weeks (§4.3).
5. **Interrupt** — a layoff backs loads off by time away, then rebuilds (§4.4).
6. **Re-test** — at phase transitions, re-anchor from a fresh max test.

Every step (3–5) emits one **decision record** — the existing `adjustment_decision` shape:
`{ decision, current_load_grams, next_load_grams, reason_code, rule_version }` — which is
authoritative and drives §7.

---

## 4. The deterministic engine (normative shapes; dev-config numbers)

### 4.1 Anchor — resolved fork: e1RM-anchored (not 8RM × 0.72)

The prior digests left the anchor **OPEN** between `working = 8RM × 0.72` (a one-time test,
fixed-linear progression) and `working = e1RM × intensity%` (a continuously re-estimated
max). **Resolved: e1RM-anchored**, because the chosen progression model (§4.2) is *adaptive*
— it must read every session and re-estimate the max, which the 8RM-once model cannot
express. Rationale is recorded so this is not smuggled in as settled.

- e1RM is **derived**, dev-config formula (default: Brzycki, most accurate 2–10 reps),
  carried on `rule_version`; freshness and upward-ratchet rules are dev-config.
- The attested `strength_baseline` is the seed; performed sets recalibrate.

### 4.2 Progression — layered (base + adaptive override)

Deterministic, two-layer:

- **Base:** a predictable step (dev-config; e.g. add load when all target reps hit).
- **Adaptive override:** reads completion-rate + effort (RPE; optional readiness) and
  overrides the base up / hold / down (dev-config bands).

Output: a decision record with a `reason_code` naming which layer/branch fired.

### 4.3 Deload — both: scheduled backstop + triggered

- **Backstop (safety floor):** never exceed a max interval without an easy week (dev-config
  cadence). This is a safety mechanism (§5), not a preference.
- **Triggered:** an earlier deload when fatigue signs appear (missed reps / rising effort /
  declining trend; dev-config thresholds).

### 4.4 Layoff — auto-back-off by time away

Absence beyond a dev-config threshold reduces working loads as a function of time away
(detraining), then rebuilds over dev-config sessions. Emits a decision record with a layoff
`reason_code`.

---

## 5. Safety — the outermost clamp (normative)

**Safety outranks every other rule** (Gate 0 §F). The adaptive engine moves load *up*, so
every progression and deload path is wrapped by a hard clamp applied **last**, that no §4
branch can exceed:

- **Max per-session load increase** (dev-config cap; carried forward from prior iterations'
  `maxIncrease`).
- **Max absolute load / volume / frequency bounds** per lift and per session.
- **Never-to-failure / RIR floor** — prescriptions retain a reps-in-reserve margin.
- **Deload floor** — the §4.3 backstop cannot be disabled by the adaptive path.
- **Baseline sanity** — a derived e1RM outside plausible bounds is rejected, not prescribed.

A clamp hit is itself a decision `reason_code` (e.g. `safety.capped`) and may raise a
`safety_hold` via port (§8). Safety bounds are dev-config **values** but the clamp
**mechanism** is not optional and is proven by fixtures (§10, K4).

---

## 6. Dev-config vs. reviewed methodology

- Every number in §4–§5 lives in a single labeled **development configuration** stamped with
  a `rule_version`; the UI labels calibration output as development content until Gate 0, and
  configuration rejects the dev config in production (mirroring the program template).
- This spec commits the **engine, seams, and safety clamp** only. It commits **no reviewed
  prescription**. Replacing the dev config is a Gate 0 review deliverable (baseline/TM
  formula, intensity bands, increments, deload thresholds, back-off rates, safety bounds,
  golden vectors), not a code change relabel.
- `rule_version` on every decision makes each prescription traceable to the exact ruleset
  and swappable without touching the engine.

---

## 7. The LLM explanation seam (explains, never decides)

Consistent with [ADR 0006](adr/0006-optional-local-grounded-language.md) and the explanation
contract (*"without giving the model authority over training decisions"*; journeys "must
remain complete when generation is disabled"):

- The **calibration decision record is authoritative** (the "codes path"). The model never
  chooses a load, a deload, or a back-off.
- The existing explanation seam (`future_load_explanation_cache` + fact bundle) narrates the
  calibration decision in grounded, personal prose, reading it via a port; it *"does not
  invent loads or reason codes."* Every explanation shows the `reason_code` and
  `rule_version`.
- Calibration becomes the **largest consumer** of the explanation layer — the coaching voice
  across progression, deload, and layoff — with the LLM off by default and all journeys
  intact.
- Model-*decided* prescription is **not** in scope and remains behind the deferred bar
  (DEFERRED.md: consented dataset, failure taxonomy, safety ADR).

---

## 8. Module boundary + write-fence integration (target, proven by the fence)

Calibration is a new, cleanly-bounded module. Cross-module access is via **ports**, not
table reaching — enforced by the ADR 0007 write-fence (a boundary violation fails O1/O2 at
compile/CI). The load-bearing "what moves / what stays":

| Concern | Owner (target) | Rationale |
| --- | --- | --- |
| `strength_baseline` (attested test) | **stays `athletes`** | It is athlete-attested input; calibration reads it via an `athletes` port |
| Derived e1RM / working-max state | **new, `calibration`** | Derived calibration state is calibration's to own |
| The future-load **decision** (`adjustment_decision` + its invalidation ledger) | **moves to `calibration`** | Calibration is now the decider; it reads session facts (`training` port) and the applied revision (`programs` port), and writes the decision |
| The LLM **explanation** (`future_load_explanation_cache` + fact bundle) | **stays as the seam** | Presentation over the decision; reads the calibration decision via a port (§7) |
| Prescriptions / `program_revision` / `planned_workout` | **stay `programs`** | Calibration computes the next revision's loads and calls a **Programs write port** to persist them |

**How this retires the Part B debt (framed as a target, not an accomplishment):** today
`training` writes `program_revision` and the prescription cluster directly on completion — the
declared co-write debt fenced by ADR 0007. Built this way, that write becomes a
**calibration → Programs port call**: calibration computes the next loads on completion and
Programs persists them; `training` stops reaching across. **The write-fence proves the debt
is retired when the slice lands** — the `sharedWriters` debt grants for the Programs↔Training
cluster in `ownership.ts` shrink to zero and the O3 stale-grant check enforces it. This spec
does not claim the debt is gone; it defines the target whose landing the fence verifies.

**Required `ownership.ts` changes** (all covered by the existing fence machinery): add
`'calibration'` to `ModuleId`; add the new calibration schema file so the schema-derived
`SqlTableName` and glob-based scanner pick up its tables; add the new calibration-owned
tables and re-home the moved decision tables in `tableWriteFence`; calibration is a writer
(not added to `NON_WRITING_MODULES`).

---

## 9. What exists vs. net-new

- **Exists:** `strength_baseline`, the prescription tables, the feedback + decision records
  (`adjustment_decision`, `future_load_explanation_cache`), the fact-bundle + explanation
  pattern, the dev-fixture generator, and the ADR-0007 write-fence.
- **Net-new:** the `calibration` module + engine; its schema (derived e1RM history /
  working-max / calibration state); the ports to `athletes` / `training` / `programs`; the
  layered-progression + both-deload + layoff rules; the safety clamp; real plate math wired
  to the athlete's captured equipment inventory (never wired before); e1RM derivation; and
  calibration-specific `reason_code`s.

---

## 10. Definition of done (falsifiable — the K-series)

| ID | Claim | Proof |
| --- | --- | --- |
| **K1** | Engine is deterministic and total | Golden vectors incl. progress/hold/deload(both paths)/layoff/phase-transition; same input → same decision + `reason_code` + `rule_version` |
| **K2** | Journeys survive LLM off | J1–J6 green with generation disabled; explanation absence never blocks a decision |
| **K3** | Numbers are dev-config, not reviewed | Every rule carries a `rule_version`; output labeled development; config rejects dev values in production; no reviewed prescription asserted |
| **K4** | Safety clamp is unconditional | Fixtures prove no §4 branch exceeds the §5 caps; a super-cap input is clamped and emits `safety.capped`; deload backstop cannot be disabled |
| **K5** | Boundary holds under the fence | `calibration` owns its tables; cross-module access via ports; the write-fence (O1/O2) is green; Programs↔Training `sharedWriters` debt grants removed and O3 enforces it |
| **K6** | Decisions are traceable | Every prescribed load traces to a decision record → source performed sets + `rule_version`; e1RM derivations reproducible |

Blocker-4 note: this arc does not reopen the schema-ownership blocker; it is the first real
consumer that *exercises* the fence and (K5) is where the Programs↔Training debt actually
retires.

---

## 11. Deferred (with conditions)

Reviewed methodology numbers (Gate 0); velocity capture; plateau detection (interface only in
priors); model-decided prescription (deferred bar); a Progress read-model. Each is named so
its absence is explicit, not silent.
