# ADR 0001: Start as a modular monolith

- Status: accepted
- Date: 2026-07-11

## Context

Previous attempts created global script systems, dozens of services/APIs, and a
microservice/polyglot architecture before one user journey worked.

## Decision

Build one Next.js/TypeScript application with explicit internal modules and no internal
HTTP. Domain and application boundaries are enforced in code/tests; deployment
boundaries are not invented.

## Consequences

- One process, repository, transaction boundary, and debugging path
- Module ownership and dependency rules still matter
- Services may be extracted only after measured scaling/team/deployment pressure and an
  ADR
- A global `services/` directory and mutable service registry are prohibited
