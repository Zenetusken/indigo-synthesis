# Development roadmap — calibration and proper module architecture (Part B)

Status: **active engineering roadmap; Phase 0 complete, Stage 3 in progress**

This is the single engineering roadmap for the architecture arc from the shipped schema
write-fence to a calibrated `profile → plan → train → learn` loop and complete Part B module
boundaries. It records the decisions, dependency order, proof required at each phase, and the
line between autonomously verifiable engineering work and independent human release gates.

[ROADMAP.md](../ROADMAP.md) remains the product/release roadmap. [MVP_STATUS.md](../MVP_STATUS.md)
remains the live release-blocker ledger. This document sequences engineering implementation; it
does not close Methodology Gate 0, approve content, or substitute agent review for independent
human security, privacy, accessibility, strength-program, rights, or operator review.

---

## 1. Product and architecture direction

Indigo Synthesis is a self-hosted strength-training system with one primary loop:
**`profile → plan → train → learn`**. A trainee records factual profile/equipment inputs,
receives a deterministic program, records performed work, and gets traceable future-load
decisions. Deployment remains one TypeScript modular monolith plus PostgreSQL.

The load-bearing decisions are:

| Decision | Consequence | Authority |
| --- | --- | --- |
| Deterministic methodology | A model never selects a load, deload, or hold. | [ADR 0003](adr/0003-deterministic-methodology.md) |
| Optional LLM explains only | Structured decision codes and loads remain authoritative; normal journeys work with generation off. | [ADR 0006](adr/0006-optional-local-grounded-language.md) |
| Gate 0 governs reviewed numbers | All formulas, thresholds, phase rules, safety values, rights, and reviewed vectors remain human-gated. Development rules are never relabeled as reviewed. | [Methodology v1 pack](../product/METHODOLOGY_V1_DECISION_PACK.md) |
| Part A write fence is interim | O1–O5 prevent undeclared DML and expose current debt; they do not establish public module boundaries. | [ADR 0007](adr/0007-schema-table-ownership.md), #9 |
| Part B is the endpoint | Public module ports, private tables/repositories, workflow composition, and a shared `UnitOfWork` replace declared co-write/operator debt. | ADR 0007, [ARCHITECTURE.md](ARCHITECTURE.md) |
| Calibration is an engine invoked by workflows | Calibration owns pure rules and estimate lineage; Training owns post-session decisions/invalidation, while initial provenance stays in Programs. | [ADR 0008](adr/0008-calibration-module-boundary.md), [ADR 0009](adr/0009-calibration-live-contract.md) |
| Safety fails closed | Missing/implausible facts produce an explicit unavailable decision. Existing Athletes/Training safety-hold lifecycles remain authoritative. | [CALIBRATION_SPEC.md](CALIBRATION_SPEC.md) |

The working principle is unchanged: build structural boundaries that remain safe under handoff;
do not bless a direct-table workaround merely because the current installation is small.

---

## 2. Live checkpoint

### Complete

- **Stage 0 — schema write-fence:** shipped in #9. The live 36-table manifest has a compile-time
  bijection and the runtime O2–O5 write census.
- **Stage 1 — calibration boundary/spec:** merged in #10 after adversarial boundary review.
- **Stage 2 — accept ADR 0008 and Part B:** accepted 2026-07-15 in #12.
- **Phase 0 — implementation contract and documentation convergence:** complete on this branch;
  exact-tree architecture/integrity, product/status, and content-lock adversarial gates are green.
- Access/recovery J7–J9, guarded backup/restore, retained outbound-network-denied evidence, and
  the default-off History explanation path are already implemented.
- #13 independently corrected the first roadmap's migration mechanics and dependency graph.

### Open engineering work

- complete the Stage 3 Data Portability destructive-adapter and export-UnitOfWork cutovers;
- truthful calibration facts, schema, engine, persistence, and user-path integration;
- Programs/Training co-write retirement;
- audit, safety-hold, and Data Portability owner ports;
- public-entrypoint and peer-table-read enforcement;
- calibration decision support in the existing optional History explanation contract; and
- O6 documentation convergence and production-release blocker 4 closure.

### Human-gated and not autonomously closeable

- Methodology Gate 0, named reviewers, rights, formulas, safety thresholds, and reviewed vectors;
- a reviewed methodology/template release;
- independent WCAG 2.2 AA, screen-reader, and representative physical-device review;
- independent product/security/privacy review; and
- operator HTTPS exercise, second-person cold install, and encrypted off-host restore.

### Deferred or separate

CI/CD, Docker orchestration, monitoring, offline synchronization, multi-profile accounts, second
factor, model-led coaching, Program-page Explain, a Progress read model, broad/bulk completed-set
editing, and account-security UI stay under their existing re-entry gates. Stage 8 includes only
the source-linked History correction surface required to recover calibration-invalid evidence;
that narrow safety/liveness path does not silently absorb the broader deferred experiences.

---

## 3. Phase 0 — implementation contract and documentation convergence *(COMPLETE)*

The accepted module boundary remains sound, but the first roadmap certified several behaviors
that the live product cannot truthfully represent. This phase resolves them before runtime code.

### Accepted implementation amendment

[ADR 0009](adr/0009-calibration-live-contract.md) preserves ADR 0008's owner boundary and records
the following implementation decisions without rewriting the earlier accepted record:

1. **Starting loads are not e1RM evidence.** Existing `trainee-selected-starting-load` rows are
   conservative working-load facts only. They may seed the first development prescription but
   are never reinterpreted as a one-repetition maximum. Derived e1RM begins only from qualifying,
   explicitly confirmed performed work. A measured-test input stays deferred with its capture and
   provenance contract.
2. **Loadability is athlete data, not an invented default.** The engineering slice will capture
   immutable versions of bar mass plus paired plate denominations/counts and compute attainable
   total loads. Decisions and prescriptions retain the exact version/hash. Existing
   profiles without that additive data get an explicit `loadability.missing` unavailable result;
   no metric/imperial rounding assumption is silently injected.
3. **The result vocabulary is total and truthful.** Calibration returns either an available
   decision with direction `increase | hold | decrease`, next load, reason code, rule version,
   and estimate provenance, or an unavailable result with no invented load. Deload and layoff are
   decrease reasons, not disguised holds. Reason/rule/recovery catalogs are closed and versioned;
   unknown persisted values fail closed.
4. **Calibration does not create safety holds in this arc.** A clamp/gate may return unavailable,
   but the underspecified `raise_hold` boolean is removed. Pain and eligibility holds keep their
   current source-specific lifecycles. Any new calibration-specific hold requires a separate
   typed provenance/resolution contract and review.
5. **Derived state is append-only and correction-aware.** Calibration persists a single
   chronological chain, separate anchor dependencies, explicit session/revision sources, and
   source-linked invalidations, not a mutable untraceable “current max.” Database constraints
   enforce subject, order, acyclicity, and unique-head invariants. A correction follows fact,
   session, revision, anchor, and cross-exercise dependencies atomically; replacement uses only
   effective corrected facts or leaves no active estimate. Valid estimate derivation is orthogonal
   to decision availability, so missing equipment or a later projection block does not discard
   truthful performed-work lineage.
6. **Personal-data coverage lands with persistence.** Export, subject deletion, instance reset,
   E2E reset, schema versioning, preflight, and backup/restore coverage are Stage 4 requirements,
   not deferred until the later Data Portability port refactor.
7. **One adjustment authority.** Stage 6 removes the production call and authority of
   `decideDevelopmentLoadAdjustment`. Stage 8 separately replaces hardcoded initial-load
   generation; two post-session engines never coexist.
8. **Part B must be executable.** The endpoint requires public module entrypoints, rejection of
   private cross-module imports and peer-table reads, workflow-layer no-DML enforcement, removal
   of the Data Portability operator, and removal—not perpetual ratification—of every current debt
   grant.
9. **UI and LLM follow structured truth.** Existing Program/Today/Workout/History surfaces expose
   direction, reason, rule version, unavailable state, evidence/development status, concise
   deterministic copy, and recovery action before optional prose. The LLM phase versions the
   FactBundle/prompt/validator/cache contract and adds closed grounded paraphrases; Program-page
   Explain stays deferred.
10. **Unavailable blocks only the affected future work.** Factual completion succeeds. Programs
    persists mixed available/blocked revisions, with no sets or copied old load for a blocked
    exercise; wholly blocked workouts cannot start. Typed load/fact recovery may publish its named
    future-revision cause. Pain-hold resolution leaves the blocked revision immutable and routes to
    the safety-attested Regenerate-program root workflow instead of inventing a fifth cause. Every
    accepted athlete input also persists its exact discriminated
    `revision-created | no-program-yet | no-future-work | no-republication | projection-blocked`
    outcome; failure-to-publish first quarantines the old continuation so stale work cannot start.
11. **Initial and phase provenance have real owners.** Initial generation composes public Athletes,
    Exercises, Methodology, Calibration, and Programs ports without a fictional session. Programs
    persists the installed exercise/category source, a development-only phase fixture, and exact
    decision provenance; production rejects development contract/phase/rule versions until Gate 0.
12. **Bootstrap never invents progress.** Before qualifying performed work, an attested starting
    load is a ceiling: the engine may hold/project down but never increase. Athletes owns an
    append-only correction/recovery path for incompatible legacy values. Training supplies only its
    canonical effective confirmed-fact projection/hash; Calibration owns the closed admission
    classification and accepted-estimate history. Qualifying evidence keeps control; invalid
    current evidence routes to source-linked History correction; a fully invalidated historical
    estimate requires an explicit conservative starting-load reset confirmation. None silently fall
    back to the original setup fact.
13. **Untouched is not unavailable.** Only exercises with the rule-required effective performed
    evidence receive Training decisions. Blocked/no-set, all-skipped, and untouched exercises do
    not receive fictional decisions. Programs
    stores availability separately from typed computed/inherited derivation, so an untouched future
    exercise can retain exact available or blocked parent provenance; a same-session block may
    never inherit a prior available load.
14. **Every non-root revision has a truthful cause.** Programs owns a generalized parent graph with typed
    session-completion, training-fact-correction, loadability-update, and starting-load-correction causes.
    Training retains correction invalidations but asks the Programs port for dependency closure.
