# Explanation generation contract

Status: **implemented; FactBundle v2, closed-output prompt v3, and validator v4 active**

Date: 2026-07-13

Authority: [ADR 0006](adr/0006-optional-local-grounded-language.md)

This document pins how an optional **host-local, model-agnostic** language-generation
port may produce plain-language explanations in Indigo Synthesis. It freezes the
FactBundle, validation, cache, and degrade semantics—not a particular model, weight
format, or inference engine. It is the implementation contract for the first product
slice and for any later surfaces that reuse the same pattern.

## 1. Purpose

Convert **already-persisted, authoritative decision and session facts** into optional
plain-language prose so a trainee can understand why a future load or related rule
outcome occurred—without giving the model authority over training decisions.

Core product journeys (J1–J6) must remain complete when generation is disabled, offline,
timed out, or rejected by validation.

## 2. Authority and honesty

| Kind of data | Owner | Model role |
| --- | --- | --- |
| Prescriptions, adjustments, holds, substitutions | Pure rules + application + PostgreSQL | None |
| Reason codes, rule/engine versions, loads, reps, RPE | Persisted facts | Input only |
| Plain-language explanation prose | Optional inferred presentation | Generator only |
| Evidence/source inspection records | Reviewed content / Gate 0 | Input only when present |

Rules:

- Never invent loads, repetitions, RPE, dates, exercise identities, or decision kinds.
- Never clear, open, or reinterpret safety holds.
- Never diagnose pain, injury, overtraining, or medical state.
- Never describe deterministic rules as “AI,” “smart coaching,” or “optimized for you.”
- UI labels generated prose as **inferred** (claims taxonomy) and always shows the
  structured reason code and ruleset version beneath or beside it.
- If prose and structured facts disagree, **structured facts win**; discard the prose.

## 3. Pattern choice (pinned)

| Pattern | Status |
| --- | --- |
| Structured grounded generation over a FactBundle | **Primary product path** |
| Lazy or post-commit precompute + cache | **Primary delivery** |
| Primary-key retrieval from PostgreSQL | **Only retrieval for trainee decisions** |
| Reviewed reason-code vocabulary / lemmas (versioned table or static map) | Optional enrichment, not a vector store |
| Narrow doc RAG for host/owner tools | **Operator path only** |
| Trainee multi-turn coaching chatbot | **Out of scope** |
| Write-capable tool-calling agents | **Prohibited** |
| Cloud model API as core dependency | **Prohibited** |

## 4. FactBundle schema

The application builds a versioned, JSON-serializable FactBundle **after** the
authoritative decision exists. The model never queries the database.

### 4.1 Envelope

```ts
interface ExplanationFactBundle {
  readonly contractVersion: '2'
  readonly bundleKind:
    | 'future-load-decision'
    // later: 'program-prescription' | 'safety-hold-state' — each needs its own golden set
  readonly locale: 'en' // expand only with reviewed copy expectations
  readonly contentMode: 'development' | 'reviewed'
  readonly subject: {
    /** Display units already resolved for prose; canonical grams remain in facts. */
    readonly units: 'metric' | 'imperial'
  }
  readonly decision: FutureLoadDecisionFacts
  readonly grounding: {
    readonly reasonCode: string
    readonly ruleId: string
    readonly ruleVersion: string
    readonly engineVersion: string
    readonly methodologyId: string
    readonly methodologyVersion: string
  }
  readonly display: {
    /** Pre-formatted for the athlete's units; model must copy these strings for loads. */
    readonly currentLoadLabel: string
    readonly proposedLoadLabel: string
    readonly exerciseName: string
  }
  readonly constraints: ExplanationConstraints
}
```

### 4.2 Future-load decision facts

Align with persisted `adjustment_decision` rows and session exercise identity. Field
names may map 1:1 to application DTOs when implemented.

