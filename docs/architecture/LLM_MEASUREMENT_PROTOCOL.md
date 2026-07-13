# LLM layer measurement protocol

Status: active
Baseline version: `LLM_BASELINE_VERSION` in `src/platform/llm/baseline/golden-cases.ts`
Companion: [ADR 0006](adr/0006-optional-local-grounded-language.md), [explanation contract](EXPLANATION_GENERATION_CONTRACT.md)

Current checkpoint: baseline `2026-07-13.5` is 43/43 across nine golden cases—eight
eligible plus one invalidated—and 21 rejection traps. The final validator-v4 clean-tree
archive passed three live runs at availableRate 1.0, p50 `806 / 807 / 807` ms, p95
`1177 / 1017 / 1012` ms, and green live History E2E. Its archived root tree is byte-equal
to `99ace8c^{tree}`. The manifest is operator-local evidence under gitignored
`tmp/llm-runs/`, not a versioned repository artifact; future claims require a newly
verified batch.

## Principle

**Measure before product surface.** Do not ship History prose, cache tables, or
trainee-visible inference until:

1. Offline contract baseline is green in CI.
2. FactBundle construction from **persisted decision fields** is pure, tested, and
   measured for label fidelity.
3. Live model pass rate (when an operator runs a local server) is recorded against the
   same golden cases—not ad-hoc chat demos.

This protocol defines *what* we measure and *how* results are interpreted. It does not
claim coaching quality or clinical validity.

## Hypotheses under test

| ID | Hypothesis | Falsifier |
| --- | --- | --- |
| H1 | Default mode keeps inference off without breaking composition | Offline baseline `config/default-disabled` fails |
| H2 | The one supported pack has a committed exact artifact identity | Registry differs from the locked Q4 pack or its digest is absent |
| H3 | Hand-authored grounded templates pass the validation gate | Any golden `accepted` fails validation |
| H4 | Trap prose (invented loads, diagnosis, missing codes) is rejected | Any golden `reject:*` unexpectedly passes |
| H5 | Fake synthesize + validation reproduces available prose for active cases | Synthesize matrix fails |
| H6 | Invalidated / blocked-from-generation paths stay fail-closed | Invalidated case becomes `available` |
| H7 | Builder maps persisted decision rows to FactBundles without inventing loads | Builder unit tests fail or labels ≠ `formatLoad` |
| H8 (live, optional) | A local model produces validation-passing prose for every eligible golden case in a calibrated archive | Hardened archive live available rate is below 1.0 |
| H9 (product path, optional) | History Explain with local GPU yields grounded prose without hiding codes | `pnpm test:e2e:llm` fails or codes-first assertions fail |
| H10 (product path, optional) | On-demand interactive latency stays within the current explicit budget | Live `latencyMs.p95` exceeds 3.5s, or History click-to-visible exceeds the same E2E budget |
| H11 (live quality, optional) | Grounding failures remain fail-closed rather than being waved through as noise | Any validation failure is accepted, or the hardened archive rate falls below 1.0 |
| H12 (integrity) | Post-completion training corrections invalidate explanation framing and make cached prose unservable; purge is best-effort cleanup | Explain returns available prose or a stale row is reinserted after correction linearizes |
| H13 (provenance) | Product inference uses the pinned weights, launcher, mapped DSO closure, build, alias, and live GPU PID | Full preflight cannot return a verified runtime identity |
| H14 (concurrency) | Training correction and explanation-cache publication are linearizable | A stale paraphrase is served or reinserted after correction linearizes |
| H15 (source provenance) | Every calibrated product-path run executes from one clean reviewed Git commit and root tree | The worktree is dirty, HEAD/tree changes during the batch, or any run lacks the batch source identity |

## Metrics (offline, required)

Produced by `pnpm llm:validate-baseline` (and unit tests of the same runner).

| Metric | Definition | Pass criterion |
| --- | --- | --- |
| `offline.ok` | All offline checks pass | `true` |
| `offline.passed` / `offline.failed` | Check counts | `failed = 0` |
| `offline.durationMs` | Wall time of offline suite | Record only (no SLA yet) |
| `registry.packCount` | Loaded model packs | exactly 1 (`qwen3.5-9b-q4_k_m`) |
| `golden.caseCount` | Golden FactBundle cases | ≥ 9 |
| `golden.reasonCodeCoverage` | Distinct reason codes in goldens | Includes development increase/holds/pain-block |
| `validation.acceptPassRate` | Accepted templates that validate | 1.0 for non-invalidated cases |
| `validation.rejectPassRate` | Trap samples that fail validation | 1.0, with the explicit non-empty validation-matrix coverage check also green |
| `synthesize.availablePassRate` | Active cases → `available` via fake | 1.0 |
| `baselineVersion` | Protocol pin | Matches committed `LLM_BASELINE_VERSION` |

JSON shape is emitted with `--json` for archival comparison between runs.

