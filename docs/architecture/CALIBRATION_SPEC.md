# Calibration engine and module boundary

Status: **accepted boundary and live-contract amendment; Phase 0 complete**

Scope owner: architecture/product; every numeric methodology value remains gated by Gate 0
Relates to: [ADR 0001](adr/0001-modular-monolith.md), [ADR 0003](adr/0003-deterministic-methodology.md),
[ADR 0006](adr/0006-optional-local-grounded-language.md),
[ADR 0007](adr/0007-schema-table-ownership.md), accepted
[ADR 0008](adr/0008-calibration-module-boundary.md),
[ADR 0009](adr/0009-calibration-live-contract.md), the
[development roadmap](DEVELOPMENT_ROADMAP.md), and the
[Methodology v1 decision pack](../product/METHODOLOGY_V1_DECISION_PACK.md).

Calibration is the deterministic mechanism that turns truthful athlete/performed-work facts into
traceable working-load decisions. It is a pure engine invoked by application workflows; Training
remains the owner of post-session decisions, so Calibration is not a second training ledger and
never an LLM decision surface. This revision hardens the accepted boundary against live product
facts that the original draft did not represent: conservative starting loads, missing plate data,
downward decisions, blocked prescriptions, correction-derived state, portability, and safety-hold
lifecycle semantics.

---

## 1. Authority and non-claims

- This document fixes software contracts, ownership, state lineage, and proof obligations.
- It does **not** approve a formula, percentage, threshold, deload schedule, phase ontology,
  population, claim, or content release. Those remain Gate 0 outputs.
- Every numeric development rule is carried on a development `ruleVersion`; production rejects
  development rules. The fixture is replaced through review, never relabeled.
- Derived e1RM/working-max values remain internal provenance in this arc. A user-facing Progress
  metric requires its separately defined formula/source/labeling gate.
- A model may paraphrase a persisted decision only after the structured path is complete. It
  never supplies a fact, reason, direction, load, or safety action.

---

## 2. Live grounding

The current setup asks for a conservative starting load and explicitly says it is **not measured
strength or an automatic training max**. Persistence distinguishes it by protocol
`trainee-selected-starting-load`, even though it lives in the historical `strength_baseline` table.
It is therefore a starting-working-load fact, not a one-repetition maximum.

The current future-load record/gate stays in Training. Its active status is a linearized read over
the Training-owned session, feedback, correction, decision, and invalidation tables. Moving that
record to Calibration would shear the atomic invalidation contract; ADR 0008 correctly keeps it in
Training.

The current development adjustment function supports only increase/hold/unavailable and Training
directly inserts the Programs revision cluster on completion. That path is compatibility debt to be
retired, not a second authority that survives beside Calibration.

Current equipment capture records only equipment-category presence. It cannot support an honest
claim that a target is loadable on the athlete's bar and plates.

---

## 3. Input facts

`computeNextLoad` is pure over an explicit, versioned normalized facts object. All dates, including
`asOfDate`, are passed facts. `sourceFactsHash` is the canonical hash of that complete normalized
facts contract; replay uses the hash plus `ruleVersion`. Calibration reads no peer module table,
clock, environment, network, random source, or global registry.

### 3.1 Anchor facts

The anchor is discriminated so no caller can silently reinterpret a starting load:

- **`starting-working-load`** — a conservative user-attested working load, including load grams,
  exercise code, tested/attested date, and provenance. It can seed the first development target but
  cannot be passed through an e1RM formula. Before qualifying performed evidence exists, the engine
  may hold or reduce this value to a safe attainable total but may never increase it.
- **`performed-work-estimate`** — an active Calibration-owned estimate derived from qualifying,
  explicitly confirmed performed sets. It includes estimate ID, e1RM grams, working-max grams,
  estimate-source-facts hash, and rule version.
- **`performed-working-load-ceiling`** — the exact current working target plus effective session/
  correction provenance when the performed facts are truthful but outside the development
  estimator's supported domain. It can hold or reduce but never increase, and creates no estimate.
Initial prescriptions use `starting-working-load`. After qualifying performed work exists, the
engine uses the active estimate. A latest truthful-but-unsupported exposure uses the performed
working-load ceiling for that decision even if an older estimate remains historically valid.
Missing starting anchor returns unavailable; a concrete invalid starting row returns
`anchor.starting-invalid`. Malformed/stale derived-estimate provenance is
`estimate-source.unverifiable` with no decision, never a user correction prompt.

A measured-repetition-test input is deferred with its capture journey. It is not part of the
implemented union until the product can persist its discriminated source provenance; callers must
not fabricate one from existing starting-load rows.

#### Starting-working-load correction ledger

Athletes owns append-only `starting_working_load_correction`. Each row records: ID, user ID,
exercise code, original `strength_baseline` ID, self actor ID, command ID, stable intent hash,
per-user/exercise sequence, nullable previous correction ID, prior effective grams, replacement
grams, the closed correction kind `value-correction | new-working-load-attestation |
historical-invalidated-estimate`, bounded nonblank reason, prior and replacement effective
attested dates, the athlete IANA timezone/profile source version and hash used to derive a new
date, first-execution result/source hash, and creation time. The stable intent hash covers only the
submitted kind/value/reason plus the source/form identities issued to the client; it never includes
a recomputed clock or current profile. Athletes classifies command ID and this intent hash first.
The result/source hash separately covers the persisted prior/replacement dates, timezone/profile
source, sequence, and all other first-execution facts. The raw current instant
is never accepted from the browser. A `value-correction` says the value entered for the earlier
attestation was wrong and must preserve its prior effective date. A `new-working-load-attestation`
and the explicit `historical-invalidated-estimate` recovery are new current facts and must use the
server-derived current athlete-local date; their prior date is retained only as lineage. The
original baseline and earlier corrections are never changed or deleted by this correction workflow
(subject deletion remains authoritative).

Unique command and `(user_id, exercise_code, sequence)` identities plus composite FKs/deferred
constraints enforce same subject/exercise, previous-head continuity, prior-value/date equality,
the correction-kind/date union, no fork, and strictly positive in-domain replacement. The effective fact is the validated chronological
head, never the newest clock value. Under the subject lock, Athletes classifies command ID and stable intent hash
before any mutable-state gate. Exact replay returns the persisted correction and the Programs-owned
`program_load_input_outcome` recorded by the original workflow, without re-running performed-
evidence or active-session gates. Reuse with different input returns
`starting-load.command-conflict`; only a new command may proceed to those gates and mutation.
Missing, duplicate, or inconsistent outcome evidence fails closed without changing either owner.
Hostile SQL, replay, replay-after-state-change, cross-midnight/DST replay, and concurrent-correction
integration tests prove those invariants. Export and deletion include the complete ledger and outcome.

This correction is a bootstrap recovery only. For a command already classified as new, Training
first asserts there is no initializing/active/paused session; if both later gates would block,
`starting-load.active-session` has deterministic precedence. Only then Training
supplies its canonical current effective confirmed performed-fact projection and hash; Training
never decides whether those facts qualify for estimation. Calibration applies its closed,
versioned admission predicate and returns `no-qualifying-evidence | qualifying-evidence |
unsupported-evidence | invalid-evidence`, while separately attesting whether any estimate has ever been accepted for the
exercise. The closed `starting-load.superseded-by-performed-evidence` response carries one blocker
discriminant: `current-qualifying-evidence`, `current-unsupported-evidence`,
`current-invalid-evidence`, or
`historical-invalidated-estimate`. Current qualifying evidence needs no setup recovery; current
invalid evidence routes to its exact source-linked correction in History. Truthful unsupported
evidence is not presented as an error to edit: its current program uses the conservative
performed-working-load ceiling, and the setup correction remains superseded. A historical accepted
estimate with no current qualifying or invalid facts may not silently fall back to the original
setup value: it requires an explicit `historical-invalidated-estimate` recovery confirmation, which
appends a new starting-working-load correction with that reason and can publish a future revision.
That recovery is admitted only when every formerly accepted estimate is invalidated and the
current effective-fact classification is `no-qualifying-evidence`; it remains a conservative
working-load ceiling, never estimate evidence. Thus every branch has a live recovery without
quietly reinterpreting disproven facts. Both owner attestations run under the same lock/`UnitOfWork`;
missing, stale, or inconsistent evidence fails closed. Corrected-away facts classified
`no-qualifying-evidence` do not supersede setup unless Calibration reports the historical branch.
Every rejected gate leaves command identity unclaimed, so a later retry rereads current state;
exact successful replay and mismatched reuse still retain their earlier precedence.
Temporal vectors distinguish an old-date `value-correction` (which can immediately require the
14-/28-day back-off) from both current-date attestation kinds. They prove exact replay retains the
original timezone/date provenance and that profile-time changes, host timezone, DST boundaries, or
client-supplied dates cannot rewrite the effective temporal anchor.

### 3.2 Performed-work facts

Facts include only effective Training projections: session/exercise identity, explicitly confirmed
performed sets, source set-prescription identity/ordinal/kind, actual load/repetitions, optional RPE,
completion date, correction version/hash, expected working-set target/count, and session-pain
observations when methodologically relevant. Skips remain a status, not model or free-form input.
Warmup sets remain factual history but are excluded from estimation, high-strain, skip, and target-
match rules. The development rule requires one uniform load/repetition target across its working
sets; a nonuniform working-set shape is `facts.unsupported-working-target-shape`, not normalized into
one target. Original immutable facts plus corrections determine the effective
projection. Training also supplies a bounded chronological history of prior terminal exercise
exposures, including all-skipped and corrected exposures with no surviving decision. The requested
window size is a closed `ruleVersion` parameter and is
included in `sourceFactsHash`; the infrastructure admission ceiling is 64 entries and has no
methodology meaning. Every history entry carries source session/revision, completion date,
effective performed/skip facts, target, and correction version/hash. Its decision source is
discriminated: `calibration-decision-v1` requires the exact active decision ID/sequence/rule/reason/
source-facts hash; `legacy-development-v1` carries only the archival active decision identity/
current columns that actually exist; and `no-current-decision` carries the closed reason
`zero-performed | legacy-invalidated-before-cutover | legacy-source-unverifiable |
source-release-revoked |
projection-blocked`, with exact correction/release or projection-failure provenance. No current
hash is fabricated for a legacy or
absent decision; the new compute's `sourceFactsHash` truthfully covers that shape plus the complete
current Training factual projection. Calibration derives scheduled-deload count, consecutive high-strain
count, and last-training distance from those facts; it never asks Training for an opaque counter or
peer-reads its ledger. Training's owner attestation states the requested window, ordered boundary,
and whether the result is complete or deliberately saturated at that window. A missing middle,
invalidated decision, stale fact hash, duplicate session, non-chronological history, or unproved
boundary is unverifiable and aborts the workflow. A pre-Stage-6 correction that invalidated a
legacy decision is therefore honest and usable rather than a permanent missing-middle error.
History does not affect the current-set estimate
formula and is excluded from `estimateSourceFactsHash`; it does affect the decision. Every computed
Training decision therefore persists ordered `adjustment_decision_history_source` rows, and every
computed Programs prescription persists ordered `exercise_prescription_history_source` rows, with
same-subject source session/revision/decision and effective-fact hash plus the discriminated current
decision hash or archival legacy shape. Corrections find
direct consumers through those owner relations before closing descendant revision/prescription
edges. All contributing history identities/hashes enter `sourceFactsHash`.
Every history entry also carries a closed scheduled-deload proof. A current
`calibration-decision-v1` supplies its exact reason and can affirm `not-deload`; the closed archival
`legacy-development-v1` policy can affirm `policy-had-no-deload`; every
`no-current-decision` shape, revoked/unknown policy, or invalidated decision is `breaks-window`.
Absence of a current deload code is never treated as affirmative proof that an invalidated decision
was not a deload. The scheduled window requires 11 contiguous prior qualifying entries with an
affirmative proof, so correction/revocation/projection-blocked gaps conservatively reset the count.
Vectors include correction of an earlier source whose later invalidated consumer was a deload.
Eligibility/availability comes only from the standalone Athletes safety attestation; Training does
not duplicate it here.

### 3.3 Phase and interruption facts

Current and immediately preceding phase code/intensity, their source prescription/revision, and
`asOfDate` are explicit inputs with their source/version. `asOfDate` and every completion date are
ISO calendar dates derived in the athlete's persisted IANA timezone; the timezone value and profile
source version/hash are normalized inputs. Layoff distance is the integer calendar-day difference
in that zone, independent of host timezone and daylight-saving offsets. Missing/invalid zone/date
owner facts are `profile-time.unverifiable` workflow failures with no mutation, never replaced with
UTC/server time or advertised as a self-service recovery. Last-training dates come only from
the effective history in section 3.2, not a wall clock or an unproven counter.
Programs persists the named development phase fixture, version, and intensity on each exercise
prescription; the initial and future-revision workflows carry it into normalized provenance.
Production rejects that development fixture until Gate 0 supplies a reviewed phase release. The
engine uses only the persisted phase facts; absence returns unavailable rather than inferring a
phase from A/B/C labels or elapsed time.

Each available prescription persists the exact temporal anchor: latest truthful performed working-
set exposure (qualifying or estimator-unsupported), otherwise the effective starting-working-load
attestation date. It also persists `temporalValidThroughDate`, the last athlete-local date before
the next layoff bucket can change: anchor +13 days before the first boundary, +27 days while in the
14-day bucket, and null only once the 28-day bucket has already been applied. A missing anchor is
unavailable, never an infinite-validity draft. Anchor kind/date and boundary are part of v3 output/
hash. Under the subject lock and before a
session snapshot, Training obtains the current instant from the application clock and Athletes'
current timezone projection, derives the local date, and rejects when it is after the persisted
boundary. The closed workflow result is `program.start-recalibration-required` with
`regenerate-program`; start never recomputes/publishes opportunistically. Regeneration uses the
current date/history under the same lock and creates the truthful revision. Vectors pin days
13/14/27/28 for never-trained starting anchors and first unsupported/qualifying exposures, plus both
start/regeneration orderings. Draft activation performs the same local-date
check before changing status; a crossed boundary returns
`program.activation-recalibration-required` with `regenerate-program`, so a knowingly stale draft
is never labeled active. Draft-generated-before-boundary/activation-after-boundary vectors cover
both thresholds.

### 3.4 Loadability facts

The first supported loadability model is a single barbell plus paired plate inventory:

- `barWeightGrams` — canonical integer grams in the engineering admission range
  `1_000..100_000`;
- `plates[]` — at most 16 unique denominations, each with integer `plateWeightGrams` in
  `100..100_000` and `pairCount` in `1..20`; and
- an immutable loadability-version ID, monotonically increasing athlete version, source hash, and
  confirmation timestamp.

Each `athlete_loadability_version` also records self actor ID, command ID, request hash, and nullable
previous-version ID. Unique command and `(user_id, sequence)` identities plus same-subject previous-
head constraints make append/replay deterministic. Its `athlete_loadability_plate` children are
covered by the request/source hash. Under the subject lock, Athletes classifies command ID and hash
before any mutable-state gate. Exact replay returns the prior version plus the Programs-owned
`program_load_input_outcome` recorded by the original workflow, even if session or program state
has since changed. Reuse with different input returns `loadability.command-conflict`; only a new
command may proceed to the active-session gate and mutation. Missing, duplicate, or inconsistent
outcome evidence fails closed without changing either owner, and concurrent appends cannot fork.
The effective inventory is the validated chain head, never the newest timestamp. Hostile/replay/
replay-after-state-change fixtures prove actor, command, hash, prior-head, sequence, child-set
integrity, and stable prior response.

An attainable total load is the bar plus twice the sum of selected plate weights, bounded by each
pair count and the existing one-million-gram absolute load domain. The engine uses binary-split
bounded subset sum over a packed 32-bit bitset for the half-load domain, precomputes the attainable
set once per unique inventory/hash in a compute batch, and chooses only from that finite set. With
16 denominations, at most 20 pairs each, and the 1,000,000-gram total domain, binary splitting
creates at most 80 bitset items and the 499,500 half-load ceiling requires at most 15,610 32-bit
words: no more than 1,248,800 word transitions per unique inventory before selection. The pure
engine exposes this operation count in test diagnostics; worst-case inventory x full-program
vectors enforce the bound and a generous non-normative wall-clock smoke budget prevents an
accidental local denial-of-service regression. Versions and their plate items are append-only; a decision, prescription, and
session snapshot retain the exact version/hash used. An update appends the next version and drives
a future-only program revision rather than changing the meaning of history. The model does not
assume a 2.5 kg/5 lb quantum, unlimited plates, or a standard bar. Existing profiles without these
additive facts receive `loadability.missing` until the required setup/update UI records them.

### 3.5 Safety-eligibility facts

Safety eligibility is a standalone Athletes-owned attestation, not a field hidden inside Training's
performed-work projection. Inside the subject lock/`UnitOfWork`, the owner contract emits a total
canonical `athlete-safety-eligibility-v1` projection containing the subject ID, adult/technique
attestations, restriction status, the sorted unresolved safety-hold IDs/reason/source identities,
closed `eligible | blocked` status, reason-specific recovery, and a canonical source-facts hash. A
genuinely absent profile/setup root is a hashable blocked owner result. A present profile is created
only after both attestations pass validation; a contradictory/malformed persisted profile is
`safety-attestation.unverifiable`, not an actionable "complete profile" state. The closed owner reasons are
`eligibility.profile-incomplete | eligibility.restriction | safety.session-pain-hold |
safety.unsupported-hold`. Deterministic precedence is profile incomplete, restriction/eligibility
hold, session-pain hold, then unsupported hold; all unresolved hold IDs remain sorted in the hashed
projection even when an earlier reason wins. Recovery is respectively `complete-profile |
no-self-service | resolve-session-pain-hold | no-self-service`. Eligible requires null reason/
recovery and no hold IDs; blocked requires exactly one closed reason/recovery pair, and the pain-
hold recovery requires at least one passed same-subject hold ID. Unknown/contradictory source
shapes are unverifiable rather than guessed.

Each emitted projection is backed by append-only Athletes tables
`athlete_safety_eligibility_attestation` and
`athlete_safety_eligibility_attestation_hold`. The parent stores ID, user ID, contract version,
source-facts hash, normalized adult/technique/restriction snapshot, status, reason, recovery, and
creation time; `(user_id, contract_version, source_facts_hash)` is idempotent. Ordered child rows
store every unresolved hold ID/reason/source-session identity with composite same-subject FKs,
unique ordinal, and no duplicate hold. Parent shape checks enforce eligible/null reason/null
recovery/no children and every closed blocked reason/recovery combination; deferred validation
requires a pain-hold recovery to have at least one matching child. Decisions, program revisions/
prescriptions, and workout-session start snapshots reference the exact attestation ID plus subject
through a composite FK; the owner port hydrates reason-specific hold details for UI rather than
copying opaque unverified IDs into peer tables. These rows are personal data and append-only history.

The live transitional ownership is explicit. Until Stage 9, the application asks Athletes for its
profile/hold-source projection and Training for resolution/source-session validity for only the
passed hold IDs, then passes both same-subject projections to an Athletes-owned pure attestation
builder. Athletes does not read `safety_hold_resolution` through a peer import. Stage 9 transfers
resolution persistence/read projection to Athletes; Training then supplies only source-session
terminal/durable-invalidation attestations required by the owner mutation API. The output contract
and hashes do not change across that transfer.

Every current-contract compute, publish, or executable-snapshot path obtains this attestation under the same lock:
initial generation, completion, training-fact correction, loadability update, starting-load
correction, draft replacement, draft activation, and workout start. Programs and Training persist
the exact same-subject attestation reference with the prescription/decision/session snapshot. Later activation rereads the
owner attestation and rejects a changed or blocked source instead of publishing stale availability.
Training's session facts may explain why a hold was raised, but they never replace the Athletes
attestation. A missing gateway response, stale version/hash, cross-user source, or incomplete
transitional projection is not a fabricated blocked attestation: it returns the closed
`safety-attestation.unverifiable` workflow error and commits no decision, prescription, or session
snapshot. A Training fact-correction or already-admitted athlete-input workflow is the deliberate exception:
after the factual append and complete dependency invalidation closure are proven, unverifiable
optional reprojection persists the correction/input plus its `projection-blocked` outcome but writes no
estimate that depends on the unverifiable source, decision, prescription, revision, or executable
snapshot. Athlete input is retained only when Programs atomically proves/quarantines all previously
startable future projections first; an unverifiable quarantine/closure still rejects the input.