```ts
interface FutureLoadDecisionFacts {
  readonly decisionId: string
  readonly sessionId: string
  readonly exerciseCode: string
  readonly kind: 'blocked' | 'hold' | 'increase' // extend only with domain kinds
  readonly currentLoadGrams: number
  readonly proposedLoadGrams: number
  readonly invalidated: boolean
  readonly invalidationReason: string | null
  /** Minimal set ledger used by the rule; omit unused personal history. */
  readonly setFacts: readonly {
    readonly ordinal: number
    readonly status: 'performed' | 'skipped'
    readonly loadGrams: number | null
    readonly repetitions: number | null
    readonly rpe: number | null
    readonly explicitlyConfirmed: boolean | null
  }[]
  readonly painReported: boolean | null
}
```

### 4.3 Constraints block (always present)

```ts
interface ExplanationConstraints {
  readonly mustMentionReasonCode: true
  readonly mustMentionRuleVersion: true
  readonly mustUseDisplayLoadLabelsOnly: true
  readonly mustNotInventNumbers: true
  readonly mustNotDiagnose: true
  readonly mustNotAdviseIgnoringPainOrHolds: true
  readonly developmentFixtureNoticeRequired: boolean // true when contentMode === 'development'
  readonly maxOutputTokens: number // current implementation default ≤ 256
}
```

### 4.4 Canonicalization

Before hashing or prompting:

- serialize with the same canonical JSON rules used elsewhere in methodology (sorted
  keys, no insignificant whitespace variance);
- include `contractVersion`;
- omit trainee-authored free text, including set notes and skip reasons;
- never include raw auth secrets, recovery codes, or unrelated profile fields.

`factBundleHash` = SHA-256 of the canonical FactBundle. Cache and audit keys use it.

## 5. Generation request and result

### 5.1 Port shape

```ts
interface ExplanationGenerationPort {
  synthesize(
    input: ExplanationGenerationRequest,
  ): Promise<ExplanationGenerationResult>
}

interface ExplanationGenerationRequest {
  readonly factBundle: ExplanationFactBundle
  readonly promptVersion: string // e.g. 'future-load.v3'
  readonly timeoutMs: number
}

type ExplanationGenerationResult =
  | {
      readonly status: 'available'
      readonly prose: string
      readonly modelId: string // committed model-pack identifier
      readonly modelContentDigest: string // SHA-256 (or stronger) of the loaded weights/artifact
      readonly runtimeId: string // verified runtime commit + process identity
      readonly promptVersion: string
      readonly factBundleHash: string
      readonly generatedAt: string // UTC ISO from an application-side clock function, not the model
    }
  | {
      readonly status: 'unavailable'
      readonly reason:
        | 'disabled'
        | 'runtime-unreachable'
        | 'timeout'
        | 'config-error'
        | 'validation-failed'
        | 'model-error'
        | 'invalidated-decision'
      readonly detail: string | null // operator-safe; no secrets
    }
```

A disabled or missing adapter returns `{ status: 'unavailable', reason: 'disabled' }`
without throwing into the workout path.

### 5.2 Prompt versioning

- Prompts live in versioned application resources, not in the database as free edits.
- Changing system or user prompt text requires a new `promptVersion`.
- Golden groundedness fixtures are keyed by `(promptVersion, contractVersion, reasonCode)`.
- Development content prompts must force the unreviewed-fixture notice into prose when
  `developmentFixtureNoticeRequired` is true.

### 5.3 Model identity (model-agnostic)

Domain/application authority does not branch on model family, size, quantisation, weight
format, or inference engine. The current supported deployment is deliberately narrower:
one exact Q4 artifact and one host-pinned CUDA runtime are admitted only after full
attestation. Configuration records what is needed to reproduce and invalidate caches:

| Field | Role |
| --- | --- |
| `modelId` | Stable committed pack identifier |
| `modelContentDigest` | Cryptographic digest of the loaded weights/artifact |
| `runtimeId` | Verified runtime commit and process identity |
| `runtimeAttestationDigest` | Digest of the launcher-produced process/file evidence |
| path or endpoint | Local file path and/or loopback URL for the chosen runtime |
| optional metadata | Family, size, quant, format—for operator docs only, not product branches |

Rules:

- Application logic branches on **port results and validation**, never on model name.
- Changing weights, quant, or runtime without changing digests/`modelId` is an operator
  error; cache keys include digest so stale prose cannot silently attach to new weights
  when digests are maintained correctly.
