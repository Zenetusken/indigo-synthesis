# LLM layer measurement protocol

Status: active  
Baseline version: `LLM_BASELINE_VERSION` in `src/platform/llm/baseline/golden-cases.ts`  
Companion: [ADR 0006](adr/0006-optional-local-grounded-language.md), [explanation contract](EXPLANATION_GENERATION_CONTRACT.md)

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
| H2 | Committed model packs load and are hot-swappable by id | Registry load fails or Q4/Q5 missing |
| H3 | Hand-authored grounded templates pass the validation gate | Any golden `accepted` fails validation |
| H4 | Trap prose (invented loads, diagnosis, missing codes) is rejected | Any golden `reject:*` unexpectedly passes |
| H5 | Fake synthesize + validation reproduces available prose for active cases | Synthesize matrix fails |
| H6 | Invalidated / blocked-from-generation paths stay fail-closed | Invalidated case becomes `available` |
| H7 | Builder maps persisted decision rows to FactBundles without inventing loads | Builder unit tests fail or labels ≠ `formatLoad` |
| H8 (live, optional) | A local model can produce validation-passing prose for golden cases | Live available rate = 0 with healthy server (informational until target set) |

## Metrics (offline, required)

Produced by `pnpm llm:validate-baseline` (and unit tests of the same runner).

| Metric | Definition | Pass criterion |
| --- | --- | --- |
| `offline.ok` | All offline checks pass | `true` |
| `offline.passed` / `offline.failed` | Check counts | `failed = 0` |
| `offline.durationMs` | Wall time of offline suite | Record only (no SLA yet) |
| `registry.packCount` | Loaded model packs | ≥ 2 (Q4 + Q5 packs) |
| `golden.caseCount` | Golden FactBundle cases | ≥ 9 |
| `golden.reasonCodeCoverage` | Distinct reason codes in goldens | Includes development increase/holds/pain-block |
| `validation.acceptPassRate` | Accepted templates that validate | 1.0 for non-invalidated cases |
| `validation.rejectPassRate` | Trap samples that fail validation | 1.0 |
| `synthesize.availablePassRate` | Active cases → `available` via fake | 1.0 |
| `baselineVersion` | Protocol pin | Matches committed `LLM_BASELINE_VERSION` |

JSON shape is emitted with `--json` for archival comparison between runs.

## Metrics (live, optional)

When `INDIGO_LLM_LIVE=1` and a loopback server is up:

| Metric | Definition | Interpretation |
| --- | --- | --- |
| `live.availableCount` | Cases with validation-passing model prose | Operator calibration sample |
| `live.unavailableCount` | Cases that failed generation or validation | Break down by `reason` |
| `live.availableRate` | available / eligible active cases | Not a shipping gate until a target is chosen after N runs |
| `live.latencyMs.p50` / `p95` | Per-case synthesize latency | Informational; gym path must not await model |
| `live.unreachable` | All failures are runtime-unreachable/timeout | Environment problem, not model quality |

**Do not** treat a single live success as product readiness. Prefer ≥3 independent live
runs with the same `modelContentDigest` before considering a UI enablement experiment.

## What is *not* measured yet

- Trainee comprehension (beta survey; Phase 4)
- A/B of codes-only vs prose (requires UI)
- Token cost, GPU utilization, multi-tenant load
- Cloud models (out of scope)

## Procedure

### Every PR that touches `src/platform/llm` or `llm/models`

1. `pnpm test -- src/platform/llm`
2. `pnpm llm:validate-baseline`
3. If baseline version semantics change, bump `LLM_BASELINE_VERSION` and note why in the PR

### Operator live calibration (optional)

1. Install weights + start loopback server (`llm/README.md`)
2. `INDIGO_LLM_LIVE=1 INDIGO_LLM_ENDPOINT=… INDIGO_LLM_MODEL_ID=… pnpm llm:validate-baseline --json > /tmp/llm-live.json`
3. Record `modelContentDigest`, baseline version, available rate, failure reasons
4. Do not enable product UI solely from one run

### Interpretation rules

- Offline red → block merge of LLM changes.
- Live unreachable → document environment; offline still green.
- Live available but invents numbers → validation correctly fails; **do not** loosen gate.
- Desire for higher live rate → adjust model/prompt/pack settings, re-measure; never skip validation.

## Sequence after this protocol

1. ~~Infra + offline baseline~~ (done)
2. ~~Builder from persisted decisions + metrics emission~~ (done)
3. ~~Measured live runs on operator hardware~~ (CPU then GPU availableRate=1.0 recorded)
4. ~~Application FactBundle wiring from completed sessions~~ (`getFutureLoadFactBundlesForSession`)
5. History read-path experiment (codes always; prose only if measured local stack healthy)
6. Cache only after prose is product-visible and invalidation rules are defined