15. **Athlete-input replay returns the original workflow result.** Athletes classifies command/hash
    before mutable gates. Programs persists one append-only discriminated outcome—
    including the two fact-saved/failure-to-publish branches—for every accepted input in the same
    `UnitOfWork`; exact replay returns it and its quarantine, mismatched reuse conflicts, and missing/
   invalid outcome evidence fails closed. One generalized quarantine head carries remaining-work,
   deferred-correction, and session-invalidation ancestry; later inputs/corrections transfer or
   directly resolve it only under the checked result union, and delayed recovery is receipt-bound.
16. **Safety eligibility is owner-attested at every publish/start boundary.** A normalized
    Athletes-owned append-only attestation and hold-source relation preserve subject, profile,
    active-hold, status/reason/recovery, and hash provenance. Until Stage 9, public Athletes and
    Training projections are composed without peer reads; Stage 9 transfers resolution ownership to
    Athletes. Consumed blocked state is unavailable. Unverifiable evidence aborts derived decision/
    prescription/session publication; after a factual append and complete invalidation/quarantine,
    the fact plus typed blocked outcome/continuation may persist without fabricated derived rows.
17. **Deletion/reset linearize with product mutation and identity epochs.** Every product-table
    writer takes shared product fencing; subject paths add their subject generation/key, while
    global writers add owner/content keys. Locks are leak-safe session locks on one dedicated
    connection before `BEGIN`, so a post-wait `SERIALIZABLE` snapshot is fresh. Identity rechecks
    the pre-queue installation epoch and actor/session authority first. Subject deletion holds the
    same locks through recount/delete/tombstone; reset takes product exclusive and rotates the
    epoch. Both race orderings prevent stale post-delete/reset/revocation resurrection.
18. **Exact-version content revocation remains a publish and execution gate.** Publishers,
    activation, start, perform/skip, resume, and completion keep the canonical release lock/
    revalidation order. Factual correction remains appendable after revocation but only invalidates;
    it may not republish or re-enable revoked work.
19. **Executable integrity advances, history remains exact.** Current revisions use
    `normalized-input-v3`/`executable-prescription-v3` over every calibration, source, safety, and
    blocked field; workout snapshots bind exact source prescriptions/attestations. v1/v2 bytes stay
    historical. A started legacy session can complete only by quarantining untouched future legacy
    loads as blocked/no-set until inventory-backed regeneration.
20. **Lifecycle replay is anti-ABA.** Identity owns `subject_data_generation`; Athletes owns setup
    receipts. Every subject command carries its pre-queue generation. Setup classifies exact replay
    before the new-command generation gate, while deletion advances generation and removes receipts
    so stale queued/replayed commands cannot resurrect facts.
21. **Evidence advances once.** Persisted complete compute bases separate initial/session/correction/
    one-time legacy-cutover evaluation from phase/time/safety/exercise/loadability reprojection. Owner-
    composed currency and basis invalidation prevent a repeated Regenerate/input edit from applying
    progression twice. First recovery of a fact-saved outcome with no basis evaluates its persisted
    mode once; legacy performed history never silently falls back to the setup load. Basis-frozen safe
    intervals use evidence-current-load only; current-revision logical predecessor anchors control
    direction/equipment fit without becoming new evidence or ratcheting the interval.
22. **Corrections replay the full causal history.** Performed-set and session-feedback corrections
    close complete dependencies, preserve empirically independent estimates, replay affected
    decisions chronologically, persist a total outcome/result set, and project only the final current
    state. Deferred historical replay propagates through dependent descendants and is materialized by
    a success-only Training recovery ledger before Programs can resolve the quarantine; zero-future
    replay debt remains visible. A start-first descendant is invalidated and recovered after abandon/
    Regenerate.
23. **Exercise eligibility has an owner seam.** Exercises owns a narrow development registry and
    pure eligibility builder; Athletes owns versioned category equipment. Plate inventory cannot
    bypass an uninstalled/prohibited/advanced/category gate, and reviewed mode rejects the fixture.
24. **Credential authority includes the provider's dynamic writes.** Stage 3 preserves exact live
    credential keys, makes session reads fixed-expiry/write-free, binds every mutation route to the
    same leased control client, checks sign-out deletion, and budgets ordinary/control/capture/
    external connections without a recovery starvation path. `INDIGO_DATABASE_POOL_MAX` is the exact
    operator key (default 10, accepted integer range 6–64); ordinary receives `poolMax - 4`, control
    two, capture one, and the separate host process one. No unused runtime-health lane is reserved.
25. **Occurrence projection is a current-result chain.** The first remaining occurrence anchors to
    the frozen evidence-current-load; later occurrences bind only the newly persisted immediate
    predecessor with the same basis/result/phase sequence. Inherited loads retain parent provenance
    but rebind current-revision anchors, and a blocked predecessor produces a closed dependent reason.
26. **Client input never selects content locks.** Authorized owner reads return opaque, owner-slotted
    projections to a neutral composer for a signed canonical `content-lock-plan-v1` bound to immutable
    shape/purpose/account/subject/preallocated form-or-command/source IDs and lifecycle expectations.
    The closed shape registry requires no slots, Methodology target, Programs current, Programs plus
    Methodology, or Training history plus Programs current, with totals of 0, 1, exactly 2, 2–4, or
    2–64 potential-impact correction keys. Initial/current publication always locks the complete
    methodology/template pair. Raw, malformed, tampered, duplicate, noncanonical, extra, or
    oversized input fails cheap structural/MAC verification without a connection; a valid wrong-actor
    binding may use one bounded credential-capture lease but never UoW admission. Platform alone owns
    HMAC/key material and callback-scoped one-use adapter/attestor capabilities; no global registry is
    permitted and every outcome revokes them in `finally`. After Identity/generation, each owner
    re-derives only its transaction-bound fragment and the opaque attestor proves the exact closed slot
    union equals the prelocked set before mutation. Workflows see neither crypto nor raw keys. A
    correction locks the source-derived potential-impact union across every legal submitted shape;
    parsed values choose only a later causal subset contained by it.
27. **Ordinary exact replay precedes later mutable gates.** Plan structural/MAC/binding checks,
    transactional Identity authority, and current subject generation run first. The owning gateway
    then classifies receipt plus stable-intent hash: exact replay returns the original persisted
    result, mismatched reuse conflicts, and only a new command proceeds to fresh content-slot equality
    and content/source/planning gates. Root setup is the sole exception and classifies its receipt
    before generation under the stored/result-generation rule.

### Phase 0 definition of done

- `CALIBRATION_SPEC.md`, `product/ACCESS_AND_RECOVERY_SPEC.md`, ADRs 0007–0009, this roadmap,
  `ROADMAP.md`, `MVP_STATUS.md`, `ARCHITECTURE.md`, schema-ownership status docs, and code comments
  agree with the live #9–#13 checkpoint and one accepted Stage 3 connection topology.
- Independent architecture, data-integrity/privacy, and product-honesty/safety reviews report no
  unresolved critical or major finding.
- `pnpm check`, `pnpm docs:check`, `pnpm typecheck`, `pnpm test`, and
  `git diff --check` pass.

No runtime implementation begins until this gate is green.

---

## 4. Build phases

### Stage 3 — foundational `UnitOfWork`

- **Goal:** land the lifecycle/connection substrate before any calibration schema depends on it.
  Add Identity `installation_state.product_mutation_epoch` with upgrade backfill and reset/
  preflight/backup coverage. Implement an infrastructure-free `UnitOfWork<Scope>` port over closed
  lock/mutation-authority/isolation intents and a PostgreSQL adapter that acquires leak-safe session
  locks before `BEGIN`, then binds only transaction-scoped gateways. Replace the live single pool +
  raw lifecycle clients with the accepted ordinary/control/trusted-capture pools plus serialized
  external-host slot and no reserved runtime-health lane. Cut live Identity routes to the exact
  credential locks, sealed same-session lease, request-scoped mutation
  adapter, fixed-expiry read-only session policy, checked sign-out, and bounded expired-session
  cleanup. Neutral `ProductMutationFence`/`SubjectWorkflowLock` ports own no product schema/read.
