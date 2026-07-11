# Deferred capabilities

Deferred means intentionally absent—not forgotten and not partially scaffolded.

| Capability | Why absent now | Minimum re-entry evidence |
| --- | --- | --- |
| Docker/Compose, CI/CD, monitoring stack | User explicitly deferred operations; prior attempts overbuilt here | First vertical slice complete; one supported manual self-host path; concrete packaging/operations need |
| Offline workout mutation/sync | User said it is not a hard requirement; conflict/queue complexity is substantial | Observed connectivity failures materially block sessions; explicit conflict and data-loss model |
| Redis/cache | PostgreSQL is sufficient; no measured hot path | Profile shows unacceptable repeat query/coordination cost and simpler query/index fixes fail |
| Queue/broker/background workers | No first-slice async workload | Durable task with retry/idempotency requirements cannot fit request/in-process work |
| WebSockets/realtime | No multi-client live collaboration need | Validated coach/client or cross-device live use case |
| Mongo/search/analytics database | No data shape/scale need | Measured query or storage requirement PostgreSQL cannot meet reasonably |
| Neurotype assessment | Instrument, scoring, evidence, claims, and rights unresolved | Gate 0 approval plus validation/evaluation protocol |
| Subjective readiness | Legacy score was fabricated/overprescriptive | Reviewed inputs, formula, allowed actions, uncertainty, and unavailable behavior |
| Nutrition/supplements | Medical/nutritional risk and unsupported vendor material | Separate qualified clinical, legal, evidence, and product scope |
| Social/community/messaging | Not core; moderation/privacy burden | Validated user demand and funded moderation/safety model |
| Gamification/streak economy | Rest-conflicting and manipulative legacy patterns | Ethical design review and evidence it improves prescribed adherence |
| Payments/subscriptions | No validated commercial product yet | Product/market decision and completed core journey |
| Wearables/HRV/biometrics | Product cannot honestly measure/infer them today | Device integration, consent, validation, and allowed-decision policy |
| Video/form analysis | Media, ML, privacy, safety, and accuracy burden | Licensed media model, evaluation set, safety review, and clear non-diagnostic scope |
| LLM/ML coaching | No clean dataset or evaluation; deterministic rules suffice | Consented dataset, baseline, failure taxonomy, offline/self-host model strategy, and measurable benefit |
| Native mobile apps | Web/mobile-first experience not yet validated | Browser limits demonstrably block a core workflow |
| Multi-instance/HA/multi-region | No availability or scale evidence | Measured load/SLO and operational ownership |
| Coach marketplace/teams | Different actor, auth, billing, and privacy model | Validated coach/client workflow and authorization model |
| Advanced media/object storage | No upload in first slice | Licensed upload use case and storage lifecycle |

## Re-entry process

Every deferred capability requires:

1. observed user or operational evidence;
2. a narrowly stated problem;
3. alternatives, including doing nothing;
4. impact on self-hosting, privacy, safety, and support;
5. acceptance and exit criteria;
6. an ADR; and
7. removal if the experiment fails.

Do not add placeholder tables, SDKs, routes, services, flags, or navigation for a deferred
capability.
