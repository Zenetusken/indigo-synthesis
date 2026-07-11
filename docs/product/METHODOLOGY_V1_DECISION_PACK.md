# Methodology v1 decision pack

Status: open Gate 0  
Scope: decisions required before coaching content, product/program schema, or generator
implementation

The technical scaffold may exist while this pack is open. No production program template,
assessment, product/program schema, numeric adaptation rule, or marketing claim may be
encoded before it closes. Phase 1 may implement only the independently reviewable Better
Auth, singleton installation-state, and migration-ledger schema needed to prove the stack.

## Decision owners

Name the accountable people before approval:

- Product owner:
- Strength-program domain expert:
- Safety reviewer:
- Evidence reviewer:
- Rights/licensing owner:
- Technical implementer:

Every approver records relevant credentials and conflicts of interest. One person may
hold multiple administrative roles only where independence is not compromised. For every
material claim or advanced method, evidence and safety approval must come from a reviewer
who did not author the rule and did not implement it. The approval record identifies the
rule author, implementer, evidence reviewer, and safety reviewer separately.

## A. Brand and rights

- [ ] Is `Indigo` available and authorized as a product name?
- [ ] Which original program texts, tables, exercise descriptions, and method names may
      be used?
- [ ] May the product implement HFSW and omni-contraction terminology commercially?
- [ ] Are any assessment questions licensed?
- [ ] Which exercise media/content sources are authorized?
- [ ] What attribution and modification terms apply?
- [ ] Is a clean independent name/methodology required?

Output: signed rights matrix with source, owner, license, attribution, modification,
commercial-use, end-user export, redistribution, required omission/reference behavior,
and expiry fields. An archive must name licensed material it cannot include.

## B. Product framing

Choose one:

- [ ] Neurotype is excluded from v1.
- [ ] Neurotype is retained only as an explicitly experimental preference/coaching
      framework, not a neurological measurement.
- [ ] An independent validation plan exists and defines the allowed claims.

This choice explicitly approves or rejects the restart's deliberate pivot away from the
legacy neurotype/high-frequency/omni-contraction proposition; that proposition is not an
accepted differentiator while this gate is open.

Also decide:

- [ ] Is the first product for advanced trainees only?
- [ ] Is the first deployment single-owner, household, coach/client, or open signup?
- [ ] Is one exact authored program the initial wedge, or one configurable program
      family?

## C. Canonical program ontology

Resolve the contradictory source material:

- [ ] 12 weeks or 16 weeks
- [ ] Three phases or four phases
- [ ] Phase names and order
- [ ] Three-week or four-week phase duration
- [ ] Three, four, five, or variable sessions per week
- [ ] Meaning of preparation/foundation, accumulation, intensification, realization, and
      deload
- [ ] Whether contraction emphasis is a phase, week, day, exercise, or set attribute
- [ ] Whether HFSW is mandatory, optional, or excluded
- [ ] How rest days and rescheduled days affect phase/week state

Output: one versioned state diagram and glossary.

## D. Inputs

For every input, classify it as system-observed, user-attested performed, user-reported,
derived, prescribed, or prohibited:

- [ ] Goal
- [ ] Experience
- [ ] Equipment
- [ ] Schedule and session length
- [ ] Limitations/contraindications
- [ ] Baseline strength and test protocol
- [ ] Bodyweight
- [ ] RPE
- [ ] RIR
- [ ] Sleep/soreness/energy/motivation
- [ ] Pain/issues
- [ ] Training history window

Define missing-data behavior. No input receives an invented default.

## E. Prescription rules

- [ ] Baseline/training-max formula
- [ ] Exercise selection and order
- [ ] Equipment-compatible substitution
- [ ] Sets/repetitions/load/rest
- [ ] Warm-up generation
- [ ] Load rounding and available plates
- [ ] Progression success/failure definition
- [ ] Double/triple/wave progression, if any
- [ ] Deload trigger and action
- [ ] Plateau definition
- [ ] Missed/partial/abandoned session behavior
- [ ] Phase transition rules
- [ ] Manual override permissions

Each rule needs an ID, evidence status, source, bounds, priority, reviewer, examples, and
tests.

## F. Safety

- [ ] Intended population and experience floor
- [ ] Pre-participation and professional-clearance language
- [ ] Pain stop/escalation rule
- [ ] Contraindications and equipment/spotter requirements
- [ ] Maximum load/volume/frequency bounds
- [ ] Advanced eccentric/isometric/ballistic/max-effort tier policy
- [ ] Unsafe substitution rules
- [ ] Behavior after extended absence
- [ ] Emergency and disclaimer copy

Safety rules must outrank every other rule.

## G. Explanations and claims

- [ ] Plain-language explanation vocabulary
- [ ] Which evidence statuses are user-visible
- [ ] e1RM formula and label
- [ ] Allowed personalization language
- [ ] Prohibited neurological, outcome, injury, recovery, and nutrition claims
- [ ] Claim re-review interval
- [ ] Correction/retraction process

## H. Golden examples

Approve a compact set of deterministic vectors before implementation:

- [ ] Minimum and maximum experience inputs
- [ ] Each supported goal
- [ ] Minimal and full equipment
- [ ] Missing optional data
- [ ] Successful progression
- [ ] Failed progression
- [ ] Partial/abandoned session
- [ ] Substitution
- [ ] Deload
- [ ] Phase transition
- [ ] Safety block/manual review

Each vector includes normalized input, expected complete output, reason codes, warnings,
input hash, and output hash.

## Approval

Gate 0 closes only when all required outputs are versioned, reviewed, and linked from an
accepted ADR. Unresolved items must be removed from v1 rather than guessed.
