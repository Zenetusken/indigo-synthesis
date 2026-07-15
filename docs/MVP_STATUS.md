# Engineering MVP status and traceability

Snapshot: 2026-07-13
Status: working engineering MVP; **not** a production coaching release and **not** the
canonical Release 1 gate

This document reconciles the live repository with the canonical product and architecture
documents. It does not weaken the requirements in
[the Product Spec](product/PRODUCT_SPEC.md) or close
[Methodology Gate 0](product/METHODOLOGY_V1_DECISION_PACK.md).

## What “MVP” means here

The engineering MVP proves that the product shape can work coherently: a self-hosted
instance can bootstrap a local owner, create a trainee, instantiate a deterministic
technical program, conduct and persist a workout, show history and a future revision,
export the subject's data, delete a member subject, reset the instance, recover owner or
trainee credentials, and resume committed workout state after sign-in.

The technical program is `0.0.1-development`. Its exercise selection, volume, loads,
rest periods, safety framing, and progression values are unreviewed test inputs. The UI
labels them as development content, and server configuration rejects development content
in a production process. “Deterministic” and “bounded” describe software properties;
they do not make the fixture safe, effective, licensed, or evidence-based.

Production release still requires independent human strength-program, safety, evidence,
and rights review, named approvers, reviewed golden examples, and a reviewed content
record. No software test can substitute for that approval.

## Product choices now reflected in the implementation

- Self-hosting is essential; the core topology is one Node.js application and one
  PostgreSQL 18 database.
- The product is online-first. Offline workout mutation/synchronization is not a hard
  requirement.
- Docker/Compose, CI/CD, monitoring, and deployment packaging remain deferred.
- Neurotype assessment and neurological framing are excluded from the MVP.
- The intended population is adults already familiar with the listed basic lifting
  movements; trainee attestation is not a medical or coaching clearance.
- The first owner may also be the trainee and can create controlled local member
  accounts. A host-issued capability gates the one-time bootstrap; generic public signup
  is disabled throughout the installation lifecycle.
- Only a clean-room, visibly unreviewed development fixture is bundled. No legacy
  branded or third-party program content is inherited.

## Journey traceability

| Journey | Live implementation | Current proof | Release qualification |
| --- | --- | --- | --- |
| J1 — Bootstrap and sign in | Host-issued one-use bootstrap capability, explicit database creation modes, atomic owner credential/installation claim, Better Auth sessions with credential-lifecycle serialization, reauthenticated owner-created local users, owner-mediated member reset, and host-issued owner recovery through CLI or web redemption | `identity.integration.test.ts`, the recovery integration suites, and the J1/J7/J8/J9 browser journeys | Bootstrap and owner-recovery issuance remain host-administrative; public signup, email reset, and browser-only owner recovery remain absent |
| J2 — Set up a trainee | Units, IANA timezone, goal, experience, three training days, session duration, equipment, starting loads, age/technique attestations, and limitation context | Browser journey plus unit conversion tests | Initial setup is immutable in the current UI; a reviewed profile-change/revision workflow is still future work |
| J3 — Instantiate a program | Pure deterministic generator, explicit local date, canonical hashes, revision/workout/prescription rows that become immutable on activation, review-status fields, content eligibility, and persisted safety/equipment validation before activation | Methodology/domain tests, training integration tests, browser restriction and advanced-tier cases | Only an unreviewed development fixture exists; Gate 0 and reviewed golden vectors remain open |
| J4 — Train today | Truthful Today states; start; active/paused lifecycle; snapshot exercises/sets; canonical load, reps, optional RPE and notes; skips; timestamp-derived rest; pain stop/hold; abandon; source-linked hold resolution after live-source abandonment or completed-source durable invalidation plus abandonment of any already-active affected descendant session; exact PostgreSQL resume; and cause-neutral sign-in return reconstructed only from a UUIDv7 workout identifier and reauthorized after sign-in when the session is absent | Main browser journey, safety browser cases, supervised-restart hold-resolution journey, J7 mid-workout session-revocation case, restart-process integration, idempotency and authorization integration tests | No reviewed substitution set exists, so substitution correctly remains unavailable; resolution never reopens or rewrites the source session, and unsaved browser fields are not claimed as persisted |
| J5 — Complete and learn | Transactional completion; immutable original sets, feedback, history, and decisions; append-only completed-set correction ledger/projection; feedback-correction entry from History; recursive decision/revision invalidation; fail-closed post-completion safety reporting; and a new future program revision without rewriting the completed revision | Main browser journey, direct database integrity tests, adjustment property/unit tests, correction/invalidation concurrency tests, and completion-replay integration | The correction ledger preserves historical facts and halts affected progression; trainee completed-set correction entry, richer progress aggregates, and comparison remain later Phase 3 work |
| J6 — Control data | Repeatable-read versioned JSON export with hashes/provenance/omissions, including owned cached-explanation provenance independent of current content eligibility; previewed member deletion; owner-only whole-instance reset; password reauthentication; transactional deletion/redaction; non-personal tombstones; and a guarded PostgreSQL backup/restore procedure with an exercised disposable-database drill | Main and cross-user browser journeys, portability integration tests, and the retained backup/restore drill record | Export is subject-scoped; operators still own encrypted off-host retention, deployment-specific restore practice, runtime-secret custody, and any future media boundary |

