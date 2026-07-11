# Indigo Synthesis engineering contract

This project exists because three earlier attempts confused subsystem activity with a
working product. These rules are part of the architecture.

## Product truth

- Never fabricate readiness, progress, recovery, recommendation, or workout data.
- Never make a failed request look like a successful personalized result.
- Never call deterministic rules AI.
- Never describe a coaching framework as a neurotransmitter test or medical diagnosis.
- Never publish outcome, injury, nutrition, or scientific claims without an approved
  evidence record.
- Never copy legacy assets, prose, program content, questions, or code until rights are
  confirmed.

## Scope

The first product proof is:

local sign-in → athlete setup → one reviewed program → today's workout → set logging →
completion → persisted history → one explained next-load decision.

Until that journey works against a real PostgreSQL database, do not add:

- another datastore or runtime process;
- Redis, queues, WebSockets, service-to-service HTTP, caching, or event sourcing;
- nutrition, social, gamification, wearables, video, AI, or native clients;
- offline mutation synchronization;
- Docker orchestration, CI/CD, or production monitoring stacks.

## Architecture

- Domain modules import no Next.js, database, authentication, filesystem, clock, random,
  or environment APIs.
- UI calls application use cases. It does not call repositories directly.
- Modules use another module only through its exported application API.
- PostgreSQL is authoritative. Browser state is temporary interaction state.
- The methodology engine is pure and deterministic.
- Published methodology releases, template versions, program revisions/snapshots, and
  completed-workout history are immutable. Program aggregates may append revisions and
  change the active revision; they never rewrite a published snapshot.
- Every recommendation stores a ruleset version, reason codes, and source references.
- One schema and one ordered migration ledger exist. Do not add parallel entity models.
- Multi-module writes use the shared unit-of-work port; modules communicate through
  public application contracts, never private repositories or tables.

## Definition of done

A feature is complete only when:

1. Its user-visible acceptance criteria pass.
2. Its data survives an application restart.
3. Error, empty, and unauthorized states are explicit.
4. Unit/domain tests, database integration tests, and the relevant real browser journey
   pass.
5. Documentation and status are updated in the same change.

Mocks may isolate units. They cannot establish end-to-end completion. Health endpoints,
direct database writes from tests, random fixtures, and caught missing-script errors do
not substitute for a user journey.

## Data and safety

- Store weights canonically as integer grams and durations as integer seconds.
- Store timestamps in UTC and schedules as a date plus the athlete's IANA timezone.
- Use `null` only to mean unavailable.
- Bound loads, repetitions, RPE, dates, and status transitions in domain code and the
  database.
- A pain or contraindication signal must stop or escalate; the product does not diagnose.
- Manual overrides record actor, reason, prior value, and replacement.
- Destructive actions require explicit confirmation and are scoped to the named data.

## Experience

- Today's real workout or exact resume state is the primary action.
- Complete a defaulted set in one action; start or resume within two.
- Use semantic controls, visible focus, reduced motion, 48px workout targets, and no
  hover-only behavior.
- Never animate a measured number into a different value.
- Use local fonts and assets. Core screens make no outbound request.

When in doubt, choose the smaller design that makes the first journey more truthful.