This preserves, rather than expands, the current safety lifecycle: Calibration can return
unavailable from the passed attestation but cannot create, clear, or resolve a hold. Completion pain
handling, a post-completion fact correction that changes hold state, and Athletes hold resolution
all participate in the same subject lock before a future prescription publishes. Until Stage 9
retires Training's current direct hold write, the composed gateway attests the resulting owner
state; Stage 9 moves every mutation and resolution query behind the Athletes API. Hostile missing/stale/cross-user
attestations and both race orderings for pain correction/hold resolution versus each publisher prove
that no restricted or held subject receives an available newly published load.

### 3.6 Exercise-contract and category-equipment facts

Plate loadability is not exercise eligibility. Every initial/compute/publish/activation/start path
consumes one owner-composed `ExerciseEligibilitySource`. Exercises exposes the installed contract;
Athletes exposes the subject's exact category-equipment/advanced-eligibility projection; the
application passes both to an Exercises-owned pure builder. Neither owner reads the other's tables.
The normalized source records subject/exercise identity, the installed contract version/hash,
safety tier, sorted required equipment codes, athlete-equipment profile version/hash, closed
`eligible | blocked` status, reason, and recovery. It enters `sourceFactsHash` and the total decision,
and Programs persists the same exact source on v3 prescriptions before rechecking both owner ports.
Calibration treats the composed status as a gate and never interprets it as plate inventory.

Stage 4 installs the narrow development-only Exercises release
`exercise-development-contract-v1` for exactly `development.back-squat`,
`development.bench-press`, `development.barbell-row`, `development.deadlift`, and
`development.overhead-press`, with the exact current development-fixture names, `standard` safety
tier, and required category-equipment lists moved from Methodology's private fixture into the
Exercises owner projection. Methodology templates reference those opaque IDs; they no longer own or
duplicate exercise taxonomy. Reviewed/production content rejects this development contract, and a
future reviewed catalog replaces it rather than relabeling it. This narrow seam does not claim the
broader reviewed/licensed Exercises catalog is complete.

Athletes adds append-only `athlete_category_equipment_version` and ordered
`athlete_category_equipment_version_item`. The upgrade writes version 1 from the canonical sorted
legacy `athlete_equipment` rows and hash inside the subject generation; new setup writes the same
versioned shape directly. Composite subject/version/item constraints make the projection and hash
reconstructable. Rebuild after deletion is distinguished by subject-generation commitment even
when the sorted equipment codes match. Broader profile editing remains deferred, but it must append
a later version rather than mutate this source. The same Stage 4 checkpoint switches every
setup/read/export/delete/reset consumer to the version tables, verifies fixed legacy projection/hash
vectors, then drops `athlete_equipment`; there is no unconstrained dual-write or second current
truth. Its replacement tables enter the manifest/portability inventory atomically.

The Exercises release is a code-installed registry, not a third independently revocable content
release in this arc. `exercise.uninstalled` means the pinned code is absent from the currently
installed registry/version. Methodology/template releases keep the existing content-revocation
locks; reviewed/production mode rejects the development registry. Activation/start compare the v3
registry version/hash to the installed projection, and an application upgrade changing it requires
Regenerate. No fictional `content_release_revocation` row or new lock kind is added for Exercises.
A well-formed installed registry whose version/hash differs from the saved v3 source returns the
workflow result `program.exercise-contract-regeneration-required` with `regenerate-program`; it is
not an integrity failure and does not start/activate stale work. If Regenerate finds the exercise
still installed, it emits a replacement against the new source; if removed, the replacement is
truthfully blocked `exercise.uninstalled`. `exercise-eligibility.unverifiable` remains reserved for
malformed/missing owner proof. Vectors distinguish unchanged exercise/new registry hash, removed
exercise, malformed registry, and successful replacement.

The closed blocked reasons are `exercise.uninstalled`, `exercise.prohibited`,
`exercise.advanced-ineligible`, and `equipment.category-missing`, all with truthful deterministic
copy and `no-self-service` in this arc because profile revision/advanced eligibility are deferred.
Unknown, stale, malformed, or cross-user owner projections are
`exercise-eligibility.unverifiable` workflow failures with no decision/publish/start mutation. Valid
bar/plate inventory cannot bypass a missing rack/bench or an ineligible exercise. Regression vectors
cover every reason and unverifiable shape at generation, compute, activation, start, v3
reconstruction, export, and release revocation.

---

## 4. Total compute result

The persisted decision projection is fully discriminated:

```ts
type PersistedEstimateSource =
  | { readonly kind: 'not-consumed' }
  | {
      readonly kind: 'consumed'
      readonly estimateId: string
      readonly estimateSourceFactsHash: string
    }

type LoadabilitySource =
  | { readonly kind: 'absent' | 'not-reached' }
  | {
      readonly kind: 'consumed'
      readonly loadabilityVersionId: string
      readonly loadabilitySourceHash: string
    }

type PhaseSource =
  | { readonly kind: 'absent' | 'not-reached' }
  | {
      readonly kind: 'consumed'
      readonly currentPhaseRelease: 'calibration-development-phase-v1'
      readonly currentPhaseCode: string
      readonly currentIntensityBasisPoints: number
      readonly developmentPhaseSequenceId: string
      readonly plannedExerciseOccurrenceOrdinal: number
      readonly source:
        | {
            readonly kind: 'methodology-plan'
            readonly methodologyId: string
            readonly methodologyVersion: string
            readonly planSourceHash: string
          }
        | {
            readonly kind: 'program-prescription'
            readonly currentExercisePrescriptionId: string
          }
      readonly previous:
        | { readonly kind: 'absent' }
        | {
            readonly kind: 'consumed'
            readonly exercisePrescriptionId: string
            readonly phaseRelease: 'calibration-development-phase-v1'
            readonly phaseCode: string
            readonly intensityBasisPoints: number
            readonly developmentPhaseSequenceId: string
            readonly plannedExerciseOccurrenceOrdinal: number
            readonly phaseSourceHash: string
          }
      readonly phaseSourceHash: string
    }

type EvidenceCurrentLoadSource =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'consumed'
      readonly currentLoadGrams: number
      readonly source:
        | { readonly kind: 'starting-working-load'; readonly sourceId: string; readonly sourceHash: string }
        | {
            readonly kind: 'session-target'
            readonly exercisePrescriptionId: string
            readonly orderedWorkingSetPrescriptionIds: readonly string[]
            readonly sourceHash: string
          }
    }

type ProjectionAnchorSource =
  | { readonly kind: 'not-reached' }
  | {
      readonly kind: 'consumed'
      readonly anchorLoadGrams: number
      readonly source:
        | {
            readonly kind: 'evidence-current-load'
            readonly calibrationBasisId: string
            readonly evidenceCurrentLoadSourceHash: string
          }
        | {
            readonly kind: 'preceding-logical-occurrence'
            readonly exercisePrescriptionId: string
            readonly developmentPhaseSequenceId: string
            readonly plannedExerciseOccurrenceOrdinal: number
            readonly prescriptionOutputHash: string
          }
    }
  | {
      readonly kind: 'blocked-predecessor'
      readonly exercisePrescriptionId: string
      readonly developmentPhaseSequenceId: string
      readonly plannedExerciseOccurrenceOrdinal: number
      readonly reasonCode: 'projection.predecessor-blocked'
      readonly predecessorReasonCode: CalibrationReasonCode
      readonly predecessorRecoveryCode: CalibrationRecoveryCode
      readonly predecessorPrescriptionOutputHash: string
    }

type TimeSource =
  | { readonly kind: 'not-reached' }
  | {
      readonly kind: 'consumed'
      readonly subjectUserId: string
      readonly timezone: string
      readonly profileSourceHash: string
      readonly asOfDate: string
    }

type HistorySource =
  | { readonly kind: 'not-reached' }
  | {
      readonly kind: 'consumed'
      readonly requestedWindowSize: number
      readonly boundary: 'complete' | 'saturated'
      readonly historySourceHash: string
    }

type SafetyEligibilitySource =
  | {
      readonly kind: 'consumed'
      readonly attestationId: string
      readonly subjectUserId: string
      readonly contractVersion: 'athlete-safety-eligibility-v1'
      readonly sourceFactsHash: string
      readonly status: 'eligible'
      readonly reasonCode: null
      readonly recoveryCode: null
    }
  | {
      readonly kind: 'consumed'
      readonly attestationId: string
      readonly subjectUserId: string
      readonly contractVersion: 'athlete-safety-eligibility-v1'
      readonly sourceFactsHash: string
      readonly status: 'blocked'
      readonly reasonCode: SafetyEligibilityReasonCode
      readonly recoveryCode: SafetyEligibilityRecoveryCode
    }

type ExerciseEligibilitySource =
  | { readonly kind: 'not-reached' }
  | {
      readonly kind: 'consumed'
      readonly subjectUserId: string
      readonly exerciseCode: string
      readonly registryVersion: 'exercise-development-contract-v1'
      readonly registrySourceHash: string
      readonly contract:
        | { readonly kind: 'absent' }
        | {
            readonly kind: 'installed'
            readonly contractSourceHash: string
            readonly safetyTier: 'standard' | 'advanced' | 'prohibited'
            readonly requiredEquipmentCodes: readonly string[]
          }
      readonly athleteEquipment:
        | { readonly kind: 'not-reached' }
        | {
            readonly kind: 'consumed'
            readonly profileVersion: number
            readonly profileSourceHash: string
            readonly equipmentCodes: readonly string[]
          }
      readonly status: 'eligible'
      readonly reasonCode: null
      readonly recoveryCode: null
    }
  | {
      readonly kind: 'consumed'
      readonly subjectUserId: string
      readonly exerciseCode: string
      readonly registryVersion: 'exercise-development-contract-v1'
      readonly registrySourceHash: string
      readonly contract:
        | { readonly kind: 'absent' }
        | {
            readonly kind: 'installed'
            readonly contractSourceHash: string
            readonly safetyTier: 'standard' | 'advanced' | 'prohibited'
            readonly requiredEquipmentCodes: readonly string[]
          }
      readonly athleteEquipment:
        | { readonly kind: 'not-reached' }
        | {
            readonly kind: 'consumed'
            readonly profileVersion: number
            readonly profileSourceHash: string
            readonly equipmentCodes: readonly string[]
          }
      readonly status: 'blocked'
      readonly reasonCode: ExerciseEligibilityReasonCode
      readonly recoveryCode: 'no-self-service'
    }

type PersistedCalibrationDecision =
  | {
      readonly status: 'available'
      readonly direction: 'increase' | 'hold' | 'decrease'
      readonly evidenceCurrentLoadSource: Extract<
        EvidenceCurrentLoadSource,
        { readonly kind: 'consumed' }
      >
      readonly projectionAnchorSource: Extract<ProjectionAnchorSource, { readonly kind: 'consumed' }>
      readonly nextLoadGrams: number
      readonly reasonCode: CalibrationReasonCode
      readonly ruleVersion: CalibrationRuleVersion
      readonly sourceFactsHash: string
      readonly estimateSource: PersistedEstimateSource
      readonly phaseSource: Extract<PhaseSource, { readonly kind: 'consumed' }>
      readonly timeSource: Extract<TimeSource, { readonly kind: 'consumed' }>
      readonly historySource: HistorySource
      readonly loadabilitySource: Extract<LoadabilitySource, { readonly kind: 'consumed' }>
      readonly safetyEligibilitySource: Extract<
        SafetyEligibilitySource,
        { readonly status: 'eligible' }
      >
      readonly exerciseEligibilitySource: Extract<
        ExerciseEligibilitySource,
        { readonly status: 'eligible' }
      >
    }
  | {
      readonly status: 'unavailable'
      readonly direction: 'unavailable'
      readonly evidenceCurrentLoadSource: EvidenceCurrentLoadSource
      readonly projectionAnchorSource: ProjectionAnchorSource
      readonly nextLoadGrams: null
      readonly reasonCode: CalibrationReasonCode
      readonly ruleVersion: CalibrationRuleVersion
      readonly sourceFactsHash: string
      readonly estimateSource: PersistedEstimateSource
      readonly phaseSource: PhaseSource
      readonly timeSource: TimeSource
      readonly historySource: HistorySource
      readonly loadabilitySource: LoadabilitySource
      readonly safetyEligibilitySource: SafetyEligibilitySource
      readonly exerciseEligibilitySource: ExerciseEligibilitySource
    }
```

`CalibrationReasonCode`, `CalibrationRecoveryCode`, and `CalibrationRuleVersion` are closed,
versioned catalogs, not arbitrary
strings. Each reason maps to deterministic display copy, evidence/development labeling, and a typed
recovery action or explicit `none`. The pure engine trace uses
`not-consumed | existing-estimate { id, hash } | new-candidate { factsHash, values }`; it never
fabricates a database identity. The `UnitOfWork` persists a valid new candidate first, resolves that
trace to persisted `consumed { estimateId, estimateSourceFactsHash }`, and only then writes the
decision/Programs provenance. Estimate derivation is orthogonal to decision availability.
Qualifying effective work persists a valid candidate even when missing loadability, phase, or a
later safety projection makes the prescription unavailable. Estimation-invalid and truthful-
unsupported evidence both yield no candidate, but only the former is an editable unavailable fact;
unsupported evidence follows the conservative ceiling branch. The candidate never weakens the decision discriminant. `deload` and `layoff`
are reason-code families on a truthful `decrease`, not additional directions and not disguised
`hold` decisions. Unknown persisted directions, versions, or reasons fail closed in application
and explanation consumers.

Persisted Training decisions and Programs initial/non-session provenance use explicit source-kind
columns plus nullable ID/hash columns and ordered history-source child rows whose database union
checks match the types above. `not-consumed`, `absent`, and `not-reached` require null source
fields/children; `consumed` requires every field and same-subject owner reference. Reason-shape
checks allow absent load only for a winning pre-anchor safety reason or `anchor.missing`;
when a truthful source exists it is retained. The evidence-current-load source is only the starting
attestation or exact terminal-session target and is frozen into the basis; a future prescription can
never become new progression evidence. Projection anchoring is occurrence-stable: within the
remaining-work projection for one exercise, the first remaining logical occurrence uses
`evidence-current-load`; every later occurrence uses only the newly recomputed immediately preceding
occurrence in the same result revision and phase sequence. Its ordinal is exactly one lower. A
replacement may never point to an older version of its own ordinal or skip an occurrence. If that
predecessor is blocked/no-load, the dependent occurrence carries `blocked-predecessor` with the
exact predecessor prescription ID/output hash and original reason/recovery and cannot be available.
The dependent decision reason must equal `projection.predecessor-blocked`; its catalog-derived
recovery must equal `predecessorRecoveryCode`, and all predecessor fields are checked against the
referenced output row/hash rather than caller text.
Every recomputed occurrence for that exercise/result binds the same current basis/evidence target;
consumed and blocked-predecessor FKs prove both rows' basis ID/hash agree. Same-subject/exercise/
revision/sequence/basis composite FKs, increasing ordinals, and deferred complete-coverage checks
make the graph acyclic and reject self/same-ordinal/old-revision/cross-basis anchors. A session target includes the source exercise plus
all working-set IDs in ordinal order; database/owner proof requires a nonempty uniform target and
the hash covers that full ordered set, so no reader chooses an arbitrary representative ID. A consulted
estimate, phase, profile/time, history, or loadability source therefore cannot be erased by
writing null, even when a later gate makes the result unavailable. Available decisions require
consumed evidence-current-load, projection anchor, phase, time, and loadability. Bootstrap may truthfully use `historySource: not-reached` while
post-session/history-sensitive branches consume its complete boundary relation. Safety and
exercise eligibility are required for every current-contract computation. A
truthful consumed `blocked` attestation produces unavailable; an unverifiable gateway projection
produces a typed no-mutation workflow failure and no persisted decision.

Every new Programs result revision topologically reconstructs the complete occurrence chain for each
exercise. An `inherited` occurrence is still a newly persisted current-result row: it retains its
exact parent prescription/availability/load provenance but rebinds its projection anchor to the newly
persisted immediate predecessor in this revision and rehashes the current tuple. It may never point
back to the parent's same ordinal or predecessor row. A changed predecessor forces ordered downstream
reconstruction/reprojection; unchanged derived loads may remain truthfully `inherited`. Mixed
computed/inherited vectors reject old-revision and same-ordinal bridges.

Exercise-source shape is exact: an earlier winning safety gate uses `not-reached`;
`exercise.uninstalled` consumes the registry but requires `contract: absent` and equipment
`not-reached`; prohibited/advanced consume an installed contract and leave category equipment
`not-reached`; category-missing and eligible both consume the exact athlete equipment projection.
Only eligible requires standard tier and complete required-category inclusion. Database union checks
and hostile vectors reject every fabricated/missing field combination, including profile-incomplete
plus uninstalled.

Phase-source constraints bind sequence/positive occurrence to the exact prescription/plan hash.
Inherited and recomputed copies of one logical planned occurrence must retain both values; safety-
recovery continuation roots require the Programs continuation source. New sequence IDs are legal
only for a true no-remaining-work generation root. Hostile reset/fork/ordinal/source-hash fixtures
fail at persistence and v3 reconstruction.

#### Compute mode and immutable evidence basis

Every computation names one closed mode:

- `initial-bootstrap` evaluates one effective starting-working-load attestation;
- `session-evaluation` evaluates one newly terminal session/exercise fact projection exactly once;
- `correction-replay` evaluates the effective fact/history state created by one accepted correction
  and its complete dependency closure exactly once when the correction changes basis inputs or when
  that historical boundary has no current-contract basis. Once a current basis exists, a safety-only
  session-feedback correction preserves and reuses it under `no-new-evidence-reprojection`; or
- `legacy-cutover-evaluation` evaluates one pre-Stage-4 terminal effective-history boundary that has
  never received a current-contract basis, under a same-UoW Programs cutover receipt exactly once;
  or
- `no-new-evidence-reprojection` reuses an existing immutable evidence basis while reapplying only
  the current phase, logical projection anchor, time, safety, exercise-eligibility, content, and
  loadability gates.

Calibration persists append-only `calibration_compute_basis` rows keyed idempotently by subject,
exercise, rule release, mode-specific evidence identity, evidence-current-load source/hash, and
normalized evidence-input hash. A basis stores the phase-independent evidence-advance targets and
branch trace (starting/unsupported ceiling, one predictable progression step, adaptive override,
scheduled/triggered deload), the immutable absolute/session safe interval derived from the evidence-
current load, estimate trace, and exact evidence
boundary. An append-only `calibration_compute_basis_invalidation` names the exact correction and
invalid basis; direct performed/history dependencies and descendant basis/prescription
consumers are closed with the other owner invalidations. No-new-evidence reprojection reattests basis
currency under the lock and can never consume an invalidated row.
The basis hash excludes phase, time, safety, Exercises eligibility, loadability, content release,
and the logical projection anchor. The total decision/source-facts hash includes the selected basis
ID/hash plus every one of those exact projection sources, so phase or projection changes are visible
without masquerading as new evidence.
`legacy-cutover-evaluation` additionally requires a same-subject
`program_legacy_calibration_cutover_basis_result` ID and closed `pre-stage-4-history` source
discriminant. Programs appends its parent receipt/ordered child in the same UoW as the basis;
deferred composite FKs make basis and child name each other. Unique subject/exercise/evidence-current-load/
rule/effective-history-boundary identity prevents a second cutover basis
through another input or root command. The union is null for every other mode; there is no free-
standing or caller-forgeable “migration receipt.”

Phase is deliberately **not** a basis prerequisite or key. Programs supplies exact current/previous
phase source and planned occurrence for each projection; Calibration combines that phase target with
the frozen one-step evidence trace without re-running progression/adaptive/deload. A missing or
unverifiable phase therefore blocks only projection and cannot erase the valid evidence basis.
There is no `calibration_pending_compute_basis` in v1: no other typed-missing prerequisite has a
defined materialization contract, and persisting a generic partial row would fabricate authority.
A complete basis is total over verifiable evidence and may itself record an unavailable anchor/
history result; “unavailable” is not the same as “unevaluated.” Every recomputed/published v3
occurrence therefore binds a complete current basis even when a later safety/exercise/phase/
loadability gate wins. Only a truly unverifiable evidence owner prevents basis creation.
A truly unverifiable evidence/evidence-current-load owner response creates no basis; the already-authorized
factual outcome stores the projection failure, continuation, and closed deferred evidence-evaluation
mode only. The first successful recovery evaluates that mode exactly once against the receipt-bound
current authoritative boundary, persists its complete basis, and then projects. A pre-Stage-4
subject with qualifying terminal history but no basis uses `legacy-cutover-evaluation` unless a
newly accepted correction supplies `correction-replay` authority first; neither path can fall back to
the starting attestation. Database constraints forbid `no-new-evidence-reprojection`
without a current complete basis and forbid orphan, duplicate, cross-subject, or fabricated sources.

