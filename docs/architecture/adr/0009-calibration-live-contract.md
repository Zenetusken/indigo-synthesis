# ADR 0009: Harden the calibration contract around truthful product state

- Status: **accepted for implementation** (2026-07-15, maintainer-directed roadmap arc)
- Date: 2026-07-15
- Amends: [ADR 0008](0008-calibration-module-boundary.md)
- Relates to: [ADR 0003](0003-deterministic-methodology.md),
  [ADR 0006](0006-optional-local-grounded-language.md),
  [ADR 0007](0007-schema-table-ownership.md)
- Normative detail: [Calibration engine and module boundary](../CALIBRATION_SPEC.md)

## Context

ADR 0008 placed deterministic load computation in Calibration, post-session decisions in Training,
future prescriptions in Programs, athlete facts in Athletes, and cross-owner orchestration in an
application `UnitOfWork`. The first implementation draft nevertheless assumed product facts and
lifecycles the live application did not have. It treated the setup load as strength evidence,
invented plate fit, did not compose exercise eligibility, conflated factual correction with optional
republication, and left queued mutations able to adopt replacement identity state.

This amendment preserves the owner boundaries while making the planned implementation total,
replayable, fail-closed, and user-visible. Exact discriminants, hashes, bounds, table shapes, lock
identities, and golden vectors live in the normative specification linked above; changing them
requires an explicit ADR/spec amendment, not an implementation shortcut.

## Decision

1. **Working load is not an estimate.** A trainee-selected starting load is a dated conservative
   working-load ceiling. It may hold or project downward before qualifying performed evidence, but
   can never authorize an increase or be passed through the estimator. Athletes owns an append-only
   correction ledger with stable intent identity, separate first-result provenance, effective-date/
   timezone lineage, and the strict historical-invalidated-estimate reset path.

2. **Every source has one owner.** Initial generation composes public Athletes, Exercises,
   Methodology, Calibration, and Programs ports without a fictional Training session. Completion and
   correction additionally compose Training. Exercises owns the installed contract and pure
   eligibility builder; Athletes owns category equipment, loadability, and safety facts; Programs
   alone owns future revision/prescription state. Workflow code owns no tables or DML.

3. **Results and equipment projection are total.** Calibration returns available
   `increase | hold | decrease` with an attainable load or unavailable with no load. The first
   loadability model is one bar plus paired plates and is exact—no invented unit rounding. Required
   decreases select only a strictly lower attainable total no greater than the bounded target or
   become unavailable. Increase/hold may conservatively project an unattainable current total down;
   an inexpressible increase may retain exact current only when current is attainable. Persisted
   direction is derived from the emitted load.

4. **Evidence evaluation is immutable and advances once.** Append-only complete compute bases
   separate evidence evaluation from current phase/safety/exercise/time/loadability projection. The
   closed evaluation modes are initial bootstrap, terminal session, correction replay, one-time
   legacy cutover, and no-new-evidence reprojection. A no-basis factual outcome stores its deferred
   mode; first recovery creates one receipt-bound basis, while later retries only reproject. Programs
   owns the one-time cutover receipt across untouched-legacy immediate input, delayed recovery, and
   ordinary new-root paths; correction-first uses correction-replay authority and must not fabricate
   a cutover receipt. Ordered children distinguish each exercise/evidence-current-load/evidence target. Each
   occurrence names exactly one child, each child covers at least one same-workflow occurrence, and
   child/basis identity is one-to-one. Phase is not a
   basis key: each planned occurrence persists its exact phase projection over the frozen basis.
   Starting/session evidence-current-load is distinct from the occurrence projection anchor. The
   first occurrence uses evidence-current-load; later occurrences bind the newly persisted immediate
   predecessor with the same basis/result/phase sequence. Inherited loads retain exact parent
   derivation provenance but rebind to the current-revision predecessor. A blocked predecessor has a
   closed dependent reason and copied valid recovery. The basis freezes its safe interval from
   evidence-current-load; the projection anchor may affect direction/equipment fit but never widen
   that interval or feed a planned load back through progression.
   Legacy performed history never silently falls back to setup. Owner-composed currency and
   invalidation prevent double progression. Any first accepted correction over an unbased legacy
   boundary supplies correction-replay authority; later safety-only feedback reuses the same basis.

