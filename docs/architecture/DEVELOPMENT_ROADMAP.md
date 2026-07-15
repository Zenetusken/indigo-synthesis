# Development roadmap — write-fence → calibration → proper module architecture (Part B)

**Purpose.** This is the *engineering* roadmap for the architecture arc: how we get from the
shipped schema write-fence to **Part B** — the proper module architecture (ports/gateways and
a shared `UnitOfWork`) that [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](../../AGENTS.md)
describe as the target. It consolidates the decisions taken so far, the reasoning behind them,
and the ordered, dependency-aware plan to build everything properly.

**How to read it.** Sections 1–3 bring a new developer up to speed (vision, the load-bearing
decisions and *why*, and where we are today). Section 4 is the sequenced build plan
(nearest → furthest), each stage with goal, dependencies, what it unblocks, and a falsifiable
definition of done. Sections 5–7 are the dependency graph, a decision-point index for
onboarding, and what "Part B done" looks like.

**Relationship to the other planning docs.** [docs/ROADMAP.md](../ROADMAP.md) is the *product*
delivery roadmap (Phases 1–5, gated by proof and by **Gate 0** methodology review).
[docs/MVP_STATUS.md](../MVP_STATUS.md) tracks the production-release blockers. This document is
the *architecture/engineering* sequence that runs largely in parallel with product content and
does not itself close Gate 0.

---

## 1. Project vision (the *why*)

Indigo Synthesis is a **self-hosted strength-training system** with one primary loop:
**`profile → plan → train → learn`**. A serious, self-directed recreational trainee sets up a
profile (goals, equipment, schedule, baselines), follows an authored program, records what they
actually lifted, and the system learns from it to adjust future prescriptions. Deployment is
single-owner / household; public signup is closed.

Two deliberate posture choices shape everything:

- **Honest engineering MVP, not reviewed coaching software.** Every exercise, load, progression,
  and safety decision that reaches a real athlete is **methodology** and is gated behind
  **Gate 0** (the [Methodology v1 decision pack](../product/METHODOLOGY_V1_DECISION_PACK.md):
  named independent reviewers, a rights matrix, reviewed formulas, safety bounds, golden
  vectors). Until Gate 0 closes, numbers ship as clearly-labeled **development configuration**
  and production rejects them. We build the *machinery* now; the *reviewed numbers* come later.
- **Neurotype is excluded.** The prior iterations' personalization thesis was a neurotype
  assessment; it was cut. That leaves **calibration — per-athlete load adaptation from performed
  work — as the product's personalization mechanism and differentiator.** So calibration is
  built as a centerpiece, not a side feature.

And one working principle, agreed explicitly, that governs every architecture fork:

> **Always build with proper architecture and best practice.** "Does the app need it yet / is it
> worth the effort" is never the deciding question. This is a long-horizon, correctness-by-
> construction project that may be handed off, so a real structural boundary beats a documented
> debt-fence a newcomer could extend.

---

## 2. Guiding principles + decision record (the load-bearing calls)

These are the decisions a new developer must understand. Each links to where it is recorded.