- **Depends on:** Phase 0. **Unblocks:** Stages 4, 6, and 9.
- **DoD:** checked-in Identity epoch migration/metadata plus fresh/upgrade/preflight/backup/
  portability proof; reset rotates the epoch. Live Identity/auth/reset/bootstrap forms carry the
  issued expected epoch and stale-value proof passes. Subject generation deliberately does not land
  while legacy setup can bypass it: Stage 4 atomically adds its migration/backfill/user-insert
  trigger, capture/recheck ports, setup receipt/consumer, and retained-generation deletion advance.
  Stage 9 moves deletion behind owner ports, removes the temporary adapter, and completes every
  remaining subject-command consumer. Real
  PostgreSQL proof with test-only gateways representing two owners;
  same backend/transaction identity; both writes commit or both roll back after an injected
  post-write failure; callback result/error identity is preserved; retained gateways are revoked
  after success and failure; detached/unawaited gateway work forces rollback; nested/re-entrant
  calls reject and composition reuses passed gateways; read-only mode exposes no writer; the
  adapter imports no product module/schema; a neutral application-coordination boundary owns the
  nominal prelocked-session, content-lock-plan, opaque owner-fragment, and locked-set-attestor types
  plus their scoped ports. Platform alone owns runtime factories, HMAC key, private class/closure
  state, same-session/one-use validation, and unconditional revocation; no global capability or
  connection registry exists. Identity consumes the neutral
  port, no module/application code imports the PostgreSQL adapter, and architecture tests enforce
  both dependency directions. Each capability is not structurally forgeable; the workflow layer performs
  no DML; two real concurrent UoWs prove same-subject serialization and different-subject
  independence, with all session locks acquired before `BEGIN` and owner rows;
  an exclusive instance fence waits for all shared subject/global mutations and blocks new ones,
  while different subjects and compatible global work still overlap under the shared fence. Real
  PostgreSQL tests start a waiter before the winning commit, then prove the post-lock SERIALIZABLE
  snapshot observes the winner (not the known stale transaction-lock behavior); reverse unlock,
  cancellation, callback throw, and connection-loss paths either unlock or destroy the connection.
  production Identity gateways prove first-transactional-read epoch/authority recheck
  without giving the neutral adapter product reads. Exact current advisory identities are preserved:
  instance/email/unknown/account credential order, raw-user subject key, and unprefixed lexical
  content keys. Isolation/access is fixed at `BEGIN`; credential → product → subject → content →
  owner-row order is asserted. The neutral UoW accepts content locks only inside
  `withVerifiedContentLockPlan`: Stage 3 lands the opaque fragment composer/verifier, callback-scoped
  one-use capability and `LockedContentPlanAttestor`, platform-only HMAC implementation, and closed
  none/release-revocation/current-publication.initial/current-publication.existing/stale-regeneration/
  correction-closure owner-slot registry, with a 64-key potential-correction maximum and 16 KiB token
  maximum. The token is unpadded base64url canonical UTF-8 JSON plus HMAC-SHA-256 derived from
  `BETTER_AUTH_SECRET` under the versioned content-plan domain. It is authenticated, not encrypted:
  only already-authorized non-secret identifiers/content coordinates may appear, and the token is
  never logged/echoed or trusted as product authority. Encoded-size, base64url, canonical
  schema/sort/dedup, shape/cardinality, and constant-time MAC checks precede every DB capture. A
  DB-backed cookie may then consume one bounded trusted capture lease; actor/account/subject/purpose/
  form-or-command/source/epoch/generation binding failures precede ordinary/control UoW admission.
  Transactional Identity remains the first authority check.

  Owner infrastructure can mint only its neutral, scope-bound opaque slot through the injected
  factory; Platform reads no product state and workflow code cannot forge a fragment or inspect keys.
  After `BEGIN` and Identity/generation, Methodology, Programs, and/or Training re-derive exactly the
  required transaction-bound slots from owned authoritative state (rows where applicable, installed
  registry for Methodology). The opaque attestor rejects missing,
  duplicate, extra, wrong-owner, wrong-scope, wrong-source, or byte-unequal unions before mutation.
  Correction issuance/revalidation uses the immutable source's full potential-impact structural union
  across every legal editor transition; submitted values remain outside the envelope, are separately
  parsed/stable-intent-hashed, and choose only an actual causal subset contained by that union.

  Invalid MAC/malformed/oversized/illegal-shape plans consume no connection; a valid cross-account or
  subject binding consumes at most capture; a raw-key caller cannot issue a plan. Tamper, 65-key
  potential closure, duplicate/noncanonical/extra keys or slots, retained/forged/second use, and
  cross-transaction fragments fail. A valid stale envelope locks only its bounded issued set and then
  fails exact opaque owner equality with no mutation. Queue-capacity rejection, cancellation, lock
  timeout, callback throw, `BEGIN`/`COMMIT` failure, connection loss, and success revoke plan/attestor/
  fragment and prelocked-session scopes in `finally`; detached work fails and observable active counts
  return to zero. Architecture guards keep crypto/platform imports and raw-key issuer APIs out of
  domain/workflow/application code.

  Receipt-order integration proof covers an exact ordinary replay and mismatched reuse after content/
  source state changes: structural/MAC/binding, current Identity authority, and generation precede
  classification; exact replay returns its stored result, mismatch conflicts, and only a new command
  reaches fresh opaque slot equality. Root setup alone retains its documented pre-generation replay
  classifier.

  Initial publication races revocation of the methodology member and template member independently;
  both exact keys are mandatory and either revocation prevents publication.

  The physical pool budget and each trusted/submitted capture/control queue (64 waiters per queue) are bounded and
  priority-safe; callbacks reuse the leased control client and never re-enter `getDb()`. Ordinary
  saturation and submitted-email flood cannot starve recovery/reset/bootstrap. Better Auth 1.6.23
  route/config source tests prove GET/server session reads write no row and do not delete expiry.
  The account-lock matrix is exhaustive: ordinary authenticated product UoWs and subject export use
  account-shared; every resolved-account provider/session/credential mutation uses account-
  exclusive. Sign-in insert/cleanup locks the resolved account; unknown sign-in uses the synthetic
  unknown-account key. Local-user creation locks the actor plus preallocated target account after
  its email key; member-reset issue locks actor plus target and redemption locks the target; owner-
  recovery issue/redemption locks the owner; bootstrap creation locks the shared open-instance
  fence, submitted email, and preallocated owner account; checked sign-out, expired cleanup,
  password recovery, destructive reauthentication, revocation, and subject deletion lock every
  resolved actor/target account in lexical order. Instance reset takes the instance fence
  exclusively before its actor account and product-exclusive fence;
  external POST refresh is denied; checked sign-out cannot report success after delete failure and
  retains origin/CSRF/address/cookie boundaries. The writer census covers sign-in, sign-out, expiry
  cleanup, destructive-reauth attempts, reset/recovery/subject-delete cascades, bootstrap and owner-
  recovery issuance/redemption, audit, and durable rate limits. Purpose/target-bound authority,
  cross-purpose lease rejection, reset/revocation races, provider mutation binding, HTTP-boundary
  saturation, paginated dormant-session cleanup, and provider-upgrade fail-closed tests pass.
  One-shot host/operator processes use the serialized external slot and never instantiate app
  pools; a real CLI-under-saturation case stays within budget. Until Stage 9 removes the Data
  Portability operator, only its reset/subject-deletion verbs use one manifest-declared temporary
  table/verb-scoped leased-client adapter with no raw connection/Drizzle escape; Identity recovery
  uses scoped Identity repositories. The temporary adapter is not a new owner and is removed with
  the operator. Product-
  exclusive fencing is substrate-only here—reset-versus-every-product-writer linearization is not
  claimed until Stage 9 moves every writer to the shared side.
  Ownership/architecture suites remain green.
- **Non-goals:** no calibration, completion, audit, safety-hold, Programs, or Data Portability
  production gateway is invented before its accepted consumer; Stage 3 moves only the Identity
  epoch/auth lifecycle data and neutral UoW ports required by the live substrate. Subject generation
  waits for Stage 4's atomic setup/deletion cutover.
- **Review gate:** transaction lifetime/atomicity and architecture-boundary lenses.

#### Stage 3 implementation checkpoint — 2026-07-16 *(IN PROGRESS)*

- The nominal UnitOfWork and prelocked-session contracts, PostgreSQL transaction
  substrate, scoped Drizzle bridge, runtime mutation authority, and content-lock-plan
  capability boundaries are live.
- Identity now persists and checks the installation mutation epoch; credential,
  bootstrap, member reset, browser/host owner recovery, and bounded expired-session
  maintenance use the reserved control/capture/external-host topology.
- `INDIGO_DATABASE_POOL_MAX` now bounds the ordinary/control/trusted-capture allocation.
  Migration and observational startup preflight share one serialized, separately
  budgeted one-shot client, normalize `search_path`, verify role allowance, and never
  instantiate application pools.
- Static/type/unit/integration/build gates and the 19-migration disposable
  backup→wipe→restore drill are green at code checkpoint `131222a`; independent
  transaction/Identity, connection-budget, and one-shot-lifecycle reviews report no
  unresolved finding in the completed slices.
- Stage 3 is not complete: Data Portability still needs its epoch-bound destructive
  adapter and export UnitOfWork cutovers, followed by the cumulative Stage 3 review and
  certification gate. The retained 2026-07-13 network-denied browser evidence predates
  this topology and is not relabeled as current proof.

### Stage 4 — calibration and loadability persistence skeleton

- **Goal:** consume Stage 3 UoW/epoch ports and add public calibration/types plus exact persistence
  contracts: Identity `subject_data_generation` with upgrade backfill, Better Auth user-insert
  trigger, explicit Identity-owner/`db-trigger` external-writer attribution, commitment/redaction and
  atomic setup/deletion consumers; Athletes-owned append-only
  `athlete_setup_command_receipt` with source/result generation commitments;
  `calibration_estimate`/`calibration_estimate_invalidation` and Calibration-owned append-only
  `calibration_compute_basis`/`calibration_compute_basis_invalidation` (no generic pending basis); the narrow
  public Exercises `exercise-development-contract-v1` registry/
  eligibility builder; Athletes `athlete_category_equipment_version`/
  `athlete_category_equipment_version_item` (v1 migration and atomic
  reader/writer cutover that removes legacy `athlete_equipment`); additive Athletes-owned `athlete_loadability_version`/
  `athlete_loadability_plate` with actor, command/hash, sequence/previous-head, and exact inventory hash;
  append-only Athletes `starting_working_load_correction` with correction kind, stable intent hash,
  first-result/date/timezone provenance, actor/reason/prior/replacement, sequence/previous-head, and
  same-subject/exercise provenance;
  append-only Athletes `athlete_safety_eligibility_attestation` plus ordered
  `athlete_safety_eligibility_attestation_hold` sources with idempotent facts hash, total closed
  status/reason/recovery shape, and composite same-subject provenance;
  Programs-owned phase and available/blocked prescription provenance; immutable mixed-session
  blocked snapshots with `workout-session-snapshot-v2` and exact exercise/set prescription sources;
  orthogonal availability plus typed computed/inherited/`legacy-source-blocked` derivation
  (initial-generation, session-decision, training-fact-correction, loadability-update,
  starting-load-correction, continuation-regeneration) with parent/receipt provenance; append-only Programs-owned
  `program_load_input_outcome` with a discriminated `revision-created | no-program-yet |
  no-future-work | no-republication | projection-blocked` result plus
  `program_load_input_outcome_basis_result`;
  `program_training_correction_projection_outcome` plus ordered
  `program_training_correction_projection_basis_result`;
  generalized `program_projection_quarantine`, ordered
  `program_projection_quarantine_occurrence` and
  `program_projection_quarantine_correction` plus
  `program_projection_quarantine_session_invalidation`, mutable CAS
  `program_projection_quarantine_head`, and
  append-only `program_projection_quarantine_resolution`;
  `program_regeneration_receipt` plus ordered `program_regeneration_receipt_basis_result` and
  `program_regeneration_receipt_correction_recovery`; and
  `program_legacy_calibration_cutover_receipt` plus ordered
  `program_legacy_calibration_cutover_basis_result`;
  generalized cause-discriminated `program_revision_lineage`; and the persisted
  `adjustment_decision` append-only sequence/replacement direction/provenance extension plus
  Training-owned `adjustment_decision_history_source` and
  `training_fact_correction_outcome` plus ordered `training_fact_correction_decision_result`,
  success-only `training_fact_correction_recovery_receipt` plus ordered
  `training_fact_correction_recovery_decision_result`,
  and
  append-only cause-ledger `workout_session_execution_invalidation`, and Programs-owned
  `exercise_prescription_history_source`
  (`decrease`, nullable next load for unavailable, source facts hash, explicit estimate-use and
  loadability-use discriminants with conditional IDs/hashes, and required same-subject
  `athlete-safety-eligibility-v1` attestation reference, explicit current/phase/time/history/
  exercise-contract/category-equipment sources, development phase sequence/occurrence, and temporal
  validity). Current-contract program revisions use `normalized-input-v3`/
  `executable-prescription-v3`; current-contract sessions use snapshot v2 only after their named
  Stage 6/8 writer cutovers. Versioned legacy discriminants
  preserve v1/v2 rows and hashes without treating historical loads as executable.
