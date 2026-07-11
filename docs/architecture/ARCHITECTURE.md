# Architecture

Status: accepted foundation; product schema remains blocked on Methodology Gate 0

## System shape

Indigo Synthesis is one self-hosted TypeScript modular monolith.

```text
Browser
  │
  ▼
Next.js UI
RSC pages + focused client interaction + server actions
  │
  ▼
Application use cases and transaction boundaries
  │
  ├──────────┬───────────┬────────────┬───────────┐
  ▼          ▼           ▼            ▼           ▼
Identity   Athletes   Exercises   Methodology   Programs
                                      │           │
                                      └─────┬─────┘
                                            ▼
                                         Training
                                            │
                                            ▼
                                         Progress
  │
  ▼
Infrastructure ports
PostgreSQL · Better Auth · local media · clock/IDs
```

There is no separate frontend API service, internal HTTP, broker, cache cluster, or
secondary database.

## Module boundaries

### Identity

Owns local accounts, sessions, bootstrap, signup policy, and authorization context.
Better Auth owns auth semantics, while its tables are represented through the single
Drizzle schema and committed migration ledger. Better Auth does not run a second
production migration authority. Other modules consume an authenticated actor ID, not
auth tables.

### Athletes

Owns units, timezone, goals, experience, schedule, equipment, baselines, limitations,
and future optional coaching-profile inputs.

### Exercises

Owns canonical exercise identity, movement/equipment taxonomy, authored guidance,
substitutions, safety tier, and content provenance.

### Methodology

A pure TypeScript engine plus immutable reviewed rule/template references. It has no
framework, database, clock, randomness, environment, or network dependency.

### Programs

Owns instantiated plans, immutable revisions, phase/week/workout ordering, prescription
snapshots, explanation references, and activation.

### Training

Owns the session lifecycle, snapshot of today's prescription, performed sets, notes,
timers/timestamps, substitutions, completion, and audited correction.

### Progress

Owns queries and read models derived from completed training: history, personal records,
e1RM, volume, and schedule-aware adherence. It is not a second source of truth.

### Data portability

Coordinates module export/deletion through public application ports. It does not read
arbitrary tables or become a second owner of personal data.

## Dependency rules

- Domain code imports no `next/*`, database, auth, filesystem, environment, clock, or
  random API.
- UI calls application use cases. It never imports a repository.
- Infrastructure implements domain/application ports.
- A module uses another module only through its public application API.
- No module reaches across to another module's tables.
- No internal code calls the application's own route over HTTP.
- Cross-module workflows define one application transaction boundary through the shared
  unit-of-work port.
- Cycles fail an architecture test.
- Global service registries and mutable singletons are prohibited.

Suggested internal shape:

```text
src/modules/<module>/
  domain/          pure entities, value objects, policies
  application/     commands, queries, ports, authorization
  infrastructure/  PostgreSQL and other adapters
  ui/              module-owned presentation where useful
  index.ts          public module API only
```

Not every module needs every folder on day one. Empty abstraction is not architecture.

### Cross-module composition and persistence

Multi-module operations are composed in `src/application/workflows/`. This layer owns
workflow order and authorization but no domain entities or tables. A `UnitOfWork` port
runs a callback with transaction-scoped public module gateways; the PostgreSQL adapter
binds every participating repository to the same Drizzle transaction/`pg` connection.
Repositories never escape that callback and remain private to their owning module.

Relational integrity is not a module violation. Cross-module foreign keys are allowed
when the referenced owner publishes the identity contract, both owners review the
migration, and the relationship is declared in the single schema ledger. They do not
authorize cross-module reads.

Training publishes a versioned `CompletedTrainingFacts` query contract for History and
Progress. Its first implementation returns DTOs through Training's public application
API. If profiling later requires a database view, Training owns and versions that view,
and Progress may query only that published read contract. Progress never reads Training
tables directly or persists duplicate aggregate truth.

Data Portability composes each module's `planExport`, `writeExport`, and
`planDeletion`/`deletePersonalData` ports. Deletion runs in declared referential order in
one transaction, with Identity last, so no partial account destruction can be reported
as success.

## Request and mutation flow

1. A server component or route resolves the authenticated session.
2. Boundary input is parsed once with Zod.
3. The application use case authorizes the actor and opens a transaction when needed.
4. Domain values and policies enforce invariants.
5. Repositories persist through the module's schema ownership.
6. The use case returns a typed result suitable for the UI.
7. The UI shows success, unavailable, conflict, validation, or unauthorized explicitly.

A validator never consumes a request body and then asks a handler to parse it again.

## Methodology engine

Two versions are independent:

- **engine version** — code implementing normalization, ordering, bounds, and evaluation;
- **methodology release** — reviewed coaching rules, sources, examples, and template
  release.

Input always includes an explicit `asOfDate`. Output stores:

- complete prescription;
- rule/reason IDs;
- warnings and manual-review flags;
- normalized input hash;
- output hash;
- engine, methodology, and template versions.

Properties:

- no time, random, network, database, or environment reads;
- identical normalized input and versions yield identical output;
- safety outranks template, progression, equipment, and preference rules;
- reviewed data selects among code-enforced bounded operations;
- published releases are immutable;
- overrides are explicit audited decisions;
- golden vectors and property tests prove determinism and bounds.

## Canonical data model

The exact schema waits for Gate 0, but the entity model is fixed enough to prevent legacy
duplication.

### Identity/profile

- Better Auth users, sessions, accounts, verifications
- singleton installation state for serialized first-owner bootstrap
- athlete profile
- training-day preference
- equipment and athlete equipment
- strength baseline with test protocol and date

### Reviewed content

- exercise and equipment mapping
- exercise substitution
- source/evidence record
- methodology release
- program template and immutable template version

### Program

- program
- program revision
- planned workout
- exercise/set prescription snapshot

### Execution

- workout session
- session exercise
- performed set
- session feedback
- adjustment decision
- audit event

### Portability/administration

- non-personal deletion tombstone

Personal records and progress are initially derived views/queries. No aggregate table is
added until profiling proves a need.

## Database invariants

- Domain IDs are time-sortable UUIDs generated through one ID port.
- Timestamps are `timestamptz` in UTC.
- Scheduled work uses a local `date` interpreted through the athlete's IANA timezone.
- Weight is integer grams; duration is integer seconds.
- A trainee has at most one active program and one active session.
- Exercise and set ordinals are unique within their parent.
- Published methodology/template versions and completed sessions are immutable.
- Published program revisions/snapshots are immutable; the program aggregate may append
  a new revision and change which revision is active.
- A session snapshots the prescription and exercise identity it used.
- Catalog edits never alter historical prescriptions.
- Adaptation affects future work through a new program revision.
- Client command IDs and unique constraints make writes idempotent.
- Optimistic versions protect active-session edits.
- Checks bound repetitions, loads, RPE, dates, statuses, and lifecycle transitions.
- A planned workout belongs to a program revision. A workout-session row is created
  directly as `active`, then follows active ↔ paused → completed or abandoned.
- The singleton installation row is locked in the first-owner transaction. Creating the
  owner and closing bootstrap commit atomically, and a unique owner invariant rejects
  concurrent bootstrap attempts.
- `null` remains unavailable.
- JSONB is limited to immutable versioned content or snapshots; fields needing routine
  joins, filtering, or constraints remain relational.

## Authentication

- Better Auth email/password with opaque PostgreSQL-backed sessions
- Better Auth uses its Drizzle adapter; generated auth schema is checked into the
  project-owned Drizzle schema, and Drizzle Kit emits reviewed SQL into the one committed
  migration ledger
- only the project migration command applies committed SQL before application startup;
  Better Auth runtime migration/schema push is disabled and its CLI is never a production
  migration authority
- `HttpOnly`, `Secure` in production, `SameSite=Lax` cookies
- transactionally serialized first-owner bootstrap
- public signup off by default after bootstrap
- server-derived actor identity for every use case
- optional SMTP; no mandatory email/cloud identity
- out-of-band sole-owner recovery when SMTP is absent: a host-local admin command with
  database access issues an expiring single-use recovery code, revokes existing sessions
  on use, and writes a redacted audit event

Social login, passkeys, MFA, SSO, organizations, and custom JWT/refresh tokens are not
first-slice requirements.

## Media

The first slice uses only licensed bundled static assets. If uploads become real:

- domain depends on a `MediaStore` port;
- the default adapter writes below a configured local data directory;
- PostgreSQL stores key, hash, MIME type, size, owner, visibility, and lifecycle;
- core data does not store binary blobs; and
- an optional S3-compatible adapter may be added without changing domain code.

## Runtime and operations boundary

Supported baseline:

- one Node.js process;
- one PostgreSQL database;
- one writable media directory only if uploads are enabled.

Structured stdout, configuration validation, and truthful application/database health are
part of the application. Reverse proxy, Docker, CI/CD, monitoring stack, HA, backup
automation, and deployment packaging are later operational work.

Plain HTTP is a loopback-only development mode. Phone, LAN, and any other non-loopback
access require an externally visible HTTPS origin and `Secure` cookies. A user-managed
TLS terminator may sit in front of the Node process; it is an ingress prerequisite, not
an application datastore or authority. Product-supplied proxy configuration and
certificate automation remain deferred.

Deletion is a deliberate destruction exception to historical immutability. The
portability workflow deletes or redacts scoped personal records in referential order and
retains only a system-level tombstone containing event ID, actor class, timestamp, schema
version, aggregate row counts, and a completion digest—never identity, health context, or
training content.

See [the self-hosting contract](SELF_HOSTING_CONTRACT.md).

## Architecture acceptance

Before a second feature category is added:

- the first real browser/database journey passes;
- fresh-database migration passes;
- active-session restart recovery passes;
- outbound-network-blocked core use passes;
- cross-user denial and idempotency pass;
- approved methodology golden vectors, safety precedence, and output hashes pass;
- export/deletion boundaries and the permitted non-personal tombstone pass; and
- dependency and schema-ownership checks pass.