Inventory edits, phase/new-cycle projection, safety-hold recovery, activation-time regeneration,
and repeated Regenerate requests are no-new-evidence reprojections **when a current complete basis
exists**. The sole exception is the first recovery of an outcome that persisted no basis: it uses
that outcome's deferred evidence mode (including legacy cutover), creates one receipt-bound basis,
and projects in the same UoW; only later retries are no-new-evidence. They must not feed the prior emitted load back through
progression/adaptive logic, advance the evidence boundary, or create a second candidate estimate.
Reprojection never advances an existing logical phase occurrence. A true no-remaining-work root
allocates its new phase sequence/ordinals exactly once in Programs before projecting them; exact
command replay reuses those identities. A session completion and a correction each create at most one new
mode-specific basis **per affected evidence identity**; a correction cascade can therefore replay
S1, S2, and S3 chronologically from each session's frozen evidence-current-load/logical projection
anchor/date/history viewpoint, then
use only the final replay state for the one current Programs projection. Exact command replay
returns its original ordered basis/result set. The Programs normalized-
input/output hash records basis ID/hash and compute mode, and its dedupe compares them before mutable
state. Repeated inventory changes, hold recovery, all-skipped inheritance, a blocked-then-repaired
projection, correction-blocked-before-basis followed by later state change, and concurrent
Regenerate/correction vectors prove that one factual exposure can advance the development fixture
at most once and that a stale invalidated basis cannot republish through another root. Legacy
performed-history + first inventory, exact retry, and two concurrent first Regenerates produce one
receipt-bound cutover basis; correction-first creates a correction-replay basis with no fabricated
cutover receipt, while correction-after-cutover closes/replaces the existing basis as causally
required. Neither path silently reuses the starting load.

Basis currency is an owner-composed exact-key protocol, not “noninvalidated means current.” Training
attests the boundary-proved latest effective evidence-bearing session/exercise plus its final ordered
**basis-affecting** performed-set correction head (or exact absence and the effective starting-
attestation head). For `correction-replay` over a previously unbased historical boundary, Training
also attests the exact accepted correction as the one first-basis authority even when it is safety-
only feedback; that mode-specific identity is provenance, not fabricated changed evidence. The
separate projection-correction head, including later session feedback, enters the total decision hash
but not the basis key. Programs
attests the evidence-current-load source required by the target and the current nonquarantined
planning scope. Calibration selects only a basis whose subject, exercise, rule, evidence/correction
boundary, starting/evidence-current-load source, and hashes match. A later terminal exposure, effective
starting correction before performed evidence, relevant correction/history replay, changed original
evidence-current-load source, or source-rule revocation invalidates/supersedes every mismatching basis. Phase/
continuation row identity, projection anchor, time, safety, Exercises eligibility, and loadability do not, because they
are projection inputs. Programs persists the exact basis ID/hash **and** exact phase source/sequence/
occurrence plus projection-anchor source on each resulting prescription; reconstruction reprojects
that tuple and compares the
stored output. Row/status replacement therefore cannot self-stale the basis, while changed phase
truth produces a newly hashed projection without advancing evidence. Unique/deferred constraints
prevent two current rows for one exact evidence key. Missing/partial/cross-user owner attestations
fail closed. Vectors cover a blocked projection followed by newer evidence, correction on another
history dependency, preserved-occurrence and new-cycle phase changes, inventory update → immediate
start → second inventory update, and later Regenerate selecting only the newest applicable basis.

`adjustment_decision` is an append-only per-session/exercise sequence, not a unique singleton.
Stage 4 seeds every legacy row at sequence 1 with null previous/source-correction, then replaces the
old `(session_id, exercise_code)` uniqueness with consecutive sequence, same-session/exercise
previous-decision, and deferred one-noninvalidated-head constraints. The correction source is
discriminated: `performed-set` names one exact session/exercise/set, while `session-feedback` names
the session-level feedback row and no fabricated exercise. A replacement adds
`correctionCauseKind: direct-performed-set | direct-session-feedback | history-replay` plus a
same-subject `sourceCorrectionId`. `direct-performed-set` requires the corrected session/exercise;
`direct-session-feedback` names a same-session exercise whose decision or safety-dependent
projection consumed that feedback; `history-replay` may name a later session only
when its persisted history-source relation proves dependence on the corrected source or a decision
invalidated earlier in that same cascade. Completion appends the first current decision only when
the required performed **working-set** input exists.

The performed-set zero-decision transitions are explicit: skipped→performed on a session/exercise that never had
a decision appends sequence 1 with null previous decision and direct correction cause; performed→
skipped invalidates the current head and appends none; performed→performed appends after invalidating
its predecessor. Existing corrections that predate cutover are
`legacy-invalidated-before-cutover` and never receive invented output. Forks, gaps, two active
heads, wrong cause/dependency, cross-user source, or a replacement pointing to a non-head fail in
deferred database proof.

The correction workflow separates personal factual truth from optional reprojection. After
authorization, epoch/authority/generation, command conflict, source-set identity, and correction-
shape checks pass, Training first proves the complete direct/history/decision/session dependency
set with every owner. Missing, partial, or cross-user discovery is
`correction.dependency-closure-unverifiable` and rejects before the factual append. Otherwise the
same UoW appends the correction and closes decision, revision, inherited-prescription, and
executable-session dependencies before any reprojection. It closes compute bases/estimates only
when the correction changed their declared inputs; safety-only session feedback preserves both.

Estimate invalidation follows estimation evidence, not broad session/revision coincidence. Training
returns the exact old/new normalized estimate-source hashes and changed source-fact IDs. Calibration
invalidates a v1 estimate only when those performed load/repetition inputs changed or became
unverifiable, or when a declared anchor dependency was invalidated. RPE-only, feedback-only, safety-
only, and Programs future-revision invalidations do not erase a performed-facts-only estimate. A
later v1 estimate derived independently from S2 remains valid when S1's future revision is
invalidated. Decisions and prescriptions still close over changed RPE/safety/history sources.

Training then replays every affected terminal decision chronologically from its complete frozen
historical occurrence tuple: evidence-current-load and logical projection anchor, athlete-local date +
timezone/profile source, phase, loadability, Exercises registry/category, safety attestation,
methodology/template/rule releases, and corrected effective history. Replay replaces only the
source causally changed by the correction (including safety for session feedback); it never reads
today's unrelated inventory, contract, profile, phase, or content into an old decision. It appends a
phase-independent replacement basis when basis inputs changed **or** when this is the first accepted
correction over a historical boundary with no current-contract basis, then applies that historical
occurrence's exact persisted projection tuple; it never advances progression again while projecting
phase. Once a basis exists, safety-only session feedback reuses the exact same basis ID/hash while
changing only safety/output provenance. Current exact-version revocation remains the independent
gate that can suppress a replacement decision/publication without rewriting the frozen historical
source.
It appends a
`direct-performed-set` replacement/no-current marker for the corrected exposure,
`direct-session-feedback` markers for every affected same-session exercise, and `history-replay`
replacements/no-current markers for later consumers. Only after this ordered ledger is current does
Programs project the **final** state once: active remaining work has priority and retires a
collateral draft; otherwise a future-bearing draft is replaced; otherwise the result is
`no-future-work`. A skipped→performed correction performs this projection even when no old decision
consumer existed. A performed→skipped correction chooses a basis outside the invalid closure. The
historical D1 replacement never masquerades as the current S2-based revision. Replay-only decision
rows have null `appliedRevisionId`; only the final current projection outcome names the sole
same-subject Programs revision with `training-fact-correction` cause. Deferred proof binds every
replay decision to the source correction through its persisted history dependency.
Only this sole final Programs projection uses current owner phase/time/loadability/Exercises/safety/
content sources. Correction-after-inventory, Exercises/category, timezone/profile, and content-change
vectors prove historical replacements stay frozen while the final future projection is current.

If a descendant workout session is already initializing/active/paused, correction still saves the
fact and complete closure, appends an immutable `workout_session_execution_invalidation`, and
publishes nothing. Further mutation/resume/completion of that descendant fails closed; UI requires
abandoning the invalidated session and then Regenerate. Abandonment concludes that attempted workout:
performed/skipped sets are historical facts and its prescriptions are never silently issued again.
Recovery begins at the first unstarted later planned workout, if one exists. Correction-first may
publish before a later start; start-first returns this deferred result. Both lock orders are
mandatory proof.

`workout_session_execution_invalidation` is an append-only Training cause ledger, not a mutable
one-row session flag. Each row stores ID, subject, initializing/active/paused session, its exact
source revision, the accepted Training correction and correction-outcome ID, the pre-invalidation
session status/optimistic version, the correction/effective-fact hash, creation time, and a canonical
row hash. A same-subject deferred FK and unique `(session_id, source_correction_id)` identity give
exact replay one row while allowing a later accepted correction to append another cause against the
same still-blocked session. Existence of any valid row blocks resume/mutation/completion; abandonment
is the only executable-session transition and does not mutate or delete causes. The correction
outcome and Programs active-session outcome each bind the newly preallocated same-UoW invalidation
ID/hash. Deferrable proof rejects a cause for a terminal session, wrong correction/revision/outcome,
missing newest cause, duplicate replay, or a session that was not a descendant of the invalidated
planning source.

The durable Training-owned `training_fact_correction_outcome` has exactly one checked parent per
accepted `calibration-correction-v1` correction after the atomic Stage 6 cutover, one preallocated
same-UoW Programs projection-outcome ID, and ordered
`training_fact_correction_decision_result` children for every direct
exposure/feedback consumer and replayed later consumer. Performed-set correction requires exactly
one direct child for its exercise; session-feedback requires the complete set of affected same-
session exercise consumers and permits zero only when Training attests that no session decision or
future safety projection consumed that feedback. Children order by completion date, session
identity, source exercise ordinal, exercise code, then decision sequence. Each child names source
session/exercise, prior decision when present,
`direct-performed-set | direct-session-feedback | history-replay`, frozen/persisted basis or
deferred evidence mode, and
exactly one `replacement-decision | no-current-decision` result; an estimate ID appears only when
that evaluation created a qualifying candidate.

Programs owns the corresponding append-only `program_training_correction_projection_outcome` and
ordered `program_training_correction_projection_basis_result`. The parent names the exact Training
correction/outcome, the optional consumed planning-source quarantine ID/hash, and has one closed
result:

- `revision-created`, requiring the sole Programs correction revision, zero deferred historical
  Training results, and no carried session-invalidation ancestry;
- `no-future-work`, forbidding a revision and requiring zero deferred historical Training results,
  zero carried session-invalidation ancestry, and no unresolved quarantine head;
- `no-republication`, naming the exact revoked release, forbidding a revision, and requiring the
  generalized quarantine;
- `projection-blocked`, naming a closed owner-source reason/recovery,
  `correction.historical-replay-deferred | regenerate-program`, or
  `projection.active-session-recovery-pending | regenerate-program`, and requiring the quarantine;
  or
- `projection-deferred-active-session`, naming the invalidated descendant session, the newly
  appended execution-invalidation ID/hash and complete blocking-invalidation-set hash, recovery
  `abandon-invalidated-session-then-regenerate`, and requiring a quarantine with a nonempty exact
  execution-invalidation cause set.

Planning scope is classified before optional publication gates. With no initializing/active/paused
invalidated descendant, no unresolved quarantine head, no remaining work, and zero deferred
historical children, the result is
`no-future-work` even when content is revoked or a projection owner is unavailable—there is no
publication to block. Otherwise the result winner is total: an invalidated active descendant wins
first as `projection-deferred-active-session`; exact content revocation wins next as
`no-republication`; then a current owner-source projection block wins; carried execution-invalidation
ancestry after abandonment is `projection.active-session-recovery-pending`; and
`correction.historical-replay-deferred` is used when deferred replay is the remaining block. A head
with session-invalidation ancestry therefore never takes the earlier final no-future arm. The
active-session arm may carry deferred Training children, and its quarantine correction-child set must
equal them. Abandonment clears only the executable-session blocker, not replay debt: the subsequent
Regenerate materializes every carried Training recovery before current projection. Its quarantine
occurrences cover only unstarted planned workouts **after** the invalidated session's planned-workout
ordinal. The invalidated workout itself is concluded by abandonment and is never re-prescribed,
whether it had zero, some, or all sets recorded before completion. A last-workout correction can
therefore have zero continuation occurrences without losing the separate execution-invalidation
cause set. Exact correction replay still returns the original combined outcome after abandonment.

Its occurrence basis-result children use the same complete ordered `current-basis | deferred-mode`
shape and projection-anchor/phase provenance as input outcomes; `revision-created` requires current
basis throughout. Training outcome ↔ Programs projection outcome is one-to-one via deferred same-
subject/correction FKs, so Training owns historical replay while Programs alone owns the current
planning attempt/continuation. Deferred constraints prove source-kind-specific complete ordered
coverage and the revision/decision/estimate/basis-or-deferred/quarantine discriminants.
`revision-created` and `no-future-work` forbid deferred Training children and carried session-
invalidation ancestry. Higher-precedence
`no-republication`, owner-blocked, and active-session results may carry them only through the exact
quarantine correction ancestry described below. A factual
correction with no remaining program scope but deferred historical replay is `projection-blocked`
with reason `correction.historical-replay-deferred`, recovery `regenerate-program`, and the zero-
occurrence quarantine/recovery debt described below; it may not pretend to be final
`no-future-work`. Hostile
partial/orphan/duplicate rows fail. Revoked or owner-blocked projection cannot roll back a proven factual correction, but no stale
descendant remains executable and no decision/estimate derived from an unverifiable or revoked rule
is fabricated. Exact command replay returns the original full outcome/result set before later
mutable gates; mismatched reuse conflicts. Only authentication/authority/generation, malformed
request/fact union, wrong source ownership, corrupt existing correction lineage, or
`correction.dependency-closure-unverifiable` rejects the factual append itself.
An exact same-value/effective-state new command is a typed `correction.no-op` rejection and claims no
command or correction identity; exact command replay remains distinct and returns the earlier
result. Session-feedback corrections in the current ledger change the safety projection and
therefore use the session-level direct/replay union rather than a fictitious “no impact” shortcut.
Multi-exercise feedback correction, zero-decision safety reproject, exact replay, and concurrent
later-session vectors pin its coverage/order.

Deferred historical replay is recoverable, not a permanent hole in the correction chronology.
Training owns success-only append-only `training_fact_correction_recovery_receipt` and ordered
`training_fact_correction_recovery_decision_result` rows. The parent stores user, original
`training_fact_correction_outcome`, the successful Programs regeneration receipt, and a canonical
result-set hash. It is legal only when the original outcome has at least one `deferred-mode` child
and is unique by subject/original outcome, so that immutable deferred set materializes once. Each
ordered child names exactly one original deferred `training_fact_correction_decision_result`, its
original ordinal/mode and frozen historical occurrence tuple, and exactly one
`replacement-decision { decisionId, basisId, basisHash, estimateId? } | no-current-decision {
cause: zero-performed | legacy-invalidated-before-cutover | legacy-source-unverifiable,
provenance }` result. Source-release revocation and an unresolved owner projection block cannot be
recorded as successful recovery. Deferred constraints require complete, nonduplicate coverage of the original
outcome's deferred subset in its existing chronological/dependency order. On the original correction
attempt, `deferred-mode` propagates through the full affected history/basis descendant closure: a
child may be current only when it proves it has no deferred ancestor, while an empirically independent
branch may remain current. Hostile S1-deferred → dependent-S2-current rows fail, while an independent
sibling remaining current passes.

Programs owns ordered `program_regeneration_receipt_correction_recovery` rows for every unresolved
deferred correction carried through the generalized quarantine ancestry. Each join and its Training
recovery parent name each other through deferred same-subject composite FKs; one Programs receipt may
therefore carry zero or more Training recoveries, while each recovery belongs to exactly one
successful receipt. The Programs normalized-input hash includes their ordered IDs/result-set hashes,
and the continuation root/quarantine resolution cannot commit until ancestry coverage is complete.
Under the subject lock, recovery evaluates deferred correction outcomes oldest first and each child
in global dependency-DAG order, with the existing deterministic chronology as the tie-break, then
performs the sole final current Programs projection. A downstream child freezes its factual/time/
phase/content tuple but stores an unresolved ancestor edge rather than a fictional old `no-current`
placeholder; recovery must consume and hash the newly materialized earlier decision/basis. The two-
correction vector proves C2 consumes recovered C1.
Any missing/unverifiable owner source or current publication block rolls back every Training
recovery, Programs receipt/revision/resolution, and command claim. The original blocked correction
outcome remains immutable; exact recovery-command replay returns the same Programs and Training
receipts. Vectors cover transient owner failure followed by S1/S2/S3 replay restoring the immediate-
replay history/deload result; feedback-first legacy recovery and feedback-only basis reuse;
performed-to-skipped no-current; input transfer and two deferred corrections carried into one
receipt; later evidence before recovery; exact/mismatched and concurrent recovery; cross-user/
orphan/partial/duplicate children; and failure injection between Training recovery and Programs root.

---

## 5. Deterministic rule pipeline

The exact numeric values are development configuration until Gate 0. Computation has two explicit
halves so a dynamic gate cannot erase or accidentally replay the evidence evaluation:

1. validate every passed owner projection/provenance shape; unverifiable evidence aborts;
2. resolve the frozen anchor/evidence-current-load/evidence identity without reinterpreting its kind;
3. derive/update an estimate from qualifying performed work when possible;
4. compute or reuse the immutable phase-independent evidence basis: starting/unsupported ceiling,
   one predictable progression step, adaptive override, and scheduled/triggered deload;
5. persist/resolve the complete basis trace; a truly unverifiable owner proof cannot create partial
   or pending basis state;
6. apply the total winning-reason precedence: a consumed blocked Athletes safety attestation first,
   then consumed blocked Exercises/category eligibility, then anchor/performed/history availability.
   Next inspect the logical projection anchor: `blocked-predecessor` wins before this occurrence's
   phase/time/loadability, copies the predecessor's valid recovery, and leaves those later sources
   `not-reached`. A verifiable dynamic block retains the basis/estimate; an earlier safety winner
   leaves exercise source and projection anchor `not-reached`;
7. apply the exact current/previous persisted phase source for this planned occurrence: only the
   success/progression branch may take the greater of its already-frozen one-step target and the
   phase target; adaptive/deload/starting/unsupported branches are not replayed or weakened, and the
   re-anchor reason uses the normalized phase transition;
8. apply current athlete-local layoff back-off to the nominal projected target;
9. apply the immutable absolute/session safe interval already stored on the basis. The exact
   logical projection anchor controls truthful direction and equipment fitting only. It must be the
   evidence source for the first remaining occurrence or the newly recomputed immediately preceding
   occurrence for a later ordinal; it can never widen/recompute the interval or feed back into step
   4. When that predecessor has no load, emit `projection.predecessor-blocked` with its exact
   prescription/output hash and original reason/recovery, and do not inspect a skipped ancestor or
   an older version of the same ordinal;
10. apply the closed conservative equipment-fit fallback over attainable totals in that interval;
11. choose the permitted candidate nearest the bounded target, using the lower load as the equal-
    distance tie-break; and
12. derive direction from the actual emitted load and emit the total decision and trace.

Steps 2–5 are evidence-basis evaluation; steps 6–12 are current projection. Phase/safety/exercise/time/
loadability repair with a current basis uses `no-new-evidence-reprojection` and never
re-runs progression. The first repair of a fact-saved outcome with no basis instead performs its one
persisted deferred evidence mode (including legacy cutover) before projection. Golden
cross-products pin the reason winner and every later source's `not-reached` shape.

The scheduled deload backstop cannot be disabled by an adaptive branch. A phase-transition raised
anchor changes the target but still ramps under the final per-session increase cap. Projection
cannot move outside the final interval. It may conservatively degrade an unexpressible increase to
an exact-current hold or an unattainable current total to a real lower load under the closed
equipment-fit rules below; it never rounds through a clamp, labels an unchanged load as a decrease,
or defeats a required back-off.

For a `starting-working-load` anchor, the final interval's upper bound is the attested load and no
base/adaptive/phase branch may raise it. Only a `performed-work-estimate` can authorize a future
increase. An unattainable starting value may project downward; it never rounds upward merely
because the next plate combination is closer.

### Frozen development fixture

`calibration-development-v1` is the only engineering rule release in this arc. It is a visibly
unreviewed software fixture, is rejected when production content mode is requested, and is never a
coaching claim. Gate 0 must replace it with a separately reviewed release rather than renaming it.
Its complete numeric contract is:

