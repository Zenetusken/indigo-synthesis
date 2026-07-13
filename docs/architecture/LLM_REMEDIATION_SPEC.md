# LLM grounded-explanation remediation specification

Status: implemented
Date: 2026-07-13
Scope: `feat/llm-modular-inference-layer`

## Purpose

Close the audited safety, provenance, concurrency, portability, product-path, and operator
contract gaps before the optional grounded-explanation branch can continue. This work does
not expand model authority: deterministic methodology rows and reason codes remain the only
training decisions.

## Root causes

1. **Untyped grounding.** The prose validator flattened loads, grams, repetitions, RPE,
   ordinals, and version components into one numeric allow-list. It also treated a narrow
   deny-list as a complete safety policy.
2. **Untrusted prompt content.** Free-form trainee skip text was copied into the model
   message even though explanation only needs the persisted skipped-set fact.
3. **Claimed model identity.** Configuration supplied a digest and model name, but neither
   the loaded artifact nor the server response/runtime was required to prove them.
4. **Non-linearizable invalidation.** Explain read active state, generated outside a lock,
   and wrote/returned without a final authoritative state check. Pain reporting deleted an
   optional cache inside the safety transaction.
5. **Cache semantics mixed with authority.** Cache failures could reject otherwise valid
   prose or safety invalidation, hits bypassed the current validator, and concurrent misses
   duplicated generation.
6. **Incomplete data ownership.** Cached subject prose was added without extending export,
   exact deletion plans, tombstone counts, or residual-row tests.
7. **Operator claims exceeded evidence.** Loopback redirects were followed, endpoint body
   timeouts were incomplete, GPU presence was conflated with GPU inference, runtime source
   was mutable, and default E2E inherited operator LLM mode.
8. **Status drift.** ADR/MVP updates moved ahead of the canonical architecture, stack,
   runbook, and explanation-contract status.

## Non-negotiable invariants

- Model prose never chooses or changes a load, hold, session, or methodology record.
- Unit-bearing load text must be an exact authorized display label; raw grams, repetitions,
  RPE, ordinals, and version numbers cannot be reinterpreted as loads.
- Generated prose cannot contain forward coaching, medical claims, or instructions to
  continue through pain or a safety hold.
- Trainee-authored free text is not sent to the language model.
- A cache hit is accepted only after the current validator passes it under the current
  validator version and FactBundle.
- A completed-session training correction linearizes against cache reads/writes and
  generated responses. An Explain operation that linearizes after invalidation cannot
  return active prose.
- Optional cache failure cannot roll back or reject an authoritative pain report.
- Product generation requires a verified artifact digest, exact served-model identity,
  loopback-only transport without redirects, and supported-runtime evidence. Unverified
  model packs are not product options.
- Cached prose participates in subject export and exact deletion accounting.
- Default tests force LLM-disabled mode regardless of operator environment.

## Contract decisions

### FactBundle and prompt

- Bump the FactBundle to contract version `2`.
- Remove free-form `skipReason` from model input entirely. Skipped status is sufficient;
  the database already guarantees that the authoritative row has a reason.
- The initial FactBundle hardening bumped prompt/validator identity to v2. The closed
  output pass bumped the prompt to v3; the realistic-name adversarial fix independently
  bumped the validator to v4. Only the exact FactBundle-derived paragraph is accepted,
  and old cache keys cannot collide.
- Purge v1 cache rows during migration rather than relabeling unverified prose. New rows
  store non-null validator version, served model name, runtime ID, and runtime-attestation
  digest.

### Prose validation

- Normalize Unicode, whitespace, and exact required strings. Independently safety-check
  the structured exercise name, then mask it with complete authorized display labels plus
  the exact required reason code and rule version before rejecting every remaining digit.
  Repetitions, RPE, ordinals, and raw grams are not authorized prose fields; any later
  contextual numeric grammar requires another validator bump.
- Reject second-person modal/imperative action and any action or permission near pain,
  hurt, symptom, hold, clearance, training, or lifting language. Explanation does not need
  forward coaching, so uncertain advice fails closed.
- Preserve the exact reason code, rule version, development notice, and increase-label
  requirements.
- Add every audited bypass to both unit tests and the versioned golden baseline.

### Cache and invalidation

- PostgreSQL cache reads and final writes acquire the same per-user advisory lock used by
  correction commands, and re-read the authoritative decision-invalidation ledger while
  holding it.
- Generation happens outside the user lock. A final `putIfActive` transaction is the
  linearization point; it either stores under active state or returns invalidated.
- Cache hits use `getIfActive`, validate the returned prose again, and purge rejected rows
  best-effort.
- One supported application instance uses bounded in-process single-flight by cache key to
  prevent duplicate model calls. Entries are removed in `finally`; no prose is retained in
  process memory.
- Cache read/write/delete failures degrade to a miss or no-cache success when authoritative
  state can still be confirmed in a fresh transaction. State-check failure fails closed to
  codes-only UI.