- **Depends on:** Stages 0 and 3. **Unblocks:** Stage 5.
- **DoD:** checked-in Drizzle migration and metadata; fresh and additive-upgrade migration proof;
  the same checkpoint cuts Program/Today/workout start readers so every existing or newly emitted
  legacy-writer `legacy-unverified-load` is immediately non-startable with minimal
  `legacy.inventory-required` copy, while an already-started immutable legacy snapshot may resume/
  complete; until Stage 6 its legacy completion output remains `legacy-unverified-load` and is
  immediately non-startable, while Stage 6 alone may emit `legacy-source-blocked` for untouched
  future work;
  explicit constraints, indexes, FKs, lineage/invalidation semantics, and preflight checks;
  database-hostile proof for same-subject/session/revision/correction links, consecutive single-head
  chronology, Calibration-owned candidate/selector partial-invalidation failure, and complete
  compute-basis exact identity/currency/invalidation with phase-independent keys. The Programs legacy-
  cutover parent/ordered child schema proves its immediate-input/delayed-recovery/root-generation
  source union, same-UoW basis back-reference, one basis per subject/exercise/evidence-current-load/
  rule/effective-history boundary, one-to-one child/basis identity, and explicit one-child-to-many-
  occurrence mapping. Every affected occurrence names its exact cutover child; correction-first
  creates a correction-replay basis and no fabricated cutover receipt, while correction-after-
  cutover closes/replaces the prior basis only when causally required.

  Generalized revision/root-receipt cause shape, acyclicity, per-cause uniqueness, inherited
  available/blocked parent identity, idempotent estimate-source/rule identity, and one same-subject
  shape-valid immutable input outcome per accepted loadability version/starting-load correction are
  database-enforced. Stage 4 backfills/continues `legacy-correction-v1` for the still-live correction
  writer and creates the new outcome tables without inventing rows for that archival contract. Stage
  6 atomically removes the transitional default, cuts the writer to `calibration-correction-v1`, and
  enables deferred completeness: each accepted **current-contract** Training correction then has one
  total Training outcome with complete ordered direct/history results and one deferred same-subject
  Programs projection outcome. Programs
  owns only the final current-planning result and its complete ordered occurrence basis children;
  Training owns historical replay. `revision-created` and final `no-future-work` forbid deferred
  historical Training children and carried session-invalidation ancestry. Planning scope precedes publication gates: no active descendant, no
  unresolved quarantine head, no remaining work, and zero deferred children is `no-future-work` even if content/owner projection is
  currently unavailable. Otherwise overlapping blockers have one winner: invalidated active session,
  content revocation, current owner-source block, post-abandonment
  `projection.active-session-recovery-pending`, then historical-replay-deferred. The earlier blockers may
  carry deferred children only through exact quarantine correction ancestry; when replay debt is the
  sole block it uses `correction.historical-replay-deferred | regenerate-program`. Any of those
  non-active higher-precedence results may use a debt-only zero-occurrence quarantine exactly when no
  future work exists and its Training outcome has a nonempty deferred subset. Active-session outcome
  instead always has a nonempty exact execution-invalidation child set. Its occurrences cover only
  unstarted workouts after the invalidated session: a last-workout correction has zero occurrences,
  and abandonment never reissues its zero/partial/fully-recorded workout.

  The generalized quarantine source union is exactly `load-input-outcome | training-correction-
  projection-outcome`. Its ordered occurrence rows completely preserve remaining work, while its
  ordered `program_projection_quarantine_correction` children preserve each exact same-subject
  Training/Programs correction-outcome pair and deferred-result-set hash. Ordered
  `program_projection_quarantine_session_invalidation` children preserve every immutable same-
  session Training invalidation cause. All three sets enter the continuation hash. A CAS head row plus deferrable
  constraint triggers prove exactly one unresolved head per subject; direct/concurrent parent inserts,
  orphan/fork/cycle, and a head pointing at a resolved quarantine fail. Resolution shapes distinguish
  exact transfer to a new outcome/quarantine, direct successful projection with no deferred replay
  debt, receipt recovery with a revision, and receipt recovery with history repaired/no future work.
  Transfers prove one-to-one old/new occurrence, correction-child, and session-invalidation-child
  coverage; a later same-session correction adds exactly one new unique cause. Direct success requires
  zero correction and session-invalidation children plus exact consumed old-head identity and a bijection from every preserved
  occurrence/sequence/ordinal to the new revision; direct `no-future-work` cannot erase a nonempty
  continuation. Unrelated/partial/reordered/skipped-ordinal outcomes cannot clear a head.
  A session invalidation is unique per `(session, source correction)`, binds exact source revision/
  outcome/fact hash and prior session version, and blocks execution by existence. Active-session
  quarantine occurrences bijectively cover only later unstarted planned work; zero occurrences are
  required for a last workout. Missing/extra/current-workout/cross-session mappings, dropped prior
  causes, or a one-row-per-session overwrite fail. Inputs cannot transfer the head before abandonment;
  after abandonment an admitted input/correction transfers it under
  `projection.active-session-recovery-pending | regenerate-program` absent a higher content/owner
  block, and only Regenerate may resolve session-invalidation ancestry.

  Training correction-recovery parents are success-only and unique per original outcome. Their
  ordered children exactly cover the transitive deferred subset in dependency/chronological order;
  no current child may have a deferred ancestor, while independent branches may stay current.
  Programs receipt/recovery joins cover every deferred correction in quarantine ancestry and bind
  one-to-one to the Training parents. Recovery materializes ancestors before descendants and hashes
  those resolved edges before the sole final current Programs projection.

  Regeneration receipts use the exact source union `safety-hold-resolution | projection-quarantine |
  stale-program`; stale reason is exactly `temporal-boundary-crossed | exercise-contract-source-
  changed | category-equipment-source-changed | phase-source-invalid | content-source-replaced`.
  Uniform source-kind/source-ID/continuation-hash uniqueness permits at most one successful receipt
  for every source. The result is a current-basis `revision-created` continuation root,
  `historical-replay-recovered-no-future-work` with no revision/occurrence children and at least one
  complete Training recovery join, or `active-session-cleared-no-future-work` with no revision,
  basis/recovery children, or correction ancestry and a nonempty exact invalidation set for one
  abandoned last-workout session. Failed/current-blocked recovery writes no Training recovery,
  Programs receipt/revision/resolution, or command claim.

  Every input/correction projection outcome and successful revision-producing regeneration receipt
  has complete ordered same-subject basis-result children for every recomputed remaining exercise/
  continuation ordinal, exact legal current/deferred shapes, no duplicate/partial coverage, and a
  binding to its resulting prescription or quarantine occurrence. Revision-created results forbid
  deferred mode. Verifiably unavailable evidence persists a complete unavailable basis, so no
  recomputed occurrence uses a basisless shortcut. Every v3 occurrence stores its exact basis ID/hash
  plus occurrence phase source/sequence/ordinal and the projection-anchor union
  `evidence-current-load | preceding-logical-occurrence | blocked-predecessor`. The first occurrence
  anchors to the basis-frozen evidence-current-load; every later one names only the newly recomputed
  immediate predecessor in the same subject/exercise/result-revision/phase sequence with ordinal one
  lower, and every occurrence in that exercise/result binds the same current basis/evidence target.
  Self/same-ordinal/old-revision/skipped-ancestor/cross-basis references fail. A blocked predecessor binds
  its exact prescription/output hash and original reason/recovery and emits
  `projection.predecessor-blocked`; later projection sources are not reached. The basis-frozen safe
  interval can never widen or turn the anchor into new progression evidence. Phase is not in the
  basis key: repeated occurrences may reuse one evidence basis while producing independently hashed
  phase projections; row/status replacement stays compatible and changed phase truth reprojects
  without evidence advancement. Every new revision reconstructs the full per-exercise chain in
  order: an inherited row keeps exact parent derivation/load provenance but rebinds to the new
  current-revision immediate predecessor, and a changed predecessor forces downstream
  reconstruction. Hostile mixed computed/inherited, phase/anchor omission or mismatch, wrong
  occurrence, cross-
  user basis, incomplete coverage, and output/hash disagreement fail. Source-kind union
  constraints/FKs require every consulted estimate/loadability ID and hash even
  on unavailable decisions and require null ID/hash for `not-consumed | absent | not-reached`;
  available requires consumed loadability. Exercise eligibility unions prove not-reached, absent
  registry contract, installed tier/requirements, consumed/not-reached category equipment, and exact
  reason precedence without fabricated fields. Current-contract decision/prescription rows require a
  same-subject consumed safety-attestation and a shape-valid exercise source. Available requires
  eligible; an exercise-caused blocked row requires the matching consumed blocked reason, while an
  earlier safety winner may retain exercise `not-reached`. Attestation constraints cover subject,
  contract version/hash, normalized profile snapshot, `eligible + null reason/recovery + no holds`,
  each closed blocked reason/recovery combination, ordered nonduplicate hold children, and pain-
  recovery requiring a same-subject pain-hold child. Available decisions and every session start
  require eligible; a consumed blocked attestation requires a matching unavailable safety reason.
  Hostile missing/stale/cross-user/transitional-incomplete projections abort every derived decision/
  prescription/publisher row rather than fabricating provenance. After a factual correction or
  athlete input has proven complete invalidation/quarantine closure, only its factual row plus typed
  blocked outcome/continuation may persist with no fabricated estimate/decision/revision.

  In the same cutover, root setup classifies receipt/stable hash before the new-command generation
  gate, stores source G0/result G1 commitments plus profile hash, atomically advances Identity, and
  returns exact replay, while the temporary leased deletion verb begins advancing the retained
  generation. Neither side lands alone; mismatch, rollback, raw-token denial, delete/rebuild stale
  tab, and cross-user cases pass.
  `'calibration'` added to `ModuleId`; the new schema module explicitly added to the
  `SqlTableName` type imports/barrel; one manifest entry per table; O1–O5 green; typed compute and
  estimate/basis ports and initial Programs provenance port read no peer tables. Exercises exposes
  the exact development registry; Methodology references opaque IDs and no longer owns duplicate
  names/tier/equipment. The live legacy writers are refactored through that public projection while
  fixed v1/v2 snapshot/hash vectors remain byte-identical until their cutovers. Transitional safety
  composition uses public Athletes hold/profile and Training resolution projections passed to the
  Athletes-owned pure attestation builder—never an Athletes peer-table read. Programs can represent
  an unavailable exercise with no set rows while available set loads remain non-null; the named
  development phase fixture is persisted and production-rejected; export schema/version/provenance,
  deletion preview/count/execution, instance reset, E2E reset, and backup/restore inventory cover
  every new table and field; migration tests prove legacy discriminants are exact and no persisted
  revision hash or append-only decision is rewritten. Transitional defaults keep the live legacy
  completion/initial writers and correction writer labeled legacy until their Stage 6/8 cutovers;
  only calibrated gateways may explicitly emit the new contract. Upgrade and between-migration tests
  prove legacy corrections have zero fabricated outcome children, while the atomic Stage 6 writer/
  constraint switch rejects a current-contract correction without its total Training/Programs
  outcomes. `program_revision_lineage` remains Training-owned
  until the Stage 6 writer cutover, then transfers to Programs without losing historical rows.
  Starting-load hostile/replay/concurrency tests prove unique command/version, request conflict,
  previous-head/prior-value continuity, deterministic non-clock head selection, and subject deletion.
  Category-equipment migration proves canonical version-1 hash, complete reader/writer/export/delete
  switch, and removal of the legacy table with no dual truth. Loadability hostile/replay/concurrency tests prove the same command conflict/head guarantees plus
  child inventory hash integrity and exact replay of the persisted inventory version. Personal-data
  proof explicitly inventories both input/correction outcome parents and basis children, Training
  correction-recovery parents/results and execution-invalidation causes, projection quarantine/head/
  occurrences/correction- and session-invalidation-ancestry children/resolutions,
  regeneration receipt/basis/correction-recovery joins, legacy cutover parent/children, and safety-
  attestation/source rows in export/deletion/reset/preflight/backup-restore. Stage 8 owns full
  workflow/UI replay proof for all five input outcome families, generalized quarantine transfer/
  direct and delayed resolution, historical-replay recovery, and every regeneration result.
  The ownership architecture suite additionally inventories the effective post-ledger live trigger
  graph by ordered migration replay plus `pg_trigger`/`pg_get_functiondef` (or a resolver with proved
  catalog parity), attributing every live object to its last effective source migration. Superseded
  function bodies and dropped trigger/functions are excluded; replacement/drop fixtures prevent both
  historical false positives and stale-edge survival. Live DML edges retain firing source table/event
  and source owner as well as target table/op/owner. Every target
  requires matching physical `externalWriters: db-trigger` attribution and every attribution requires
  a live edge, but that principal never erases the initiating module. Cross-owner edges require
  bounded debt plus a named removal stage. The census covers the existing same-Identity installation
  bootstrap trigger, the new Better Auth user-insert → Identity `subject_data_generation` trigger,
  and the live Training `program_revision_invalidation` → Programs state effects, rejecting missing,
  wrong-owner, source-owner-erased, and stale records that the TypeScript DML scanner cannot observe.