The concrete evidence lives in `src/**/*.test.ts`, `test/architecture/`,
`test/integration/`, and `test/e2e/*.spec.ts`. Application APIs are not mocked in the
browser journeys.

## Access and recovery (implemented 2026-07-13)

A UI/UX audit surfaced a cold-start dead end on claimed instances. The review-hardened
[Access and recovery](product/ACCESS_AND_RECOVERY_SPEC.md) contract now maps to the live
repository as follows:

- **Trainee credential reset (J7).** A reauthenticated owner issues a one-use,
  digest-only code from Settings; `/reset` lets the trainee choose the replacement
  password. Redemption revokes that account's sessions, preserves training data, and
  writes one redacted audit event.
- **Owner recovery (web J8 plus CLI escape path).** Host-only issuance is unchanged.
  The owner can redeem through protected CLI files or `/recover`; both replace the
  credential, revoke sessions, and audit the channel without recording secrets. The web
  path is not a browser-only recovery mechanism because code issuance still requires
  host access.
- **Cold-start orientation (J9).** Claimed-instance sign-in now names concrete next
  actions for a trainee, owner, and visitor without an account. `/reset` and `/recover`
  redirect to bootstrap while an installation is still open.
- **Session-ended workout continuity.** If the session is absent on the next workout
  command/navigation—including after recovery revocation—the app redirects to sign-in
  with a cause-neutral notice and a return path reconstructed only from a shape-restricted
  UUIDv7 workout identifier. The workout is reauthorized after sign-in.
  Signing in resumes the exact committed workout; the denied command is not replayed and
  unsaved browser fields are not represented as durable.
- **Threat controls.** Email-first and account-scoped lifecycle locks serialize sign-in,
  creation, and recovery; their dedicated connections and both waiter queues
  are bounded, with trusted host/account work prioritized; web admission uses HMAC-keyed
  fixed-window buckets and bounded cleanup; member-code backoff does not consume the
  code; session cookie caching is disabled; unsupported Better Auth identity-mutation
  routes are blocked; and audit addresses are minimized.
- **Account/profile separation.** P1, P2, and P4 govern these account-only journeys.
  P3 and P5–P7 remain a single deferred multi-profile entry contract: training still
  keys on `userId`, and cross-account isolation remains application-layer only (no RLS).