## Metrics (live, optional)

When `INDIGO_LLM_LIVE=1` and a loopback server is up:

| Metric | Definition | Interpretation |
| --- | --- | --- |
| `live.availableCount` | Cases with validation-passing model prose | Operator calibration sample |
| `live.unavailableCount` | Cases that failed generation or validation | Break down by `reason` |
| `live.availableRate` | available / eligible active cases | Informational standalone; calibrated archive requires 1.0 |
| `live.latencyMs.p50` / `p95` | Per-case synthesize wall time (ms) | Archive p95 gate is 3.5s; gym mutation path never awaits model |
| `live.latencyMs.samples` | Raw per-case ms | Archive for drift comparison |
| `live.modelContentDigest` | Digest used for the probe | Pin multi-run comparison |
| `live.unreachable` | All failures are runtime-unreachable/timeout | Environment problem, not model quality |
| `product.e2eOk` | `pnpm test:e2e:llm` exit success | Product-path pin (operator archive only) |
| `product.e2eDurationMs` | Wall time of the Playwright suite | Informational; includes journey + Explain |
| `archive.sourceCommit` / `sourceTree` | Full Git commit and root-tree object IDs from a clean worktree | Must equal the verified batch manifest and every other run |

**Do not** treat a single live or e2e success as product readiness. The archive command
requires at least three runs from the same clean source commit/tree with the same model
and runtime-attestation digests, live available rate 1.0, bounded p95, and green E2E on
every run; any miss fails the archive.

## What is *not* measured yet

- Trainee comprehension (beta survey; Phase 4)
- A/B of codes-only vs prose (requires a reviewed study design, assignment mechanism, and comprehension instrument; the product UI exists)
- Token cost, GPU utilization, multi-tenant load
- Cloud models (out of scope)

## Procedure

### Every PR that touches `src/platform/llm` or `llm/models`

1. `pnpm test -- src/platform/llm`
2. `pnpm llm:validate-baseline`
3. If baseline version semantics change, bump `LLM_BASELINE_VERSION` and note why in the PR

### Operator live calibration (optional)

1. Install locked weights, build the pinned CUDA server, start it, and require
   `pnpm llm:preflight` to report `runtime: verified` (`llm/README.md`).
2. `INDIGO_LLM_LIVE=1 node --import tsx scripts/llm/validate-baseline.ts --json > /tmp/llm-live.json`
3. Record `modelContentDigest`, baseline version, available rate, `latencyMs.p50/p95`, failure reasons
4. Product browser path: `pnpm test:e2e:llm`

   — real setup/program/workout completion → History → Explain with GPU local mode;
   codes stay authoritative. Run default `pnpm test:e2e` separately for the full J1–J6
   journey including export/deletion.
5. **Multi-run archive (required for calibration claims):**
   `RUNS=3 pnpm llm:archive-product-path`

   Run this only after committing the exact source under review: staged, unstaged, and
   untracked status must all be empty. The command rechecks that clean HEAD commit and
   root tree before and after every run. It writes verified per-run
   `tmp/llm-runs/product-path-*.json` plus an `archive-batch-*.json` manifest/summary,
   embeds source and runtime identity, forcibly pins the committed model registry and
   3,000 ms product deadline, and fails unless all three offline/live/E2E runs meet
   their hard gates and share every source/model/runtime/baseline identity. A failed
   batch may retain raw logs, baseline/preflight evidence, or its internal `.list`, but
   it does not publish a verified batch manifest or a verified JSON summary for the
   failed run.
6. Do not treat a single green e2e as shipping readiness; re-archive after pack/prompt changes

### Interpretation rules

- Offline red → block merge of LLM changes.
- Live unreachable → document environment; offline still green.
- Live available but invents numbers → validation correctly fails; **do not** loosen gate.
- Desire for higher live rate → adjust model/prompt/pack settings, re-measure; never skip validation.

## Sequence after this protocol

1. ~~Infra + offline baseline~~ (done)
2. ~~Builder from persisted decisions + metrics emission~~ (done)
3. ~~Measured live runs on operator hardware~~ (historical CPU diagnosis preceded the
   supported GPU calibration; only fully attested GPU evidence counts for product readiness)
4. ~~Application FactBundle wiring from completed sessions~~ (`getFutureLoadFactBundlesForSession`)
5. ~~History read-path experiment~~ (codes always; on-demand Explain; `pnpm test:e2e` LLM-off + `pnpm test:e2e:llm` GPU-on)
6. ~~Product-path multi-run discipline + live latency metrics (H9/H10)~~ (`pnpm llm:archive-product-path`)
7. ~~Explanation prose cache~~ (`future_load_explanation_cache`; validation-passing only; subject cascade)
8. ~~Semantic invalidation~~ (post-completion feedback/performed-set corrections →
   FactBundle `invalidated`, locked active-state checks, and best-effort session-cache
   cleanup)
