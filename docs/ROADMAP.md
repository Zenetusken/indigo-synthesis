# Gated delivery roadmap

This roadmap is sequenced by proof, not calendar promises. No phase begins because files
or subsystem tests exist.

The narrow Phase 1 authentication/migration/secure-self-hosting compatibility spike may
run in parallel with Gate 0 because it does not encode coaching content. Program schema,
templates, assessment, numeric adaptation, and product claims remain blocked until Gate 0
closes.

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
- Better Auth first-owner bootstrap and session;
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

## Phase 3 — Progress depth and corrections

Only after Phase 2:

- exercise-specific history;
- labeled e1RM with source/formula;
- PR definitions and source sets;
- mathematically defined volume;
- schedule-aware weekly adherence;
- audited correction of completed sets;
- program revision history and comparison; and
- clearer explanation/source inspection.

Gate:

- every value traces to completed source data;
- no duplicate aggregate truth;
- performance measurements justify any read model.

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
