# ADR 0002: PostgreSQL is the only source of truth

- Status: accepted
- Date: 2026-07-11
- Supersedes: legacy multi-database ADR-001

## Context

Legacy designs split exercises/templates into MongoDB, workout state into Redis, and
relational history into PostgreSQL. They then required synchronization logic and HA
clusters without product-scale evidence.

## Decision

Use PostgreSQL 18 for identity, profile, catalog, methodology metadata, programs,
sessions, sets, audits, and derived queries. JSONB is permitted for immutable versioned
content/snapshots when relational constraints are not required.

## Consequences

- Cross-entity invariants and transactions remain enforceable
- Active workout state survives an application restart without Redis
- One ordered migration ledger exists
- Redis, MongoDB, search, and analytics stores require measured need and a new ADR