- **Non-goals:** no numeric engine rules and no user-facing e1RM/Progress claim.
  The cumulative Stages 4–6 tree is intentionally not deployable/mergeable until Stage 8 supplies
  truthful loadability capture and the complete recovery UI.
- **Review gate:** migration/integrity, privacy/portability, and boundary lenses.

### Stage 5 — pure deterministic calibration engine

- **Goal:** implement the frozen `calibration-development-v1` contract as evidence-basis evaluation
  followed by exact occurrence-scoped phase/time/safety/Exercises eligibility/loadability projection.
  Phase is not a basis key: the basis freezes one progression/adaptive/deload evaluation and each
  projection combines the owner-attested phase target without advancing that evidence again. A first computation
  retains mode `initial-bootstrap | session-evaluation | correction-replay |
  legacy-cutover-evaluation` through both halves; only a later projection-only command uses
  `no-new-evidence-reprojection` and reuses a current basis. The first recovery of a blocked outcome
  with no basis uses its persisted deferred evidence mode exactly once; later retries are projection-
  only.
  It covers truthful starting/unsupported ceilings, qualifying estimate, phase/progression,
  adaptive up/hold/down, scheduled/triggered deload, layoff, clamp, and exact equipment fit. Every
  numeric value is visibly development-only and production rejects it.
- **Depends on:** Stage 4. **Unblocks:** Stage 6.
- **DoD:** deterministic repeat and golden/boundary vectors for every closed source/result/reason/
  recovery branch and exact operation order; missing/invalid facts return truthful unavailable while
  unverifiable owner proof aborts; no branch exceeds the final clamp; raised anchors ramp under the
  per-session cap; deload backstop cannot be disabled; all chosen loads are actually attainable
  from the passed bar/plate inventory and stay inside the final clamp. Required decrease uses only a
  strictly lower total no greater than its target or becomes unavailable; increase/hold may project
  unattainable current downward or degrade an inexpressible increase to exact-current hold. Starting
  temporal back-off cannot use bootstrap's ordinary nearest-below fallback. Trace includes compute
  mode/basis, evidence-current-load and the exact projection-anchor union, source facts/estimate/
  rule/phase/time/history/safety/exercise/loadability/content; domain
  imports no database, clock, random, environment, network, or LLM APIs.
  Starting-working-load vectors prove no pre-performance increase, correction-date temporal
  provenance, days 13/14/27/28, and typed recovery when
  no safe attainable total exists at or below the attested value. Estimate output is orthogonal to
  decision availability: qualifying effective work yields the same valid candidate when a missing
  loadability/phase or later projection makes the prescription unavailable, while estimation-
  invalid evidence yields no candidate. Golden vectors retain a valid estimate through a later
  missing-phase/safety block and retain present inventory provenance through an unrelated
  unavailable reason. Unsupported load/reps creates no estimate and can only hold/decrease; exact
  12/13/100-rep, 714286/714287-gram estimate-domain, high-strain, history/deload-proof, phase-
  sequence, and reason-precedence vectors pass. Explicit source-kind traces distinguish every
  not-consumed/absent/not-reached/consumed variant including exercise contract absent/installed and
  category equipment. Same-basis/same-phase repeat, preserved-occurrence phase projection, completed-
  no-future → new-sequence/base projection, and phase-change Regenerate vectors prove exact v3 phase
  binding/re-anchor precedence without double progression. The first remaining occurrence anchors to
  the evidence-current-load; every later occurrence uses only the newly recomputed immediate logical
  predecessor in the same result revision/phase sequence. Property vectors reject self/same-ordinal/
  old-revision/skipped-ancestor anchors and prove the predecessor can control direction/equipment fit
  but is never fed back as evidence-current-load, another progression step, or a wider safe interval.
  A blocked predecessor yields `projection.predecessor-blocked` with its exact prescription/output
  hash and copied valid recovery; phase/time/loadability remain not reached. A
  high phase target over a 100 kg evidence load remains capped at the same 102.5 kg basis ceiling
  across repeated inventory/registry/time/Regenerate changes. Mixed computed/inherited revisions
  rebuild the whole chain topologically: inherited load provenance survives, current-revision anchor
  IDs/hashes replace parent-revision anchors, and predecessor changes reproject downstream in order.
  The engine never fabricates an
  estimate ID; the UoW resolves `new-candidate` only after persistence. A consumed blocked safety
  attestation or exercise source is unavailable; unverifiable owner evidence is a no-mutation
  workflow failure. Binary-split packed-bitset operation-count and worst-case full-program tests
  enforce the bounded loadability budget. Repeated inventory/safety/time/Regenerate, blocked-then-
  repaired, all-skipped, phase/new-cycle reprojection, and correction replay prove one factual exposure advances progression at
  most once and stale bases cannot republish. First projection preserves its evidence mode
  in hashes/rows; only later inventory/time/safety/exercise repair records no-new-evidence mode. Pre-
  Stage-4 performed history with no basis, exact/concurrent first Regenerate, and immediate/delayed/
  root cutover paths produce one cutover basis. A performed-set-first or feedback-first correction
  instead creates the first correction-replay basis without a cutover receipt; feedback-only replay
  over an existing basis retains its exact ID/hash while changing safety/output provenance. A later
  correction after cutover replaces only causally changed basis inputs. No path reuses setup over
  qualifying legacy evidence.
- **Non-goals:** development values are not coaching approval; e1RM is not added to Progress UI.
- **Review gate:** adversarial methodology-shape/safety/property review (software behavior only).

### Stage 6 — atomic completion workflow and co-write retirement

- **Goal:** one workflow-scoped transaction composes Athletes, Exercises, Training, Programs, and Calibration ports.
  The neutral coordination gateway acquires the canonical athlete lock first. The Training gateway
  owns effective-fact projection, session assertions, decision/revision-invalidation provenance,
  and recursive invalidations; Athletes supplies safety/category equipment, while Exercises owns
  installed-contract eligibility through the transitional public projection composition. Programs alone persists/activates available/
  blocked prescriptions with explicit
  typed computed/inherited derivation plus the generalized revision parent edge; Calibration
  touches only its passed-fact estimate lineage.
