# Indigo Synthesis

Indigo Synthesis is a self-hosted strength-training system rebuilt from three abandoned
implementations around one narrow loop:

> Know today's work. Log it quickly. Understand what changes next.

The repository now contains a working **engineering MVP**: local authentication and
owner bootstrap, trainee setup, deterministic development-program generation, Today,
workout execution, history, a bounded future adjustment, export, subject deletion, and
owner-controlled instance reset.

It is **not a production coaching release**. The only bundled program and adjustment
policy are conspicuously labeled development fixtures. They have not received independent
strength-program, safety, evidence, or rights review, and configuration rejects them in
production mode. See [MVP status and traceability](docs/MVP_STATUS.md).

## Product and runtime boundaries

- Core use is self-hosted and online-first: one Node.js application and one PostgreSQL
  database, with no mandatory cloud service.
- Authentication, sessions, fonts, program state, workout state, and history are local.
- Plain HTTP is supported only on loopback. Phone, LAN, and other non-loopback use
  requires an operator-supplied HTTPS/TLS terminator.
- Offline mutation/synchronization is not a hard requirement and is deferred.
- Docker/Compose, CI/CD, a monitoring stack, and deployment packaging are deliberately
  absent.
- Neurotype assessment, nutrition, social features, wearables, and AI coaching are out of
  scope.

## Implemented engineering slice

- one-time, transactionally serialized first-owner bootstrap;
- local email/password accounts and PostgreSQL-backed sessions through Better Auth;
- owner-created local users with cross-user authorization boundaries;
- host-local, expiring, one-use owner credential recovery;
- trainee units, timezone, goal, experience, schedule, equipment, baseline loads, and
  trainee-reported limitation context;
- deterministic, versioned program revisions with normalized-input and output hashes;
- safety/content eligibility gates that fail closed;
- Today, start, pause/resume, persisted set logging, timestamp-derived rest context,
  explicit skip/abandon, pain stop, completion, and application-restart recovery;
- factual session history and a development-only, bounded future-load decision that
  creates a new revision rather than rewriting completed work;
- versioned subject export with provenance, category hashes, and explicit omissions;
- previewed member account/data deletion and owner-only full-instance reset, each with
  reauthentication, exact row counts, and a non-personal tombstone; and
- PostgreSQL constraints/triggers for ownership, lifecycle, immutability, and audit
  immutability outside the explicit deletion workflow.

No reviewed exercise substitution is bundled. The workout UI therefore denies
substitution rather than inventing an equivalent.

## Local development

Requirements:

- Node.js 24 LTS
- pnpm 10
- PostgreSQL 18 or newer

Create a PostgreSQL database and copy `.env.example` to `.env.local`. Set a unique
authentication secret of at least 32 characters. For the technical walkthrough, change
the content mode to `development`:

```dotenv
DATABASE_URL=postgresql://indigo:change-me@127.0.0.1:5432/indigo_synthesis
BETTER_AUTH_SECRET=replace-with-a-unique-secret-at-least-32-characters-long
BETTER_AUTH_URL=http://127.0.0.1:3000
INDIGO_CONTENT_MODE=development
NEXT_TELEMETRY_DISABLED=1
```

Then install, migrate, verify, and run:

```sh
pnpm install
pnpm db:migrate
pnpm db:preflight
pnpm dev
```

Open `http://127.0.0.1:3000`. Both `pnpm dev` and `pnpm start` bind only to that
loopback address; network access belongs behind an operator-managed HTTPS ingress. A
fresh database presents the one-time owner bootstrap, then setup and the
development-program walkthrough. `pnpm start` retains the database compatibility
preflight before the production process starts listening.

`INDIGO_CONTENT_MODE=development` is for technical validation only. A production
process refuses that mode. No reviewed program release ships yet, so the application is
not presently a production coaching product even though a production build can be
validated.

## Validation

The normal local gates are:

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
INDIGO_CONTENT_MODE=reviewed pnpm build
```

`pnpm validate` runs static checks, unit/domain tests, and a production-mode build. The
database-backed suites are intentionally separate because they require PostgreSQL.

The Playwright suite includes targeted 390×844 mobile reflow, 200% text sizing,
keyboard/focus continuation, reduced-motion, status-announcement, control-size, distinct
page-title, and non-loopback browser-request checks. Those automated checks are useful
evidence, not a full WCAG audit or manual screen-reader certification.

Integration tests use `DATABASE_URL` as their administrative connection and create then
drop uniquely named disposable databases on the same server. The configured role must
therefore be allowed to create and drop databases. The browser suite also needs a
separate disposable database and secret, normally in `.env.e2e.local`:

```dotenv
E2E_DATABASE_URL=postgresql://indigo:change-me@127.0.0.1:5432/indigo_synthesis_e2e
E2E_BETTER_AUTH_SECRET=replace-with-another-unique-secret-at-least-32-characters-long
```

The E2E reset command drops and recreates the database named by `E2E_DATABASE_URL`.
Before opening any connection, its destructive-target guard requires both values to be
PostgreSQL URLs on an explicit loopback host, with exactly the same host, effective port,
and explicit username; query parameters are refused so they cannot override that checked
connection identity. The target must differ from the administrative database and match
`indigo_<name>_e2e` using lowercase letters, digits, and underscores. The configured
PostgreSQL role must be allowed to create and drop it. These constraints make the reset
a conspicuously local, project-test-only operation; do not point either value at a shared
or production server.

## Owner recovery

Owner recovery is deliberately host-local and two-step. Secret values are accepted only
through absolute-path, owner-readable files; they are never command arguments or browser
inputs.

```sh
pnpm owner:recover issue \
  --owner-email owner@example.test \
  --code-file /absolute/private/path/recovery-code \
  --ttl-minutes 15

pnpm owner:recover redeem \
  --owner-email owner@example.test \
  --code-file /absolute/private/path/recovery-code \
  --password-file /absolute/private/path/new-password
```

The issue command creates the code file exclusively with mode `0600`, so that path must
not already exist. The password file must already exist as a regular file
readable/writable only by its owner and contain exactly one line with 12–128 characters.
The TTL must be 5–60 whole minutes. Redemption consumes and removes the code file,
changes the credential, revokes existing owner sessions, and records a redacted audit
event.

## Repository map

- `docs/MVP_STATUS.md` — implementation traceability, evidence, open release gates, and
  known architecture debt
- `docs/discovery/` — source coverage and failure synthesis
- `docs/product/` — vision, canonical requirements, methodology gate, and claim policy
- `docs/architecture/` — runtime shape, stack, self-hosting contract, and ADRs
- `docs/design/` — experience and visual-design direction
- `docs/ROADMAP.md` — gated path from the engineering MVP to a releasable product
- `docs/DEFERRED.md` — explicit non-goals and re-entry criteria
- `src/modules/` — identity, athlete, methodology, program, training, and portability
  behavior
- `src/platform/db/` and `drizzle/` — PostgreSQL schema, preflight, and the sole committed
  migration ledger
- `test/integration/` and `test/e2e/` — database and real-browser proof

Start with [the product vision](docs/product/VISION.md), then read
[the core specification](docs/product/PRODUCT_SPEC.md) and
[the open Methodology v1 decision pack](docs/product/METHODOLOGY_V1_DECISION_PACK.md).

No legacy code, branded imagery, program prose, or third-party training material was
copied into this implementation.