- estimate admission requires one or more explicitly confirmed performed **working** sets, integer
  load in `1..1_000_000` grams, repetitions in `1..12`, and optional integer RPE in `1..10`.
  Structurally valid recorded load 0 or repetitions `13..100` are `unsupported-evidence`, never
  “invalid” and never a prompt to falsify the fact; the whole current exposure uses its exact
  working-target ceiling and creates no candidate. A contradictory performed/skip shape or missing
  required confirmed value/provenance is `invalid-evidence` rather than silently dropping a set.
  Checked formula overflow or a derived result outside the persisted estimate domain is
  `unsupported-evidence`, because a derived-fixture limit does not make the recorded fact false;
- each set estimate is `floor(loadGrams * (30 + repetitions) / 30)`, candidate e1RM is the minimum
  admitted set estimate, and working max is `floor(e1rmGrams * 9_000 / 10_000)`; all arithmetic is
  exact signed-64-bit/BigInt checked integer arithmetic before a checked conversion. Persisted e1RM
  and working max are PostgreSQL integers constrained to `1..1_000_000` grams; the intermediate
  multiplication must remain within signed 64-bit. A derived out-of-domain result follows the
  unsupported ceiling branch above. Boundary vectors include 12 reps at 714,286 grams (e1RM
  1,000,000, admitted) and 714,287 grams (e1RM 1,000,001, unsupported), plus the generated
  last-admitted/first-unsupported pair for every repetition 1–12 and direct arithmetic-overflow unit
  vectors over the lower-level checked helper;
- phase release `calibration-development-phase-v1` has the exact codes/intensities
  `development.base=7_000`, `development.build=7_500`, and
  `development.intensify=8_000` basis points of working max. The development plan fixture persists
  base for planned exercise occurrences 1–2, build for 3–4, and intensify thereafter. Programs owns
  an opaque `developmentPhaseSequenceId` and positive `plannedExerciseOccurrenceOrdinal` for each
  prescription. Initial generation creates one sequence and assigns ordinals by chronological
  planned occurrence per exercise. Remaining-work, completion, correction, inherited/blocked, and
  athlete-input revisions preserve the logical occurrence's sequence/ordinal. Safety recovery
  Regenerate over a blocked active program consumes a Programs continuation projection and preserves
  its remaining sequence/ordinals even though the replacement is a root; only generation after no
  remaining active/draft work creates a new sequence and resets to 1. Blocked/skipped positions are
  still explicit planned positions—this fixture does not pretend they were performed exposures.
  Sequence/ordinal/source enter v3 hashes. Calibration consumes the persisted phase fact and never
  derives phase from the ordinal;
- the rule requests the 12 immediately preceding terminal exercise-exposure entries, including
  entries with `no-current-decision`. The history is sufficient when Training
  attests it is complete at the true start boundary or saturated with the exact 12 immediately
  preceding entries. The scheduled deload triggers when the current qualifying exposure plus the
  immediately preceding 11 entries are all qualifying and every prior entry affirmatively proves
  `not-deload | policy-had-no-deload`; `breaks-window` never counts as absence of a deload. Older
  history cannot change that threshold, so saturation is sufficient proof;
- the predictable progression step is 1,000 grams. Current-session high strain is evaluated over
  every structurally valid confirmed working set, independent of estimate admission: repetitions
  below target or RPE `>= 9`. Two consecutive high-strain exposures including
  the current one trigger the earlier deload. A single high-strain exposure targets 95% of current
  load. Branch precedence inside adaptive evaluation is high strain, then any skipped set or
  missing RPE, then performed load unequal to the evidence-current target, then success. Thus a high-strain
  performed set plus a skip still decreases and can trigger deload; partial evidence cannot mask
  the conservative branch. The partial/off-target branches hold. When every expected set is
  performed at the target, meets repetitions, and has RPE `<= 8`, the target is the greater of
  phase target and the basis-frozen evidence-current load plus 1,000 grams. Equality is
  `progression.increase`; `phase.reanchor.increase` is emitted only when the phase target is
  strictly greater **and** the normalized `(phase release, code, intensity)` differs from the
  immediately preceding normalized phase contract. Source row/revision IDs remain provenance but
  do not define a transition. Different prescription IDs with equal phase fields remain
  `progression.increase`; one source identity claiming contradictory phase fields is unverifiable;
- scheduled and triggered deload both target 90% of the evidence-current load. They outrank progression and
  phase re-anchor. A gap of 14–27 whole calendar days since the exact temporal anchor (latest
  truthful performed working-set exposure, otherwise starting-working-load attestation)
  exposure targets at most 90% of current load; 28 or more targets at most 80%. Layoff back-off is
  applied after deload and the numerically lower target wins. Equal targets use the total reason
  precedence `deload.scheduled > deload.triggered > layoff.fourteen-day > adaptive >
  phase.reanchor > progression`; a 28-day layoff wins by its strictly lower target. Missing or
  unproved history needed for a boundary is `history.unverifiable` with no mutation, and an
  `asOfDate` before its latest source date is invalid;
- the basis-frozen final per-session interval is
  `[floor(evidenceCurrentLoad * 8_000 / 10_000), floor(evidenceCurrentLoad * 10_250 / 10_000)]`, intersected with
  `0..1_000_000` grams. A starting-working-load additionally caps the upper bound at its attested
  grams. The phase target, 1,000-gram step, deload, layoff, and any later basis-bound prior-
  prescription projection source never widen this interval;
  and
- equipment fit is conservative and total within the final interval. Initial-bootstrap's special
  nearest-at-or-below-ceiling rule applies only when no temporal, adaptive, or deload rule requires
  a decrease. A starting anchor that has crossed a layoff boundary uses the same strict required-
  decrease rule as performed evidence; bootstrap may not neutralize time back-off. An intended
  decrease (adaptive, deload, or layoff) chooses nearest to the bounded back-off target from attainable totals that are
  strictly below current **and no greater than that target**; if none exists it returns
  `loadability.no-safe-lower-total`. It never uses the generic fit fallback to weaken the required
  back-off. For an increase/hold intent only, if current is no longer attainable, the engine chooses
  the greatest attainable lower total in the safe interval and emits actual decrease
  `loadability.projected-down`, or returns `loadability.no-safe-lower-total` when none exists.
  Otherwise an intended increase chooses a higher attainable total nearest its target, or degrades
  to exact-current hold `loadability.increase-not-expressible` when no safe higher combination
  exists; intended hold retains exact current. All nearest-target ties choose the lower load, and
  emitted direction always comes from emitted load. Cross-product vectors cover never-trained
  starting anchors at days 14 and 28 against current attainable, safe lower available, and no-safe-
  lower inventories.

For `performed-working-load-ceiling`, the nominal target is exactly current target, estimate source
is `not-consumed`, and phase cannot raise it. High-strain/deload/layoff rules may lower it and retain
their winning reason; otherwise the branch emits `facts.estimation-unsupported-hold`. Equipment fit
may emit its own conservative reason. This branch can never increase.

The closed reason/recovery catalog for that release is exhaustive:

| Reason code/family | Status/direction and precedence | Required provenance | Recovery and deterministic copy intent |
| --- | --- | --- | --- |
| `bootstrap.ceiling-hold` | available hold; initial branch | starting fact, phase, eligible safety, inventory | `none`; say the attested starting load was retained as an unreviewed development ceiling |
| `bootstrap.projected-down` | available decrease; initial projection | same, plus chosen inventory total | `update-loadability-or-correct-starting-load`; say equipment fit required a lower load |
| `progression.increase` | available increase; success branch | current facts, estimate, phase, history, inventory, safety | `none`; say confirmed work produced one bounded development step |
| `progression.hold.partial` | available hold; skip/missing-RPE branch | current facts and history | `none`; say partial evidence prevented a change; History may separately offer the exact-source factual editor |
| `progression.hold.off-target` | available hold; performed load differs | current facts and history | `none`; say the load differed; History may separately offer the exact-source factual editor |
| `facts.estimation-unsupported-hold` | available hold; truthful load/reps outside estimator admission and no decrease override | exact current effective facts and performed-target ceiling; estimate not consumed | `none`; say the set was saved truthfully but this development estimator did not use it to increase the load; History may separately offer the exact-source factual editor |
| `progression.decrease.high-strain` | available decrease; single high-strain branch | current facts, estimate, history | `none`; say the fixture backed off; History may separately offer the exact-source factual editor |
| `phase.reanchor.increase` | available increase; phase target exceeds the 1,000-gram step and no later override wins | current/previous persisted phase, estimate | `none`; say the persisted development phase raised the bounded target |
| `deload.scheduled` | available decrease; outranks phase/progression | complete-or-saturated ordered history | `none`; say the development backstop fired after its versioned exposure count |
| `deload.triggered` | available decrease; outranks phase/progression | current facts plus contiguous high-strain history | `none`; say repeated recorded high strain fired the back-off; History may separately offer the exact-source factual editor |
| `layoff.fourteen-day`, `layoff.twenty-eight-day` | available decrease; applied after deload, lower target wins | `asOfDate` plus the exact performed-or-starting temporal anchor | `none`; say the gap length selected the versioned development back-off |
| `anchor.missing` | unavailable, before target | exact absent anchor discriminant | `no-self-service`; say required historical setup data is absent and do not link a correction that requires that row |
| `anchor.starting-invalid` | unavailable, before target | exact existing starting fact/correction source | `correct-starting-load`; deep-link that source and say its entered ceiling needs correction |
| `facts.estimation-invalid` | unavailable, estimate/adaptive stage | exact existing effective working-set source | `correct-performed-fact`; deep-link that set without showing an internal estimate |
| `facts.unsupported-working-target-shape` | unavailable source-prescription compatibility | exact Programs prescription/set shape | `no-self-service`; say this saved program shape is unsupported and never deep-link an athlete fact editor |
| `phase.missing`, `phase.invalid` | unavailable, target stage | exact absent/invalid Programs phase source | `regenerate-program`; say the saved development phase cannot be verified |
| `projection.predecessor-blocked` | unavailable, logical projection-anchor stage | exact same-result immediately preceding prescription/output hash plus its original reason/recovery | copy the predecessor's still-valid recovery; say this later occurrence waits on the earlier planned occurrence and never suggest an unrelated repair |
| `loadability.projected-down` | available decrease; current total no longer expressible | consumed inventory and safe interval | `none`; say the nearest conservative lower equipment total was selected |
| `loadability.increase-not-expressible` | available hold; no higher total inside the cap | consumed inventory and safe interval | `none`; say current load was retained because no safe higher entered combination exists |
| `loadability.missing`, `loadability.invalid` | unavailable, projection stage | absent/not-reached/consumed inventory as applicable | `update-loadability`; say equipment facts are missing or invalid |
| `loadability.no-safe-lower-total` | unavailable required decrease | consumed inventory and safe interval | `none`; say no entered combination can satisfy the required back-off and never promise unchanged inventory will fix it |
| `starting-load.no-attainable-at-or-below` | unavailable bootstrap projection | starting fact plus consumed inventory | `update-loadability-or-correct-starting-load`; say no entered total fits beneath the ceiling |
| `eligibility.profile-incomplete` | unavailable safety gate | consumed absent-profile attestation | `complete-profile`; say setup is required |
| `eligibility.restriction` | unavailable safety gate | consumed restriction attestation/holds | `no-self-service`; say no load is provided while the restriction is active |
| `safety.session-pain-hold` | unavailable safety gate | consumed pain-hold attestation/source | `resolve-session-pain-hold`; say the pain hold must be resolved, then regenerate |
| `safety.unsupported-hold` | unavailable safety gate | consumed closed unsupported source | `no-self-service`; say this hold has no self-service recovery |
| `exercise.uninstalled`, `exercise.prohibited`, `exercise.advanced-ineligible`, `equipment.category-missing` | unavailable exercise/category gate | consumed exercise contract plus athlete equipment profile | `no-self-service`; identify the exact installed-contract or category gate without suggesting plate edits |

The optional exact-source “Correct saved fact” affordance is factual editing, not a persisted
decision recovery. It appears only when the authorized History source still exists and truthfully
says “If this saved fact is wrong, correct it; otherwise no action is needed.” Required
`correct-performed-fact` recovery is reserved for `facts.estimation-invalid`; no valid hold/decrease
asks an athlete to falsify evidence to escape it.

`safety-attestation.unverifiable`, `exercise-eligibility.unverifiable`,
`profile-time.unverifiable`, `history.unverifiable`,
`performed-facts.unverifiable`, `estimate-source.unverifiable`, content
revocation, stale lifecycle generation, and installation-epoch mismatch are workflow failures, not
fabricated persisted calibration decisions. Unknown
reason/recovery/rule/phase values fail closed. Golden vectors assert every row, branch precedence,
formula boundary, history-window boundary, and copy/recovery mapping, including scheduled plus
triggered, each deload plus 14-day layoff, all three tied branches, and the strictly lower 28-day
layoff. Admission vectors pin 12/13/100 repetitions, maximum in-domain/first derived out-of-domain
formula inputs, and truthful zero-load handling without a correction prompt. Unsupported RPE-9
current/consecutive-history and day-0/13/14 vectors prove estimator admission does not erase high-
strain or layoff facts. Same-phase versus genuine-transition vectors pin phase-reanchor labeling. Equipment fixed-
point vectors cover current attainable/no higher, current unattainable with
a safe lower total, and required decrease with no lower total; resubmitting unchanged truthful
inventory never advertises a recovery action that deterministically repeats the same block.

Catalog tests additionally prove every non-`none` recovery names an existing command target and a
valid action can change its predicate; owner-integrity failures and derived-row corruption never
masquerade as editable athlete facts.

When more than one unavailable cause is present, the one persisted reason is total: unverifiable
owner evidence aborts with no decision; otherwise consumed safety reasons win in their attestation
precedence, then exercise/category eligibility, invalid/missing anchor or performed/history facts,
a blocked logical predecessor, invalid/missing phase, then loadability. A valid estimate candidate
derived before a later winning safety/exercise/phase/loadability block is still persisted. Golden cross-products pin this
precedence.

### Fail-closed safety

Invalid/missing normalized facts, an implausible estimate, an unattainable target set, or a consumed
blocked Athletes safety attestation returns an unavailable reason with exact consumed-source
provenance. Unverifiable owner evidence aborts without mutation. Calibration does **not** emit
`raiseHold` and does not write `safety_hold`.
The live safety-hold table has distinct eligibility and session-pain provenance/resolution rules;
an untyped calibration boolean cannot truthfully enter either lifecycle. A future
calibration-specific hold requires a separate typed reason, source, resolution policy, database/UI
contract, and review.

---

## 6. Derived estimate lineage and corrections

Calibration owns append-only estimate truth, not a mutable “current max” cell.

### `calibration_estimate`

Each row records at least: ID, user ID, exercise code, per-exercise sequence, optional previous
estimate ID, optional anchor estimate ID, source session ID, source program revision ID,
estimate-source-facts hash, derived e1RM grams, working-max grams, rule version, and creation time.
`previous_estimate_id` is the single chronological chain; `anchor_estimate_id` separately names the
estimate actually used as derivation evidence. A correction replacement may therefore follow an
invalidated chronological predecessor without treating it as a valid anchor. A unique
`(user_id, exercise_code, estimate_source_facts_hash, rule_version)` identity makes replay idempotent while
allowing an intentional rule-version recalculation to append a new row.

For `calibration-development-v1`, a new candidate is computed solely from the current admitted
performed sets, so `anchor_estimate_id` is null even when a prior estimate exists;
`previous_estimate_id` still advances chronology. A branch with no new candidate may consume the
already active estimate as its decision source. The fixture never blends, ratchets, or silently
anchors to a prior estimate. A future rule that does so must define the formula and populate the
exact anchor dependency.

The estimate-source hash covers only normalized performed/anchor facts and the estimation rule; the
decision `sourceFactsHash` covers the complete compute input, including phase and loadability. An
equipment update can therefore change a decision without pretending it changed historical
performed strength evidence.

### `calibration_estimate_invalidation`

Each row records at least: ID, user ID, exercise code, invalidated estimate ID, source correction
ID, reason code, and creation time. It is append-only and unique per estimate/correction cause.

Composite foreign keys and deferred constraint triggers enforce: previous/anchor subject and exercise
equality; consecutive chronological sequence; strictly earlier anchors; source session subject;
source session/program-revision agreement; invalidation estimate/correction subject and relevant
session lineage; acyclicity; one chronological head; and the idempotent source/rule identity. The
advisory lock coordinates workflows but is not the only integrity control.

Active selection is a composed owner-query workflow under the same `SubjectWorkflowLock` and
`UnitOfWork`, never a Calibration peer read. The physical chronological head is not automatically
the active candidate: Calibration returns noninvalidated rows newest-to-oldest by sequence, and the
selector chooses the first row whose complete owner/anchor provenance remains valid. A correction
of a later independent source to `no-qualifying-evidence` may therefore expose an older still-valid
estimate; a current `invalid-evidence` classification blocks selection of every older estimate until
that factual source is corrected. No carry-forward estimate row or fictional anchor is appended.

1. Calibration returns the ordered candidate rows, their transitive anchor graphs, explicit
   source session/revision provenance, stored estimate-source hashes/rule releases, declared
   validity dependencies, and Calibration invalidations.
2. Training returns a same-subject attestation for every requested session containing terminal
   factual-source validity, correction sequence, and canonical effective performed-fact hash
   material. It
   separately attests the boundary-proved latest **effective evidence-bearing** exposure per
   exercise—identity, correction/hash, and `qualifying | unsupported | invalid` admission—or exact
   absence. All-skipped/zero-performed exposures are not evidence-bearing; correcting an exposure
   to all-skipped removes it from this projection. The attestation is independent of candidate rows,
   so an originally invalid/unsupported session that created no estimate is still visible.
3. Only when an estimate rule explicitly declares a revision/anchor validity dependency does the
   application pass those exact IDs—not Training tables—to Programs for owner closure. The
   performed-facts-only v1 rule declares none: its source revision is immutable historical
   provenance and a later future-revision invalidation cannot falsify the performed sets.
4. Programs separately attests that the **current publisher's** exact methodology/template release
   is not revoked and declares the estimate rule/version compatible. A revoked source program never
   contributes executable load/phase/progression/history policy; its personal performed facts may
   be re-derived under the current nonrevoked compatible rule, or an already derived
   performed-facts-only estimate may be consumed when that exact rule remains allowed. If no current
   compatible release exists, Regenerate truthfully stays blocked; starting-load reset cannot bypass
   authoritative performed evidence.
5. The application passes the complete owner attestations back to the pure Calibration selector.
   Any missing, duplicate, cross-subject, stale-fact hash, invalid factual session, invalid declared
   anchor/dependency, revoked current publisher, or rule incompatibility yields no active estimate.

The latest-evidence attestation is checked before older-estimate fallback: `invalid` blocks every
older estimate until that source is corrected, `unsupported` keeps older lineage historical but
selects the conservative current-target ceiling for this decision, and `qualifying` must match the
newest owner-valid candidate source. Exact absence permits no estimate. Missing/duplicate/stale or
unproved-boundary evidence fails closed. Vectors cover E1 valid → originally invalid E2 (no
candidate) → root/inventory recompute blocks E1; E2→all-skipped exposes E1; and later qualifying E3
selects E3, plus partial/cross-user attestations and races.

Creation-clock ordering and a mutable pointer are never authority. Sequence order plus owner
validity is authority. Stage 4 proves Calibration's
own-lineage candidate/selector behavior; Stage 6 adds transaction-scoped Training/Programs
attestations and the composed workflow. Hostile partial owner responses, direct partial
invalidations, cross-user IDs, and correction races must fail closed without any peer schema import.
When Training corrects a source fact, it supplies exact old/new estimation hash material and the
correction workflow invalidates only estimates whose declared performed-fact/anchor inputs changed,
then recursively follows actual anchor dependencies. Calibration returns the exact invalidated
estimate and compute-basis IDs to the application. Programs finds every prescription whose consumed
estimate/basis source names one, including independently root-generated programs, and closes basis/
inherited descendants; Training/Programs also use ordered history sources to find decision/
prescription consumers. All invalidations and the chronological decision replay in §4 run in one
UoW. A disproven estimate/basis cannot influence a later decision, while an empirically independent
later v1 estimate survives mere invalidation of its source future revision.