5. **Correction closes the complete causal graph.** Performed-set and session-feedback corrections
   preserve the original fact, append exact effective replacements, and replay every dependent
   decision chronologically from its frozen historical viewpoint. The cascade follows fact,
   history, estimate anchor, basis, revision, inherited prescription, regeneration-receipt/
   continuation, and executable-session edges. Independent later estimates survive when their
   declared inputs did not change. A total parent/result ledger distinguishes republished,
   no-future-work, no-republication, projection-blocked, and active-session-deferred outcomes.
   Deferred historical replay propagates through dependent descendants and is recoverable through a
   success-only Training `training_fact_correction_recovery_receipt`/ordered-result ledger. Programs
   `program_regeneration_receipt_correction_recovery` joins carry every required Training recovery
   and materialize them in dependency order before the sole final current projection; no-future
   replay debt remains visible and recovers without inventing a revision. When an invalidated active
   session and deferred replay coincide, the active-session result wins while the same quarantine
   preserves replay ancestry; abandonment clears only execution and Regenerate recovers history
   before projecting. Immutable Training invalidation causes are separate ordered quarantine
   children, one per `(session, correction)`. Abandonment concludes the attempted workout; quarantine
   occurrences start at the first later unstarted workout, so zero/partial/fully-recorded work is not
   prescribed twice. A last-workout active head has zero occurrences and resolves through an exact
   history-recovered or execution-only no-future receipt instead of inventing a revision.

6. **A truthful fact is separate from optional projection.** A factual correction or admitted
   athlete input may persist after complete invalidation/quarantine even when a current owner source
   is unverifiable or content is revoked. It then writes no fabricated estimate, decision,
   prescription, revision, or executable snapshot. Incomplete closure rolls the fact back. Initial
   generation, ordinary publication, activation, and start remain all-or-nothing on complete current
   owner proof.

7. **Projection outcomes and recovery are durable.** Programs records exactly one immutable outcome
   for each accepted loadability version or starting-load correction:
   `revision-created | no-program-yet | no-future-work | no-republication | projection-blocked`.
   Ordered per-exercise basis-result children prove complete current/deferred coverage; every
   published revision requires a complete current basis, while only a fully quarantined factual
   outcome may defer an unverifiable basis. It separately records one current-planning outcome for
   each `calibration-correction-v1` Training correction after the atomic Stage 6 cutover in
   `program_training_correction_projection_outcome`; no outcome is fabricated for archival/still-live
   `legacy-correction-v1` rows. Training alone owns historical decision replay. Planning scope
   precedes publication gates: no active descendant, no unresolved quarantine head, no remaining
   work, and no deferred history is final `no-future-work` even if content/owner projection
   is unavailable. Deferred replay with no remaining work instead uses a debt-only zero-occurrence
   quarantine under the total primary blocker.
   Failure-to-publish is accepted only after every formerly startable active/draft projection is
   quarantined with one preserved remaining-work/debt continuation and ordered
   `program_projection_quarantine_correction` children for all deferred-correction ancestry.
   Programs owns append-only `program_projection_quarantine`/occurrence/correction-ancestry/session-
   invalidation-ancestry/
   resolution rows plus mutable CAS `program_projection_quarantine_head`; deferrable constraint
   triggers enforce one unresolved
   quarantine per subject. Later inputs/corrections either resolve it with zero replay debt plus a
   bijection from every old occurrence to the new revision, or transfer the exact occurrence and
   correction-child/session-invalidation sets. Direct no-future-work cannot erase a nonempty
   continuation, and only Regenerate may resolve carried execution-invalidation ancestry after
   abandonment; an intervening accepted fact uses the closed
   `projection.active-session-recovery-pending | regenerate-program` transfer result absent a higher
   content/owner block.
   Revision-created and final no-future outcomes forbid both deferred correction and carried session-
   invalidation ancestry.
   Delayed Regenerate writes one success-only receipt result: a continuation root with complete
   current-basis occurrence results; historical replay recovered with no future work, zero occurrence
   results, and at least one complete Training-recovery join; or execution-only active-session
   clearance with no future work and no fabricated revision. The shaped resolution lands
   in the same UoW. Its source union
   covers safety-hold resolution, projection quarantine, and exact temporal/exercise/category/phase/
   content stale-program reasons with at most one success per source/continuation. Dependency closure
   traverses the receipt back to every preserved source.

