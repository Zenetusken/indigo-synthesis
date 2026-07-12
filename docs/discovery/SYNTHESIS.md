# Discovery synthesis

Date: 2026-07-11

## Executive conclusion

All three attempts contain useful product fragments, but none is a viable codebase to
resume.

The coherent product hidden across them is:

> A self-hosted strength-training system that turns a trainee's explicit context and a
> reviewed coaching methodology into a clear program, a fast workout log, an honest
> history, and explainable adjustments.

The restart should preserve that loop and discard the super-app, distributed-system, and
unsupported medical/scientific ambitions that repeatedly displaced it.

## Discovery method

The corpus was read in this order:

1. Canonical `VISION.md`
2. Canonical feature and technical specifications
3. Remaining product/domain, module, progress, and experience research
4. Focused architecture/status evidence
5. Live `project-synthesis-training` implementation
6. Live `Indigo` implementation
7. Live `training` implementation, PDFs, and internal documentation
8. Comparative UX and architecture synthesis

Independent lanes audited product/domain, UX/module/progress, implementation truth,
Indigo, training, and the proposed restart architecture. Every lane separated fully read
material, targeted reads, enumerated material, and excluded generated/vendor content.

Per user direction, CI/CD, Docker Compose, orchestration, Portainer, monitoring, and
Redis-cluster detail were removed from the working scope. Offline workout support was
also downgraded from a requirement to a possible later enhancement. Self-hosting remains
a hard product constraint.

See [source coverage](SOURCE_COVERAGE.md) for the auditable manifest.

## The attempts

| Attempt | What exists | What it proves | Why it is not the baseline |
| --- | --- | --- | --- |
| `training` | A browser-only journal for five static Week-1 workout fragments; about 32,424 active lines; local weights, completion, notes, timers, dashboard, and extensive feature accretion | The only concrete workout hierarchy and logging interaction research | Workouts are HTML, domain data is parsed back from markup, globals and load order coordinate the app, tests crash, only one branded week exists, and coaching/nutrition content is unsafe and rights-unclear |
| `Indigo` | 1 page, 57 API routes, 35 services, 12 repositories, 29 migrations, 162 active test files, and 52,733 core TypeScript/TSX lines | Useful domain vocabulary, later schema concepts, a calm visual experiment, and recognition that only observable/user-reported data should be collected | No coherent authenticated journey; typecheck stops on syntax errors; API failures become plausible fake recommendations and randomized calendar data; assessment scoring makes two types unreachable; schema and services accreted without convergence |
| `project-synthesis-training` | About 1,365 source lines across 14 files, disabled login/register pages, a landing page, health/metrics routes, and a very large infrastructure/test corpus | The clearest evidence of infrastructure-first failure | It never implemented assessment, program generation, workout execution, or progress; user-journey and load tests simulate features through health/metrics/database calls; 301 passing tests were mislabeled as 100% coverage/product readiness |

## What survives

### Product loop

1. Capture goals, experience, equipment, schedule, limitations, baseline performance,
   and explicit coaching preferences.
2. Instantiate a reviewed program template through a deterministic methodology release.
3. Show today's prescription and its rationale.
4. Record prescribed versus performed sets, load, reps, optional RPE, rest, and notes.
5. Complete a session and derive factual session history.
6. Explain a bounded adjustment to a future prescription.

### Domain concepts

- Program → revision → phase → week → planned workout
- Workout → ordered exercise → ordered set
- Warm-up, working, and advanced set types
- Exercise equipment, substitutions, and safety tier
- Prescribed versus performed values
- Planned workout as program state; Start creates a session directly as active, then
  active ↔ paused → completed or abandoned
- Personal records and estimated strength as derived, labeled outputs
- Ruleset, template, and explanation provenance
- Manual override with audit
- Portable export and explicit deletion

### Experience concepts

- Today/Resume as the primary screen and action
- Program, session-level History, and Settings in the first slice; exercise History and
  Progress follow only after that slice passes
- Prior performance beside the current prescription
- A set ledger with fast defaults and one-action completion
- A contextual rest timer
- Factual post-workout summary and next-workout preview
- Calm whitespace and low chrome
- Mobile-first controls and interruption recovery

## What is rejected

- Neurotransmitter diagnosis from a questionnaire
- Claims of 85% greater gains, precise injury reduction, or guaranteed body composition
- Automated supplement/nutrition prescriptions
- Synthetic readiness, recovery, progress, or recommendation values
- Randomized production fallbacks
- Unreviewed extreme eccentric/isometric/ballistic methods
- Microservices, polyglot persistence, event sourcing, brokers, service mesh, and
  multi-region design before measured need
- Health endpoints as feature-test proxies
- Mock-only end-to-end tests
- Streak guilt, loss aversion, variable rewards, and automatic social sharing
- Legacy logos, bodybuilder imagery, branded prose, and copied program material

## Root causes

1. No canonical source of truth for product, methodology, data, or status.
2. Infrastructure and subsystem breadth came before one user-visible vertical slice.
3. Generated research/pseudocode was treated as an implementation specification.
4. Unvalidated claims became architectural dependencies.
5. Three or more models existed for the same workout, session, set, or user state.
6. Fallbacks and mocks masked integration failure.
7. Test counts and completion reports replaced requirement traceability.
8. Scope expanded simultaneously into nutrition, social, gamification, wearables, AI,
   native apps, and enterprise-scale operations.
9. Safety, evidence, and rights questions were deferred even though they determine the
   product.
10. Documentation accumulated competing final truths instead of superseding stale ones.

## Restart decisions

- Clean-room implementation in `indigo-synthesis`
- Working title only; brand and content rights remain unresolved
- Online-first; offline sync deferred
- Self-hosted core with no mandatory cloud service
- One Next.js/TypeScript modular monolith
- One PostgreSQL source of truth
- Local database sessions through an established auth library
- Pure, deterministic, versioned methodology engine
- One reviewed program family before a generic generator
- Native CSS Modules and local fonts for an intentional, self-contained UI
- One real browser/database journey before breadth or operational scale

## Open decisions that block production product logic

- Rights to the Indigo name, original program material, assessment questions, and media
- The coaching-profile/neurotype concept is excluded from the MVP; any later re-entry
  would require independent validation and a new product decision
- Canonical 12-week versus 16-week phase model
- Exact frequency, progression, deload, baseline, and substitution rules
- Permitted advanced techniques and their safety gates
- RPE/RIR policy
- Pain, injury, and contraindication behavior
- Domain expert and evidence-review authority
- Exact production account model beyond one owner-as-trainee plus controlled local
  member accounts; public signup is closed

These are captured as the
[Methodology v1 decision pack](../product/METHODOLOGY_V1_DECISION_PACK.md). The
original discovery gate permitted only a technical foundation while they were open.
The project owner subsequently authorized a generic schema, pure generator, and visibly
unreviewed development fixture to prove the engineering slice. That allowance is
documented in [MVP status and traceability](../MVP_STATUS.md) and does not approve or
unblock production coaching content.