Focused unit/component, architecture, disposable-PostgreSQL, and browser runs cover the
new flows, including recovery/sign-in races, one-use and throttling behavior, audit
cardinality, redaction, data preservation, and mid-workout return. Standalone session
management and a security-events view with sign-in-failure auditing remain the named
Account security follow-on, not unfinished J7–J9 work.

## Cross-cutting status

| Concern | Implemented | Still required for canonical Release 1 |
| --- | --- | --- |
| Self-hosting | Local auth/assets, no mandatory cloud adapter, validated origin/config, one Node process plus PostgreSQL, source guards, browser request observation, and retained 19/19 proof from a clean committed tree in a Linux namespace exposing only loopback plus a private PostgreSQL socket bridge | Rerun after any product/runtime or default-suite change; keep deployment ingress and cold-install evidence separate |
| Database integrity | Seventeen Drizzle migration entries, canonical 0004 ledger provenance plus current-hash coverage, PostgreSQL 18 preflight, ownership/lifecycle checks, unique constraints, immutable original training facts, append-only corrections/invalidation/hold-resolution/content-revocation records, cache provenance/uniqueness, HMAC-keyed recovery admission state, and conservative audit-backed legacy provenance recovery | Ambiguous legacy hold provenance remains fail-closed for explicit administrator remediation; keep fresh-migration, upgrade, and preflight proof in final release evidence |
| Reproducibility | Canonical JSON/SHA-256 vectors, versioned input/output hashes, explicit `asOfDate`, no clock/random/network/database access in the pure generator | Replace development vectors with independently approved methodology golden vectors |
| Authorization/privacy | Server-derived actor, owner/member roles, cross-user denial, local sessions, subject-scoped export/deletion, and no application telemetry | Independent security/privacy review before an exposed deployment |
| Safety honesty | Contraindication/restriction block, fail-closed content status, pain stop/hold, append-only subject-only hold resolution with live-source abandonment or completed-source durable-invalidation prerequisite, no medical-clearance implication, advanced-tier denial, no diagnosis, and no fabricated substitution | Human strength and safety approval of the intended population, movements, bounds, stop rules, and copy |
| Accessibility/mobile | Semantic server-rendered UI plus targeted Playwright proof at 390×844 for reflow, 200% text sizing, 48px controls, skip-link/focus visibility, keyboard form order and focus continuation, changing polite save status, distinct titles, reduced motion, and no horizontal overflow | Independent WCAG 2.2 AA review, manual screen-reader certification, and representative physical-device testing |
| Maintainability | TypeScript, Biome, pure domain tests, one schema/migration authority, and executable guards for domain purity, dependency direction, platform independence, runtime outbound clients/remote assets, and an acyclic module graph | Extend enforcement to schema/table ownership and resolve the cross-module gateway debt below |

