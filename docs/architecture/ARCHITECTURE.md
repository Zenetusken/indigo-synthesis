# Architecture

Status: accepted target; engineering slice implemented with documented boundary debt;
production methodology/content remains blocked on Gate 0

The live implementation checkpoint is summarized in
[MVP status and traceability](../MVP_STATUS.md). A generic product schema and
development-only fixture now exist to validate the end-to-end mechanics. Neither is a
reviewed methodology release.

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
  ├─ identity/account: Identity
  ├─ initial plan: Identity lifecycle fence → Athletes + Exercises + Methodology + Calibration → Programs
  ├─ train/learn: Identity lifecycle fence → Athletes + Exercises + Training + Calibration + Programs
  ├─ history/read models: Training → Progress (target extraction)
  └─ subject controls: module ports → Data Portability
  │
  ▼
Infrastructure ports
PostgreSQL · Better Auth · local media · clock/IDs
```

There is no separate frontend API service, mandatory internal HTTP service, broker, cache
cluster, or secondary database. The optional grounded-language feature is the sole narrow
exception: when explicitly enabled, the Node application calls an attested host-local
llama.cpp process over loopback HTTP. That process is presentation-only and never becomes
a product-data or decision authority.

## Module boundaries

### Identity

Owns local accounts, sessions, bootstrap, credential recovery, web admission policy, and
authorization context. Better Auth owns the narrow credential/session adapter semantics,
while its tables and Indigo's recovery state are represented through the single Drizzle
schema and committed migration ledger. Better Auth does not run a second production
migration authority, and unsupported provider signup/credential-mutation routes are
blocked so they cannot bypass Indigo's owner-administered lifecycle. Sign-in, local-user
creation, member reset, and owner recovery share email-first/account-scoped lifecycle
locking; recovery revokes database sessions and records redacted audit evidence. Other
modules consume a server-derived authenticated actor ID, not auth tables or
request-supplied identity.

### Athletes

Owns units, timezone, goals, experience, schedule, equipment, baselines, limitations,
and future optional coaching-profile inputs.

### Exercises

Owns canonical exercise identity, movement/equipment taxonomy, authored guidance,
substitutions, safety tier, and content provenance.

### Methodology

A pure TypeScript engine plus immutable reviewed rule/template references. It has no
framework, database, clock, randomness, environment, or network dependency.

### Calibration

Accepted Part B target, not yet implemented: a pure deterministic load-adaptation engine plus
Calibration-owned append-only estimate, compute-basis, and invalidation lineage. Application workflows pass facts
through public ports: initial provenance stays in Programs, while Training retains post-session
decision/invalidation/explanation ownership. Calibration reads no peer tables. Conservative
starting loads remain working-load facts rather than e1RM evidence; exact loadability comes from
Athletes-owned immutable bar/plate versions. See
[the calibration contract](CALIBRATION_SPEC.md) and
[ADR 0009](adr/0009-calibration-live-contract.md).

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

### Current vertical-slice boundary debt

The module descriptions above are the target boundaries. The current engineering slice
still performs some cross-module Programs/Training coordination through direct Drizzle
queries. Data Portability subject export now runs through a subject-scoped temporary cross-owner
gateway inside one repeatable-read, read-only `UnitOfWork`. Protected subject deletion and instance
reset execution run through exact table/verb-scoped temporary adapters inside serializable UoWs,
with Identity authority rechecked first. Preview creation and current-plan reads remain direct, and
module-owned export/deletion gateways remain unimplemented.
History queries also remain in Training until a real Phase 3 Progress contract exists.

These are explicit convergence tasks, not hidden exceptions. The architecture suite now
guards domain purity, dependency direction, platform independence, runtime outbound
clients/remote assets, and an acyclic module graph. The shipped Part A write-authority fence
additionally enforces a schema/manifest bijection and authorizes every observed DML write. Public
gateway/private-import enforcement and peer-table read boundaries remain Part B work. See
[the debt register](../MVP_STATUS.md#known-architecture-debt).

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

Neutral coordination contracts live in `src/application/coordination/`. Multi-module operations
are composed in `src/composition/`, which owns workflow order and authorization but no domain
entities or tables. The PostgreSQL implementation lives in
`src/platform/application-coordination/`: its `UnitOfWork` adapter runs a callback with
transaction-scoped gateways bound to the same Drizzle transaction/`pg` connection. Scoped
gateways are revoked at callback settlement and cannot expose a raw transaction. Stage 3's Data
Portability gateways are temporary cross-owner adapters; the target remains private owner
repositories exposed only through public module ports.

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

This is the accepted Part B target flow; the current vertical-slice debt is described above and the
[development roadmap](DEVELOPMENT_ROADMAP.md) sequences its cutover.

1. A server component or route parses boundary input once with Zod. For a sealed content plan it first
   performs only encoded-size, base64url, canonical-schema/order/cardinality, and constant-time MAC
   checks. Invalid or tampered tokens stop without a database connection or queue permit.
2. The issued form/command carries the captured installation epoch and, for subject work, lifecycle
   generation plus a server-signed canonical `content-lock-plan-v1` envelope. Raw submitted IDs/keys
   never select locks. The envelope binds immutable server-issued shape/purpose, account/subject,
   preallocated form/command ID, ordered source entity IDs, owner-slot manifest, lifecycle
   expectations, bytewise-sorted distinct keys, closed 0/1/exactly-2/2–4/2–64 cardinalities (the
   methodology/template pair is mandatory for publication), and a 16 KiB encoded limit. It is
   canonical base64url JSON plus an
   HMAC-SHA-256 derived from `BETTER_AUTH_SECRET` under a versioned domain. Values entered at submit
   time are parsed/intent-hashed separately and never cause action-entry resigning or lock selection.
   HMAC authenticates but does not encrypt: the decodable payload contains only non-secret,
   already-authorized identifiers/content coordinates, is never logged or echoed, and is never
   trusted without scoped verification plus fresh owner re-derivation.
3. Signed cookie material is then verified. When the account key requires a database lookup, one
   bounded trusted capture lease resolves it without authorizing mutation. Actor/account/subject/
   purpose/form/source/lifecycle binding failures stop after at most that capture lease and before
   ordinary/control UoW admission. Submitted IDs are never authority.
4. Application coordination invokes a neutral
   `withVerifiedContentLockPlan(envelope, bindings, callback)` port. Platform alone owns HMAC/key and
   raw canonical keys inside opaque owner projections. It creates a one-use, callback-scoped nominal
   capability, immediately enters bounded admission, and revokes it in `finally` on every outcome.
   There is no global capability registry; domain/workflow/application code cannot import Platform
   crypto or inspect/forge projections.
5. The application checks out one dedicated database connection and acquires every known session-
   level key in global order: credential authority, product fence, subject, then lexical content
   release keys.
6. Only after all waits finish does the adapter `BEGIN` at the use case's required isolation and bind
   transaction-scoped module gateways plus a scoped opaque locked-content attestor.
7. Identity performs the first authoritative transactional recheck of installation epoch and actor/
   session/role authority. A stale queued request fails before any product-owner read or write.
8. Ordinary subject workflows then recheck generation before owner reads. Root setup is the sole
   replay exception: Athletes may read/classify the exact setup receipt first; exact replay must match
   its stored/current result generation, while only a new command proceeds to Identity's expected-
   generation gate. No owner mutation precedes that gate.
9. For every ordinary receipt-bearing command, its owning gateway now classifies the stored command
   identity plus stable-intent hash. Exact replay returns the original persisted result without later
   content/source/planning gates; mismatched reuse conflicts; only a new command proceeds. Plan
   structure/MAC/binding, current Identity authority, and current generation have already passed, so
   replay cannot cross actor, installation, or subject lifecycle authority. Root setup remains the
   sole classifier that runs before generation.
10. Every shape-required owner re-reads only its owned authoritative state—rows where applicable and
   Methodology's code-installed release registry—and returns a fresh, transaction-bound opaque
   projection fragment. The neutral attestor requires the exact closed owner-slot union and compares
   its hidden key bytes, purpose, source IDs, and transaction scope with the prelocked plan. A missing,
   duplicate, extra, wrong-scope, or changed fragment fails `content-lock-plan.stale` before mutation;
   Platform reads no product state and workflow code sees no keys or DML.
11. Owner gateways revalidate their domain invariants. For corrections the locked set is the full
    source-derived potential-impact union across every legal submitted shape; only now do parsed
    values select an actual causal invalidation subset contained by that union.
12. Repositories persist only their module's schema through the same transaction/connection.
13. Commit succeeds as one unit; all capabilities/fragments are revoked and locks released in
    unconditional cleanup, then server state is revalidated or redirected as required.
14. The UI shows success, unavailable, conflict, validation, or unauthorized explicitly.

`content-lock-plan.stale` discards the old token and refreshes/reissues the authorized form; safe
normalized values may be retained only for the same still-authorized source and require user review
and resubmission. It is never an automatic mutation retry. `content-lock-plan.invalid` is a generic,
non-echoing validation/security rejection followed by a fresh authorized reload. Transactional
epoch/generation/authority results retain their existing routes and precede plan currency;
`uow.capacity` and `uow.lock-timeout` remain distinct retryable service states.

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

### Optional grounded explanation (implemented, default off)

Plain-language explanation of **already persisted** decisions may use the optional
host-local model from completed-session History. That path is presentation only:
structured reason codes, versions, and loads remain authoritative; model output is
labeled inferred and must exactly reproduce the closed FactBundle-derived safe paragraph.
The methodology engine never calls a model.

The implemented slice includes a loopback adapter, versioned prompt/validator, pinned
model/runtime provenance, on-demand control, provenance-keyed PostgreSQL cache, and
linearized correction-ledger invalidation. It remains optional and disabled by default. See
[ADR 0006](adr/0006-optional-local-grounded-language.md) and the
[explanation generation contract](EXPLANATION_GENERATION_CONTRACT.md).

## Data model

The lists below distinguish the live engineering schema from the reviewed-content target.
The current schema implements the identity/profile, program snapshot, execution, and
portability entities needed for the technical slice. It stores methodology/template IDs,
versions, review status, hashes, and JSON snapshots on program revisions; those fields
are provenance references, not a reviewed content catalog. Gate 0 may still narrow or
extend them before a reviewed release.

### Identity/profile

- Better Auth users, sessions, accounts, verifications
- singleton installation state for serialized first-owner bootstrap
- destructive-reauthentication attempt state for subject deletion, instance reset,
  member-reset issuance, and local-user creation
- target-keyed member-reset issuance/cooldown/backoff state linked to the active
  digest-only verification capability
- HMAC-keyed fixed-window web credential-admission buckets for sign-in, member reset,
  and owner recovery
- athlete profile
- training-day preference
- confirmed athlete equipment codes
- strength baseline with test protocol and date

### Reviewed content target — not implemented

- exercise and equipment mapping
- exercise substitution
- source/evidence record
- methodology release
- program template and immutable template version

None of those reviewed-content catalog tables exists in the engineering MVP. Exercise
identity and equipment requirements come from the conspicuously unreviewed development
fixture, while program revisions snapshot the resulting prescriptions. Exact-version
methodology/template revocation is already represented by an append-only instance record
and enforced against those snapshots at runtime. There is no operator-facing revocation
UI or CLI yet. Source lookup, rights enforcement, substitutions, reviewed-release
authoring/activation, and its operator workflow still require the future catalog and Gate
0 approval.

### Program

- program
- program revision
- append-only revision lineage (currently Training-owned; Part B transfers it to Programs in Stage 6)
- Training-owned correction invalidation provenance
- planned workout
- exercise/set prescription snapshot
- append-only exact-version methodology/template release revocation

### Execution

- workout session
- session exercise
- performed set
- session feedback
- adjustment decision
- session-linked safety holds and append-only hold resolutions
- append-only command receipts, training-fact corrections, performed-set/feedback
  corrections, and decision invalidations
- validated future-load explanation cache (owned by user/session/decision with model,
  runtime, prompt, validator, FactBundle, and duration provenance)
- audit event

### Portability/administration

- expiring, digest-bound deletion preview
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
- A planned workout belongs to a program revision. Workout start stages its session as
  `initializing` while snapshot exercises and sets are inserted, then atomically
  finalizes it to `active` before the transaction commits. Its externally visible
  lifecycle then follows active ↔ paused → completed or abandoned.
- The singleton installation and host-issued capability rows are locked in the
  first-owner transaction. Credential creation, capability consumption, and bootstrap
  closure commit atomically; explicit database creation modes and the unique owner
  invariant reject generic or concurrent claims.
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
- `HttpOnly`, `SameSite=Lax` cookies; `Secure` whenever the configured application origin
  is HTTPS, while loopback-local HTTP remains supported without the `Secure` attribute
- host-issued, expiring, one-use, transactionally serialized first-owner bootstrap
- generic public signup disabled before and after bootstrap
- one email-first/account-scoped advisory-lock order covers known and unknown password
  sign-in, owner-created local credentials, member reset, and owner recovery through
  password replacement and session revocation
- server-derived actor identity for every use case
- optional SMTP is a future adapter, not an implemented password-reset path; no
  mandatory email/cloud identity exists
- owner-mediated member reset: fresh owner reauthentication issues an expiring one-use
  code; public redemption chooses the replacement password, revokes sessions, and
  preserves all account-owned training state
- out-of-band sole-owner recovery when SMTP is absent: a host-local admin command with
  database access issues an expiring one-use code; protected CLI or web redemption
  revokes sessions and writes a redacted channel-aware audit event
- HMAC-keyed, fixed-window web credential admission with bounded cleanup and minimized
  audit addresses; active throttles do not amplify mutable state or audit
- database-backed session reads disable cookie caching, and no browser bearer/refresh
  token path can outlive recovery-triggered revocation

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

That is the core topology. Enabling optional grounded-language generation adds one
non-authoritative, host-local llama.cpp process reached only through the
loopback-restricted HTTP primitive; the application and database continue to serve every
core journey without it.

Structured stdout, configuration validation, and truthful application/database health are
part of the application. A guarded manual PostgreSQL backup/restore runbook and exercised
disposable-database drill are checked in. Reverse proxy, Docker, CI/CD, monitoring stack,
HA, backup scheduling/retention automation, and deployment packaging are later
operational work.

Plain HTTP is supported only for loopback-local use. Phone, LAN, and any other
non-loopback access require an externally visible HTTPS origin and `Secure` cookies. A
user-managed TLS terminator may sit in front of the Node process; it is an ingress
prerequisite, not an application datastore or authority. Product-supplied proxy
configuration and certificate automation remain deferred. The supported `dev` and
`start` commands bind the Node listener explicitly to `127.0.0.1`; `start` completes the
database preflight before listening.

Deletion is a deliberate destruction exception to historical immutability. The current Data
Portability composition captures authority before queueing, then rechecks Identity first and uses
its exact temporary adapter to delete or redact scoped personal records in referential order inside
one serializable `UnitOfWork`. A post-`COMMIT` transport failure is reported as outcome unknown,
never as a known rollback. Short-lived signed, nonce-bearing destructive-result notices are bound
to the exact actor on authenticated surfaces; generic verification is limited to post-destruction
sign-in/bootstrap orientation. They report an outcome and never authorize a mutation. The workflow
retains system-level tombstones
containing event ID, actor class, timestamp, schema version, aggregate row counts, and a
completion digest—never identity, health context, or training content. Instance reset also
retains the cleared singleton installation record and prior non-personal tombstones.

See [the self-hosting contract](SELF_HOSTING_CONTRACT.md).

The outbound-network acceptance runner executes the application and browser in a Linux
namespace with only loopback and a private PostgreSQL bridge. The complete 19-test default
tree passed from clean committed product tree
`6117fbe4f6ea363b8cf4553ed5c10eee51009ef6`; later product/runtime or default-suite
changes require a new retained run.

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
