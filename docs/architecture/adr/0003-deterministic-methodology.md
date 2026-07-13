# ADR 0003: Coaching logic is deterministic and versioned

- Status: accepted architecture; methodology content pending Gate 0
- Date: 2026-07-11

## Context

Legacy algorithms used randomness, broken scoring, circular preference questions,
duplicated constants, and unversioned prose. Product copy called simple thresholds AI and
made unsupported neurological claims.

## Decision

Implement coaching logic as a pure TypeScript engine evaluated against immutable reviewed
methodology/template releases. Inputs include an explicit date. Outputs include complete
prescriptions, reason/source IDs, warnings, versions, and hashes.

## Consequences

- Results are reproducible and auditable
- Completed history remains interpretable after rules change
- Safety rules have explicit highest priority
- No LLM/ML, executable database rule language, randomness, network, clock, or database
  access exists inside the engine
- Optional local language models, if ever enabled, may only paraphrase already-persisted
  decisions under [ADR 0006](0006-optional-local-grounded-language.md); they never enter
  this engine
- Methodology content cannot ship before the decision pack closes