- **Depends on:** Stages 3 and 5. **Unblocks:** Stages 8 and 9, then transitively Stage 7.
- **DoD:** injected failures after every participant boundary leave no partial rows; the existing
  per-user advisory lock and command-receipt idempotency remain; replay, conflicting command,
  concurrent completion/correction, cross-user denial, timestamps, optimistic version, and
  one-revision semantics remain green; factual completion succeeds for unavailable results; mixed
  results create available sets plus blocked/no-set exercises and never carry an old unavailable
  load; untouched future exercises inherit exact available or blocked parent provenance without a
  Training decision, while Programs still writes their new-revision occurrence rows in topological
  order and rebinds each logical anchor to the immediate current-revision predecessor;
  all-unavailable future workouts cannot start. Completion emits decisions only for performed
  working-set evidence, persists complete history/basis sources, and quarantines unverifiable legacy
  source mappings without invented provenance.

  Performed-set and session-feedback correction classifies command first, proves complete owner
  closure, saves fact plus decision/basis/estimate/revision/prescription/session invalidations, then
  chronologically replays direct and history-dependent decisions from their frozen evidence-current-
  load, logical projection anchor, date/timezone/profile, phase, inventory, Exercises/category,
  safety, content/rule, and effective-history viewpoints. Only the causally corrected source changes;
  the sole final Programs projection uses current owner sources.
  Estimate invalidation follows changed estimate-source facts/declared anchors—not mere revision
  invalidation—so the S1→E1/D1/R1, S2→E2/D2/R2, correct-S1 case preserves independent E2 while
  replaying D1/D2 and projecting only final S2 state. Three-session/deload, all-skipped, skipped→
  performed, RPE-only, feedback multi-exercise/zero-decision, revoked-source, and latest-evidence
  E1/E2 cases pass. Correction-after inventory, contract/category, timezone/profile, phase, and
  content changes proves historical rows stay frozen while the final projection is current. A
  performed-set-first or feedback-first legacy correction creates the first correction-replay basis;
  feedback-only over an existing basis retains the exact basis ID/hash and changes only safety/output.
  Exactly one total Training correction outcome and one deferred same-subject Programs current-
  projection outcome with complete ordered children persist;
  no-republication/owner-blocked projection retains the fact, while incomplete closure rolls back.
  Start-first invalidates the descendant session and defers publication until abandon/Regenerate;
  correction-first publishes before start. If active-session invalidation and deferred historical
  replay coincide, the active-session result wins while its quarantine still carries every deferred-
  correction child; abandonment clears only execution, and Regenerate must recover that ancestry
  before projection. The quarantine's exact execution-invalidation cause children remain nonempty,
  while its occurrence set starts strictly after the invalidated workout. Abandonment concludes the
  attempted workout without duplicating zero/partial/fully-recorded work. Recovery publishes only
  later unstarted work, or records `active-session-cleared-no-future-work` for an execution-only last-
  workout head. Exact replay returns the original combined outcome before and after abandonment.

  A transient replay-owner failure propagates deferred mode through the complete dependent history/
  basis closure and creates/transfers the generalized quarantine plus ordered
  `program_projection_quarantine_correction` ancestry; no child with a deferred ancestor may be
  current. Regenerate materializes success-only Training correction-recovery parents/results
  in global dependency order, Programs receipt joins cover the entire carried ancestry, and only then
  may the sole current projection and quarantine resolution commit. Vectors cover S1-deferred with
  dependent S2 plus an independent sibling, two deferred corrections where C2 consumes recovered C1,
  later evidence before recovery, feedback-only basis reuse, performed-to-skipped no-current, input/
  correction transfers, exact/mismatched replay, concurrent recovery, and failure after Training
  recovery before Programs root. A deferred correction with no future scope stays visibly under the
  total primary blocker with a zero-occurrence correction-ancestry quarantine; when replay debt is
  the sole block it uses `correction.historical-replay-deferred`. Successful recovery records
  `historical-replay-recovered-no-future-work` with no fabricated revision, clears the head, and only
  then permits a separate ordinary new-root command. Revocation/current owner block writes no
  recovery/receipt/revision/resolution or command claim. No-future plus revoked-content vectors prove
  a nondeferred historical no-current result returns `no-future-work` with no quarantine, while a
  deferred result retains the debt-only quarantine under the revoked primary block.
  Zero-set, partial-set, all-sets-recorded-before-completion, and last-workout active corrections with
  and without deferred history prove abandon-first gating, exact immutable cause coverage, no
  current-workout reissue, and the correct revision-producing/history-only/execution-only recovery.
  Two corrections before abandonment preserve both ordered causes; a pre-abandon input cannot
  transfer them, while a post-abandon transfer cannot resolve them without Regenerate.

  The Stage 6 migration drops `program_revision_invalidation_effect_guard` and
  `indigo_apply_program_revision_invalidation`: Training's gateway owns the session invalidation/
  pause effect and Programs' gateway owns revision supersede/program retirement in the same UoW.
  Architecture proof rejects every remaining trigger-mediated cross-owner DML edge. Training no longer inserts
  the four Programs tables or `program_revision_lineage`; lineage ownership transfers to Programs;
  their four debt grants are removed; O2/O3 remain green; legacy
  adjustment is no longer an independent authority; the completion writer no longer relies on the
  transitional legacy discriminator. Active-estimate resolution composes Calibration candidate,
  Training effective-session/hash attestation, and Programs revision-validity attestation under the
  lock; source revision is provenance for performed-facts-only v1 while current publisher rule/
  content compatibility remains mandatory. Missing/partial/stale/cross-user owner responses,
  invalid basis currency, and correction/reprojection races fail closed. A
  completion with a valid estimate but `loadability.missing` persists the estimate and blocked
  decision atomically, proving estimate validity does not depend on prescription availability.
  Completion pain-hold effects are reflected in the Athletes attestation before Programs publishes;
  safety and Exercises/category sources follow the total precedence and persist exact v3 refs;
  missing/stale/cross-user owner evidence rolls back every publisher while the hardened factual-
  correction split remains intact. Content revocation permits correction/invalidation but no
  estimate/decision/revision under the revoked rule.
- **Review gate:** independent transaction/concurrency and module-boundary reviewers.

### Stage 8 — core calibrated user path (LLM disabled)

- **Goal:** make the complete deterministic product path truthful with the LLM disabled. Initial
  generation composes Athletes starting/loadability/category-equipment and safety facts, Exercises'
  installed contract and eligibility projection, Methodology plan/phase facts, Calibration, and
  Programs without inventing a Training session. J1–J9 then reuse that contract for completion,
  correction, input update, Regenerate, activation, and start. Add only the user surfaces required
  by the accepted contract: bar/paired-plate setup/update, the existing initial category-equipment
  setup wired to the new versioned projection (no later category-profile editor), append-only
  starting-load correction, and the narrow exact-source one-set History correction editor. Broader
  equipment management, bulk correction, Progress comparison, and open-ended History editing stay
  deferred.

  Every initial/publish/activation/start path uses the same subject lock, lifecycle generation,
  content keys, Exercises source, temporal boundary, safety attestation, and exact current basis.
  Active and replacement-draft programs render independently; Today remains grounded in the active
  program. Server rendering removes stale Activate/Start actions at the athlete-local boundary and
  the commands repeat the authoritative checks. Exercise contract/category mismatch, a blocked
  owner attestation, invalidated basis, quarantine, or expired temporal source produces closed
  deterministic recovery copy rather than executable stale work.

  Each athlete-input command classifies exact replay/conflicting reuse before mutable gates. A new
  command rejects while a session is initializing/active/paused, then Programs applies one total
  planning priority: unresolved generalized projection-quarantine head; active remaining work; future-bearing
  draft; active with no future work; no program; otherwise typed invalid planning state. An admitted
  fact atomically records exactly one immutable outcome: `revision-created`, `no-program-yet`,
  `no-future-work`, `no-republication`, or `projection-blocked`. The last two may retain the truthful
  Athletes fact only after every previously startable active/draft projection is completely
  quarantined; partial closure rolls back. Later inputs or corrections directly resolve a head only
  with zero correction and session-invalidation ancestry; otherwise they transfer its exact
  occurrence/replay/execution ancestry to one new head, and only Regenerate may resolve execution
  ancestry. With no higher content/owner block, a transferred correction-debt head uses
  `correction.historical-replay-deferred`; transferred post-abandonment execution ancestry uses
  `projection.active-session-recovery-pending`.
  Delayed recovery writes the success-only Programs regeneration receipt, all required Training
  correction-recovery rows/joins, optional continuation-regeneration root, and shaped quarantine
  resolution atomically. A failed/current-blocked recovery writes none of those rows, leaves its
  command unclaimed, and returns a typed no-mutation result for a fresh retry.

  Program, Today, Workout, and History show structured direction/reason/rule, evidence/development
  status, active/draft/quarantine state, and a real recovery action or explicit none. Correction UI
  distinguishes “Correction saved” from optional publication outcomes, exposes invalidated active-
  session abandonment before Regenerate, and never labels a truthful factual append as a failed save.
  Every quarantine with correction-ancestry children says historical recalculation is pending beside
  the primary winner's exact action. For active-session overlap it also says the workout must be
  abandoned; after abandonment the action becomes Regenerate and recovery materializes the carried
  history first, then rebuilds only later unstarted workouts. Copy explicitly says recorded work will
  not be repeated; a last-workout execution-only result says the correction is applied and no later
  planned workout remains.
  A post-abandonment transferred head with session-invalidation ancestry still says Regenerate is
  required after the corrected workout and exposes no stale Start/Activate action; a higher content/
  owner block keeps its primary copy.
  Revoked-plus-deferred and owner-blocked-plus-deferred states receive the same debt
  disclosure without replacing their primary recovery.
  Load-input `no-republication`/`projection-blocked` similarly says “Equipment saved” or “Starting
  load correction saved,” names the exact publication block/recovery and continuation, and removes
  stale Start/Activate actions. A deferred historical replay says “Correction saved; historical
  recalculation is pending” and remains visible even with no future program. History-only recovery
  says no program was created and leaves Generate new program as a separate subsequent action.