- `reportPain` commits an append-only feedback correction, recursive decision/revision
  invalidations, hold, receipt, and audit before best-effort cache cleanup. Performed-set
  corrections use the same invalidation/cache boundary.

### Model and runtime identity

- Product packs require a non-null expected SHA-256, and an environment digest may only
  equal—not override—the committed pack identity. Remove the unverified Q5 pack until a
  concrete artifact is downloaded, hashed, and measured.
- Supported local application mode reads model settings and weights only from committed
  directories and uses the exact 3,000 ms product deadline; archive/live E2E must not
  inherit alternate registry, weights, or timeout values from the caller environment.
- Pin the Q4 Hugging Face revision and fail the download before installation on digest
  mismatch.
- The supported product runtime is the pinned CUDA `llama-server` path. LM Studio remains
  diagnostic/operator tooling and cannot satisfy product readiness.
- `serve-local.sh` verifies the model digest, records a mode-0600 atomic runtime
  attestation, and starts the server with nonzero/all GPU offload. Attestation binds schema
  version, PID plus process start time, endpoint, binary realpath/digest/source commit,
  weights realpath/device/inode/size/mtime/digest, exact alias, GPU-layer setting, and
  timestamp. Preflight checks those fields, exact `/props` model path/alias on the pinned
  server, and GPU process memory. This protects against accidental/stale/mismatched runtime
  state; it is not cryptographic attestation against a malicious same-user process.
- Launcher and preflight pin the committed 4,096-token context argument rather than
  accepting an inherited runtime override.
- RAM readiness distinguishes pre-load model-plus-headroom capacity from the 4 GiB
  operating reserve required after the exact runtime is already attested and resident.
- Completion responses must return the exact configured model name.
- Completion, `/models`, and `/props` requests reject redirects and keep abort timers active
  through body parsing.

### Data ownership

- Bump export schema version.
- Export cached explanations with their session, decision, model, prompt, validator,
  FactBundle hash, verified served-model/runtime identity, generation duration, and creation
  time.
- Count cache rows in subject and instance deletion previews and tombstones.
- Explicitly delete/cache-count in referential order and include the table in residual-row
  assertions.

### History safety-report surface

Subject: a self-hosted strength trainee reviewing an immutable completed workout. The
page's single additional job is to let them record a late pain/safety issue without making
the product appear to diagnose it.

The existing Indigo token system remains authoritative: rack ink, paper, danger red,
Atkinson body, Saira display, and IBM Plex Mono metadata. The signature element is a
**safety ledger rail**—a restrained danger-red top rule and monospaced `LATE SAFETY REPORT`
label adjacent to completed-session facts. It uses no new animation or decorative palette.

```text
+-------------------------------------------------------------+
| LATE SAFETY REPORT                                          |
| Record pain or a safety issue from this completed session.  |
| [Optional factual context_______________________________]   |
| [Record safety report]                                     |
+-------------------------------------------------------------+
```

- The action name and result copy remain consistent.
- A successful report appends a correction and safety hold, replaces the form with
  correction provenance plus a Today status handoff, and disables explanation generation
  for every invalidated decision.
- The control is keyboard accessible, mobile-safe, and uses an explicit live error region.
- Browser coverage completes a workout, generates/caches prose, submits late pain from
  History, and verifies invalidation copy plus absence of cached/active prose.

## Commit sequence and gates

1. **Specification.** This document only; review against live code and audit evidence.
2. **Grounding and provenance.** FactBundle v2 plus prompt v3 / validator v4, cache-version migration,
   redirects, exact model response, verified pack/runtime identity. Gate: focused LLM tests,
   offline baseline, typecheck.
3. **Linearizable invalidation and cache coordination.** Active-state cache port,
   single-flight, fail-soft cache behavior, post-commit purge, overlap/failure PostgreSQL
   tests. Gate: focused unit + Training integration.
4. **Portability and product reachability.** Export/deletion lifecycle and History late
   safety-report UI/browser journey. Gate: Data Portability integration + default E2E.
5. **Runtime and documentation closure.** Deterministic default E2E mode, pinned operator
   workflow, archive threshold, full README/architecture/stack/ADR/status/runbook sync.
   Gate: clean `pnpm validate` and operator-contract tests.
6. **Final evidence.** Full integration, default E2E, live preflight, three-run archive, live
   GPU E2E, clean worktree, and independent review. Any review correction is a small final
   commit, not folded into an unrelated layer.

## Completion criteria

- Every reproduced audit bypass has a red-then-green regression test.
- Explain/pain overlap and cache-failure tests prove safety linearization and fail-soft
  behavior.
- Fresh-database migration, export, subject deletion, and instance reset cover populated
  cache rows.
- Product readiness rejects fake/CPU/unattested endpoints and wrong artifacts/models.
- Normal and live browser journeys pass from clean disposable state.
- Canonical documents describe the same shipped state and remaining non-LLM release gates.