Required vectors include: S1→E1/D1/R1, S2→E2/D2/R2, correct S1 load/reps, preserve E2 while replaying
D1/D2 and projecting the final S2 state; the analogous three-session history cascade; RPE-only and
feedback-only correction retaining E1 while decisions/safety close; E2→all-skipped exposing valid
E1; E2→invalid blocking E1 until correction; revoked source release followed by a new compatible
release Regenerate; and correction-first versus queued no-new-evidence reprojection. Partial owner
closure or stale basis evidence fails closed.

---

## 7. Ownership, ports, and the `UnitOfWork`

| Concern | Owner | Public seam |
| --- | --- | --- |
| existing starting-load/baseline facts | Athletes | versioned facts query; protocol preserved |
| append-only starting-working-load corrections | Athletes | effective fact query/append API; originals unchanged |
| immutable barbell/paired-plate loadability versions/items | Athletes | versioned loadability query/append API |
| installed exercise contract/taxonomy | Exercises | versioned registry projection + pure eligibility builder |
| estimate, complete compute basis, and their invalidation lineage | Calibration | compute/append/invalidate gateways |
| decision + decision invalidation + explanation cache | Training | Training decision/fact APIs; decision stores direction plus discriminated estimate/loadability and required safety provenance |
| correction outcome/results + invalidated executable sessions | Training | exact correction replay/projection-status API |
| deferred correction-replay recovery receipt/results | Training | success-only historical replay recovery API |
| program revision/prescription/blocked-exercise state | Programs | Programs initial/future-revision ports |
| generalized program revision parent/cause lineage | Programs | Programs revision-write/dependency-closure gateway |
| original athlete-input workflow outcome | Programs | append/read exact `program_load_input_outcome` by passed input identity |
| Training-correction current projection outcome/results | Programs | append/read exact current-planning result by passed Training outcome |
| generalized projection quarantine/head/occurrences/correction/session-invalidation ancestry/resolution | Programs | one current continuation/replay-debt/execution-block recovery API |
| regeneration receipts/basis results/correction-recovery joins | Programs | success-only continuation/replay command API |
| one-time legacy basis cutover receipts | Programs | append/read exact cutover authority/result by workflow command |
| safety eligibility and existing holds | Athletes | versioned current attestation; all hold mutations use the owner API by Part B |
| subject lifecycle generation | Identity | capture/current-generation projection plus transaction-scoped recheck/advance |
| installation mutation epoch | Identity | pre-queue capture plus transaction-scoped recheck/rotate; opaque value is not a fence concern |
| cross-workflow athlete serialization | application `SubjectWorkflowLock` | UoW-lifetime lock intent over a dedicated PostgreSQL connection; no product tables/reads |

Every product-table mutation first takes the shared side of a neutral application
`ProductMutationFence`. `SubjectWorkflowLock` composes that shared installation fence and the
subject key into a UoW lock intent: exclusive for mutations/deletion and shared for one-subject
read-only export. Global mutations such as exact-version content
revocation use shared product plus their canonical content keys without a fictional subject.
Whole-instance reset requests product exclusive. These ports own no product reads.

The PostgreSQL UoW adapter checks out one dedicated connection and acquires every known
linearization key with **session-level** advisory locks before `BEGIN`. The account mode is a closed
matrix: ordinary authenticated product UoWs and one-subject exports take the resolved account key
shared; every provider/session or credential mutation on a resolved account takes it exclusively,
including sign-in session insert plus bounded cleanup, checked sign-out/delete, expired-session
cleanup, password/member/owner recovery, reset/revocation, destructive reauthentication, and
subject deletion. Unknown-account sign-in uses the synthetic unknown-account key rather than a
fictional resolved account. After credential authority come product shared/exclusive, subject when
applicable, then the complete canonical lexical content-key set from a verified server-sealed plan.
Only after all waits finish does it begin the requested transaction isolation, bind gateways, and
permit owner revalidation/rows.

An authorized public read from each owning module returns an opaque nominal
`ContentLockSourceProjection` fragment for authoritative state that module owns. Owner infrastructure creates the
fragment through a neutral factory; workflow/application code cannot construct it, inspect its raw
keys, or submit a string array. Each fragment is bound to one closed owner slot, plan shape, purpose,
ordered source entity IDs, and issuance scope. `ContentLockPlanPort` is a neutral
application-coordination port that composes and seals fragments, verifies an envelope, and opens a
scoped adapter invocation. Platform alone implements the port and factory, sees the canonical lock
keys inside opaque fragments, and owns HMAC/key material; it never reads product state. Each owner
reads and attests only its owned authoritative state: rows where applicable and Methodology's
code-installed release registry for `methodology-target`.

The plan-shape registry is closed and exact:

- `none`: no fragments and 0 keys;
- `release-revocation`: exactly `methodology-target` and 1 key;
- `current-publication.initial`: exactly `methodology-target` containing the methodology/template pair
  and exactly 2 keys;
- `current-publication.existing`: exactly `programs-current` containing the revision's methodology/
  template pair and exactly 2 keys;
- `stale-regeneration`: exactly `programs-current` plus `methodology-target`, each a complete pair,
  with 2–4 distinct keys after deduplication; and
- `correction-closure`: exactly `training-history` plus `programs-current` and 2–64 keys. A required
  correction fragment may contribute zero keys where the shape permits, but both slots must be
  present and Training's potential-history closure supplies at least the source methodology/template
  pair.

The composer rejects a missing, duplicate, extra, wrong-owner, wrong-scope, or wrong-shape slot. It
bytewise sorts and deduplicates the exact `kind:id:version` union. The sealed token is
`base64url(canonical UTF-8 JSON payload).base64url(HMAC)`, without padding, using the project's
canonical serializer and sorted object keys. It is versioned `content-lock-plan-v1` and signed with
HMAC-SHA-256 derived from `BETTER_AUTH_SECRET` under domain
`indigo-content-lock-plan-v1\0`; rotating that secret deliberately invalidates both identity sessions
and outstanding forms. The payload binds immutable server-issued shape/purpose, actor account,
optional subject, preallocated form/command ID, ordered source entity IDs, expected epoch/generation
commitments, owner-slot manifest, and the canonical key union. The encoded token is at most 16 KiB.
HMAC provides integrity, not encryption: a browser can decode the payload. It therefore contains only
opaque identifiers and content-release coordinates already authorized for that form—never secrets,
credential material, private facts, or security rationale—and is never logged or echoed. Decoded
client fields remain untrusted; only the verified scoped capability and fresh owner projections can
select or attest locks.
A correction whose server-derived potential-impact union exceeds 64 is typed
`content-lock-plan.too-large | no-self-service` before command claim/fact mutation; other cardinality
violations are integrity failures.

Verification is deliberately split. Encoded-size, base64url, canonical-schema/order/distinctness,
shape/cardinality, and constant-time MAC checks run before any database capture or queue admission.
An invalid/tampered token therefore consumes no connection. A signed-cookie actor may then require
one bounded trusted credential-capture lease to resolve its account. Only after that capture does the
port check account/subject/purpose/form-or-command/source-entity/epoch/generation bindings. A valid
token stolen from or issued to the wrong actor consumes at most that one bounded capture lease and
never enters ordinary/control UoW admission. This pre-capture identity is not mutation authority;
Identity still performs the first authoritative transactional role/session/lifecycle check.

After binding succeeds, `withVerifiedContentLockPlan(envelope, bindings, callback)` creates a
platform-private, nominal `VerifiedContentLockPlan` only for the lexical callback. The callback must
settle and immediately enters bounded UoW admission; detached use is rejected. The capability is
one-use, cannot be structurally forged, exposes no raw keys, is revoked in an unconditional `finally`
on queue rejection, cancellation, admission or lock timeout, `BEGIN`/callback/`COMMIT` failure,
connection loss, or success, and any retained or second use fails. There is no global capability
registry, cache, or TTL cleanup problem. Active verified scopes are observable and bounded by the
request plus admission lifetime; tests require the active count to return to zero after every path.
A server-to-server caller uses the same scoped issuer after authorized opaque owner projections; it
cannot construct a plan from caller strings.

The adapter consumes the capability, acquires its verified canonical key union without exposing a
raw-key API to application code, and yields a callback-scoped
opaque `LockedContentPlanAttestor` alongside the transaction gateways. After `BEGIN`, Identity and
generation checks run first. For every ordinary receipt-bearing command, the owning gateway then
classifies command identity plus stable-intent hash: exact replay returns the original persisted full
result before fresh content/source/planning gates, mismatched reuse conflicts, and only a new command
continues. Plan structural/MAC/binding checks and current Identity/generation authority therefore
precede replay, but later mutable currency cannot rewrite an earlier result. Root setup remains the
sole exception that classifies its receipt before generation under the stored/result-generation rule.
For a new command, each required owner gateway re-reads only its current authoritative state (owned
rows where applicable, installed registry for Methodology) and returns a fresh transaction-bound
`ContentLockSourceProjection` for its required slot. Application
coordination passes the complete opaque slot set to `assertCurrentLockedContentSet`; it never sees raw
keys. The platform attestor proves exactly one of every shape-required slot, no missing/duplicate/
extra fragment, the same UoW/transaction/purpose/source IDs, and byte-for-byte equality between the
fresh union and the prelocked union. It returns only success or `content-lock-plan.stale`, and is
revoked with all fragments in the UoW `finally`. Thus Platform reads no product state, each owner
attests only owned authoritative state, and no single module is incorrectly made responsible for another owner's
keys. No owner mutation occurs before the equality succeeds.

For correction forms, `training-history` is the full authorized **potential-impact structural
closure** of the immutable source set across every legal editor transition, independent of submitted
replacement values; `programs-current` contributes current/future projection content sources.
Issuance and post-`BEGIN` revalidation derive that same structural union. Only afterward are the
separately parsed and stable-intent-hashed performed/skipped/load/repetition/RPE/feedback values used
to compute the actual causal invalidation subset transactionally. That actual subset must be contained
in the locked potential union; unused potential locks are expected, not an equality failure. The same
source therefore receives the same plan for performed→performed, performed→skipped,
skipped→performed, RPE-only, and feedback-only edits. There is no action-entry resigning step that
could turn submitted values into trusted lock selection.

The envelope is authenticated lock input, not product authority. A changed owner source makes the
fresh opaque union unequal and fails `content-lock-plan.stale` with no mutation rather than acquiring a
later key inside a fixed snapshot. Locks are released in reverse order in an unconditional `finally`;
if release/connection state is uncertain, the connection is destroyed, never returned to the pool.
The global order is therefore credential → product → subject → lexical content release → owner rows,
and a workflow never acquires an earlier class while holding a later one. Stage 9 inventories all
subject and non-subject product writers (including global audit/revocation paths) so no mutation
bypasses the shared fence.

Compatibility keys are normative during cutover. Account authority uses the existing exact
`hashtextextended('indigo:credential-lifecycle:account:' || user_id, 0)` namespace. The credential
prefix also retains exact `instance-fence`, `email:${HMAC-digest}`, and
`unknown-account:${HMAC-digest}` keys; within credential authority the order remains instance fence,
submitted-email key, then lexically resolved account keys or the synthetic unknown-account key.
Reset takes instance-fence exclusive; ordinary lifecycle work takes it shared. Session ID is
reauthenticated data, never a substitute lock key. Subject serialization reuses the existing
`hashtextextended(user_id, 0)` identity, and methodology/template locks reuse the exact unprefixed
`kind:id:version` strings. Because session- and transaction-level advisory locks share PostgreSQL's
namespace, these conflict with live writers/triggers during migration. Any key migration must update
every call and database trigger atomically; a parallel newly prefixed subject/content namespace is
forbidden. Mixed old/new cutover races prove each credential, subject, and content key actually
conflicts across implementations. Hostile tests additionally prove invalid MAC, malformed canonical
encoding, changed byte, oversized token, and illegal shape consume no connection; a signed cross-
account/subject plan consumes at most one bounded credential-capture lease and no UoW admission;
wrong purpose/form-or-command/source entity/kind, 65-key potential closure, missing/duplicate/extra
owner slot, extra unrelated release, duplicate/noncanonical key, cross-transaction fragment, and
wrong-source attestation cannot select locks. A valid stale plan locks only its issued bounded set and
then fails owner equality without mutation. Correction vectors prove the potential plan is identical
for every legal submitted shape, contains every actual causal subset, and neither a narrow underlock
nor a value-dependent broad overlock can pass. Initial publication races revocation of each member of
the mandatory methodology/template pair; neither key may be omitted. Queue-capacity rejection,
cancellation, timeout,
callback throw, `BEGIN`/`COMMIT` failure, connection loss, success, retained/second use, and detached
work all revoke the capability/attestor/fragments and return the observable active-scope count to zero.
Architecture guards forbid domain/workflow/application imports of the platform implementation or
`node:crypto`, forbid an issuer/factory that accepts a workflow-provided raw string array, and prove a
forged capability cannot reach the adapter.

Identity recovery/destructive-reauthentication may already hold canonical credential locks on an
outer dedicated connection. A neutral application-coordination boundary owns the opaque,
nominal `PrelockedSessionLease` capability type and its scoped acquisition/consumption port; neither
the application nor a module can construct it or import the concrete PostgreSQL adapter. Platform
owns the runtime factory and port implementation; Identity consumes only
`withPrelockedSessionLease(intent, callback)`. The platform-private class/closure holds the connection
only for that lexical callback, validates one-use same-session transfer, and is revoked in an
unconditional outer `finally`; there is no global connection-token registry. Queue rejection,
cancellation, timeout, callback/`BEGIN`/`COMMIT` failure, or outer-session loss releases known-clean
state or destroys the uncertain connection, and retained/detached/second use fails. Active lease
scopes are bounded by control admission and observable; every path returns the count to zero.
Identity passes the unforgeable in-process capability—not caller strings, `unknown`, or a
structurally forgeable object—back to the UoW, whose platform implementation consumes use of that
**same PostgreSQL session**. This inversion keeps platform independent of Identity and keeps
application/module code independent of platform. Architecture tests enforce both directions. The UoW
acquires product/subject/content on that session, then begins/commits there before the outer wrapper
releases credential last. It never relies on a second connection plus a best-effort JS abort signal.
Outer-session loss necessarily destroys the in-flight transaction/locks; callback and COMMIT-race
tests prove no mutation can outlive credential authority. Ordinary workflows acquire credential keys
on their UoW connection. Subject deletion, instance reset, member recovery, timeout, and connection-
loss tests prove this composition neither self-deadlocks nor weakens ordering.

The infrastructure-free request is closed: lock intent plus transaction mode
`read-committed/read-write` (ordinary mutations), `serializable/read-write` (deletion/reset), or
`repeatable-read/read-only` (export). Isolation/access mode is issued immediately after the pre-
transaction locks and as part of `BEGIN`, before any transactional statement. Starting a nested or
re-entrant UoW is rejected; composed workflows must pass the already-bound gateways. Read-only mode
exposes only read gateways. The callback must settle all work before return; retained or detached/
unawaited gateway use revokes the scope and rolls back.

Export takes credential shared, product shared, and subject shared before its one repeatable-read
snapshot, then revalidates epoch/authority/generation. Mutations/deletion take subject exclusive.
Export-first may finish and return the coherent pre-delete snapshot before deletion proceeds;
deletion-first makes a stale queued export fail generation/subject existence and a fresh export see
the post-delete state. Both orders are integration-tested without blocking unrelated subjects.

Admission is bounded before a dedicated connection is consumed. Stage 3 replaces the live single
hard-coded pool plus four raw lifecycle clients with `INDIGO_DATABASE_POOL_MAX`, an integer 6–64
defaulting to 10 and defining one physical `poolMax` budget split into independent pools/permits.
Ordinary page/UoW/Better-Auth read work gets `poolMax - 4` (minimum 2) with FIFO queue 128; two
control connections are reserved for credential/recovery/reset/bootstrap leases; one priority-
admitted security-capture connection performs the pre-wait installation epoch/owner read (Stage 4
extends that same lane to subject generation atomically with its consumers); and one installation-
wide slot is reserved for an external host/operator process. Stage 3 adds no runtime database-health
endpoint or reserved health lane: startup database preflight is a serialized host one-shot on the
external slot, and any later accepted in-process diagnostic uses bounded ordinary admission or
requires a contract amendment. Host bootstrap/recovery,
preflight, backup/restore, and every shipped one-shot entrypoint acquire one common host `flock`
before opening exactly one dedicated client, never instantiate application pools, and release it on
every exit. App pool maxima sum to `poolMax - 1`; runbook/preflight verifies the configured
PostgreSQL-role allowance covers `poolMax`. A real separate-process CLI saturation test proves the
runtime plus one external command never exceed that installation budget.
The capture lane and the two-connection control pool each have separately bounded trusted and
submitted-email queues, each capped at 64 waiters, with strict trusted priority after current work; per-account FIFO remains
inside a priority. Submitted-email HMAC/address checks before capture are non-authoritative
in-process load shedding only and require no database connection. After the lease is acquired, the
existing durable PostgreSQL HMAC-keyed fixed-window admission/cleanup runs on that same control
client before credential proof and preserves uniform failure semantics across restarts/processes.
The load-shedder is address-first, has fixed maximum cardinality, TTL plus deterministic eviction,
and fails closed at capacity; random-email/address flood and restart tests bound memory without
claiming durable brute-force authority.
Unknown-email/sign-in flood therefore cannot starve authenticated
recovery/reset/host capture. Server-rendered forms/actions and host capabilities carry
the previously issued opaque expected epoch/generation; capture at action entry never replaces that
anti-ABA value, so safe trusted waiting cannot adopt a newer lifecycle. Sign-in/unknown-account requests that have no prior product generation begin their
authority at successful capture and can create only the account/session permitted by post-lock
credential proof.

Lease-bearing control work reuses its already-held control client for every callback query and UoW;
it never re-enters `getDb()` or waits for an ordinary permit. Ordinary direct reads and adapter calls
pass the bounded ordinary admission wrapper; no node-postgres unbounded wait queue remains. Each
class has FIFO fairness where queued; ordinary callers cannot occupy capture/control capacity,
and control callers cannot leak into ordinary capacity. A checked census assigns Better Auth,
credential issuance/redemption, bootstrap, recovery, reset, and every existing direct read/writer to
one class. Session `lock_timeout` defaults to 5 seconds and is set/
reset outside the transaction; timeout returns retryable `uow.lock-timeout`, queue overflow returns
`uow.capacity`. Configuration is range-checked against the total. Saturation tests fill the ordinary
queue while recovery/reset completes through control capacity and cover ordinary read contention,
timeout at every key class, submitted-email flood plus trusted capture/control work, reset during capture/control saturation, `BEGIN`/callback/`COMMIT`
failure, cleanup failure, and destruction rather than pooling whenever lock state is uncertain.

Mutation authority is also a closed intent captured before queuing:
`authenticated-session { actorUserId, sessionId, expectedRole }`;
sealed `destructive-reauthentication-attempt { actorUserId, sessionId, expectedRole, purpose,
targetUserId? }`, limited to password-attempt/lockout/audit mutation and able only on success to mint
the one-use lease bound to that exact actor/session/purpose/target;
`authenticated-destructive { actorUserId, sessionId, expectedRole, purpose, targetUserId?,
reauthenticationLease }`, where purpose is exactly `trainee-data-deletion | instance-reset |
member-reset-issue | local-user-create` and role/target/null shape plus the lease's bound
actor/session/purpose/target are rechecked;
sealed purpose-specific credential-lifecycle variants over `PrelockedSessionLease` for email
sign-in/unknown-account plus bounded resolved-account cleanup (email digest/account), checked
sign-out (signed-token digest plus resolved account), member-reset redemption (code identity plus target), and owner-recovery web/CLI
redemption (code identity/channel/owner); the separately sealed host-bootstrap issuance/redemption
capability; or sealed host `owner-recovery-issue` authority carrying expected installation
epoch/owner and host invocation identity; or sealed host `expired-session-maintenance` carrying
instance expectation, cursor, and bounded batch. Plain email, code, cookie, caller string, or CLI flag is never authority. No generic
`owner-cli` product authority exists without a real accepted consumer. Instance reset uses
authenticated destructive authority; it is never converted into a bearer reset capability.
Identity re-attests matching session/account/role/target, purpose-bound reauthentication lease,
lifecycle purpose/capability, installation epoch/open state, or bootstrap/recovery issuance code state after the locks; no caller
converts one kind into another. Bootstrap issuance/redemption capture the pre-wait installation
epoch and exact capability/code identity, take the instance/account and shared product fences, and
recheck open state after `BEGIN`. Owner-recovery issuance uses the same expected owner/epoch and
shared product fence. Races cover bootstrap/recovery issue-or-redeem-first and reset-first, cross-
purpose or failed-attempt lease reuse, a queued workout
mutation versus J7 session revocation, and owner/self subject deletion versus role/session loss.
`AuthenticatedActor` therefore gains the opaque Better Auth session identity in server-only state;
actions never accept that value from a form/body, and logs/audit/export omit the credential token.

