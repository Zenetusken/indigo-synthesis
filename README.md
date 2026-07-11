# Indigo Synthesis

Indigo Synthesis is the clean-slate restart of three abandoned strength-training
implementations. It is a working title and a foundation, not a completed product.

The product thesis is deliberately narrow:

> Know today's work. Log it quickly. Understand what changes next.

The intended product is an online-first, self-hosted strength-training system. Its core
loop turns an athlete's goals, constraints, equipment, preferences, and completed
training into an authored plan, a focused workout experience, an honest history, and
explainable future adjustments.

## What this baseline contains

- An evidence-backed discovery synthesis across `project-synthesis-training`,
  `Indigo`, and `training`
- A rewritten product vision and core product specification
- A methodology, evidence, safety, and intellectual-property gate
- A modular-monolith architecture and PostgreSQL-only data strategy
- A strict self-hosting contract with no mandatory cloud service
- A subject-specific experience and visual-design direction
- A phased delivery plan built around one real vertical slice
- A runnable Next.js foundation and pure workout-session state machine

It does not contain a neurotype assessment, program generator, workout logger,
authentication flow, or database schema yet. The narrow authentication/migration
compatibility spike may proceed; coaching content, program logic, and product schema are
intentionally blocked on the methodology decision pack and vertical-slice model.

## Non-negotiable constraints

1. The core product runs on one self-hosted Node application and one PostgreSQL
   database.
2. No recommendation is presented as neurological, medical, nutritional, or
   scientifically validated without independent evidence and approval.
3. Coaching rules are deterministic, versioned, bounded, inspectable, and reproducible.
4. Missing data is shown as unavailable; it is never replaced by a plausible number.
5. Product completion is proven through a real browser and database journey, not test
   counts, service health, mocks, or documentation.
6. Docker, CI/CD, monitoring stacks, offline sync, social, nutrition, wearables, and AI
   are not part of this restart baseline.

## Repository map

- `docs/discovery/` — source coverage and failure synthesis
- `docs/product/` — vision, product requirements, methodology gate, and claim policy
- `docs/architecture/` — runtime shape, stack, self-hosting contract, and ADRs
- `docs/design/` — journeys, information architecture, and design system
- `docs/ROADMAP.md` — gated path to the first usable product
- `docs/DEFERRED.md` — explicit non-goals and re-entry criteria
- `src/modules/` — future product modules with dependency boundaries
- `src/app/` — the current restart-orientation surface

## Local foundation

Requirements:

- Node.js 24 LTS
- pnpm 10

Commands:

```sh
pnpm install
pnpm dev
pnpm validate
```

The current page is an orientation surface and does not require a database. The first
product slice will require PostgreSQL 18 and the variables described in `.env.example`.
Plain HTTP is for loopback development only; phone/LAN deployments must set an HTTPS
application origin behind an operator-supplied TLS terminator.

## Start here

1. Read [the recovered vision](docs/product/VISION.md).
2. Read [the discovery synthesis](docs/discovery/SYNTHESIS.md).
3. Resolve [the Methodology v1 decision pack](docs/product/METHODOLOGY_V1_DECISION_PACK.md).
4. Review [the product specification](docs/product/PRODUCT_SPEC.md).
5. Build only [the first vertical slice](docs/ROADMAP.md).

No legacy code, branded imagery, program prose, or third-party training material has
been copied into this foundation.