8. **Program state stays truthful and historical.** Availability is independent from computed,
   inherited, or migration-only derivation. A blocked exercise has no sets or copied executable
   load; mixed workouts may start only their available exercises, and wholly blocked workouts cannot
   start. Active and replacement-draft programs remain independently visible. Current v3 rows bind
   basis, estimate, phase, temporal boundary, safety, Exercises/category, loadability, content, and
   subject-generation provenance. A no-new-evidence prescription binds the exact evidence basis and
   exact occurrence phase and projection-anchor sources separately. Every new revision rebuilds each
   exercise chain topologically; row/status replacement cannot make a result self-stale, phase or
   predecessor changes reproject without advancing evidence, and changed evidence requires a new
   basis.
   Historical v1/v2 hashes are never rewritten. Started legacy
   snapshots may resume; unstarted legacy loads are quarantined until current regeneration.

9. **Dynamic gates cannot be bypassed.** Every compute/publish/activation/start path consumes the
   same-subject safety attestation and exact Exercises registry/category source under the subject
   lock. Methodology/template release revocation remains an independent exact-version execution
   gate. Athlete-local temporal validity is persisted and rechecked on server render and command.
   Calibration creates or clears neither safety holds nor exercise eligibility.

10. **The UoW has one leak-safe authority order.** A neutral application boundary owns closed lock,
    mutation-authority, isolation, gateway-scope, nominal prelocked-session, opaque owner-fragment,
    content-plan, and locked-set-attestor ports. Platform implements callback-scoped private
    class/closure capabilities with one-use/same-session checks and unconditional `finally`
    revocation; no global capability/connection registry exists. Identity consumes the neutral port.
    Neutral/application-facing ports and workflow/domain/application code never import the concrete
    PostgreSQL adapter; module infrastructure may still implement its owner repositories. Credential,
    product, subject, and lexical-content session-level advisory locks are acquired on one dedicated
    connection before `BEGIN`; Identity and owner-row reads/locks follow only after `BEGIN`.
    Detached/nested work is rejected and uncertain connections are destroyed. Content keys come only
    from a canonical HMAC-sealed plan composed from the exact closed set of opaque Methodology,
    Programs, and/or Training owner slots and bound to immutable shape/purpose/account/subject/
    preallocated form-or-command/source IDs plus lifecycle expectations and cardinality/size limits;
    publication always includes both exact methodology and template keys.
    Cheap structural/MAC failures precede DB capture; account binding may use one bounded capture
    lease but precedes UoW admission. Raw submitted keys cannot select locks. After Identity/
    generation, each owner re-derives only its transaction-bound fragment and Platform's opaque
    attestor compares the exact slot union with the prelocked bytes before mutation without reading
    product state or exposing raw-key APIs. The HMAC token is integrity-only, not encrypted; it
    contains only non-secret identifiers/content coordinates already authorized for the form and is
    never logged or echoed. Owners attest only their authoritative state, including the
    code-installed Methodology registry where applicable. A correction plan is the immutable source's shape-independent
    potential-impact union; submitted values choose only a contained causal subset. Platform alone
    owns HMAC/key material; application/domain/workflow code sees neither crypto nor raw keys.
    After plan validation, transactional Identity authority, and generation, an ordinary owning
    gateway classifies receipt/stable-intent before fresh content/source/planning gates: exact replay
    returns its stored result, mismatch conflicts, and only a new command continues. Root setup is the
    sole pre-generation classifier under its stored/result-generation rule.

11. **Provider writes are inside credential authority.** Ordinary authenticated product UoWs and
    one-subject export use resolved-account shared locks. Every provider/session/credential mutation
    on a resolved account—including sign-in insert/cleanup, checked sign-out, expiry cleanup,
    recovery/reset/revocation, and deletion—uses exclusive account authority; multi-actor/target
    flows lock every account lexically. Better Auth is pinned to the audited fixed-expiry, no-cookie-
    cache contract; mutation routes use the same leased control client. Bounded ordinary/control/
    capture pools plus one serialized external-process slot prevent recovery starvation and connection
    oversubscription; no unused runtime-health lane is reserved. This allocation explicitly
    supersedes the four-lifecycle-client/separate-CLI-
    pool paragraph in [Access and recovery](../../product/ACCESS_AND_RECOVERY_SPEC.md); that spec is
    amended in the same Phase 0 checkpoint, while its shipped admission/rate-limit semantics remain
    binding.