Better Auth is pinned at 1.6.23 and its route mutation matrix is an architecture contract, not an
opaque adapter exception. Stage 3 intentionally adopts fixed-expiry sessions for this arc:
`session.deferSessionRefresh: true` plus `session.disableSessionRefresh: true` and
`session.cookieCache.enabled: false`; every server `getSession` passes both `disableRefresh: true`
and `disableCookieCache: true`, and external `POST /get-session` remains denied. GET and
server actor reads therefore neither refresh nor delete expired session rows. Identity owns a
bounded fenced expired-session cleanup instead: sign-in/sign-out delete a capped page for the
resolved account under its exclusive key, and a documented paginated operator maintenance command
cleans dormant accounts under instance-shared then lexical account-exclusive locks. It has bounded
batch/queue limits, restart-safe cursors, no starvation, and export/deletion/reset coverage;
preflight remains observational. `POST /sign-out` is replaced/wrapped by an
Identity-owned checked token-to-account lookup and account-exclusive delete with `DELETE ...
RETURNING`; it clears the cookie only after a nonexpired row was deleted, or when the row is already
absent/expired, and injected database failure cannot return false success. The wrapper preserves
Better Auth's signed-cookie parsing, trusted-origin/CSRF semantics, client-address admission, and
exact secure cookie attributes; hostile cross-origin/missing-forwarding cases remain denied.
Provider sign-in/session
insert, checked sign-out/delete, read-only get-session, reset/recovery, subject-delete cascades,
cleanup, audit, and rate-limit writes all appear in the checked census. Row timestamp/no-delete
tests and both orderings against reset/recovery/product UoWs prove the contract; provider upgrades
fail the pinned source/config/route test until manually re-audited.
Mutation routes use a request-scoped Better Auth instance/Drizzle adapter bound to the exact leased
control client; the live singleton adapter is retained only for proven read-only calls through the
ordinary class. Sign-in/recovery callbacks may not call global `getDb()`. A saturation test fills
ordinary connections with account-shared UoWs while sign-in holds account-exclusive and proves the
control-bound provider insert completes without pool inversion or deadlock.
Trusted destructive/recovery action entry resolves and verifies its signed cookie/session through
the trusted capture/control lane before constructing authority, then rechecks on the same lease
after `BEGIN`; it never depends on ordinary `getActor()` or form-supplied session ID. Ordinary page/
product actor reads remain on the ordinary read-only path. Real HTTP/action saturation tests begin
with only the cookie and prove reset/recovery can enter while the ordinary pool/queue is full.

Identity's `installation_state` carries an opaque `product_mutation_epoch`; the neutral fence never
imports or reads that schema. At request issue time, before the request can queue, the application
captures the expected epoch through Identity's public read on a separate connection/outside the
future UoW transaction. After the pre-transaction session locks are acquired and `BEGIN` succeeds,
a transaction-scoped Identity gateway performs the first authoritative read, establishing a post-
wait snapshot, and compares the epoch with the passed expectation **and** re-attests the request's
current actor/session/role authority before any product owner read/write. Subject workflows then
validate their generation/root; global workflows apply their owner-role assertion. Instance reset
rotates the epoch through Identity inside its
exclusive transaction. A pre-reset request cannot adopt a replacement installation after waiting:
it returns `product-mutation.epoch-changed` with no rows, while a fresh post-bootstrap command
captures the new epoch and may succeed. Password/reset/session-revocation races use the same outer
credential key: revocation-first makes a queued command return `identity.authority-stale`, while
writer-first linearizes the authorized mutation before revocation. Real `SERIALIZABLE` waiters
prove reset/revocation-first and writer-first paths observe post-wait state rather than false-
passing an old snapshot.

Stage 9 subject-deletion execution takes the same composite subject lock before plan lock/recount/
digest revalidation and holds it through owner deletions and tombstone commit. If a writer commits
first, deletion rereads its latest serialized state: a changed count/digest forces a fresh plan,
while an unchanged count/digest still deletes the latest row values under the lock. If
deletion commits first, a queued stale writer must reread the missing profile/setup root and return
`subject-data.deleted` without mutation. Only a post-delete setup request carrying the current
subject-lifecycle generation may rebuild afterward.
Instance reset runs under the existing exclusive credential fence and the exclusive product-
mutation fence; queued pre-reset subject or global workflows wake only after commit, reread reset
roots/eligibility, and fail without inserting. Reset races every writer class, including content
revocation and its global audit append, in both orders. SERIALIZABLE isolation and FK cascades are
additional backstops, not the linearization boundary.

Identity owns one non-fitness coordination row per surviving account,
`subject_data_generation` (`user_id`, opaque random `generation_id`, monotonic sequence,
`absent | active | deleted` state, updated time). An Identity-owned database trigger on every Better
Auth `user` insert atomically seeds `absent`; owner bootstrap, member creation, direct auth-adapter,
and hostile SQL tests prove there is no user-without-generation window. The upgrade migration seeds
`active` exactly when a profile exists and `absent` otherwise. Every server-rendered subject form
and action payload carries the previously issued opaque expected generation as untrusted comparison
input; the server never replaces it with a fresh action-entry read. It is never authority or logged.
For API commands the issued command envelope carries the same value before it can queue. For non-root commands,
immediately after the composite subject lock—and before owner reads/writes—the workflow requires the
same current `active` generation. Root setup has one intentional replay ordering under that lock:
(1) Athletes classifies `athlete_setup_command_receipt` command/stable-intent hash; an exact receipt returns the
original created result and mismatched reuse conflicts; (2) only a new command checks that the
captured generation is the current `absent | deleted` generation; and (3) one UoW inserts the
receipt/profile and advances Identity to a fresh `active` generation. The receipt stores both source
expected generation sequence/commitment and result active generation sequence/commitment plus the
created profile ID/canonical hash; the raw tokens are absent. Exact replay requires the current
active generation/result to match that stored result. A receipt whose subject, either generation,
result, or current lifecycle shape is inconsistent fails closed. Subject deletion
deletes the receipt before advancing to a fresh deleted generation, so replay before deletion
succeeds but a post-delete stale retry cannot match and fails the generation gate.

Subject deletion advances the retained owner's row to a fresh `deleted` generation in the same UoW
after deleting athlete facts; a fully deleted trainee account cascades the row. A queued pre-delete
setup or any ABA-stale command therefore fails `subject-data.deleted` even if a genuinely fresh
setup has already rebuilt a new active generation. A post-delete form receives the new opaque token
and may explicitly rebuild. Subject export includes lifecycle state/sequence and receipt provenance
but redacts the opaque token with a documented control-metadata omission; owner subject-deletion
preview discloses that the fact-free generation row is retained solely as an anti-resurrection
fence, while receipts are deleted. Product provenance never stores the raw token: it stores the
sequence plus `SHA-256("indigo-subject-generation-v1\\0" || generation_id)` commitment. Raw values
are denied from logs, snapshots, hashes, audit metadata, and export; the commitment/sequence remain
exportable and keep v3 verification complete without granting command authority. Identity/instance reset removes it and product-epoch rotation
invalidates every pre-reset token. Migration, preflight, backup/restore, exact retry, and both setup/
delete orderings, including a stale browser tab after delete plus successful rebuild, prove the
contract.

Initial generation has no fictional Training decision. An application workflow obtains truthful
starting/loadability/category-equipment facts and the current safety-eligibility attestation from
Athletes, the installed exercise contract and composed eligibility source from Exercises, the plan
shape and persisted development phase fixture from Methodology, pure load results from Calibration,
and asks Programs to persist the normalized revision snapshot and per-exercise provenance. The
initial source-facts hash, reason/rule, loadability version, exercise-contract/category-equipment
source, phase version, status, and recovery code live with the Programs prescription.

Programs owns append-only `program_legacy_calibration_cutover_receipt` as the sole authority for a
`legacy-cutover-evaluation` basis. The parent stores user, actor, command/stable request hash and one
closed workflow source:

- `athlete-input` names the preallocated same-UoW `program_load_input_outcome` and accepted input;
- `delayed-recovery` names the preallocated same-UoW `program_regeneration_receipt` whose immutable
  source outcome remains unchanged; or
- `root-generation` is itself the receipt for an ordinary new-root command and names the resulting
  root revision.

Every source requires its exact same-subject ID/shape and nulls the others. Ordered
`program_legacy_calibration_cutover_basis_result` children store exercise, evidence-current-load
source/hash, exact legacy effective-history boundary/hash, rule release, matching input/regeneration
basis-result child(s) or root prescription(s), and resulting Calibration basis. The occurrence-
scoped workflow children/prescriptions separately store the exact phase projection and may reuse the
same cutover basis for repeated planned occurrences. Child ↔ Calibration basis deferred FKs plus
source/result constraints prove atomic creation without later mutation. Unique subject/exercise/
evidence-current-load/rule/effective-history-boundary and command identities prevent a second cutover basis
for the same evidence target. Immediate first-input, delayed recovery, and later new-cycle/root
generation therefore converge correctly. A pre-Stage-4
completed program may therefore save inventory as `no-future-work` and later generate a new root
without losing its qualifying history or inventing a delayed blocked-outcome receipt. This table is
personal data covered by export/deletion/reset/preflight/backup with the other Stage 4 schema.
Every occurrence-level input/regeneration basis-result child or root prescription produced from this
mode carries a same-source `legacyCutoverBasisResultId`. Deferred constraints require each such
occurrence to reference exactly one cutover child, each cutover child to have at least one occurrence
in its own workflow result, and the cutover child ↔ Calibration basis relation to be one-to-one.
This is the explicit one-basis-to-many-occurrence mapping; no prose-only “matching child” inference is
permitted.
Any newly accepted correction on a legacy historical boundary with no current-contract basis is
authoritative `correction-replay`, not legacy cutover: its correction identity/effective boundary
supplies the first basis authority directly. Once that basis exists, safety-only session-feedback
correction reuses its exact ID/hash; only a correction that changes basis inputs appends a replacement
basis. Later input/root paths reuse the current basis. Performed-set-first and feedback-first legacy
vectors therefore do not fabricate a cutover receipt, while an untouched legacy boundary still
requires one.

Programs also owns append-only `program_load_input_outcome`, the durable original result for an
Athletes-owned loadability version or starting-load correction. Each row carries ID, user ID, input
kind, exactly one input-version/correction ID, creation time, ordered per-exercise basis-result
children, an optional consumed planning-source quarantine ID/hash, an optional exact resulting
generalized projection-quarantine ID, and a closed outcome union:

- `revision-created` with the exact created program revision ID, independent of its later mutable
  draft/active/superseded status; or
- `no-program-yet` or `no-future-work`, each with a null revision ID;
- `no-republication`, with the exact revoked release, null revision, and complete quarantine
  relation; or
- `projection-blocked`, with a closed repairable/integrity owner-source reason,
  `correction.historical-replay-deferred`, or `projection.active-session-recovery-pending`, exact
  recovery, null revision, and complete quarantine relation. The latter two are legal only while
  transferring a head with matching nonempty correction or post-abandonment session-invalidation
  ancestry and use `regenerate-program`.

`no-program-yet | no-future-work` require no consumed unresolved head. `revision-created` may consume
one only through the direct-resolution shape below: zero correction/session-invalidation ancestry and
an exact occurrence-to-new-revision bijection. Any other consumed head must transfer to a new
quarantine under a failure-to-publish result.

Each `program_load_input_outcome_basis_result` carries outcome, exercise and continuation ordinal,
exact phase source/sequence/occurrence and projection-anchor source when reached, plus the closed source kind
`current-basis | deferred-mode`. Current requires its exact same-subject basis ID/hash; deferred
requires the original evidence mode and no fabricated basis. Each child binds
either the resulting exercise prescription for `revision-created` or its matching quarantine-
continuation exercise for a failure-to-publish outcome. `no-program-yet`/`no-future-work` have zero
children because no exercise was recomputed. Deferred triggers require complete, ordered,
nonduplicate coverage of every recomputed remaining exercise and reject a scalar/partial summary.
`deferred-mode` is legal only for `no-republication | projection-blocked` and must bind quarantine;
`revision-created` forbids it because an unverifiable basis cannot produce a derived revision.
The legacy cutover receipt references this exact child for an immediate-input source.

Programs owns the generalized append-only quarantine, shared by input and correction projection
failures:

- `program_projection_quarantine` is the immutable historical parent. It stores user, stable continuation hash,
  failure reason/recovery, prior active/draft scope, ordered deferred-correction and session-invalidation
  ancestry commitments, and exactly one source kind
  `load-input-outcome | training-correction-projection-outcome` with its same-subject FK.
- `program_projection_quarantine_head` is the single mutable Programs current-state row keyed by
  user. It stores the current quarantine ID plus monotone sequence/hash; the owning UoW compares and
  swaps it when a later input/correction transfers the debt and clears it only on successful
  recovery. It is current-head lookup authority, not historical provenance.
- ordered `program_projection_quarantine_occurrence` rows store original program/revision/workout/
  prescription identities, remaining-work/workout/exercise ordinals, exercise code, development
  phase sequence/occurrence/source hash, evidence basis ID/hash or deferred evidence mode, logical
  projection-anchor source/hash, prior active/draft status, availability/derivation provenance, and
  a canonical occurrence hash.
- ordered `program_projection_quarantine_correction` rows store quarantine, ancestry ordinal, exact
  same-subject Training correction outcome and Programs correction-projection outcome, and the
  canonical identity/hash of that outcome's complete deferred decision-result subset. A transferred
  child additionally names the exact prior quarantine-correction child. These rows are the persisted
  unresolved historical-replay ancestry; it is never inferred from resolution history.
- ordered `program_projection_quarantine_session_invalidation` rows store quarantine, cause ordinal,
  exact same-subject Training execution-invalidation ID/hash and invalidated session/revision. A
  transferred child additionally names its exact prior quarantine child. For an active-session
  outcome, the set is nonempty, includes the outcome's newly appended cause, and equals every valid
  execution-invalidation cause for that still-blocked session at the outcome boundary. Later
  corrections before abandonment append one new cause and transfer every prior child; none may be
  overwritten or collapsed into a one-row session flag.
- `program_projection_quarantine_resolution` appends exactly one closed
  `superseded-by-projection-attempt | recovered-by-projection-attempt |
  recovered-by-revision | recovered-without-future-work` edge,
  with exactly one resolving load-input/correction outcome or successful regeneration receipt and
  optional result revision as its shape requires. `superseded-by-projection-attempt` additionally
  requires the resolving outcome's new quarantine ID and matching continuation hash plus bijective
  occurrence/correction/session-invalidation child coverage; it cannot resolve the old head by
  pointing at an outcome that did not transfer the debt.
  `recovered-by-projection-attempt` instead requires that input/correction outcome's shaped
  `revision-created` result, exact consumed old-quarantine ID/hash, and no new quarantine. Its new
  revision/prescriptions must bijectively reconstruct every old quarantine occurrence with the same
  continuation sequence/ordinals; partial, reordered, unrelated, or skipped occurrences cannot clear
  the head. Direct `no-future-work` is not a legal recovery of a nonempty continuation. This shape is
  legal only when the old quarantine has zero correction-ancestry **and** session-invalidation
  children; otherwise the new outcome
  must transfer the debt to a new quarantine for receipt-bound recovery. Receipt-recovered kinds
  require the successful receipt and its shaped optional revision.

Deferred same-subject/source/ordinal FKs require complete nonduplicate coverage of every formerly
startable active/draft **unstarted** remaining occurrence. Ordered correction children must equal
every unresolved deferred Training outcome carried by the source attempt; ordered session-
invalidation children must equal the carried immutable execution causes. Transfer requires a one-to-
one old/new mapping for every existing occurrence, correction, and session-invalidation child; a
later same-session correction adds exactly its new cause only. Every receipt join must bijectively
cover the current head's correction children. A zero-occurrence quarantine is legal in exactly two
shapes: (1) Training correction replay debt with no remaining program work, a
`no-republication | projection-blocked | projection-deferred-active-session` result, and at least one
deferred historical result; or (2) `projection-deferred-active-session |
projection.active-session-recovery-pending` with no unstarted later workout and a nonempty exact
session-invalidation child set. The first keeps replay debt visible; the second keeps execution
recovery visible without inventing future work. The stable continuation hash
covers the ordered occurrence, correction-child, and session-invalidation-child sets. Deferrable
constraint triggers lock/check the pointer target, require that it has no resolution, and require
every unresolved quarantine to be the subject's sole head. Direct or concurrent parent inserts can
therefore never fork merely because “unresolved” is represented by absence of a child.
Every later input or correction must consume/transfer that same head before classifying ordinary
active/draft/no-future scope; it cannot create a parallel continuation. Quarantine and resolution are
immutable personal data; the CAS head is mutable current-state personal data. Current v3 readers
reject every quarantined source.

`projection-deferred-active-session` has a nonempty exact session-invalidation child set, but its
occurrence set bijectively covers only unstarted planned exercise occurrences strictly after the
invalidated session's workout ordinal. It is nonempty when such future work exists and zero for a
last-workout session. The current workout's zero, partial, or fully recorded set state never changes
that boundary and is not encoded as a restartable prescription. Missing/extra/current-workout/cross-
session occurrence mappings and missing/duplicate/stale invalidation causes fail. With deferred
history the same quarantine also has correction children; without it that set is empty. Before
abandonment, later inputs fail the active-session gate and cannot consume or transfer the head; a
later correction must transfer it, bijectively preserve all prior causes, and add its own. After
abandonment, any admitted input/correction may only transfer a head with session-invalidation
ancestry; absent a higher content/owner block its typed result is
`projection.active-session-recovery-pending | regenerate-program`. Only Regenerate may resolve it.

Partial unique identities allow exactly one outcome per input. Discriminated shape checks and
composite same-subject FKs reject a wrong input/revision owner. For a later update, Programs
validates that `revision-created` names the revision with the matching typed lineage cause; for an
initial/replacement draft root, it validates the persisted prescription source version instead of
fabricating a non-root cause. Mutable revision status is not part of the original outcome.
Before accepting any failure-to-publish outcome, Programs proves the complete current active/
draft planning scope and appends the generalized quarantine, retiring every future projection whose
old input would otherwise remain startable. Its occurrence rows preserve the exact unstarted
remaining-work projection as a nonexecutable continuation source. A zero-occurrence correction head
instead preserves deferred-replay ancestry, execution-invalidation ancestry, or both under the exact
shapes above. Quarantine identity/
reason is durable, v3/current readers reject it, and exact
replay returns the original fact + quarantine/result even after repair. If complete quarantine
cannot be proven or applied, the athlete fact and outcome roll back. A later Regenerate consumes the
latest admitted input, current owner sources, and that continuation—never a fresh sequence/root that
repeats or omits work. Transient blocks use `regenerate-program`, while
integrity failures use `no-self-service`.

The generalized quarantine continuation participates in planning scope ahead of `no-program-yet`/
`no-future-work`. A later loadability/starting input or factual correction while it remains unresolved
transfers the same remaining-work/debt state to the newer Programs outcome and appends the one
typed resolution. Exactly one unresolved head per subject is enforced by the head row plus database
proof under the subject lock; repair,
input, and correction cannot fork it. Historical outcomes stay immutable for replay. Deferred
triggers reject orphan, duplicate, cycle, partial transfer, and fork rows. Same-kind/cross-kind input,
input-versus-correction, two correction, and Regenerate-versus-either races prove the newest accepted
attempt owns the one continuation/debt state without resetting or erasing it.

`no-program-yet` and `no-future-work` are successful replayable outcomes, not
missing data. The Programs gateway appends this row in the same `UnitOfWork` after the input and
optional revision, then replays it by the passed input identity; it never asks Athletes tables for
facts. An exact Athletes command with no corresponding valid outcome indicates an impossible
partial/corrupt state and fails closed. The table is immutable personal data covered by export,
deletion/reset, migration, preflight, and backup/restore in Stage 4. Hostile partial quarantine,
revoked content, transient owner failure, repair, exact replay, start-currency, and both race
orderings are mandatory for both input kinds. Active and draft failure-to-publish then repair vectors
prove remaining-work/phase ordinals do not reset.