- **Depends on:** Stage 6. **Unblocks:** the complete product mechanics loop and Stage 7.
- **DoD:** new and legacy-profile upgrade paths are honest; missing loadability/category equipment
  fails visibly (category absence remains `no-self-service` after initial setup); the exact five-
  entry development Exercises registry is the only admitted catalog,
  Methodology no longer owns duplicated taxonomy, and installed-contract/category-source mismatch
  routes to Regenerate without starting stale work;
  already-started legacy snapshots remain resumable while unstarted legacy-unverified workouts are
  visibly blocked pending inventory; Program/Today expose the persisted phase with a development
  label; the hardcoded initial writer is removed and the transitional legacy database defaults are
  dropped so every later insert states its contract. For a legacy subject with qualifying performed
  history but no basis, the first admitted inventory path creates the one same-UoW Programs cutover
  receipt + `legacy-cutover-evaluation` basis immediately or retains that deferred mode for one
  delayed Regenerate. A completed/no-future input may save no basis; the later ordinary new-root
  command uses the cutover receipt's `root-generation` source. Exact/concurrent input, delayed
  recovery, and new-root paths create one cutover receipt/basis per effective boundary without
  mutating the original outcome. Performed-set-first and feedback-first correction instead create a
  correction-replay basis with no cutover receipt; feedback-only over an existing basis retains its
  exact ID/hash, and correction-after-cutover changes only causally affected inputs. No path reuses
  setup;
  incompatible starting loads expose an append-only “Correct starting load” recovery and never
  increase before qualifying performed evidence. Training owns the canonical effective facts/hash;
  Calibration owns the four-way blocker classification. `current-qualifying-evidence` needs no
  setup action; `current-unsupported-evidence` uses its conservative performed-load ceiling and may
  offer only the secondary exact-source fact correction; `current-invalid-evidence` requires the
  exact History deep-link; `historical-invalidated-estimate` permits an explicit reset only when all
  accepted estimates are invalidated and current classification is `no-qualifying-evidence`.
  Structurally present implausible/estimation-invalid facts and invalidated estimates exercise every
  branch; the original setup value is never silently reused;
  downward/deload/layoff states render factually; closed deterministic copy gives every supported
  state a concise explanation, evidence/development label, and recovery action or explicit none;
  mixed and wholly blocked workouts behave as specified; temporal days 13/14/27/28, cross-midnight/
  DST, draft-before/activate-after, and page-render/start races fail closed at the same local-date
  boundary. Active plus replacement draft, unresolved generalized quarantine/replay debt, and delayed recovery remain
  simultaneously visible and truthful. Correction/restart/export/deletion/cross-user
  journeys and both orderings pass for each athlete-input kind versus generation, activation,
  start, completion, training-fact correction, and abandonment, plus same-kind input pairs and the
  cross-kind input pair; the second
  participant rereads/rebases the latest state or returns a typed no-mutation conflict, with no lost
  update or stale activation. Blocked-after-performed-evidence inventory
  recovery succeeds only with a valid composed estimate; exact athlete-input command replay returns
  the prior version plus its exact Programs outcome (all five families) while mismatched reuse
  conflicts. Replay-after-session-start passes for
  both input kinds, and starting-load replay after performed evidence still returns the original
  success; initial-setup and no-future-work replay pass for both input kinds. Failure-outcome replay
  retains its original fact/quarantine after repair; a newer same/cross-kind input or Training
  correction either resolves the head directly—only with zero correction- and session-invalidation-
  ancestry children and a complete old-occurrence-to-new-revision bijection—or transfers the exact
  occurrence plus named correction- and session-invalidation-ancestry children once. Only Regenerate
  resolves execution ancestry. Successful receipt recovery resolves it atomically;
  the CAS head/constraint triggers reject parallel unresolved parents and missing/duplicate/
  inconsistent outcome, transfer, ancestry, head, or resolution rows. Only new commands observe later state gates. A new starting-
  load command with canonical Training facts that Calibration classifies invalid returns the typed
  superseded conflict without mutation. Both draft-update/activation orderings and exact replay
  after later replacement/activation pass. Active-plus-draft, quarantine transfer, delayed
  Regenerate, and update/generation cases in both
  orders prove latest-input regeneration, stale-draft retirement, and one caused revision/outcome.
  Inventory update → immediate Start and inventory update → second update prove the newly published
  prescription remains current by reconstructing its exact evidence basis + occurrence phase +
  projection-anchor tuple rather than self-staling on row/status replacement. A changed evidence-
  current-load source selects a new basis; changed phase or immediate-predecessor projection truth
  reprojects and rehashes without double progress. Every new revision rebuilds the complete per-
  exercise chain in order; inherited loads keep parent derivation provenance but bind current-
  revision immediate predecessors, and a predecessor change reprojects downstream. The 100 kg high-
  phase vector never exceeds the basis-frozen 102.5 kg ceiling across repeated edits/Regenerate.
  A hostile current draft with no future work returns the typed planning-state error without
  mutation. Initial generation, update recompute, draft replacement/activation, completion,
  correction, and workout start all consume the current safety attestation; profile restriction or
  active hold blocks. Unverifiable owner projections abort initial/publish/activation/start derived
  rows; after a factual correction or admitted input has proven complete invalidation/quarantine,
  its fact plus blocked outcome/continuation persists but no estimate/decision/revision does.
  Incomplete closure still rolls back. Both orderings for workout
  start and every publisher versus pain correction/hold resolution prove no restricted/held load is
  snapshotted or published. While held, session-pain recovery renders the existing resolve action;
  successful resolution leaves the old blocked revision immutable and renders “Regenerate
  program.” Root generation uses the current eligible attestation, activation retires the blocked
  active program, and both resolution/regeneration orderings plus exact resolve-command replay pass.
  Regeneration keeps Programs' normalized-input-hash dedupe: unchanged current results reuse, while
  delayed retries after fact changes recompute only from the latest locked facts. Every delayed
  continuation root participates in dependency closure through its regeneration receipt;
  safety-hold, projection-quarantine, and stale-program sources share at-most-one-success identity.
  Temporal boundary, exercise-contract, category-equipment, phase, and content replacement stale
  reasons have exact replay plus Regenerate-versus-source-change/input/correction races. A debt-only
  correction head can recover as `historical-replay-recovered-no-future-work` with zero revision/
  occurrence basis children and complete Training recovery joins;
  correction-after-regeneration and regeneration-after-correction close stale preserved sources
  without invalidating independent later evidence. The exact-source History editor proves
  performed→performed, performed→skipped, skipped→performed field shapes, confirmation, replay,
  conflict, authorization/cross-user denial, feedback-only and multi-exercise feedback corrections;
  the same immutable source produces the same potential-impact lock plan for every legal edit shape
  while each actual causal subset stays contained; tampered/extra/duplicate/65-key/oversized lock
  plans reject at their specified pre-capture/pre-UoW boundary, and a genuinely server-derived over-64
  potential correction closure renders truthful no-self-service copy with no fact save;
  invalid→correct→replacement/unblock; recursive decision/revision/session invalidation; independent-E2
  preservation; all-skipped/invalid replacement selection; revoked `no-republication`; owner-
  blocked `projection-blocked`; active-session deferred projection → abandon → Regenerate; transient
  historical replay failure → input/correction transfer → dependency-ordered Regenerate; two carried
  deferred corrections; feedback-first legacy basis creation; feedback-only exact basis reuse; and
  no-future-work history-only recovery; and active-session, revoked-content, and owner-blocked plus
  deferred-history cross-products—including revoked nondeferred versus deferred no-future scope—in
  both correction/abandon/recovery orderings; zero-set, partial-set, all-sets-recorded, and last-
  workout active cases with/without deferred history prove the attempted workout is never reissued,
  later work is never dropped, and every invalidation cause survives transfer. UI copy and stale
  action removal match each persisted correction/recovery result. Browser cases change a source
  between render/submit and use stale tabs after reset/deletion: stale plans discard/reissue the form,
  preserve only safe normalized values for the same authorized source with mandatory review, and
  never auto-retry; invalid/tampered plans reveal no token/key/MAC detail; epoch/generation/authority
  routing takes precedence; capacity and lock timeout remain distinct retryable states.
  Every revision publisher, activation, start, perform/skip, resume, correction, and completion
  preserves the exact-version content-release lock/revalidation gate. Completion checks it before
  knowing whether future work exists; revocation races include input-update revision and no-future-
  work completion cases, with no newly available/startable revoked work.
  All J1–J9 cases pass with
  `INDIGO_LLM_MODE=disabled`; no e1RM accuracy or
  reviewed-coaching claim enters the UI.
- **Review gate:** product honesty, UI/accessibility, and authorization/privacy lenses.

### Stage 9 — complete Part B

- **Goal:** apply the proven port/`UnitOfWork` pattern to the remaining boundary debt: one audit
  append port, an Athletes-owned safety-hold lifecycle API for every current writer, per-module Data
  Portability export/deletion ports, public module entrypoints, and read/private-import guards.
- **Depends on:** Stages 3 and 6.
- **Explicit deliverable — normative Part B contract before implementation:** a standalone
  specification (`docs/architecture/PART_B_BOUNDARY_SPEC.md`) plus **ADR 0010**, drafted **after
  Stage 6 lands** so it binds to the proven `UnitOfWork`/port pattern rather than its paper design,
  and passed through the same adversarial-review loop as the write-fence and calibration contracts
  before any Stage 9 implementation begins. Grounding: the DoD below already carries the normative
  intent (port shapes, lock/fence orderings, the Data Portability snapshot/deletion transaction
  matrix, the `safety_hold_resolution` ownership transfer), but it lives in a roadmap checklist;
  [SCHEMA_OWNERSHIP_SPEC](SCHEMA_OWNERSHIP_SPEC.md) is the historical decision pack (C1–C5 options,
  costed, not an implementation contract); and
  [ADR 0009](adr/0009-calibration-live-contract.md) sets the governing rule — exact discriminants,
  bounds, and lock identities "live in the normative specification … changing them requires an
  explicit ADR/spec amendment, not an implementation shortcut." The deliverable extracts and
  expands this DoD into that contract: the read/private-import and public-entrypoint scanner
  contract with synthetic fixtures, the port contracts, the Data Portability transaction matrix,
  the manifest/ownership-transfer plan for `safety_hold_resolution`, and falsifiable
  definition-of-done items, mirroring the O-/K-series treatment every other enforced boundary
  received.