## Validation commands

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
INDIGO_CONTENT_MODE=reviewed INDIGO_LLM_MODE=disabled pnpm build
```

At this documentation checkpoint, the established static, unit/domain/architecture,
database-integration, upgrade, PostgreSQL-preflight, and LLM-disabled build gates are
green. The complete default Playwright selection contains **19** tests and passed 19/19
from clean committed product tree `7c7ea334d4c88d9279abe574031881a23a15f32c` inside
the outbound-network-denied runner. The retained
[acceptance record](operations/evidence/2026-07-13-outbound-network-blocked.md) covers the
prior suite plus all J7/J8/J9 cases. Fresh migration/preflight covers all 17 ledger
entries and 28 required integrity triggers. Playwright recreates a guarded disposable
PostgreSQL database and does not mock application APIs.

`pnpm validate` covers static checks, unit/domain tests, and the production-mode build.
Integration and browser tests remain explicit because they require PostgreSQL and the E2E
suite recreates a disposable database.

Passing these commands proves the software behavior they exercise. It does not approve
training content or, by itself, satisfy the Product Spec's final release gate.

## Known architecture debt

The target architecture describes module-owned gateways and a shared workflow
`UnitOfWork`. The vertical slice has not completed that refactor:

- Programs and Training currently coordinate through direct Drizzle queries over the
  shared schema for some cross-module workflows.
- Data Portability intentionally uses a direct, repeatable-read projection and ordered
  deletion transaction while public per-module export/deletion ports are still absent.
- History queries currently live in Training; a separate Progress module is deferred
  until the Phase 3 read-model requirements exist.
- The exercise catalog is represented by development fixture identifiers and immutable
  prescription snapshots rather than a reviewed, licensed Exercises content module.
- The architecture suite proves the current module graph is acyclic and enforces several
  import/runtime dependency rules, but it does not yet prove schema/table write-authority
  fencing or require all cross-module work to use public gateways. Draft arc:
  [SCHEMA_OWNERSHIP_SPEC.md](architecture/SCHEMA_OWNERSHIP_SPEC.md) (Part A write fence +
  O1–O6 DoD) and proposed [ADR 0007](architecture/adr/0007-schema-table-ownership.md)
  (provisional debt template — not accepted). Adversarial review disposition:
  [SCHEMA_OWNERSHIP_ADVERSARIAL_REVIEW.md](reviews/SCHEMA_OWNERSHIP_ADVERSARIAL_REVIEW.md).
  Production-release blocker 4 stays open until Part A proofs and a Part B decision with
  honest status/doc convergence land; ADR merge alone does not close it.

These choices kept the first slice small and transactional, but they are tracked debt,
not evidence that the documented boundaries already exist.

## Application FactBundle wiring (codes path)

Training application maps completed sessions into contract FactBundles via
`getFutureLoadFactBundlesForSession`. For sessions admitted to History—currently eligible
content and explicitly revoked releases—History shows stored decision codes and loads.
Non-revoked development sessions are unavailable in reviewed-mode History. Subject export
still retains owned session facts, decisions, and cached-explanation provenance regardless
of current content eligibility. Optional on-demand plain-language explanation uses
`explainFutureLoadDecision` + a History server action (“Explain in plain language”):
inferred only, never blocks first paint, degrades when `INDIGO_LLM_MODE=disabled` or the
GPU/local server is not ready. Operator dry-run: `pnpm llm:dry-run-synthesize`. Product
process still defaults LLM off.

## Optional local grounded explanation (infra slice)

[ADR 0006](architecture/adr/0006-optional-local-grounded-language.md) and the
[explanation generation contract](architecture/EXPLANATION_GENERATION_CONTRACT.md) pin
structured grounded generation as the only accepted product path for optional local
language models.

**Implemented (optional product layer, default disabled):**

- model-agnostic `src/platform/llm` ports, registry, validation gate, and composition;
- one supported, exact-artifact model pack under `llm/models/*/settings.json`
  (Qwen3.5-9B Q4_K_M; the unverified Q5 pack was removed);
- loopback-only OpenAI-compatible adapter for host-local servers (e.g. llama-server);
- calibrated **offline** golden baseline (`pnpm llm:validate-baseline`) plus optional live
  probe when a loopback server is running;
- measurement protocol and JSON metrics snapshot including live `latencyMs.p50/p95`
  ([LLM_MEASUREMENT_PROTOCOL.md](architecture/LLM_MEASUREMENT_PROTOCOL.md));
- pure `buildFutureLoadFactBundle` from persisted decision fields (caller supplies
  `formatLoad` labels);
- operator guide in `llm/README.md`;
- host preflight (`pnpm llm:preflight`), pinned build/serve/download scripts, and runtime/GPU
  runbook ([LLM_RUNTIME_AND_GPU.md](architecture/LLM_RUNTIME_AND_GPU.md));
- live calibrations on this host for Qwen3.5-9B Q4_K_M:
  - **GPU path re-attested 2026-07-13:** driver 580.173.02 / RTX 4070; exact Q4
    digest; pinned llama.cpp commit, launcher, and eight mapped llama/ggml DSOs;
    literal `n-gpu-layers=all`; ~5.3 GiB live allocation; `/props` and `/v1/models` exact;
    `readyForLocalInference=true`.
  - current contract is FactBundle v2 plus closed-output prompt v3 / validator v4 and passes
    **43/43**, including canonical structured-name rejection traps.
  - the final validator-v4 clean-tree archive
    (`archive-batch-20260713T083416Z-281212.json`) passed all three runs at live
    availableRate **1.0 / 1.0 / 1.0**, p50 **806 / 807 / 807 ms**, p95
    **1177 / 1017 / 1012 ms**, offline **43/43**, and green live History E2E. Its source
    tree `f33c895056567d33dc15015e1367cdf62e7147ef` is exactly the merged
    `99ace8c^{tree}`; the squash merge changed commit identity, not reviewed source bytes.
    This manifest is operator-local evidence under gitignored `tmp/llm-runs/`, not a
    versioned repository artifact. Future calibration claims still require a fresh
    clean-commit/tree batch manifest; raw runs remain diagnostic only.
  - **Explanation invalidation:** append-only post-completion safety or performed-set
    corrections create authoritative decision/revision invalidations without changing the
    original facts. Explain returns `decision-invalidated`; correction/invalidation commit
    first, then cache cleanup runs post-commit and best-effort. Locked reads/publication
    make any residual row inert.

**History product path (implemented, default off):**

- codes always on every completed-session History record admitted by the content-
  eligibility boundary;
- on-demand “Explain in plain language” via `explainFutureLoadDecision` (inferred only);
- LLM-off e2e pin in `pnpm test:e2e`; GPU-on pin in `pnpm test:e2e:llm`;
- operator multi-run archive: `pnpm llm:archive-product-path` (writes `tmp/llm-runs/`).

**Prose cache (implemented):** PostgreSQL `future_load_explanation_cache` stores only
validation-passing available prose, keyed by contract `explanationCacheKey`, with at most
one current row per decision. Cache hits skip model preflight/synthesize; History UI
labels them `cached`. Revoked content and invalidated decisions retain authoritative
historical codes while Explain is disabled. Subject export includes full
generation/runtime provenance even when non-revoked content later becomes ineligible;
subject/instance deletion count and remove the rows. The cache is not part of the
immutable training ledger.

**Intentional boundary after this arc:** Program-page Explain and any methodology
authority change remain separate product work. `INDIGO_LLM_MODE` defaults to `disabled`.
LLM/ML **coaching** remains deferred. CI does not require GGUF weights.

## Production-release blockers

1. Close Methodology Gate 0 with named, independent human reviewers and a rights matrix.
2. Replace the development fixture with a reviewed methodology/template release and
   approved deterministic golden examples; do not relabel the fixture.
3. Complete independent WCAG 2.2 AA/manual screen-reader review and representative
   physical-device validation; the targeted automated browser checks are not a
   conformance claim.
4. Extend architecture enforcement to schema/table write-authority fencing (spec Part A,
   O1–O6) and either implement public module gateways / a targeted intermediate (C1–C5)
   or accept a provisional narrower boundary in an ADR with residual debt refiled and
   AGENTS/ARCHITECTURE convergence — see
   [SCHEMA_OWNERSHIP_SPEC.md](architecture/SCHEMA_OWNERSHIP_SPEC.md). Do not tick this
   blocker on ADR merge alone.
5. Obtain independent product/security/privacy review; document and exercise the
   operator's HTTPS deployment; and have a second person cold-install and restore from an
   encrypted off-host backup. The repository now supplies and has exercised the guarded
   PostgreSQL backup/restore procedure, but it cannot prove an operator's retention,
   secret custody, media handling, or recovery-time target.

Until those blockers close, the honest claim is: **working, browser- and
database-validated engineering MVP for local development**, not reviewed coaching
software.