Programs owns append-only `program_regeneration_receipt` for every delayed recovery that
successfully resolves an immutable blocked/stale continuation or deferred historical-replay debt.
Its closed source is
`safety-hold-resolution | projection-quarantine | stale-program`. The stale-program source names the
exact program/revision/continuation hash and one reason `temporal-boundary-crossed |
exercise-contract-source-changed | category-equipment-source-changed | phase-source-invalid |
content-source-replaced`; it cannot be a
generic caller claim. The receipt stores actor/command/stable request hash, exact source identity,
the quarantined/blocked/stale continuation projection, an ordered
`program_regeneration_receipt_basis_result` child set, the ordered correction-recovery joins,
normalized-input hash, and one total result:

- `revision-created` requires the resulting root revision/draft and complete nonduplicate basis-
  result children for every recomputed remaining exercise. Each child carries its exact continuation
  ordinal, phase and logical projection-anchor source, current basis, and resulting prescription.
  Any legacy cutover receipt references the exact matching child. The root carries
  `continuation-regeneration` provenance and preserves remaining-work phase sequence/ordinals; or
- `historical-replay-recovered-no-future-work` requires a zero-occurrence projection quarantine with
  nonempty correction ancestry, null revision, zero occurrence basis-result children, at least one
  complete Training correction-recovery join, and the matching `recovered-without-future-work`
  resolution. Session-invalidation ancestry may additionally name one now-abandoned session. It reports successful
  chronology repair without inventing a program. An ordinary root-generation command refuses while
  this debt head remains unresolved; after history-only recovery, a separate ordinary command may
  allocate a new phase sequence under its normal initial-generation provenance; or
- `active-session-cleared-no-future-work` requires a projection quarantine whose occurrence and
  correction-child sets are empty, whose session-invalidation set is nonempty and belongs to one now-
  abandoned session, a null revision, zero basis-result/recovery joins, and the matching
  `recovered-without-future-work` resolution. It reports that the corrected workout was concluded and
  that no later planned workout remains; it never fabricates or repeats the abandoned workout.

Every `safety-hold-resolution | projection-quarantine | stale-program` source/continuation has at
most one successful receipt, enforced uniformly by unique source-kind/source-ID/continuation-hash
identity; command identity separately governs replay/conflict. Failed attempts write none, and exact
recovery replay returns the receipt, Training recovery set, and optional revision. A successful
quarantine recovery appends exactly one same-UoW resolution of kind `recovered-by-revision` or
`recovered-without-future-work` and clears the head atomically. Missing recovery ancestry, current
owner failure/revocation, or any other no-publication result leaves the head unresolved, appends no
Training recovery/Programs receipt/revision/resolution, does not claim the command, and returns a
typed no-mutation result so a later retry rereads current state. Regeneration receipts are success-
only; receipt/result/revision/resolution deferred constraints ensure replay cannot resolve twice or
leave a published continuation current.
Temporal-boundary, registry/category-source, phase-source, and replacement-content stale-program
recovery each have exact replay plus Regenerate-versus-source-change/input/correction race vectors;
none can masquerade as initial generation or reset a preserved sequence/ordinal.
The receipt is also a real dependency edge: Programs' closure traverses receipt → preserved
continuation/source prescription/revision, not only ordinary basis and inherited-prescription
edges. If a later correction or owner-source invalidation reaches any preserved source, the
regenerated root and every dependent prescription close before they can remain executable.

For a deferred active-session correction, abandonment first closes the invalidated session; then
Regenerate selects the now-current final correction/evidence boundary under the lock. It publishes
only the preserved unstarted later-workout continuation; when none exists it uses the applicable
history-recovered or execution-only no-future result above. If later facts
won first, it truthfully uses that newer current basis while retaining the source blocked outcome in
the receipt. Recovery-first publishes once and a later writer rebases normally. Uniqueness is one
result per recovery command/input hash, not one forever per correction. Hostile mismatched
continuation/basis/source, correction replay versus recovery replay, two concurrent recovery
commands, later-evidence-before-recovery, and both abandonment orderings are required. Generalized
non-root lineage keeps its four causal kinds; delayed recovery is an explicit Programs root receipt,
so it does not invent a fifth non-root cause. Correction-after-regeneration and regeneration-after-
correction vectors prove both closure orderings, including preservation of an independently valid
later estimate while the continuation-derived load closes.

For normal completion, the application workflow opens one `UnitOfWork`. A neutral coordination
gateway first acquires the canonical athlete advisory lock. The transaction-scoped Training
gateway constructs effective facts, records its own decision/session transition and Training-owned
decision/revision-invalidation provenance, and performs Training-owned recursive invalidations. The
Calibration gateway receives only passed facts/identifiers and appends or invalidates its own
estimate lineage. The Programs gateway alone writes and activates the next remaining-work revision,
including its chronological parent, basis dependency, and typed cause lineage.
Before compute/publish, Athletes supplies the current safety attestation and category-equipment
projection, Exercises supplies the current installed contract and owner-composed eligibility
source, and a pain hold created in the same completion is reflected before Programs receives an
available result.
All gateways bind to the same transaction and are unusable after the callback. The workflow never
receives a raw transaction, imports schema tables, or performs DML.

Correction uses the same owner split for dependency closure and any replacement branch. Existing
advisory-lock, command-receipt, replay, conflicting-command, concurrency, authorization, and
optimistic-version guarantees remain part of the contract.

Training stops inserting `program_revision`, `planned_workout`, `exercise_prescription`, and
`set_prescription`; the four Programs/Training debt grants are removed. Stage 6 removes the legacy
development adjustment production call and authority. Stage 8 separately removes the hardcoded
initial-load generation path; there is no phase in which two post-session engines remain callable.

### Future-prescription projection and unavailable lifecycle

Factual workout completion is not rolled back merely because a future load is unavailable.
Training emits a decision only for a session exercise whose rule-required effective performed-work
input exists (at least one explicitly confirmed performed working set plus its terminal working-set performed/skip
shape). A blocked/no-set snapshot and an all-skipped or untouched exercise produce no fictional
decision. If future workouts remain, Programs creates and activates a remaining-work revision with
two orthogonal closed fields on each exercise prescription:

- availability is `available | blocked`; an available prescription has non-null sets, while a
  blocked prescription has no sets plus reason/recovery provenance; and
- derivation is either `computed` with a typed compute cause, `inherited` with
  `sourceExercisePrescriptionId` plus the parent's exact compute/block provenance. Compute cause is
  `initial-generation | session-decision | training-fact-correction | loadability-update |
  starting-load-correction | continuation-regeneration`, or the migration-only
  `legacy-source-blocked` shape described below.

This represents computed/inherited available and blocked states without inventing a session.
`session-decision` requires the same-subject/source-session decision. Non-root non-session compute
causes require their matching generalized revision-lineage cause. `initial-generation` requires a
true new-sequence root; `continuation-regeneration` requires the exact same-subject Programs
regeneration receipt with its shaped `safety-hold-resolution | projection-quarantine | stale-program`
source, preserved continuation, and complete current basis results, and is legal only on that
receipt's `revision-created` root. A stale-program source additionally binds its exact closed stale
reason and source hashes; a projection-quarantine source binds the complete quarantine/recovery
ancestry. Both root causes forbid a Training decision reference. Inherited rows require a same-subject/exercise parent prescription and no new
compute cause/decision. Inheritance is not an unavailable fallback: a same-session blocked result
must be computed-blocked and cannot inherit an older available load. Programs owner code and
database shape constraints enforce the source union. Corrections follow source-prescription chains
so invalidated available **or blocked** provenance cannot survive in a descendant; hostile fixtures
cover every compute cause, inherited-block, fictional decision, wrong-root/receipt/source
discriminant/stale reason, and wrong-subject parent attempts.
Mixed-workout proof asserts that a visible blocked/no-set snapshot creates zero decision rows.

Stage 6 can complete a session that was already snapshotted before the Stage 4 upgrade. For an
untouched future exercise whose parent is `legacy-unverified-load`, Programs must emit the third
derivation `legacy-source-blocked`: availability `blocked`, no sets, exact parent prescription/
revision/output-hash identity, reason `legacy.inventory-required`, recovery `update-loadability`,
and **no** invented phase, estimate, loadability, safety, rule, or Training-decision provenance.
This bridge preserves historical identity without carrying an unverified executable load. Only the
Stage 6 legacy-completion path may emit it. Stage 8 inventory/root regeneration replaces it with a
fully current computed prescription; it can never start or be inherited as available.

Training copies the Programs-owned blocked state into its immutable session snapshot for mixed
workouts. Every `session_exercise` persists the exact source `exercise_prescription_id` with a
same-subject/source-planned-workout composite FK, plus copied availability/reason/recovery fields;
each `performed_set` persists its exact same-exercise/source `set_prescription_id`.
`workout_session` stores `workout-session-snapshot-v2` hash material over its source workout,
ordered exercise/set snapshots, exact source-prescription identities, blocked shapes, and safety
attestation ID/hash. Resume, set mutation, correction, and completion reconstruct relational hash
material and fail closed on row/snapshot/hash disagreement. Before snapshotting, start reconstructs
v3 and rejects invalidated/quarantined planning sources; rechecks lifecycle generation, exact
methodology/template releases, installed Exercises registry plus athlete category-equipment source,
current basis/estimate/loadability sources, and the athlete-local date against every available
prescription's temporal-valid-through boundary; then rereads the current safety attestation under
the subject lock, compares it with the prescription source, and
persists the exact eligible attestation ID + subject composite reference on `workout_session`.
Changed or blocked safety
state rejects start without a partial session. Training may start a mixed workout only when at least one exercise is available; the
blocked exercise remains visible but has no completable sets. A wholly unavailable workout cannot
start. When no future workout remains, the Training decision is still recorded and no empty
revision is invented.

Resolution is reason-specific and closed: missing inventory routes to the versioned loadability
update; corrected performed facts route through the correction workflow; profile-incomplete routes
to setup; eligibility restriction has no self-service medical-clearance action; and a session-pain
hold routes to the existing acknowledged hold-resolution workflow. Loadability/starting-load/fact-
correction recovery can publish its typed future revision. Hold resolution deliberately does not
invent a fifth revision cause: it appends the owner resolution, leaves the blocked prescription
immutable, and changes deterministic UI to “Regenerate program.” That existing root-generation
workflow consumes the now-current safety attestation and publishes a continuation-regeneration
replacement draft; activation
retires the blocked active program. Both resolution/regeneration orderings and exact command replay
of the hold-resolution command are tested. A nonstale ordinary Regenerate retains Programs'
normalized-input-hash idempotence and creates no receipt. Temporal expiry, installed Exercises/
category source drift, invalid phase source, or replacement content release uses the exact checked
`stale-program` regeneration receipt; quarantine/hold recovery uses its corresponding closed source
in §7. `normalized-input-v3` includes exact
starting-load, evidence-current-load, projection anchor, loadability, exercise/category, phase, the
ordered per-exercise current/deferred basis-result list, active-estimate/effective-history, and safety-attestation IDs
plus hashes. “Unchanged current result” means non-invalidated, integrity-valid, exact-source-current, and
state-eligible; an invalidated/quarantined row is never a dedupe candidate even when historical
hash bytes match. An unchanged eligible current result is returned, while a delayed retry after any
source change creates only the draft for those latest facts. Pain-hold resolution alone changes the
safety attestation/hash and therefore creates a new eligible replacement; correction invalidation
also prevents reuse. A resolved hold cannot leave the trainee permanently blocked or silently
reuse the old load.

Appending a loadability version is itself an application workflow. The neutral
`SubjectWorkflowLock` gateway acquires the canonical athlete lock first, then Athletes classifies
the command ID/hash. An exact replay returns the persisted discriminated
`program_load_input_outcome` and mismatched reuse
conflicts without consulting mutable state. Only for a new command does a transaction-scoped
Training coordination gateway assert that no initializing/active/paused session exists. Programs
then classifies the current unresolved generalized projection-quarantine head, active program, and
independently permitted draft. The priority is total and produces at most one revision: (1) an
unresolved continuation is transferred/resolved against the new input; (2) otherwise active
remaining work is rebased/activated and any pre-existing draft is retired as stale; (3) otherwise,
a draft with future work is replaced by a newly computed draft/root; (4) an active program with no
future work and no draft yields `no-future-work`; (5) no continuation/draft/active program yields
`no-program-yet`; and (6) every
remaining shape, including a current draft with no future work, returns the closed
`program-input.invalid-planning-state` error without input or outcome mutation. The two successful
terminal branches request no absent prescription/phase facts and invent no revision. Every
admitted branch atomically asks Athletes to append the inventory and Programs to append the
matching discriminated outcome. A revision-producing or failure-to-publish branch additionally asks Athletes for
bootstrap anchors plus current safety attestation, Training for normalized effective performed-fact/
correction attestations, Programs for current prescription/phase facts, and Calibration to
resolve basis/active estimates and recompute every remaining exercise. A revoked release yields
`no-republication`; a repairable/integrity owner-source failure after complete quarantine yields
`projection-blocked`; incomplete dependency/quarantine proof rolls back. The active branch
activates the new available/blocked future revision; the draft branch preserves the old revision
immutably, retires its stale program, and publishes a replacement draft/root. Either branch records
  status-neutral `revision-created` with the sole new revision atomically. Failure-to-publish branches
  record their exact continuation/quarantine/basis-or-deferred outcome and expose delayed Regenerate.
Retiring a collateral stale
draft gives deterministic “Regenerate program” UI; it never silently activates that draft. No
workflow reads
Training tables through a peer or neutral gateway. Prior revisions and started/completed session
snapshots retain the old version and meaning. A blocked-after-performed-evidence integration case
proves a valid inventory update recovers through the composed active-estimate path, while invalid
estimate evidence remains blocked.

An incompatible starting-working-load has its own Athletes-owned recovery path. The athlete appends
a corrected attestation version under the same workflow lock and active-session assertion as a
loadability update; it rejects without mutation while a session is initializing/active/paused and
otherwise follows the same full Programs planning-scope/outcome union, including unresolved
continuation, `no-program-yet`, `no-future-work`, `no-republication`, `projection-blocked`, or a
status-neutral `revision-created` result. The original
`strength_baseline` fact is never updated or deleted. The initial/future workflow then builds a new
revision from the effective latest attestation. Input validation rejects out-of-domain values, and the engine returns
unavailable with `starting-load.no-attainable-at-or-below` when inventory has no safe attainable
total at or below the attested value. Deterministic UI copy routes that reason to “Correct starting
load” and/or “Update bar and plates.”

Initial generation, draft activation, loadability update, starting-load correction, workout start,
training-fact correction, completion, abandonment, and delayed Regenerate use the same
`SubjectWorkflowLock` port and canonical key. Each compute/publish/activation/start path composes
Athletes category-equipment with the installed Exercises contract and rechecks the exact source;
contract/category mismatch returns the typed regeneration requirement and never starts stale work.
The neutral lock gateway
owns no domain reads; every product assertion remains in its owner gateway. Initial fact reads,
pure compute, persistence, and any immediate activation occur inside that locked transaction. A later draft
activation compares its persisted loadability/phase source versions with the current versions
and rereads the Athletes safety attestation under the lock; it rejects stale/blocked provenance
instead of publishing it. If an input update wins
against activation, it replaces/retires the old draft and activation of that old revision rejects;
if activation wins, the update rebases the newly active program. An inventory update is
first classified by Athletes as exact replay, mismatched reuse, or a new command. Exact replay
returns the prior version and Programs-owned discriminated outcome without applying later state gates;
mismatch returns `loadability.command-conflict`; only a new command can be
rejected with the closed
`loadability.active-session` reason before appending anything while a session is initializing,
active, or paused. Starting-load correction uses the same ordering, with
`starting-load.command-conflict` and `starting-load.active-session`; its performed-evidence gate also
runs only for a new command. For either input kind, a new admitted command persists exactly one of
the five Programs outcome families described above. If start wins the lock, update rejects; if update wins, a stale planned workout
cannot start after the new revision activates. Every workflow acquires the canonical advisory lock
before owner row locks to keep ordering deterministic. After completion/abandonment, update rebases
from the latest active future revision. Integration tests exercise generation/update,
activation/input-update, start/input-update, completion/input-update, training-fact-correction/input-
update, and abandonment/input-update in both lock orderings for each athlete-input kind. They also
exercise two loadability updates, two starting-load corrections, and one update of each kind against
the other, again in both orderings. After the first participant commits, the second must reread and
either rebase from that latest valid state or return its typed
`loadability.active-session`, `starting-load.active-session`, or
`starting-load.superseded-by-performed-evidence` conflict without
mutation. No obsolete load, inventory, phase, decision, or invalidation snapshot can activate, and
no later workflow can lose an earlier committed update. Successful replay after a session starts is
covered for both input kinds; starting-load replay is also covered after performed evidence becomes
authoritative. Initial-setup (`no-program-yet`), completed-program (`no-future-work`), revoked
(`no-republication`), and owner-blocked (`projection-blocked`) outcomes are covered for both input
kinds. Those replays return the original discriminated response and never create a row;
`revision-created` replay is unchanged after later activation or supersession, and a failure-to-
publish replay retains its original quarantine even after repair.
Missing/duplicate/inconsistent outcome rows fail closed. Both draft-update/activation orderings and
exact replay after replacement/activation are explicit integration cases. Active-plus-draft,
input-update/generation, and input-update/activation cases in both lock orderings prove the priority,
latest-input regeneration, collateral stale-draft retirement, and exactly one caused revision/
outcome. Hostile current-draft-without-future-work fixtures prove typed fail-closed/no-mutation
behavior.

The existing exact content-release gate remains independent and mandatory. When an initial/input
publisher, draft activation, workout start, Training perform/skip/resume/completion, or correction
form/command is issued, its authorized owner projections supply every required opaque slot for the
sealed plan above. The PostgreSQL adapter—not Programs or workflow code—consumes the scoped verified
capability and acquires every canonical methodology/template key after the subject lock and before
`BEGIN`. After Identity/lifecycle rechecks and before any mutation, each required owner gateway
re-derives its transaction-bound fragment: Training owns historical/potential-impact dependencies,
Programs owns current/future program sources, and Methodology owns the release/template target. The
opaque attestor proves the closed slot union exactly equals the prelocked set and then each owner
re-evaluates its own invariants, including exact-version revocation. Fact correction is deliberately
split: after those pre-transaction content locks and transactional authority checks, Training may
append an authorized factual correction
and invalidate dependent decisions/estimates/revisions even when Programs revalidation says the
source release is revoked; it must not publish a replacement revision or permit further execution
from that release. This preserves the athlete's ability to correct personal facts without turning
revoked methodology back into executable work. Revocation therefore overrides the rule that
factual completion succeeds when calibration alone is unavailable, but not the factual correction
append. The revocation workflow acquires the same keys. If revocation wins, no new revision becomes
available and no later session/set mutation uses the release; if an eligible publisher/mutation
wins, the append-only revocation affects only later attempts and historical rows remain visible.
Both race orderings—including correction-with-invalidation/no-republication, an athlete-input
update that would otherwise produce a revision, and a completion with no future work—are
integration-tested. Workflow code and peer modules never read `content_release_revocation`
directly.

### Generalized program-revision lineage

`program_revision_lineage` becomes Programs-owned because every revision—not only a Training-
completion revision—needs truthful chronological and dependency edges. The existing
`parent_revision_id` becomes the single chronological `previousRevisionId`; additive
`basisRevisionId` names the valid revision whose future projection was used. Existing rows retain
their parent as both edges. A correction replacement can therefore follow an invalidated
chronological predecessor while deriving only from a still-valid basis. Each non-root row has
exactly one cause:

- `session-completion` with source session and program ordinal;
- `training-fact-correction` with source correction;
- `loadability-update` with Athletes loadability version; or
- `starting-load-correction` with Athletes starting-load correction version.

Cause-shape checks plus same-subject deferred constraints reject a fictional session, mismatched
owner, chronological fork, basis cycle, or non-head append. Partial unique indexes preserve the
existing one-revision-per-source-session invariant and add one revision per source correction,
loadability version, and starting-load correction. Programs' gateway treats an exact causal replay
as idempotent and a mismatched replay as conflict; hostile concurrent/replay fixtures prove every
cause identity. Programs' transaction-scoped gateway is the only writer and exposes a public
dependency-closure operation over basis, inherited-prescription, and regeneration-receipt →
continuation/source edges. Training passes
correction identity and appends its own decision/
revision invalidation ledger; Calibration invalidates compute bases and only estimates with an
explicit declared anchor/revision dependency in that closure. For performed-facts-only v1, source
revision remains provenance and only changed estimation facts invalidate the estimate.
Inventory/starting-load revisions are therefore reachable by
later corrections without Training reading Programs tables. `program_revision_invalidation`
remains Training-owned correction provenance; the parent graph itself no longer pretends every
revision was caused by a session.

### Write-fence integration