- Resource targets (latency, RAM/VRAM) are operator sizing concerns. The contract only
  requires that interactive paths respect `timeoutMs` and degrade to `unavailable`.
- An environment digest may assert equality with the committed pack digest; it cannot
  override it. A pack without a verified digest is not a product option.

## 6. Validation gate (mandatory)

Before any prose is shown or cached as `available`:

1. **Non-empty** trimmed prose within max length.
2. **Substring checks** (normalized): must include `grounding.reasonCode` and
   `grounding.ruleVersion`.
3. **Load labels**: must include `display.currentLoadLabel` and
   `display.proposedLoadLabel` when kind is `increase` or when both loads are material to
   the decision; for pure `blocked` / `hold` without load change, must not claim a new
   working weight.
4. **Numeric smuggling**: normalize Unicode, recognize unit-bearing loads as complete
   values, and allow only the exact authorized display labels. Independently safety-check
   the exact structured exercise name, then mask that name, the load labels, the required
   reason code, and the rule version; reject every remaining digit or spelled-out quantity.
   Raw grams, repetitions, RPE, and ordinals never authorize prose numbers.
5. **Safety and advice**: reject diagnosis language, forward coaching/modal/imperative
   language, or instructions that permit continuing through pain, symptoms, or a safety
   hold. Explanation is retrospective presentation only.
6. **Invalidated decisions**: do not generate “active increase” framing when
   `decision.invalidated` is true; either skip generation or use a fixed
   non-model sentence that the decision is no longer active.
7. **Closed output (v3)**: derive the one allowed paragraph with
   `canonicalFutureLoadExplanation(FactBundle)` and require byte-for-byte equality after
   trimming. The earlier lexical/numeric checks are defense-in-depth and useful failure
   diagnostics; they are not treated as proof over arbitrary prose.

Failed validation → `status: 'unavailable', reason: 'validation-failed'`. Do not store
failed prose as success.

## 7. Cache and invalidation

### 7.1 Cache key

```text
explanationCacheKey =
  decisionId
  + '\0' + promptVersion
  + '\0' + validatorVersion
  + '\0' + modelId
  + '\0' + modelContentDigest
  + '\0' + factBundleHash
```

Storage is the Training-owned PostgreSQL `future_load_explanation_cache`. Rows retain
served-model, runtime, runtime-attestation, prompt, validator, FactBundle, and
generation-duration provenance. Data Portability currently projects, counts, and deletes
these rows through its documented direct transactional path; that boundary debt does not
transfer domain authority. Schema upgrades purge rows that cannot prove the current
contract rather than relabeling them.

Every cache hit is revalidated by the current validator before presentation. Identity
or validation failure deletes the row and regenerates only through the normal guarded
path. `validatorVersion` participates in the key.

### 7.2 Invalidation

Before cache lookup or generation, the application rechecks the completed session's
current content eligibility. Explicitly revoked sessions remain available as factual
History with stored codes while the UI disables Explain. Other environment-ineligible
sessions are omitted from History; if the explanation use case is invoked directly, it
returns application-level `content-ineligible`. This guard precedes the generation port
and therefore is not an `LlmUnavailableReason`.

Drop or mark stale when any of:

- adjustment decision is invalidated (e.g. post-completion safety correction);
- FactBundle hash changes; or
- prompt, validator, or model-artifact identity changes.

The cache retains at most one current row per decision. A successful publication under a
new identity atomically replaces the stale variant instead of accumulating historical
prose rows. Runtime identity is retained as generation provenance, but a restart of the
same verified runtime/model contract does not invalidate already validated prose or force
runtime preflight on a cache hit.

Cached prose is **not** part of the immutable training ledger. Deleting it must not
delete the adjustment decision.

Eligibility governs serving, not subject portability. A subject export retains owned
cached explanation rows and their full provenance even if the owning content later becomes
ineligible without revocation. Current eligibility and revocation status are exported
separately so historical data remains interpretable.

### 7.3 Concurrency and failure semantics

- Cache read and final publication run under the same per-user PostgreSQL advisory lock
  as training correction commands and query the authoritative decision-invalidation
  ledger while locked.
