# Explanation generation contract

Status: **accepted design; not implemented**  
Date: 2026-07-12  
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
  readonly contractVersion: '1'
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
    readonly skipReason: string | null
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
  readonly maxOutputTokens: number // implementation default ≤ 256 for v1
}
```

### 4.4 Canonicalization

Before hashing or prompting:

- serialize with the same canonical JSON rules used elsewhere in methodology (sorted
  keys, no insignificant whitespace variance);
- include `contractVersion`;
- never include raw auth secrets, recovery codes, or unrelated profile fields.

`factBundleHash` = SHA-256 of the canonical FactBundle. Cache and audit keys use it.

## 5. Generation request and result

### 5.1 Port shape (target)

```ts
interface ExplanationGenerationPort {
  synthesize(
    input: ExplanationGenerationRequest,
  ): Promise<ExplanationGenerationResult>
}

interface ExplanationGenerationRequest {
  readonly factBundle: ExplanationFactBundle
  readonly promptVersion: string // e.g. 'future-load.v1'
  readonly timeoutMs: number
}

type ExplanationGenerationResult =
  | {
      readonly status: 'available'
      readonly prose: string
      readonly modelId: string // operator-configured opaque id; not a product constant
      readonly modelContentDigest: string // SHA-256 (or stronger) of the loaded weights/artifact
      readonly runtimeId: string // e.g. adapter name + runtime version label
      readonly promptVersion: string
      readonly factBundleHash: string
      readonly generatedAt: string // UTC ISO from application clock port, not the model
    }
  | {
      readonly status: 'unavailable'
      readonly reason:
        | 'disabled'
        | 'runtime-unreachable'
        | 'timeout'
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

The product **does not** hard-code a model family, size, quantisation, weight format, or
inference engine. When local inference is enabled, configuration records only what is
needed to reproduce and invalidate caches:

| Field | Role |
| --- | --- |
| `modelId` | Opaque operator label (stable string the host chooses) |
| `modelContentDigest` | Cryptographic digest of the loaded weights/artifact |
| `runtimeId` | Which adapter/runtime served the request |
| path or endpoint | Local file path and/or loopback URL for the chosen runtime |
| optional metadata | Family, size, quant, format—for operator docs only, not product branches |

Rules:

- Application logic branches on **port results and validation**, never on model name.
- Changing weights, quant, or runtime without changing digests/`modelId` is an operator
  error; cache keys include digest so stale prose cannot silently attach to new weights
  when digests are maintained correctly.
- Resource targets (latency, RAM/VRAM) are operator sizing concerns. The contract only
  requires that interactive paths respect `timeoutMs` and degrade to `unavailable`.
- Optional offline groundedness recordings may pin a digest for a specific evaluation
  run; that pin is test evidence, not a product default model.

## 6. Validation gate (mandatory)

Before any prose is shown or cached as `available`:

1. **Non-empty** trimmed prose within max length.
2. **Substring checks** (normalized): must include `grounding.reasonCode` and
   `grounding.ruleVersion`.
3. **Load labels**: must include `display.currentLoadLabel` and
   `display.proposedLoadLabel` when kind is `increase` or when both loads are material to
   the decision; for pure `blocked` / `hold` without load change, must not claim a new
   working weight.
4. **Numeric smuggling**: reject if prose contains load-like numbers that are not in the
   FactBundle display labels or set facts (implementation: extract integers/decimals and
   compare to an allow-list derived from the bundle).
5. **Safety lexicon**: reject if prose claims diagnosis, “injury,” “you are safe to push
   through pain,” or medical clearance language (maintained deny-list + tests).
6. **Invalidated decisions**: do not generate “active increase” framing when
   `decision.invalidated` is true; either skip generation or use a fixed
   non-model sentence that the decision is no longer active.

Failed validation → `status: 'unavailable', reason: 'validation-failed'`. Do not store
failed prose as success.

## 7. Cache and invalidation

### 7.1 Cache key

```text
explanationCacheKey =
  decisionId
  + '\0' + promptVersion
  + '\0' + modelId
  + '\0' + modelContentDigest
  + '\0' + factBundleHash
```

Optional storage: PostgreSQL table or local filesystem under a configured data directory.
Either is fine; both must be subject-scoped and deleted with personal data deletion.

### 7.2 Invalidation

Drop or mark stale when any of:

- adjustment decision is invalidated (e.g. post-completion safety correction);
- FactBundle hash would change (corrections to sets that rewrite effective facts feeding
  a *new* decision—historical rows stay immutable; new decisions get new ids);
- prompt version or model digest changes (lazy rebuild).

Cached prose is **not** part of the immutable training ledger. Deleting it must not
delete the adjustment decision.

## 8. Delivery and performance

| Event | Behavior |
| --- | --- |
| Complete set / complete workout | **Never** await the model on the critical path |
| Adjustment rows committed | Optional best-effort enqueue or skip |
| History (or Program) view | Lazy generate on cache miss if enabled; show codes immediately |
| Model timeout | Default ≤ 3000 ms for interactive lazy path; then `unavailable` |
| Model down | Codes-only UI; no synthetic fallback prose |

No Redis, queue product, or WebSocket is required for v1. Prefer:

1. lazy on read, or  
2. fire-and-forget in-process work that cannot fail the request, or  
3. explicit “Generate explanation” control if latency is poor on host hardware.

## 9. Runtime topology

```text
Required:   Browser → Next.js (127.0.0.1) → PostgreSQL
Optional:   Next.js  → loopback (or in-process adapter) → local inference runtime + weights
```

Rules:

- Inference is host-local only (loopback HTTP or in-process); not exposed as a public
  origin and not a mandatory cloud call.
- Core config remains valid with inference unset.
- Application outbound-network-blocked proofs still pass with inference disabled.
- Adapters are swappable behind `ExplanationGenerationPort` (different engines/formats
  are infrastructure choices, not domain changes).
- Optional config surface (names illustrative until implemented; values are operator-
  chosen, not product defaults):

```dotenv
# Default: disabled. Do not set in production unless the operator intends local inference.
INDIGO_LLM_MODE=disabled
# INDIGO_LLM_MODE=local
# INDIGO_LLM_ENDPOINT=http://127.0.0.1:8080
# INDIGO_LLM_MODEL_ID=operator-chosen-label
# INDIGO_LLM_MODEL_PATH=/var/lib/indigo/models/weights.bin
# INDIGO_LLM_MODEL_SHA256=...
# INDIGO_LLM_TIMEOUT_MS=3000
```

Startup preflight may **report** LLM status; it must not fail the process when disabled
or unreachable.

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
| `validation-failed` | Model drifted from facts | Check prompt/model; codes remain correct |
| `model-error` | Runtime error | Inspect the configured inference runtime logs |
| `invalidated-decision` | Decision no longer active | Show invalidation copy only |

## 13. Evaluation and acceptance

A slice is not done because inference “works once.”

### 13.1 Automated (required before enable-by-config in any shared environment)

- Unit tests for FactBundle builders against fixture decisions.
- Validation-gate tests: missing reason code, wrong load, invented kg, diagnosis lexicon.
- Port tests with a fake adapter (available / each unavailable reason).
- Architecture: domain purity unchanged; no general outbound model SDK in core paths;
  loopback-only client if HTTP is used.
- Personal-data deletion removes any stored prose for the subject.

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

## 14. Implementation sequence (authoritative order)

1. This contract + ADR 0006 (done when accepted in-repo).
2. FactBundle builder + validation pure functions + tests (no model binary).
3. Disabled default port + config parsing.
4. History UI wiring that already degrades to codes-only.
5. First local adapter + operator install notes (engine and weights are operator-chosen;
   document the adapter’s expected API, not a mandated model).
6. Cache + invalidation on decision invalidation.
7. Optional operator doc-retrieval tool (separate from trainee path).

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
| Optional local **grounded explanation** | Design accepted here; implement per sequence above |
| Queues/Redis/vector DB | Still deferred; not required by this contract |

When implementation begins, update `docs/MVP_STATUS.md` and the self-hosting contract in
the same change that introduces runtime config or storage.
