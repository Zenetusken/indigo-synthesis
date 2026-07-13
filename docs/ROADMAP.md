# Gated delivery roadmap

This roadmap is sequenced by proof, not calendar promises. No phase begins because files
or subsystem tests exist.

## Implementation checkpoint

The repository now contains the Phase 1 stack and a working Phase 2 **engineering
slice**. To validate the product mechanics without pretending to resolve methodology,
the slice uses a generic product schema and a clean-room `0.0.1-development` fixture.
That fixture is visibly unreviewed and configuration rejects it in production.

This checkpoint does not close a phase or Gate 0. The complete release gate still needs
reviewed content and golden examples, an outbound-network-blocked browser run,
independent WCAG/screen-reader and physical-device review, schema/table-ownership
enforcement, and independent product/security review. Targeted automated
accessibility/mobile checks already pass; they are not a conformance claim. Current
traceability and debt are recorded in [MVP_STATUS.md](MVP_STATUS.md).

The distinction is deliberate: the technical workflow exists, while every exercise,
volume, load, rest, progression, population, safety, evidence, and rights decision in a
production release remains blocked until Gate 0 closes.

## Gate 0 — Product truth

Close the [Methodology v1 decision pack](product/METHODOLOGY_V1_DECISION_PACK.md).

Required outputs:

- rights/licensing matrix;
- product framing and intended population;
- canonical phase/program ontology;
- input and missing-data policy;
- reviewed prescription/progression/deload/safety rules;
- claim vocabulary;
- golden deterministic examples; and
- named reviewers/owners.

If an item is unresolved, remove it from v1. Do not guess.

## Phase 1 — Compatibility and walking skeleton

Goal: prove the selected stack and self-hosting boundary before schema breadth.

Deliver:

- Next.js 16 + TypeScript 6 build;
- PostgreSQL 18 connection and one committed migration authority;
- host-capability first-owner bootstrap and Better Auth session;
- loopback-development versus HTTPS-network trust-boundary validation;
- module dependency test;
- configuration validation;
- local font/asset verification;
- outbound-network-blocked smoke test; and
- fresh-database migrate/reset test.

Gate:

- sign in to a fresh local instance;
- no mandatory outbound call;
- no duplicate migration/auth authority;
- all checks green.

Checkpoint: the stack, committed migrations, PostgreSQL preflight, first-owner auth,
configuration validation, local assets, and executable module-boundary guards are
implemented. The release evidence still needs the outbound-network-blocked run and
schema/table-ownership enforcement.

## Phase 2 — First vertical slice

Goal: one complete user journey, not a subsystem collection.

Deliver:

1. athlete setup for units, timezone, goal, experience, schedule, equipment, baselines,
   and limitations;
2. one licensed, reviewed, immutable program template release;
3. deterministic program instantiation with versions, hashes, and explanations;
4. truthful Today/rest/active/error states;
5. active workout with ordered exercise/set ledger;
6. load/reps/optional RPE, rest timer, notes, and approved substitution;
7. exact pause/resume and application-restart recovery;
8. transactional completion;
9. factual summary and history;
10. one bounded explained future-load decision;
11. versioned data export plus licensed-content omission reporting;
12. previewed, confirmed, transactional personal-data deletion with a non-personal
    tombstone; and
13. one real Playwright browser/database journey, including the required negative safety
    cases.

Gate:

- all [Product Spec acceptance criteria](product/PRODUCT_SPEC.md#acceptance-gate) pass;
- no mocked application API in the journey;
- no placeholder or synthetic data in its path;
- no second feature category.

Checkpoint: the full technical J1–J6 path and negative safety/authorization paths are
implemented against the development fixture. They do not satisfy this gate while the
fixture remains unreviewed and the remaining acceptance evidence in
[MVP_STATUS.md](MVP_STATUS.md#production-release-blockers) is open.

## Phase 3 — Progress depth and corrections

Only after Phase 2:

- exercise-specific history;
- labeled e1RM with source/formula;
- PR definitions and source sets;
- mathematically defined volume;
- schedule-aware weekly adherence;
- audited correction of completed sets;
- program revision history and comparison; and
- clearer explanation/source inspection (optional host-local grounded prose per
  [ADR 0006](architecture/adr/0006-optional-local-grounded-language.md), only after the
  [explanation generation contract](architecture/EXPLANATION_GENERATION_CONTRACT.md)
  implementation sequence—not model-led coaching).

Gate:

- every value traces to completed source data;
- no duplicate aggregate truth;
- performance measurements justify any read model.

Checkpoint: append-only correction of completed sets and completion feedback, recursive
decision/revision invalidation, factual History correction provenance, and optional
host-local explanations are implemented. Exercise-specific aggregates, e1RM/PR/volume/
adherence definitions, and program comparison remain open, so Phase 3 is not closed.

## Phase 4 — Small private beta

- real self-host installation by a second person;
- reviewed seed content and exercise substitutions;
- accessibility audit against WCAG 2.2 AA;
- mobile gym-use observation;
- backup/restore and export/import exercise;
- data-deletion verification;
- methodology golden-vector review;
- error/conflict/restart drills; and
- removal of unused abstractions/dependencies.

Success measures:

- first and second workout completion;
- time/actions to record a normal set;
- active-session recovery success;
- persistence/data-loss/error rate;
- weekly return to the prescribed plan;
- explanation comprehension; and
- successful export/restore.

Screen time, notification opens, points, and social engagement are not success measures.

## Phase 5 — Evidence-led expansion

Choose at most one validated next problem. Candidates require the entry criteria in
[DEFERRED.md](DEFERRED.md).

Examples:

- optional coaching/preference assessment;
- richer reviewed program families;
- subjective readiness check-in;
- coach/client workflow;
- local media; or
- optional offline session drafts.

## Definition of shipped

A phase is shipped only when:

- its user journey passes;
- data survives restart;
- authorization and error states pass;
- fresh migration passes;
- self-hosting contract passes;
- documentation/status matches live behavior; and
- an independent review finds no unresolved critical issue.

Test counts, coverage percentages, generated reports, API counts, and health checks are
supporting evidence, never shipping evidence by themselves.
