# Engineering MVP status and traceability

Snapshot: 2026-07-12
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
export the subject's data, delete a member subject, and reset the instance.

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
| J1 — Bootstrap and sign in | Host-issued one-use bootstrap capability, explicit database creation modes, atomic owner credential/installation claim, Better Auth sessions with credential-lifecycle serialization, owner-created local users, and host-local one-use recovery | `identity.integration.test.ts`, `owner-recovery.integration.test.ts`, and the browser journey | Bootstrap issuance and recovery are intentionally host-administrative rather than public reset flows |
| J2 — Set up a trainee | Units, IANA timezone, goal, experience, three training days, session duration, equipment, starting loads, age/technique attestations, and limitation context | Browser journey plus unit conversion tests | Initial setup is immutable in the current UI; a reviewed profile-change/revision workflow is still future work |
| J3 — Instantiate a program | Pure deterministic generator, explicit local date, canonical hashes, revision/workout/prescription rows that become immutable on activation, review-status fields, content eligibility, and persisted safety/equipment validation before activation | Methodology/domain tests, training integration tests, browser restriction and advanced-tier cases | Only an unreviewed development fixture exists; Gate 0 and reviewed golden vectors remain open |
| J4 — Train today | Truthful Today states; start; active/paused lifecycle; snapshot exercises/sets; canonical load, reps, optional RPE and notes; skips; timestamp-derived rest; pain stop/hold; abandon; source-linked hold resolution after abandonment; exact PostgreSQL resume | Main browser journey, safety browser cases, supervised-restart hold-resolution journey, restart-process integration, idempotency and authorization integration tests | No reviewed substitution set exists, so substitution correctly remains unavailable; resolution never reopens the abandoned session, and completed-session holds stay blocked pending H1 invalidation |
| J5 — Complete and learn | Transactional completion, immutable completed sets/history/decisions, terminal feedback guards, a fail-closed post-completion pain-report path, and a new future program revision without rewriting the completed revision | Main browser journey, direct database integrity tests, adjustment property/unit tests, and completion-replay integration | H1's append-only feedback correction and recursive decision/revision invalidation remain Phase 3; the current hold cannot be resolved until that safety precedence exists |
| J6 — Control data | Repeatable-read versioned JSON export with hashes/provenance/omissions; previewed member deletion; owner-only whole-instance reset; password reauthentication; transactional deletion/redaction; non-personal tombstones | Main and cross-user browser journeys plus portability integration tests | Export is subject-scoped; database/media backup and restore remain operator responsibilities |

The concrete evidence lives in `src/**/*.test.ts`, `test/architecture/`,
`test/integration/`, and `test/e2e/mvp.spec.ts`. Application APIs are not mocked in the
browser journey.

## Access and recovery (specified 2026-07-12; partially implemented)

A UI/UX audit surfaced a cold-start dead end: a locked-out visitor on a claimed
instance has no path forward. The response is
[Access and recovery](product/ACCESS_AND_RECOVERY_SPEC.md) (journeys J7–J9,
review-hardened), which reconciles to the live repository as:

- **Owner recovery — implemented, not surfaced.** `owner-recovery.ts` and
  `scripts/identity/recover-owner.ts` provide host-issued one-use recovery with session
  revocation and audit, but no product-surface entry point (web redeem `/recover`) yet
  exists.
- **Trainee credential reset (J7) — specified, not implemented.** No `member-reset`
  domain, route, or migration exists today; trainees currently have no reset path.
- **Cold-start orientation (J9) — specified, not implemented.** Sign-in offers no
  next action for the locked-out.
- **Account/profile separation (P1–P7) — a forward-compatibility direction**, not code:
  training data still keys on `userId` (`athlete_profile.userId` is the primary key),
  and cross-account isolation is application-layer only (no RLS).

None of the above is part of the current green suite; it is a specified next slice, not
implemented behavior.

## Cross-cutting status

| Concern | Implemented | Still required for canonical Release 1 |
| --- | --- | --- |
| Self-hosting | Local auth/assets, no mandatory cloud adapter, validated origin/config, one Node process plus PostgreSQL, a source guard against runtime outbound clients/remote assets, and browser request observation | Run and retain the complete browser proof in an environment whose outbound network is actually denied |
| Database integrity | Fourteen Drizzle migration entries, canonical 0004 ledger provenance, PostgreSQL 18 preflight, ownership/lifecycle checks, unique constraints, terminal-history and published-prescription guards, audit immutability, terminal/monotonic feedback enforcement, immutable hold provenance, append-only hold-resolution and content-release revocation records, and conservative audit-backed legacy provenance recovery | Ambiguous legacy hold provenance remains fail-closed for explicit administrator remediation; keep fresh-migration, upgrade, and preflight proof in final release evidence |
| Reproducibility | Canonical JSON/SHA-256 vectors, versioned input/output hashes, explicit `asOfDate`, no clock/random/network/database access in the pure generator | Replace development vectors with independently approved methodology golden vectors |
| Authorization/privacy | Server-derived actor, owner/member roles, cross-user denial, local sessions, subject-scoped export/deletion, and no application telemetry | Independent security/privacy review before an exposed deployment |
| Safety honesty | Contraindication/restriction block, fail-closed content status, pain stop/hold, append-only subject-only hold resolution with abandonment prerequisite and no medical-clearance implication, completed-source resolution blocked pending H1, advanced-tier denial, no diagnosis, and no fabricated substitution | Human strength and safety approval of the intended population, movements, bounds, stop rules, and copy |
| Accessibility/mobile | Semantic server-rendered UI plus targeted Playwright proof at 390×844 for reflow, 200% text sizing, 48px controls, skip-link/focus visibility, keyboard form order and focus continuation, changing polite save status, distinct titles, reduced motion, and no horizontal overflow | Independent WCAG 2.2 AA review, manual screen-reader certification, and representative physical-device testing |
| Maintainability | TypeScript, Biome, pure domain tests, one schema/migration authority, and executable guards for domain purity, dependency direction, platform independence, runtime outbound clients/remote assets, and an acyclic module graph | Extend enforcement to schema/table ownership and resolve the cross-module gateway debt below |