12. **Installation and subject lifecycles are anti-ABA.** Identity persists an opaque installation
    mutation epoch and per-subject generation. Forms/commands carry the pre-queue values; after all
    session locks and `BEGIN`, Identity first rechecks epoch and actor/session/role. Ordinary subject
    workflows then check generation before owner reads. Root setup alone lets Athletes classify its
    exact receipt first: replay must match the stored/current result generation, and only a new
    command applies the expected-generation gate before mutation. Setup records a source-generation/
    result-generation receipt, deletion
    advances the retained generation (or cascades it with the account), and reset rotates the epoch.
    A stale queued request or browser tab cannot adopt a reset installation or rebuilt subject.

13. **Deletion, export, and reset share the same fences.** Every product-table writer takes product
    shared; no stronger credential lock is a bypass. Subject mutation/deletion adds subject
    exclusive, export uses subject shared in one repeatable-read snapshot, and reset takes product
    exclusive. Deletion deliberately creates its plan/count/digest in one serializable transaction,
    then waits for confirmation/reauthentication. A separate serializable execution transaction makes
    plan lock, recount/digest revalidation, owner deletes, and tombstone atomic across module ports.
    Both race directions are proven against every subject and global writer, and Data Portability's
    cross-owner table operator is removed at Part B.

14. **Persistence ships with lifecycle and UI coverage.** Every new personal-data row/field enters
    export, deletion/reset, fresh/upgrade migration, preflight, and backup/restore coverage with its
    schema. LLM-off Program/Today/Workout/History surfaces render deterministic direction/reason/
    evidence/development/blocked copy, truthful active/draft/quarantine and pending historical-replay
    state, and exact recovery or explicit none. Outcome, quarantine/head/occurrence/correction- and
    session-invalidation-ancestry/resolution, Training correction-recovery, Programs regeneration join, and cutover
    tables/children are all personal-data lifecycle inventory. Stage 8
    includes only the required bar/plate capture, existing initial category
    setup wiring, starting-load correction, and narrow exact-source one-set History editor. Stage 4
    also makes the effective post-ledger live database-trigger DML graph and `db-trigger` manifest
    attribution bijective before adding the Better Auth user-insert lifecycle trigger. Ordered
    migration replay/catalog inspection resolves replacement/drop history and attributes the last
    effective source migration; fixtures prevent superseded or dropped bodies from being counted.
    Each edge retains firing source owner and
    target owner; neutral trigger attribution cannot authorize a cross-owner effect. Stage 6 removes
    the live Training-invalidation trigger's Programs state writes, and final Part B proof permits no
    trigger-mediated cross-owner DML.

15. **Implementation is phased but not partially shippable.** Lifecycle/UoW substrate precedes
    persistence, which precedes the pure engine and atomic completion cutover. The LLM-off product
    path and Part B boundary retirement then gate the optional grounded-prose extension. Stages 4–6
    may be reviewed as commits, but are not a deploy/merge checkpoint until Stage 8 restores the
    complete truthful user path and the cumulative gates pass.

## Consequences

- `adjustment_decision` remains a post-session Training record; initial provenance lives in Programs.
- Programs owns generalized revision/continuation lineage; Training owns its decision/correction
  ledger; Calibration owns only estimates and bases.
- Unavailability is executable product state, not a fallback to a prior load.
- Loadability edits, starting-load corrections, correction replay, and delayed Regenerate are
  cross-module workflows rather than hidden profile updates.
- The first implementation is visibly development-only. It does not close human content, security/
  privacy, or WCAG release reviews and makes no coaching-accuracy claim.

## Alternatives considered

- **Treat setup loads as e1RM or silently restore them after invalidation.** Rejected as fabricated
  evidence.
- **Round to a conventional plate quantum or keep the old load when fit fails.** Rejected as
  invented equipment and unsafe executable fallback.
- **Make the Training decision/session identity nullable for initial generation.** Rejected because
  it conflates distinct workflows.
- **Roll back every factual correction when optional publication fails.** Rejected because it loses
  authorized personal truth; complete invalidation/quarantine supplies the safe split.
- **Use mutable “current” rows or infer replay from present state.** Rejected because correction,
  concurrency, export, and historical provenance require append-only exact outcomes.
- **Let credential locks substitute for product/subject fencing, or start the transaction before
  waiting.** Rejected because queued requests could commit into a replacement identity state or read
  a stale serializable snapshot.
- **Put the prelocked connection token in platform-facing application types.** Rejected because it
  inverts the dependency boundary; only the neutral nominal capability crosses layers.