- Generation happens outside the lock. `putIfActive` is the publication linearization
  point and rechecks state after generation.
- Post-completion pain commits an append-only feedback correction, recursive
  decision/revision invalidations, hold, receipt, and audit first. Performed-set
  corrections use the same invalidation boundary. Cache purge is post-commit and best
  effort, so cache failure cannot roll back authoritative state.
- Cache relation/read/write failure degrades only after a fresh locked active-state
  check; inability to query authoritative state fails closed.
- A bounded process-local singleflight coalesces identical misses in the supported
  single-Node deployment and releases entries in `finally`.

## 8. Delivery and performance

| Event | Behavior |
| --- | --- |
| Complete set / complete workout | **Never** await the model on the critical path |
| Adjustment rows committed | Optional best-effort enqueue or skip |
| Explicit History Explain action | Lazy generate on cache miss if enabled; codes are already visible |
| Model timeout | Exactly 3000 ms for the supported interactive lazy path; then `unavailable` |
| Model down | Codes-only UI; no synthetic fallback prose |

No Redis, queue product, or WebSocket is required. The implemented path is explicit lazy
generation on History with bounded in-process miss coalescing. A Program Explain control
is deferred product work, not part of this delivery path.

## 9. Runtime topology

```text
Required:   Browser → Next.js (127.0.0.1) → PostgreSQL
Optional:   Next.js  → loopback (or in-process adapter) → local inference runtime + weights
```

Rules:

- Inference is host-local only (loopback HTTP or in-process); not exposed as a public
  origin and not a mandatory cloud call.
- Every TypeScript LLM HTTP request—completion, `/v1/models`, and `/props`—passes through
  the sole `fetchLoopback` network primitive. It revalidates an HTTP(S) loopback target
  immediately before I/O and forces `redirect: 'error'`.
- Architecture tests reject direct, aliased, destructured, computed, or promise-carried
  runtime network globals and forbidden HTTP/raw-socket modules everywhere else. Type-only
  `fetch` references used for injectable test signatures remain allowed.
- Core config remains valid with inference unset.
- Inference-disabled operation remains compatible with the required
  outbound-network-denied release proof. The namespace runner has passed the preceding
  15-test default tree with inference disabled; the current 19-test clean-commit rerun is
  still required for the final product-release record.
- Adapters are swappable behind `ExplanationGenerationPort` (different engines/formats
  are infrastructure choices, not domain changes).
- Implemented optional config surface (the listed model/runtime values are the current
  supported, attested deployment):

```dotenv
# Default: disabled. Do not set in production unless the operator intends local inference.
INDIGO_LLM_MODE=disabled
# INDIGO_LLM_MODE=local
# INDIGO_LLM_ENDPOINT=http://127.0.0.1:8080/v1
# INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m
# INDIGO_LLM_MODEL_SHA256=03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8
# INDIGO_LLM_N_GPU_LAYERS=all
# INDIGO_LLM_ATTESTATION_PATH=tmp/llm-runtime-attestation.json
# INDIGO_LLM_TIMEOUT_MS=3000
```

Supported local application mode reads settings and weights only from the committed
`llm/models` and `llm/weights` directories and accepts exactly the 3,000 ms deadline.
Alternate directories or longer timeouts are diagnostic-only and cannot satisfy the
product configuration contract.

Application boot does not require LLM readiness when the feature is disabled. The
explicit operator command `pnpm llm:preflight` is a hard readiness gate and exits
non-zero when the attested local stack is not ready.

## 10. Module and layer placement

| Layer | Allowed |
| --- | --- |
| `methodology/domain` | **No** model imports or calls |
| `training/domain`, `programs/domain` | **No** model calls; facts only |
| Application use case | Build FactBundle from public DTOs; call port; validate; cache |
| Infrastructure adapter | Loopback client / local runtime only |
| UI | Render structured facts always; inferred prose when `available` |
| `scripts/` host tools | Separate operator contract; may use doc retrieval |

Preferred ownership when implemented: a small application port (for example under
`platform/llm` adapter + `modules/.../application` use case), not deep coupling inside
`workouts.ts` transaction logic.