## Validation commands

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
INDIGO_CONTENT_MODE=reviewed pnpm build
```

At this snapshot, Biome, TypeScript, 262 unit/domain/architecture tests, 89 database
integration tests, dedicated upgrade proofs, the 15-path Playwright suite including the
supervised restart/replay journeys, PostgreSQL preflight/fresh migration across fourteen
ledger entries and 28 required integrity triggers, and the production build are green.
The Playwright suite runs against a freshly recreated PostgreSQL database with
application APIs unmocked.

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
  import/runtime dependency rules, but it does not yet prove schema/table ownership or
  require all cross-module work to use public gateways.

These choices kept the first slice small and transactional, but they are tracked debt,
not evidence that the documented boundaries already exist.

## Application FactBundle wiring (codes path)

Training application can map a completed session’s stored future-load decisions into
contract FactBundles via `getFutureLoadFactBundlesForSession` (query enrichment + pure
mapper over session snapshots). History remains **codes-only**; no trainee prose UI.
Unit + integration validation cover the mapper. Operator dry-run:
`pnpm llm:dry-run-synthesize` (disposable DB → FactBundles → live GPU synthesize). LLM
generation stays optional and disabled by default in the product process.

## Optional local grounded explanation (infra slice)

[ADR 0006](architecture/adr/0006-optional-local-grounded-language.md) and the
[explanation generation contract](architecture/EXPLANATION_GENERATION_CONTRACT.md) pin
structured grounded generation as the only accepted product path for optional local
language models.

**Implemented (platform only, default disabled):**

- model-agnostic `src/platform/llm` ports, registry, validation gate, and composition;
- per-model packs under `llm/models/*/settings.json` (first packs: Qwen3.5-9B Q4_K_M and
  Q5_K_M);
- loopback-only OpenAI-compatible adapter for host-local servers (e.g. llama-server);
- calibrated **offline** golden baseline (`pnpm llm:validate-baseline`) plus optional live
  probe when a loopback server is running;
- measurement protocol and JSON metrics snapshot
  ([LLM_MEASUREMENT_PROTOCOL.md](architecture/LLM_MEASUREMENT_PROTOCOL.md));
- pure `buildFutureLoadFactBundle` from persisted decision fields (caller supplies
  `formatLoad` labels);
- operator guide in `llm/README.md`;
- host preflight (`pnpm llm:preflight`), serve/load/download scripts, and runtime/GPU
  runbook ([LLM_RUNTIME_AND_GPU.md](architecture/LLM_RUNTIME_AND_GPU.md));
- live calibrations on this host for Qwen3.5-9B Q4_K_M:
  - CPU path (pre-reboot): offline 28/28, live availableRate=1.0
  - **GPU path (post-reboot, 2026-07-13):** driver 580.173.02 / RTX 4070, CUDA
    `llama-server` with `n-gpu-layers=-1`, ~6.1 GiB VRAM in use, offline 28/28, live
    **availableRate=1.0** (8/8 eligible; invalidated case correctly unavailable). Product
    policy remains GPU-only for local inference (`INDIGO_LLM_REQUIRE_GPU=true`).

**Not implemented yet:** trainee History/Program UI for prose, prose cache/migrations, or
any methodology authority. History continues to show structured reason codes only.
`INDIGO_LLM_MODE` defaults to `disabled`. LLM/ML **coaching** remains deferred. CI does
not require GGUF weights; live probe is operator calibration. Product UI waits on
protocol gates plus a healthy post-reboot GPU path if CUDA is desired.

## Production-release blockers

1. Close Methodology Gate 0 with named, independent human reviewers and a rights matrix.
2. Replace the development fixture with a reviewed methodology/template release and
   approved deterministic golden examples; do not relabel the fixture.
3. Complete the Product Spec acceptance run with outbound network blocked and preserve
   the fresh-database, restart, authorization, idempotency, safety, export, and deletion
   evidence as one release record.
4. Complete independent WCAG 2.2 AA/manual screen-reader review and representative
   physical-device validation; the targeted automated browser checks are not a
   conformance claim.
5. Extend architecture enforcement to schema/table ownership and either implement the
   intended public module gateways or accept a narrower boundary in an ADR.
6. Obtain independent product/security review and document a supported manual
   backup/restore and HTTPS deployment procedure before beta.

Until those blockers close, the honest claim is: **working, browser- and
database-validated engineering MVP for local development**, not reviewed coaching
software.
