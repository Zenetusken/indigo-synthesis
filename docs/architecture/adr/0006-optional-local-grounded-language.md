# ADR 0006: Optional local language model for grounded explanation only

- Status: accepted; History on-demand Explain + PG prose cache + post-completion pain
  invalidation implemented (default LLM off; GPU-local optional). Program-page Explain
  still open.
- Date: 2026-07-13
- Supplements: [ADR 0003](0003-deterministic-methodology.md), [ADR 0004](0004-self-hosted-online-first.md)
- Contract: [Explanation generation contract](../EXPLANATION_GENERATION_CONTRACT.md)

## Context

The engineering MVP persists deterministic future-load decisions with reason codes, rule
versions, and load facts. History surfaces those codes (for example
`development.adjustment.increase · rule 0.0.1-development`) and, when explicitly enabled,
can request a validated inferred paraphrase. Explanation comprehension remains a later
beta measure.

Legacy attempts and marketing called simple thresholds “AI,” invented readiness scores,
and expanded into opaque coaching models before one trustworthy training journey existed.
`docs/DEFERRED.md` therefore deferred **LLM/ML coaching** until a consented dataset,
baseline, failure taxonomy, offline/self-host model strategy, and measurable benefit
exist.

A host-local language model can improve explanation comprehension **without** becoming
the methodology engine—if and only if authority, topology, and failure modes stay
explicit. The application architecture binds to a versioned generation port and
groundedness contract rather than a vendor SDK. The currently supported product profile
is deliberately narrower: one exact Q4 artifact and one pinned/attested CUDA llama.cpp
runtime. Adding or changing that profile is a reviewed code/provenance change.

## Decision

1. **Pattern.** Product language generation uses **structured grounded generation**
   (one-shot prose over an authoritative FactBundle), not a trainee chatbot, not
   write-capable agents, and not classic open RAG over training math.
2. **Authority.** Deterministic TypeScript methodology and application rules remain the
   sole authority for prescriptions, adjustments, substitutions, and safety holds.
   Model output is **inferred** presentation only and is never a recommendation source of
   truth. The implemented validator accepts only a closed FactBundle-derived paragraph.
3. **Model-agnostic application port.** The product depends on an
   `ExplanationGenerationPort` and on
   identity fields (`modelId`, content digest, `promptVersion`), not on a named vendor
   model, weight format, or inference binary. Swapping models must not change FactBundle
   schema, validation rules, or methodology behaviour.
4. **Topology.** Inference is an **optional**, host-local runtime reached only on loopback
   (or an equivalent in-process adapter that never requires outbound network). Core use
   remains one Node process plus PostgreSQL with outbound network blocked. The application
   must start and complete J1–J6 when the model is absent.
5. **Delivery.** Generation is lazy and must not block set completion or other gym
   critical paths. Validation-passing prose may be cached with decision, model artifact,
   served runtime, prompt, validator, and FactBundle identity.
6. **Operator assist.** Narrow doc retrieval or RAG is permitted only for host/owner
   tooling (Gate 0 drafting, help corpora)—never as the path that chooses loads.
7. **Implementation gate.** Product routes, tables, controls, and flags ship only after
   the [explanation generation contract](../EXPLANATION_GENERATION_CONTRACT.md)
   acceptance criteria for that slice pass. The History slice crossed this gate; Program
   explanation remains open.

## Non-goals

- AI-powered program generation or load selection
- Medical, diagnostic, or pain-interpretation answers
- Mandatory cloud model APIs
- Multi-turn coaching chat as a primary surface
- Tool-calling agents that mutate programs, sessions, or holds
- Vector databases or brokers introduced only to host an LLM feature
- Describing deterministic rules as AI
- Making any model family, quantisation, or inference engine the decision authority

## Consequences

- Self-hosting lists optional local inference under a digest-locked model directory and
  exact loopback endpoint; it remains non-authoritative and non-mandatory.
- Claims and UI language must label generated prose as inferred paraphrase of reviewed
  or development rules, and always show structured reason codes and versions.
- Architecture tests may allow a loopback-only inference client when implemented; general
  outbound model SDKs remain prohibited for core use.
- Choosing or changing the supported product model/runtime requires an explicit reviewed
  lock/configuration change plus groundedness, provenance, and live-path evidence.
- LLM/ML **coaching** (decision-making or preference instruments) stays deferred under
  the existing re-entry bar; this ADR does not re-open that capability.
- Failure of generation is an explicit unavailable state, never a fabricated decision.
- If the experiment fails measured explanation benefit or honesty review, remove the
  adapter and retain structured reason codes alone.