| Decision | Why | Recorded in |
| --- | --- | --- |
| **Deterministic methodology.** Prescription/progression/deload are deterministic rules, never model output. | Product truth "forbids calling rules AI"; deterministic rules are reviewable/testable; safety. | [ADR 0003](adr/0003-deterministic-methodology.md) |
| **LLM explains, never decides.** The model produces optional grounded prose over an *already-decided* authoritative reason code; journeys work with it off. Model-*decided* prescription is deferred behind a consented-data + evaluation + safety-ADR bar. | Safety (an unevaluated model must not choose loads/deloads); product truth; ADR 0006 contract. | [ADR 0006](adr/0006-optional-local-grounded-language.md), [DEFERRED.md](../DEFERRED.md) |
| **Gate 0 governs reviewed numbers.** All methodology numbers are labeled dev-config until Gate 0; the fixture is replaced through review, never relabeled. | Product-truth / safety governance; separates buildable engineering from human-gated content. | [Methodology v1 pack](../product/METHODOLOGY_V1_DECISION_PACK.md) |
| **Write-authority fence (Part A, shipped).** Ownership = *write* authority; a checked-in manifest maps every table to an owner + declared debt grants; enforced by compile-time bijection (O1) and a runtime write census (O2–O5). | Contains and makes visible the cross-module co-write debt without a big up-front refactor; the interim guardrail. | [ADR 0007](adr/0007-schema-table-ownership.md), [SCHEMA_OWNERSHIP_SPEC.md](SCHEMA_OWNERSHIP_SPEC.md), merged in #9 |
| **Part B = proper module boundaries.** Build the ports/gateways + `UnitOfWork` that ARCHITECTURE/AGENTS describe; the fence is only ever *interim*, never the accepted terminal design. | The "always proper architecture" principle; a real boundary a newcomer cannot route around. | ADR 0007 §Part B, [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Calibration is an engine, the decision stays in `training`.** Calibration is a deterministic engine + derived e1RM state, exposed as a `computeNextLoad(facts)` port; the caller passes the facts so it reads no peer tables. The future-load *decision record* + its atomic invalidation gate stay in `training` (the gate is a locked read over training's session lifecycle and cannot leave without shearing atomicity). | Converged over **three adversarial-review rounds** (the boundary was *inverted* after the second; the third confirmed it) — moving the decision to calibration repeatedly broke atomicity / the write-fence. | [ADR 0008](adr/0008-calibration-module-boundary.md), [CALIBRATION_SPEC.md](CALIBRATION_SPEC.md), merged in #10 |
| **The `UnitOfWork` is the mechanism that retires cross-module co-writes.** A transaction-scoped composition of module ports; calibration's on-completion write is its first real use and the re-entry trigger ADR 0007 named. | A multi-module atomic write cannot be expressed by table-reaching without the fence flagging it; ARCHITECTURE's stated target. | [ADR 0001](adr/0001-modular-monolith.md), ARCHITECTURE.md "Cross-module composition" |
| **Calibration methodology direction (owner product-direction, Gate-0-revisable).** e1RM-anchored, *adaptive* (layered base + override); deload = scheduled backstop **and** triggered; layoff = auto-back-off by time away. | The owner's chosen product direction (recorded, not a clinical claim); the engine expresses fixed-linear as a degenerate config if Gate 0 prefers it. | CALIBRATION_SPEC §4 |
| **Safety outranks everything.** Input gates (reject an implausible baseline at anchor) + an *unconditional* output clamp (bounds every prescribed session-to-session delta, incl. after a re-anchor). | Gate 0 §F: "safety rules must outrank every other rule." | CALIBRATION_SPEC §5 |

---

## 3. Where we are today

- **Shipped:** the schema write-fence (**#9**) — compile-time bijection (O1) + a runtime write
  census (O2–O5). *Note:* there is **no in-repo CI**; the fence and tests run under
  `pnpm test` / `pnpm validate` (local / pre-merge). Adding CI to actually gate merges is an
  open item.
- **Merged, ADR accepted:** the calibration engine spec + **ADR 0008** were merged in **#10**
  (as *proposed*); **ADR 0008 was accepted** (2026-07-15) in **#12**, committing Part B (ADR
  0007's Part B disposition recorded — build the proper boundary; the write-fence is interim,
  not terminal). The **spec itself remains `draft for review`** — its numbers are Gate-0-gated.
- **Tabled:** the local-LLM arc continuation (lives on the `feat/schema-ownership-spec` branch).
- **Open production-release blockers** ([MVP_STATUS](../MVP_STATUS.md)): (1) Methodology Gate 0,
  (2) reviewed content release, (3) WCAG/device review, (4) schema ownership — Part A shipped,
  **Part B + O6 doc convergence open**, (5) independent security + operator review. Blockers
  1/2/3/5 are human/process; **blocker 4 Part B is the engineering arc this roadmap sequences.**

---

## 4. The build plan (nearest → furthest)

Each stage: **Goal · Depends on · Unblocks · Definition of done (falsifiable) · Decisions.**
Stages 0–1 are done; the rest are ordered by dependency.

### Stage 0 — Schema write-fence *(DONE, #9)*
The manifest + compile-time bijection + runtime O2–O5. The interim guardrail every later stage
verifies against.

### Stage 1 — Calibration engine spec + ADR 0008 *(DONE, #10)*
The converged boundary and the falsifiable K1–K7 definition of done.

### Stage 2 — Accept ADR 0008 + the Part B commitment *(DONE — accepted 2026-07-15)*
- **Goal:** accept the calibration boundary and the commitment to build the `UnitOfWork` / Part B.
- **Depends on:** Stage 1. **Unblocks:** all build stages below.
- **DoD (met):** ADR 0008 status → **accepted**; ADR 0007 Part B disposition recorded (build the
  proper boundary; the write-fence is interim).
- **Decisions:** the "always proper architecture" principle (D1). **Next: Stage 3 — build the
  `UnitOfWork`.**

### Stage 3 — Build the `UnitOfWork` *(foundational)*
- **Goal:** the `src/application/workflows/` layer + a `UnitOfWork` port whose PostgreSQL adapter
  binds transaction-scoped module gateways to one Drizzle transaction (ARCHITECTURE.md). No
  calibration yet — just the mechanism.
- **Depends on:** Stage 2. **Unblocks:** every cross-module atomic write (Stages 6, 9).
- **DoD:** a workflow runs a callback with transaction-scoped repositories from ≥2 modules;
  commit/rollback is atomic (an injected mid-transaction failure leaves nothing partial);
  repositories never escape the callback; the write-fence stays green.
- **Decisions:** ADR 0001 (UnitOfWork), proper-architecture principle.

### Stage 4 — Calibration module skeleton
- **Goal:** the `calibration` module + its owned schema (derived **e1RM / working-max /
  calibration-state** tables) with a **checked-in Drizzle migration** that creates them
  (PostgreSQL-only, one migration authority — [ADR 0002](adr/0002-postgresql-only.md)); update
  the fence manifest (`ownership.ts`): add `'calibration'` to `ModuleId`, **add the new
  calibration schema file to the `SqlTableName` imports** (the runtime glob scanner already
  discovers it, but the *compile-time* `SqlTableName` union is fixed to the
  auth/installation/product schema files and must be extended), and **add an explicit
  `{ owner: 'calibration' }` entry per new table** (the manifest is a `satisfies Record<
  SqlTableName, …>` bijection — new tables are *demanded*, not auto-covered). The typed
  `computeNextLoad(facts)` port (no engine logic yet).
- **Depends on:** Stage 2. **Unblocks:** Stage 5.
- **DoD:** the migration creates the tables and `pnpm db:migrate` on a fresh DB succeeds; the
  module owns its tables; the fence is green (O1 bijection covers the new tables; O2 shows no
  undeclared writes); the compute port is typed and reads no peer tables.
- **Decisions:** ADR 0008 (calibration = engine), ADR 0007 (fence), ADR 0002 (one migration
  authority).

### Stage 5 — The calibration engine *(deterministic, dev-config)*
- **Goal:** implement `computeNextLoad`: e1RM derivation → `e1RM × phase-intensity%` anchor →
  layered progression (base + adaptive override) → scheduled-backstop-plus-triggered deload →
  layoff back-off → the **safety clamp** (input gate + unconditional output clamp) → a decision
  `{ next_load, reason_code, rule_version, raise_hold? }`. Real plate math wired to the athlete's
  captured equipment. All numbers are labeled dev-config on a `rule_version`.
- **Depends on:** Stage 4. **Unblocks:** Stage 6.
- **DoD:** **K1** (deterministic golden vectors incl. progress/hold/deload-both-paths/layoff/
  phase-transition re-anchor) · **K4** (safety fixtures: no branch exceeds the clamp; re-anchor
  ramps under the per-session cap; implausible baseline rejected; backstop cannot be disabled) ·
  **K3** (dev-config labeled, production rejects) · **K6** (decisions traceable). Pure over
  inputs — no peer-table reads.
- **Decisions:** e1RM-anchored adaptive (owner direction), safety layers, dev-config/Gate-0.

### Stage 6 — Completion workflow through the `UnitOfWork` *(retires the co-write)*
- **Goal:** the on-completion workflow, in one `UnitOfWork` transaction: `training` records the
  decision (computed via the calibration port) and writes its own `program_revision_lineage`; a
  **Programs write port** persists the new revision + prescriptions; the **calibration port**
  updates e1RM state; the **athletes owner path** raises `safety_hold` if `raise_hold` was
  signaled. Remove `training`'s four Programs↔Training `additionalWriters` debt grants.
- **Depends on:** Stage 3 (`UnitOfWork`) + Stage 5 (engine). **Unblocks:** Part B co-write
  retirement for this cluster; Stages 7–8.
- **DoD:** **K5** (the four debt grants removed; O2/O3 green — `training` no longer writes the
  cluster and no stale grant remains) · **K7** (the `UnitOfWork` commits decision + revision +
  lineage + e1RM (+ `safety_hold`) atomically or rolls back). **This is where the Programs↔Training
  debt actually dissolves.**
- **Decisions:** ADR 0008, ADR 0007 fence, ADR 0001 UnitOfWork.

### Stage 7 — LLM explanation consumer for calibration
- **Goal:** extend the existing `future-load-explanation` pattern so every calibration decision
  gets grounded, personal narration (the coaching voice) — LLM off by default, showing
  `reason_code` + `rule_version`.
- **Depends on:** Stage 6. **Unblocks:** the personalization experience.
- **DoD:** **K2** (J1–J6 green with generation disabled; explanation absence never blocks a
  decision).
- **Decisions:** ADR 0006 (explains, never decides).

### Stage 8 — Real prescriptions on the J-path
- **Goal:** the J1–J6 journey uses **calibration-computed** loads (dev-config) instead of the
  hardcoded `UNREVIEWED_DEVELOPMENT_TEMPLATE` loads; still labeled development; production still
  rejects the dev config.
- **Depends on:** Stage 6. **Unblocks:** a real profile→plan→train→learn loop.
- **DoD:** the journey prescribes calibration-derived loads; content still dev-labeled; Gate 0
  still gates production.

### Stage 9 — Complete Part B *(proper module architecture — the endpoint)*
- **Goal:** realize the rest of the ARCHITECTURE target beyond the Programs↔Training cluster,
  using the now-proven `UnitOfWork` + port pattern: an **audit append port** (retire the
  four-writer `audit_event` debt), a **`safety_hold` owner API** (retire the training session-pain
  debt), **Data Portability per-module ports** (retire its whole-schema operator breadth), and
  any remaining declared debt. Then the **O6 doc convergence** (AGENTS / ARCHITECTURE /
  MVP_STATUS) and **close blocker 4**.
- **Depends on:** Stage 3 (`UnitOfWork`) + Stage 6 (proven pattern).
- **DoD:** every `additionalWriters` debt grant is removed or explicitly ratified with a re-entry
  trigger; the ARCHITECTURE/AGENTS boundary rules hold; O6 convergence done; blocker 4 closed.
- **Decisions:** SCHEMA_OWNERSHIP_SPEC §6 (options C1–C5), ADR 0007 re-entry triggers.

### Cross-cutting / parallel tracks (do not block the engine build)
- **Gate 0 (methodology review)** — a *human* process that gates the **numbers** (baseline/TM
  formula, intensity bands, increments, deload thresholds, back-off rates, safety bounds, e1RM
  formula, rights matrix, named reviewers, golden vectors). Required before **production**, not
  before building the engine. Blockers 1 & 2.
- **CI** — none in-repo today; the fence/tests run under `pnpm test` / `pnpm validate`. Adding a
  CI pipeline to gate merges is worthwhile (the fence's enforcement is currently local/pre-merge
  only).
- **Independent reviews** — WCAG/device (blocker 3) and security/operator (blocker 5): human,
  process, independent of this arc.

---

## 5. Dependency graph

```text
Stage 0  write-fence (DONE #9)
Stage 1  calibration spec + ADR 0008 (DONE #10; ADR accepted #12)
   │
Stage 2  ACCEPT ADR 0008 + Part B  (DONE 2026-07-15)
   ├─────────────────────────────────┐
   ▼ (parallel)                       ▼
Stage 3  build UnitOfWork         Stage 4  calibration module skeleton (+ Drizzle migration)
   │                                  │
   │                                  ▼
   │                              Stage 5  calibration engine (dev-config, golden vectors)
   │                                  │
   └──────────►  Stage 6  ◄───────────┘   completion workflow via UnitOfWork  (needs Stage 3 + Stage 5)
                    │                      ← retires Programs↔Training co-write
                    ├── Stage 7  LLM explanation consumer
                    ├── Stage 8  real prescriptions on the J-path
                    ▼
                 Stage 9  complete Part B (audit port, safety_hold API, DP ports, O6, close blocker 4)

Parallel track (gates PRODUCTION, not the build): Gate 0 methodology review · CI · independent reviews
```

Critical path to Part B: **2 → 4 → 5 → 6 → 9** (the longest chain). **Stage 3 (the `UnitOfWork`)
runs in parallel** with 4 → 5 and also gates Stage 6, so it must land before 6 — *not* before 4.
Stages 7 and 8 branch off 6 (the usable product loop) and are not on the critical path to the
boundary work.

---

## 6. Decision-point index (onboarding quick-reference)

| # | Decision | One-line rationale | Where |
| --- | --- | --- | --- |
| D1 | Always proper architecture; fence is interim | Long-horizon, hand-off-able, correctness-first | principle (§1) |
| D2 | Deterministic methodology | Reviewable, testable, safe; not "AI" | ADR 0003 |
| D3 | LLM explains, never decides | Safety + product truth; model-decisions deferred | ADR 0006, DEFERRED.md |
| D4 | Gate 0 governs reviewed numbers | Separates buildable engine from human-gated content | Methodology pack |
| D5 | Write-authority fence (Part A) | Contain + surface co-write debt now | ADR 0007, #9 |
| D6 | Calibration = engine; decision stays training | Its atomic gate is welded to training's session state | ADR 0008, #10 |
| D7 | UnitOfWork retires cross-module co-writes | The atomic multi-module write mechanism | ADR 0001 |
| D8 | e1RM-anchored, adaptive; both-deload; layoff back-off | Owner product direction, Gate-0-revisable | CALIBRATION_SPEC §4 |
| D9 | Safety: input gates + unconditional clamp | Safety outranks all (Gate 0 §F) | CALIBRATION_SPEC §5 |

---

## 7. What "Part B done" looks like

- **Structural boundaries are real, not asserted:** every cross-module interaction goes through a
  public port; the `UnitOfWork` owns cross-module transactions; the write-fence is green with the
  declared-debt grants **removed** (or explicitly ratified with objective re-entry triggers).
- **Calibration is the personalization engine:** a deterministic, tested engine turns baselines
  into loads and recalibrates from performed work; the LLM is its coaching voice (explains only);
  the whole loop works with the LLM off.
- **Docs match reality (O6):** AGENTS / ARCHITECTURE / MVP_STATUS reflect the built boundaries;
  **production-release blocker 4 is closed.**
- **Production still gated by Gate 0:** the machinery is done and correct; the *reviewed numbers*
  and content remain the separate, human-gated path to a real coaching release.

This is the endpoint the whole arc — from the write-fence, through calibration and the
`UnitOfWork` — is built to reach, one properly-verified stage at a time.