## 11. Operator path (non-trainee)

Host/owner tooling may use the same local model with **document retrieval** over product
docs and Gate 0 drafts to propose copy or golden-vector *candidates*.

Operator path rules:

- no automatic publication of methodology releases;
- no trainee UI entry point required;
- outputs are drafts for human review;
- still no write tools into programs or sessions.

This path does not unblock `LLM/ML coaching` in the deferred list.

## 12. Failure taxonomy

| Reason | User-visible meaning | Operator action |
| --- | --- | --- |
| `disabled` | Explanations use rule codes only | Enable local runtime if desired |
| `runtime-unreachable` | Optional service not running | Start or reconfigure host-local inference |
| `timeout` | Host too slow for interactive generate | Smaller/faster model, shorter prompt, or manual control |
| `config-error` | No closed template exists for this persisted reason | Codes-only; add a reviewed template before enabling prose |
| `validation-failed` | Model drifted from facts | Check prompt/model; codes remain correct |
| `model-error` | Runtime error | Inspect the configured inference runtime logs |
| `invalidated-decision` | Decision no longer active | Show invalidation copy only |

## 13. Evaluation and acceptance

A slice is not done because inference “works once.”

### 13.1 Automated (required before enable-by-config in any shared environment)

- Unit tests for FactBundle builders against fixture decisions.
- Validation-gate tests: exact closed paragraph, wrong load, invented kg, reversed notice,
  advice/medical suffixes, and unsupported persisted reasons.
- Port tests with a fake adapter (available / each unavailable reason).
- Architecture: domain purity unchanged; no general outbound model SDK in core paths;
  loopback-only client if HTTP is used.
- Personal-data deletion removes any stored prose for the subject.
- Subject exports include cached prose and its full generation/validation/runtime
  provenance; subject and instance deletion previews count those rows exactly.
- Deterministic race tests cover pain-before-publication and publication-before-pain;
  no stale cache row may be served or reinserted after invalidation. A row may remain
  physically when post-commit best-effort cleanup is unavailable, but locked state
  checks make it inert.

### 13.2 Groundedness golden set

Maintain a small fixed set of FactBundles (development policy is fine for mechanics):

- increase at target;
- hold for high RPE;
- hold for skipped set;
- blocked for pain;
- invalidated after post-completion correction.

For each, either a recorded accepted paraphrase (when a specific `modelContentDigest` is
under optional offline evaluation) or a deterministic fake adapter in CI. **Default CI
must not require any model weight file or local inference process.**

### 13.3 Product honesty

- Copy review: no “AI coach,” no medical claims.
- Manual check: codes visible when prose present; codes alone when unavailable.
- Measurable benefit (later beta): explanation comprehension vs codes-only—not screen
  time or chat engagement.

## 14. Implementation sequence

1. Contract + ADR 0006. **Done.**
2. FactBundle v2 plus closed-output prompt v3 / validator v4 and adversarial goldens. **Done.**
3. Disabled default, strict loopback transport, and exact response model. **Done.**
4. Codes-first History explanation and completed-session safety correction. **Done.**
5. Exact artifact/runtime locks and live attestation. **Done.**
6. Linearizable, revalidated cache plus portability accounting. **Done.**
7. Optional operator doc retrieval remains separate and is not required for this slice.

Do not open trainee chat, program-generation prompts, or cloud keys in this sequence.
Do not bake a preferred model name into domain code, UI copy, or migration defaults.

## 15. Explicit non-goals (recap)

- Replacing ADR 0003 determinism
- Mandatory second process for core use
- Scaffold-only tables/routes before step 2–4 above
- Using explanation prose as input to the next load rule
- Shipping model weights inside the application repository by default
- Product-level commitment to a specific model family, quant, weight format, or engine

## 16. Relationship to deferred capabilities

| Capability | Relationship |
| --- | --- |
| LLM/ML **coaching** (decisions, instruments, opaque scores) | Still deferred; full re-entry bar unchanged |
| Optional local **grounded explanation** | Implemented per the sequence above; default disabled |
| Queues/Redis/vector DB | Still deferred; not required by this contract |
