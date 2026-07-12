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
| LLM/ML coaching (decision-making, instruments, opaque scores) | No clean dataset or evaluation; deterministic rules suffice; product truth forbids calling rules AI | Consented dataset, baseline, failure taxonomy, offline/self-host model strategy, measurable benefit, and a separate ADR that does not weaken methodology purity |
| Optional local grounded explanation **product UI** (History/Program prose, cache) | Platform infra + model packs exist under `src/platform/llm` and `llm/`; default disabled; no trainee surface yet | Wire History to `ExplanationGenerationPort` with codes-only degrade, cache/invalidation, and groundedness checks per [explanation generation contract](architecture/EXPLANATION_GENERATION_CONTRACT.md) |
| Native mobile apps | Web/mobile-first experience not yet validated | Browser limits demonstrably block a core workflow |
| Multi-instance/HA/multi-region | No availability or scale evidence | Measured load/SLO and operational ownership |
| Coach marketplace/teams | Different actor, auth, billing, and privacy model | Validated coach/client workflow and authorization model |
| Advanced media/object storage | No upload in first slice | Licensed upload use case and storage lifecycle |
| Multiple profiles per account | Release 1 is one profile per account; the account axis (auth, recovery, admin) is built first so this stays additive | Server-side profile-ownership resolution (a request-supplied profile id is never an authorization key), immutable profile→account binding (no reparenting), no profile is authenticatable, and isolation tests that reject a cross-account profile id — mandatory because there is no RLS backstop |
| Second factor (TOTP, passkeys) | Password plus host/owner-mediated recovery is the Release 1 access model; a second factor's own loss path still routes through owner/host mediation | Recovery journeys J7/J8 shipped, a defined enrollment and second-factor-loss path, and no dependency on email/SMS/cloud identity |

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
