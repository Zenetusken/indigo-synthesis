# ADR 0004: Self-hosted and online-first

- Status: accepted
- Date: 2026-07-11

## Context

Self-hosting is essential. The user clarified that offline workout execution is not a
hard requirement. Earlier offline implementations added broken service-worker paths,
fake sync, and incompatible state APIs.

## Decision

Core use requires no mandatory external/cloud service and must work with outbound network
blocked. Source guards and browser request observation cover the current implementation;
retaining the complete browser proof in a network-denied environment remains a release
gate. Durable state is saved to PostgreSQL through the self-hosted application. Offline
mutation queues and conflict resolution are deferred. Plain HTTP is supported only for
loopback-local use; phone, LAN, and other non-loopback use requires an HTTPS origin
through an operator-supplied TLS terminator.

## Consequences

- Core runtime remains one Node process plus PostgreSQL. Optional grounded-language
  generation may add one non-authoritative, host-local loopback HTTP process; core use
  never depends on it
- A TLS terminator is an ingress prerequisite for network use, not a product datastore or
  application authority; repository-supplied proxy/certificate automation is deferred
- Refresh/restart recovery is required; disconnected multi-mutation operation is not
- Local fonts/assets and optional adapters are mandatory design constraints
- PWA/offline work requires validated demand and a later ADR