- **DoD:** every current `additionalWriters` grant is removed; the cross-cutting Data Portability
  operator and Stage 3 temporary verb-scoped adapter are removed; modules import peers only through
  public entrypoints; non-owners cannot
  import peer schema tables for reads or writes; workflow code owns no tables/DML; architecture,
  ownership, export, deletion, and integration suites are green. The Data Portability coordinator
  preserves one sequential `REPEATABLE READ READ ONLY` export snapshot across all module ports,
  one `SERIALIZABLE` planning/count/digest transaction, and—after confirmation/reauthentication—a
  separate `SERIALIZABLE` plan-lock/recount/digest-revalidation/delete/tombstone transaction across
  all deletion ports. Subject execution first acquires the composite `SubjectWorkflowLock` and holds
  it through commit. Writer-first is reread under the lock: changed count/digest forces a fresh plan,
  while unchanged count/digest still deletes the writer's latest serialized values. Deletion-first
  makes queued stale writers return `subject-data.deleted`; only setup carrying the new lifecycle
  generation may rebuild. Both orderings are proven
  against every subject writer, especially loadability/starting-load and program publishers.
  Instance reset holds the existing exclusive credential fence, then the exclusive
  `ProductMutationFence`, through recount/delete/tombstone; every subject and global product writer
  takes its shared side with no “stronger credential fence” bypass. All known session-level advisory
  keys are acquired before `BEGIN`, then epoch/actor/session/role is the first transaction-scoped
  recheck. Ordinary subject generation follows before owner reads; root setup alone classifies its
  exact Athletes receipt first, validates stored/current result generation on replay, and applies the
  expected-generation gate before any new-command mutation. Both orderings—including content
  revocation/global audit—prove no pre-reset
  product transaction can commit afterward. A write-census cross-check against the exact instance-
  reset table inventory proves every reset-deleted table writer uses shared product fencing;
  deletion-plan/tombstone, audit/rate-limit, content, setup, and every subject command path are
  included. The enforced
  order is credential → product fence → subject → lexical content-release → owner rows. The
  coordinator never opens one transaction per module.
  Every issued subject command/form carries the current opaque generation and installation epoch;
  setup commits a receipt bound to expected prior state and resulting generation, deletion advances
  the retained generation (or cascades it with the account), and reset rotates the epoch. Stale
  queued or browser-tab commands cannot adopt a replacement installation or ABA-rebuilt subject;
  fresh post-delete setup can rebuild exactly once. Export takes account/product/subject shared,
  revalidates epoch/authority/generation, and returns one coherent pre- or post-delete snapshot;
  deletion takes them exclusively and uses the accepted serializable plan/recount/digest flow.
  `safety_hold_resolution` manifest/read/write ownership transfers from Training to Athletes, and
  Athletes becomes the sole projection owner for active holds. Resolve remains one composed UoW:
  Athletes exposes the hold/source-session identity; Training classifies/records the existing
  resolve command receipt and attests terminal source-session plus durable invalidation eligibility;
  Athletes validates acknowledgement/no-medical-clearance semantics and appends the resolution.
  Exact receipt replay returns before later mutable gates; mismatch conflicts. Training raises pain
  holds only through the Athletes API and never imports either safety table.
  AGENTS/ARCHITECTURE/MVP_STATUS O6 convergence is complete; production-release blocker 4 is
  closed.
- **Review gate:** full adversarial architecture review. No current debt may be “ratified” merely
  to satisfy the checklist.

### Stage 7 — optional grounded explanation extension *(executed last)*

- **Goal:** extend the existing History-only, default-off explanation contract to the new
  calibration decision kinds/reasons using closed deterministic paraphrase templates. Structured
  codes remain visible and authoritative; Program-page Explain remains deferred.
- **Depends on:** Stages 8 and 9; scheduled last so it targets stable public APIs.
- **DoD:** FactBundle/prompt/validator/cache versions advance together; every supported kind and
  reason has canonical prose and hostile reject traps; unknown input fails closed; cache
  provenance/export/deletion remain complete; default suites force LLM disabled; J1–J9 remain
  green with generation absent. The FactBundle/templates omit internal e1RM/working-max values and
  claims; deny/golden cases prove prose can use only the persisted decision/reason/load and cannot
  bypass the deferred Progress/formula-labeling gate. Offline baseline passes; live GPU claims require fresh attested
  preflight/e2e/archive evidence.
- **Review gate:** independent LLM safety, grounding, provenance, and fail-soft review.

### Final certification — complete engineering arc

- **Goal:** certify the accumulated committed tree rather than extrapolating from per-stage green
  runs.
- **Depends on:** Stages 7, 8, and 9.
- **DoD:** from a clean worktree, record commit/environment and pass `pnpm validate`,
  `pnpm test:integration`, `pnpm test:e2e`, `pnpm db:preflight`,
  `pnpm db:backup-restore-drill`, `bash scripts/e2e/run-network-denied.sh`, and
  `pnpm llm:validate-baseline`. Integration evidence must explicitly include fresh-schema and
  additive-upgrade migrations, concrete preflight, hostile calibration constraints, portability
  snapshot/deletion semantics, restart/replay, and cross-user denial. Run the checked-in
  `pnpm docs:check` command plus `git diff --check`; reconcile roadmap/status/ADRs/runbooks with the
  committed code. The docs checker is added and made green in Phase 0.
  Independent architecture, data-integrity/privacy, product-honesty/UI, concurrency, and LLM-safety
  reviewers inspect the full cumulative diff and report no unresolved critical/major finding.
- **Conditional evidence:** live GPU preflight/e2e/archive is required only if this branch makes a
  fresh live-runtime claim; independent human release gates remain open regardless.
- **Review gate:** full adversarial code review after automated proof, followed by targeted reruns
  for every accepted finding.

---

## 5. Dependency and execution graph

```text
Stages 0–2  decisions/fence (DONE)
       │
       ▼
Phase 0  implementation contract + doc convergence (DONE)
       ▼
Stage 3  lifecycle + UnitOfWork substrate
       ▼
Stage 4  schema/ports/loadability/portability
       ▼
Stage 5  pure engine
       ▼
Stage 6  atomic completion + co-write retirement
       ├──► Stage 8  calibrated user path (LLM off) ──┐
       └──► Stage 9  complete Part B / O6 ────────────┤
                                                      ▼
                                Stage 7  optional grounded prose (last)
                                                      ▼
                                Final certification / cumulative review
```

The implementation path is **Phase 0 → 3 → 4 → 5 → 6**, then Stages 8 and 9 may proceed in
parallel. Stage 8 is the core user-path branch and is deliberately proven with the LLM off. Stage 7
begins only after both Stages 8 and 9 are green; final certification follows Stage 7.

---

## 6. Validation and independent review gates

| Phase | Required automated proof | Independent lens | Stop condition |
| --- | --- | --- | --- |
| Phase 0 | check, typecheck, unit/architecture, links, diff check | architecture; integrity/privacy; product honesty/safety | any unresolved critical/major |
| Stage 3 | unit + disposable-PostgreSQL integration + architecture/ownership | transaction lifetime; boundary | leak, detached work, partial commit, raw transaction exposure |
| Stage 4 | fresh/upgrade migration, preflight, portability/reset, integration | schema/integrity; privacy; boundary | personal data omitted or invariant not DB-backed |
| Stage 5 | golden/property/boundary vectors and purity tests | safety/property | non-total, non-deterministic, unattainable, or unclamped output |
| Stage 6 | failure injection, replay/concurrency/correction/auth, ownership | transaction/concurrency; boundary | any partial, duplicate, stale-estimate, or co-write path |
| Stage 8 | components + full LLM-off E2E/restart/export/deletion | product/UI/accessibility; privacy | hidden provenance, invented fact, or inaccessible state |
| Stage 9 | public-import/read guards, all port/integration suites | adversarial architecture | any remaining current grant/operator/private reach |
| Stage 7 | offline baseline, contract/cache tests, LLM-off E2E; optional attested live proof | LLM safety/provenance | prose changes authority or unknown input is served |
| Final | full static/type/unit/integration/E2E/build, migration/preflight, backup/restore, network-denied, baseline, docs | cumulative architecture; integrity/privacy; product/UI; concurrency; LLM safety | any failed command or unresolved critical/major |

Each phase is reviewed against its committed diff. Legitimate findings are root-caused and
patched before the next phase; the affected gate is rerun. Agent review evidence is engineering
evidence only and is never represented as the independent human release reviews listed in §2.

---

## 7. Evidence ledger

| Phase | Commit/PR | Automated evidence | Independent disposition |
| --- | --- | --- | --- |
| Stage 0 | #9 | O1–O5 fence; full suite recorded in PR | Part A shipped |
| Stage 1 | #10 | typecheck/format/schema suite recorded in PR | three adversarial boundary rounds |
| Stage 2 | #12; corrections #13 | docs-only validation | acceptance + roadmap certification |
| Phase 0 | this Phase 0 contract commit | `pnpm check`; `pnpm docs:check`; `pnpm typecheck`; `pnpm test` (70 files, 570 tests); `git diff --check` | exact-tree architecture/integrity, product/status, and content-lock gates green; no unresolved critical/major |
| Stage 3 | in progress — `a93ebe1` through `131222a` | `pnpm check`; `pnpm docs:check`; `pnpm typecheck`; committed code checkpoint: 130 unit files/1194 tests; `pnpm test:integration` (19 files, 194 tests); reviewed-mode LLM-disabled build; 19-migration backup/restore drill | completed transaction/Identity, connection-budget, and one-shot-lifecycle slices independently green; Data Portability/export and cumulative disposition pending |
| Stage 4 | pending | pending | pending |
| Stage 5 | pending | pending | pending |
| Stage 6 | pending | pending | pending |
| Stage 8 | pending | pending | pending |
| Stage 9 | pending | pending | pending |
| Stage 7 | pending | pending | pending |
| Final certification | pending | pending | pending |

Update this ledger in the same commit that closes each phase. A PR body or test count without a
reproducible command/result is supporting context, not completion proof.

---

## 8. Engineering completion versus production release

This arc is complete when Stages 3–9 are implemented, every phase gate is green, the final full
validation and adversarial code review are clean, O6 documentation matches the code, and blocker 4
is closed. At that point the engineering machinery and module boundaries are complete.

Production coaching release remains blocked until the independent human gates in §2 close. A
development rule version, deterministic engine, agent review, or green browser suite cannot approve
methodology, content rights, safety values, accessibility conformance, or operator practice.