Stage 4 must:

- add `'calibration'` to `ModuleId`;
- add the new Calibration schema module explicitly to the `SqlTableName` type imports and schema
  barrel (the compile-time union is not a runtime glob and is not auto-covered);
- add explicit owner entries for every Identity-, Athletes-, Calibration-, Training-, and Programs-
  owned new table, including subject lifecycle/setup receipt; input outcome/basis-result/quarantine/
  resolution; execution-invalidation/correction outcome/recovery; regeneration receipt/basis-result;
  and legacy-cutover receipt/basis-result tables; and
- keep Calibration out of `NON_WRITING_MODULES`.

The four Programs/Training grants are removed only when Stage 6 moves the actual writes.
The Stage 4 additive schema migration keeps the still-live legacy `program_revision_lineage` writer
and manifest owner as Training. In the Stage 6 cutover commit, Programs' gateway becomes the only
writer, the manifest owner changes to Programs, and Training's direct lineage insert disappears.
This is an explicit transitional state, not dual target ownership. Training-owned
`program_revision_invalidation` remains separate correction provenance.

---

## 8. Persistence and portability are one change

Calibration estimates, complete compute bases and invalidations, loadability inventory, starting
correction date provenance, safety attestations/hold-source children, input/correction outcomes and
basis results, correction-recovery receipts/results/joins, quarantine heads/occurrences/correction-
ancestry children/resolutions,
regeneration/cutover receipts and children, exercise/category source snapshots, Training execution-
invalidation causes and Programs quarantine session-invalidation ancestry,
phase/load provenance, and blocked-prescription state are personal data. The migration that makes them writable is incomplete unless the same
stage updates:

- versioned subject export with facts, estimate/basis provenance,
  outcomes/ordered basis results/correction recoveries/quarantines, heads, occurrence/correction/
  session-invalidation-ancestry children, regeneration/cutover
  receipts, invalidations, and rule/source hashes;
- deletion preview/count/execution for subject deletion and instance reset;
- E2E reset inventory;
- startup preflight and fresh/additive-upgrade migration proof;
- backup/restore inventory and integrity proof; and
- schema ownership O1–O5.

Database-trigger writes are not invisible exceptions. The Stage 4 ownership test inventories every
DML edge in the effective post-ledger live trigger graph: ordered checked-in migrations are replayed
into disposable PostgreSQL, live `pg_trigger`/`pg_get_functiondef` are read and mapped to the last
effective source migration (or an ordered create/replace/drop resolver proves catalog parity).
Superseded function bodies and dropped trigger/functions are historical, not live edges. Each live
edge records trigger/function, last source migration, firing source table/event, source owner, target
table/operation, and target owner. Physical `externalWriters: db-trigger` attribution
must be bijective with those targets, but it never launders the firing module into a neutral writer:
each edge also retains its initiating source owner. A cross-owner edge requires an explicit bounded
debt record and removal stage. The census covers the existing Better Auth-user → Identity
installation bootstrap edge, the new same-owner Better Auth-user → Identity
`subject_data_generation` edge, and the live Training `program_revision_invalidation` trigger's
Training→Programs effects. Stage 6 drops `indigo_apply_program_revision_invalidation` and its effect
trigger: Training's gateway performs Training-owned session invalidation, Programs' gateway performs
Programs-owned revision/program transitions in the shared UoW, and the Training table remains
provenance only. Final Part B architecture proof rejects every trigger-mediated cross-owner DML edge,
plus missing, wrong-owner, source-owner-erased, or stale trigger attribution. Replacement/drop
fixtures prove historical DML neither false-fails the current graph nor survives a later replacement/
drop.

Stage 9 later replaces Data Portability's direct operator projection with per-module ports; that
architectural refactor cannot justify omitting new personal tables in the interim.

### Executable integrity versions

Every current calibrated revision uses the exact discriminator `executable-prescription-v3` and
`normalized-input-v3`. The normalized input projection includes subject lifecycle sequence plus
domain-separated generation commitment (never the raw token),
starting-working-load source ID/hash/date provenance, evidence-current-load and projection-anchor
source unions, loadability version/hash, current/previous phase source,
effective Training history attestation and sources, installed-exercise/category-equipment source,
compute mode plus ordered per-occurrence current basis ID/hash or deferred mode
result, consumed/new estimate material, exact safety-
attestation ID/hash, methodology/template releases, and `asOfDate`/IANA-timezone source. The output
projection includes every executable and blocked field: revision/workout identity and ordinals;
exercise availability; computed/inherited/legacy-source-blocked derivation and cause/source
identity; phase; temporal anchor kind, exact source identity/hash, athlete-local anchor date, next
boundary kind, and temporal-valid-through date; exercise/category-equipment source;
direction/reason/rule/recovery; estimate/loadability source unions; safety
attestation reference; exercise/set identity and ordered loads/repetitions/rest; and every parent/
history-source identity that can affect correction closure. The persisted JSON snapshot, canonical
hash, and relational columns/child rows must agree.

After their named Stage 6/8 cutovers, current writers emit v3 only. Readers retain exact byte-compatible v1/v2 reconstruction and fixed
hash vectors; migration never retags or rewrites their snapshot/hash. Initial persistence, input
recompute, completion/correction publication, draft activation, and workout start reconstruct the
appropriate version from owner rows and verify normalized input, output snapshot, and output hash.
Unknown versions or any column/child/snapshot/hash disagreement fail closed before activation or
execution. Hostile tests independently alter availability, blocked reason, derivation/cause,
parent, phase, estimate/loadability/history source, temporal anchor/boundary, safety attestation, and set rows. The separate
`workout-session-snapshot-v2` integrity contract then binds the exact v3 source prescription and
attestation into immutable Training history; legacy workout-session v1 bytes remain readable.

### Legacy upgrade discriminants

Existing append-only facts are not rewritten to impersonate the new contract:

- migrated `adjustment_decision` rows receive the archival contract discriminator
  `legacy-development-v1`; its historical `unavailable` row may retain a non-null candidate load,
  but consumers never interpret that value as an executable recommendation;
- rows written by the still-live legacy completion path between the Stage 4 migration and Stage 6
  cutover continue to receive `legacy-development-v1` from the transitional database default;
- only the Stage 6 calibrated completion/correction gateways explicitly emit
  `calibration-decision-v1`, whose database shape requires `next_load_grams IS NULL` exactly when
  unavailable;
- existing exercise prescriptions and prescriptions written by the still-live legacy completion or
  hardcoded initial generator after the Stage 4 migration receive `legacy-unverified-load`. Those
  unstarted rows are immediately non-startable; neither legacy writer may populate checked current
  provenance. Only the Stage 6 calibrated completion gateway emits checked computed/inherited or
  `legacy-source-blocked` shapes, and the hardcoded initial generator remains legacy until Stage 8;
- existing `training_fact_correction` rows receive archival `legacy-correction-v1`, and the still-live
  correction writer keeps that transitional default through Stage 6. Stage 4 creates the outcome,
  recovery, and projection tables but requires no fabricated outcome/basis/replay children for legacy
  corrections. The Stage 6 cutover removes the default, explicitly emits
  `calibration-correction-v1`, and in the same migration enables deferred completeness requiring
  exactly one Training outcome and one Programs projection outcome only for that current contract;
  the writer and constraint switch are atomic, so there is no accepted current-contract correction
  without its total outcome and no legacy correction is backfilled with invented results; and
- existing program revisions remain byte-/hash-stable and do not gain invented phase or inventory
  provenance.

Stage 4 constraints deliberately accept both discriminated shapes; they never infer shape from a
nullable field alone. Stage 8 removes the transitional legacy defaults after both production
writers have been cut over, so every later insert must state its contract explicitly. Historical
legacy rows remain readable/exportable and are not rewritten.

The migration also adds nullable source `exercise_prescription_id` to `session_exercise` and source
`set_prescription_id` to `performed_set`, plus an explicit legacy/current snapshot discriminator.
It backfills a legacy source only through the unique planned-workout → exercise ordinal/code → set
ordinal/target chain and only when code/load/repetition/rest facts agree. Ambiguous or mismatched
legacy snapshots remain null and are labeled `legacy-source-unverifiable`; completion may record
facts and quarantine future work but may not emit a current Calibration decision. Current
`workout-session-snapshot-v2` rows require both source IDs with same-subject/workout/exercise FKs.
No legacy revision/session hash bytes are rewritten. Upgrade fixtures prove exact mapping and
hostile ambiguity, ordinal, code, target, and cross-workout mismatches.

The Stage 4 migration and execution reader/start cutover are one atomic branch checkpoint: every
unstarted `legacy-unverified-load` workout becomes non-startable immediately and Program/Today show
minimal deterministic `legacy.inventory-required` blocked copy. An already-started legacy session
retains its immutable snapshot and may resume/complete. Before Stage 6 its live legacy completion
writer can emit only new `legacy-unverified-load` future rows, which the reader immediately blocks.
After Stage 6, calibrated completion maps an untouched future exercise whose parent is legacy to
`legacy-source-blocked`, never current inheritance. The athlete then
records loadability, and the update
workflow then builds a new future revision with the explicit development phase fixture and complete
calibration provenance. History labels legacy decisions as archival development-policy output,
not current calibrated guidance. Upgrade tests cover unstarted reject, already-started resume/
complete, future quarantine, inventory recovery, and zero fabricated provenance.

Because truthful loadability capture/recovery arrives in Stage 8, the cumulative Stages 4–6 tree is
deliberately not a deploy/merge checkpoint. Those stages may exist as reviewed commits on this
working branch, but the branch must not be shipped until Stage 8 restores the complete J1–J9
recovery path. The final cumulative
gate, not an intermediate ledger row, is deployment authority.

---

## 9. Structured UI and optional explanation

Program, Today, Workout, and History show structured direction, reason code, rule version, load,
evidence/development status, and unavailable state as relevant. A closed deterministic display-copy
catalog supplies a concise explanation for every supported reason plus a reason-specific recovery
action or an explicit no-action state; raw identifiers are provenance, not the only user-facing
copy. Missing loadability has a direct user action. Downward decisions are described as decreases
with their deload/layoff reason, never as a hold.

Programs exposes active and replacement-draft summaries independently; it never suppresses a draft
merely because an active program exists. Today remains grounded in the active program and shows its
blocked truth. Program shows both states, labels the replacement draft, and exposes activation only
after integrity, source-currency, safety, lifecycle-generation, and content-release revalidation.
The canonical safety recovery journey is blocked active → resolve pain hold → Regenerate → blocked
active plus eligible replacement draft visible → activate → old active retired → Today executable.

Program/Today server rendering derives the current athlete-local date from the same owner timezone
projection and suppresses Activate/Start as soon as a persisted temporal boundary is crossed,
showing “Recalibration required” and Regenerate. The server command repeats the authoritative
same-lock check, so stale HTML cannot bypass it. Component/browser vectors pin days 13/14/27/28,
draft-before/activate-after, and page-render/start races for starting, qualifying, and unsupported
anchors.

Stage 8 includes the narrow History correction surface required by `facts.estimation-invalid` and
the starting-load `current-invalid-evidence` blocker. Every persisted
required `correct-performed-fact` recovery deep-links its exact source set into this same editor.
Truthful partial, off-target, high-strain, triggered-deload, and estimator-unsupported rows expose
the same deep link only as a secondary “Correct saved fact” affordance with conditional copy, never
as a required recovery. It edits one source-linked completed set
through the existing append-only correction command/UoW, with reason, audit, confirmation,
authorization, generation, content-lock, and replay/conflict guarantees. Its closed effective-state
union supports performed→performed, performed→skipped, and skipped→performed with load/repetition/
RPE/provenance fields required exactly for `performed` and absent for `skipped`. A revoked source
still permits the factual append/invalidation but no replacement publication. Component/browser
vectors cover all three transitions plus invalid → correct → replacement decision/estimate/future
revision → unblock. Broader bulk editing, Progress comparison, and open-ended History editing remain
deferred.

If the server-derived potential-impact correction closure exceeds the 64-key content-lock-plan bound,
the editor returns `content-lock-plan.too-large | no-self-service` before claiming the command or
saving a correction and says the history is too broad for safe self-service recalculation. It never
truncates the lock set, accepts caller-selected keys, or labels the fact “saved.” The potential plan
for one immutable source is identical across performed→performed, performed→skipped,
skipped→performed, RPE-only, and feedback-only submissions; submitted values choose only the later
transactional causal subset.

`content-lock-plan.stale` is a no-mutation conflict, not a generic retry. The server discards the old
envelope and refreshes/reissues an authorized form. It may preserve only normalized user-entered
values that remain safe when the same source/editor is still present and authorized, then requires
the user to review and submit again; it never automatically retries a mutation with the old token.
`content-lock-plan.invalid` is a generic validation/security rejection: the response and logs do not
echo the hidden token, MAC detail, keys, or binding mismatch, and the UI discards it and reloads a
fresh authorized form. Transactional epoch/generation/authority failures retain their existing
redirect, unavailable, or unauthorized results and take precedence over owner-plan currency after
`BEGIN`. `uow.capacity` and `uow.lock-timeout` remain distinct retryable service states. Browser tests
cover a source changing between render and submit, a stale tab after reset/deletion, safe value
preservation plus required review, tamper without detail disclosure, and prove there is no infinite
retry loop with an old envelope.

Correction result copy separates fact persistence from projection: `no-republication` and
`projection-blocked` say “Correction saved” and then the exact reason no future load was published,
with its real recovery or explicit none. History/Program remove stale Start affordances and never
render the successful correction as a failed save. LLM-off browser cases cover revoked and owner-
source-blocked outcomes plus exact replay. Independently of the primary winner, any current
quarantine with `program_projection_quarantine_correction` children also renders “Historical
recalculation is pending.” The primary recovery/action remains authoritative, and eventual
Regenerate materializes that ancestry before projection. Revoked-plus-deferred and owner-blocked-
plus-deferred browser/result vectors prevent hidden replay debt.
Any post-abandonment quarantine retaining session-invalidation children says regeneration is still
required after the corrected workout and never offers Start/Activate; a newer saved input/correction
does not make that debt disappear. A higher content/owner block keeps its primary copy/action.
No-future revoked vectors distinguish nondeferred replay (`no-future-work`, no quarantine) from
deferred replay (the primary revoked block plus a zero-occurrence quarantine); neither invents a
future prescription.
`correction.historical-replay-deferred` says “Correction saved; historical recalculation is pending,”
keeps that debt visible even when no future work remains, and offers Regenerate. A successful
`historical-replay-recovered-no-future-work` response says the history was recalculated and that no
future program was created; it never claims publication. Generate-new-program remains a separate
action after the debt head is cleared.
`projection-deferred-active-session` instead says the correction was saved, identifies the now-
invalidated active workout without exposing internal IDs, disables further set/session mutations,
and offers “Abandon workout, then regenerate.” It says recorded work will not be repeated. When its
quarantine carries correction children, the same state also says historical recalculation is pending;
after abandonment the stale abandon action disappears, Regenerate remains, and recovery materializes
those children before rebuilding only later unstarted workouts. A last-workout execution-only
recovery says the correction is applied and no later planned workout remains; a history-bearing one
also reports successful historical recalculation without claiming a new program. Zero-set, partial-
set, all-sets-recorded-before-completion, two-corrections-before-abandonment, and both race orderings
with/without later planned work are browser-proven.

Load-input outcomes use the same fact-versus-projection honesty. `no-republication` and
`projection-blocked` say “Equipment saved” or “Starting load correction saved,” then show the exact
reason no program was published and its recovery/none. Program/Today render the preserved
nonexecutable continuation, suppress every stale Start/Activate affordance, and a repairable
Regenerate uses the receipt/continuation. LLM-off browser cases cover active and draft quarantine,
integrity no-self-service, exact replay after repair, and a newer same-/cross-kind input superseding
the quarantine. A valid athlete fact save is never rendered as a failed submission.

Starting-load recovery renders the blocker discriminant truthfully: current qualifying evidence
needs no setup action; truthful current unsupported evidence explains that its conservative current
target remains authoritative and offers only the optional exact-source correction affordance;
current invalid evidence links the exact History source; historical-
invalidated estimate state offers the explicit conservative reset confirmation only when its strict
admission predicate holds. No branch routes the user to an action that cannot change its state.

The optional LLM remains History-only and default-off in this arc. Supporting new decision kinds
requires a coordinated FactBundle, prompt, canonical-prose, validator, cache-key/provenance, offline
baseline, export, and deletion version advance. Closed grounded paraphrase may be shown only after
byte-/fact-safe validation. The FactBundle and templates omit internal e1RM/working-max values and
claims; deny/golden cases allow only persisted decision/reason/load facts so optional prose cannot
bypass the deferred Progress/formula-labeling gate. Program-page Explain stays deferred behind its observed-comprehension
re-entry gate.

---

## 10. Falsifiable definition of done (K-series)

| ID | Claim | Required proof |
| --- | --- | --- |
| **K1** | Engine is deterministic and total | Same normalized input/version gives the same available or unavailable result; golden vectors cover initial, progress, hold, adaptive decrease, both deload paths, layoff, and phase re-anchor. |
| **K2** | Core journey does not depend on prose | J1–J9 pass with LLM disabled; explanation absence never blocks or changes a decision. |
| **K3** | Development is not reviewed methodology | Every rule/output is development-versioned and production rejects it; no e1RM accuracy/coaching claim is shown. |
| **K4** | Safety/loadability are outer constraints | Missing/implausible facts fail closed; every branch obeys the final delta/absolute interval; raised anchors ramp; backstop remains; conservative equipment fallbacks emit their actual attainable direction and a required decrease never degrades to hold; every publish/start references a current same-subject eligible or closed blocked Athletes attestation. Unverifiable evidence publishes no derived state; an authorized factual append may persist only after complete invalidation/quarantine with its typed blocked outcome. |
| **K5** | Structural write boundary holds | Calibration writes only its tables; Training no longer writes the four Programs tables or `program_revision_lineage`; the lineage manifest owner transfers to Programs; the four grants disappear; O1–O5 and public-boundary guards pass. |
| **K6** | Decisions and estimates are reproducible | Decision → basis/frozen safe interval → discriminated evidence-current-load/estimate/loadability → current-result immediate-predecessor anchor chain → effective facts/history/session/revision/hash → rule version is complete; inherited rows keep parent provenance but rebind current-revision anchors; every program/decision/session reference resolves to a normalized same-subject safety attestation/hold-source graph; a valid estimate persists independently of downstream decision availability; DB constraints reject wrong-subject/fork/cycle/cross-basis/source-shape omissions; active reads fail closed over partial invalidation; correction closes every fact/session/revision/anchor/copied-prescription dependency. |
| **K7** | Workflow is atomic and idempotent | Decision when applicable, computed/inherited available/blocked revision or explicit no-revision outcome, typed parent cause, Training session transition/recovery, estimate lineage/invalidation, Programs current-projection result, quarantine head/transfer/resolution, and regeneration receipt/joins commit together or roll back; failure/replay/cross-user plus each athlete-input/correction/recovery race proves latest-state rebase or typed no-mutation conflict, no fork, no stranded deferred chronology, and no lost update. Exact replay returns its original discriminated outcome before later state gates. |
| **K8** | Personal-data lifecycle is complete | Export, deletion preview/count/execution, instance/E2E reset, preflight, fresh/upgrade migration, and backup/restore cover every new table/field including starting-load corrections, safety attestations/hold sources, input and correction projection outcomes/results, Training correction-recovery receipts/results and execution-invalidation causes, quarantine/head/occurrence/correction- and session-invalidation-ancestry/resolution rows, regeneration receipt/basis/recovery joins, cutover receipts/results, and generalized lineage before live writes; subject deletion and instance reset share product/subject fences with every writer so stale transactions cannot resurrect rows; legacy hashes/facts are not rewritten. |
| **K9** | Optional prose remains grounded/fail-soft | Versioned canonical cases cover every supported kind/reason; unknowns reject; codes remain available; cache provenance and invalidation stay correct. |
| **K10** | Structured UI is independently sufficient | With LLM disabled, each availability/derivation/legacy/safety state shows concise deterministic copy, evidence/development status, and its typed recovery action or explicit none; pain-hold resolution routes to Regenerate while restriction stays non-actionable; blocked or revoked loads cannot be started. |

---

## 11. Explicitly deferred

Reviewed methodology values and content; user-facing Progress/e1RM/PR/volume/adherence; a distinct
measured-repetition-test capture journey; velocity and plateau models; model-decided prescription;
Program-page Explain; and any new calibration-specific safety-hold lifecycle. Each requires its
existing human or evidence-based re-entry gate.
