# Technology stack

Snapshot date: 2026-07-11

The stack is modern because its parts are current, supported, and reduce system
boundaries—not because it includes the most tools.

| Layer | Choice | Baseline version | Why |
| --- | --- | --- | --- |
| Runtime | Node.js LTS | 24 | Supported LTS line; one ordinary self-hosted process |
| Web | Next.js App Router | 16.2.10 | Current stable full-stack React framework with documented self-hosting |
| UI runtime | React | 19.2.7 | Current stable React line used by Next 16 |
| Language | TypeScript | 6.0.3 | Stable transition release with ecosystem API compatibility; TS 7.0 was only days old and lacks the prior programmatic API |
| Database | PostgreSQL | 18 | One mature relational source of truth; current supported major |
| SQL mapping | Drizzle ORM + `pg` | 0.45.2 / 8.22.0 | Typed schema/query layer with committed generated SQL migrations |
| Authentication | Better Auth | 1.6.23 | Self-hosted database sessions and documented Next.js/PostgreSQL integration |
| Validation | Zod | 4.4.3 | Boundary parsing and explicit validation results |
| Styling | CSS Modules + modern CSS | framework-native | No runtime styling system, remote assets, or config layer; tokens remain ordinary CSS |
| Fonts | Fontsource packages | 5.2.x | Locally bundled runtime assets; no Google Fonts request |
| Unit/domain tests | Vitest | 4.1.10 | Fast deterministic engine/domain testing |
| Browser tests | Playwright | 1.61.1 | Real user journey against application and database |
| Lint/format | Biome | 2.5.3 | One current tool instead of overlapping ESLint/Prettier stacks |
| Package manager | pnpm | 10 | Deterministic lockfile and efficient local installs |

Package versions are pinned in `package.json` and resolved in `pnpm-lock.yaml`.

## Why Next.js

- One codebase and deployment process for server rendering, interaction, and application
  endpoints
- Official `next start` self-hosting path
- Server components suit mostly server-owned program/history data
- Client components can remain limited to active workout interaction
- No requirement for a separate REST and GraphQL stack

Official references:

- https://nextjs.org/blog/next-16
- https://nextjs.org/docs/app/guides/self-hosting
- https://nextjs.org/docs/app/getting-started/installation

## Why PostgreSQL only

Program/session data is relational and transactional. PostgreSQL also provides JSONB for
immutable versioned template snapshots without introducing a document database.

MongoDB, Redis-owned workout state, Elasticsearch, ClickHouse, and cross-database
consistency have no measured first-release need.

Official references:

- https://www.postgresql.org/about/news/postgresql-18-released-3142/
- https://www.postgresql.org/docs/current/datatype-json.html

## Why Drizzle and Better Auth

Drizzle keeps TypeScript schema/query definitions close to committed SQL migrations.
Better Auth avoids another custom JWT/refresh-token implementation and supports
PostgreSQL-backed sessions. The Better Auth Drizzle adapter is used so generated auth
tables enter the same reviewed schema and migration ledger; its CLI does not become a
second production migration authority.

The first database spike must prove Next 16 + TypeScript 6 + Drizzle + Better Auth
compatibility before schema breadth. If that combination fails, select one stable
Kysely/plain-SQL path; never mix ORMs or migration authorities.

References:

- https://orm.drizzle.team/docs/migrations
- https://orm.drizzle.team/docs/transactions
- https://better-auth.com/docs/integrations/next
- https://better-auth.com/docs/concepts/session-management
- https://better-auth.com/docs/adapters/postgresql

## Why native CSS Modules

The product needs a specific training-ledger identity, not a generic component-library
look. Modern CSS already supplies cascade layers, custom properties, container queries,
logical properties, color mixing, and reduced-motion media queries.

This choice:

- removes Tailwind configuration/upgrade work that dominated an earlier attempt;
- keeps selectors local by default;
- makes design tokens inspectable;
- avoids shipping a large component abstraction before interaction patterns stabilize;
  and
- still allows accessible headless primitives to be added individually when a control
  truly requires them.

Tailwind and a broad UI kit are rejected for the foundation, not prohibited forever.

## State strategy

- PostgreSQL owns durable server state.
- React component/reducer state owns temporary interaction.
- Server components fetch initial read models.
- Server actions/application commands perform mutations.
- No Zustand or TanStack Query until a measured interaction need is documented.
- No cache until profiling identifies an expensive repeatable query.

## Deliberately absent

- Redis
- MongoDB
- Keycloak
- MinIO
- Kafka/RabbitMQ/NATS
- GraphQL/gRPC
- WebSockets
- service mesh
- SaaS analytics/monitoring
- model/AI SDK
- remote font/CDN dependency
- PWA/offline synchronization package
- native mobile framework
- Docker and CI/CD configuration

Each requires its own measured need, entry criterion, and ADR.
