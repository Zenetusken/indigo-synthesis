# Indigo Synthesis

Indigo Synthesis is a self-hosted strength-training system rebuilt from three abandoned
implementations around one narrow loop:

> Know today's work. Log it quickly. Understand what changes next.

The repository now contains a working **engineering MVP**: local authentication and
owner bootstrap, trainee setup, deterministic development-program generation, Today,
workout execution, history, a bounded future adjustment, export, subject deletion, and
owner-controlled instance reset. It also implements owner-mediated trainee reset,
host-issued owner recovery through CLI or web redemption, and claimed-instance recovery
orientation.

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
- Neurotype assessment, nutrition, social features, wearables, and AI coaching (model-led
  decisions) are out of scope. Optional host-local grounded explanation prose is
  implemented only as a default-off, codes-subordinate History presentation path; see
  [ADR 0006](docs/architecture/adr/0006-optional-local-grounded-language.md).

## Implemented engineering slice

- one-time, transactionally serialized first-owner bootstrap;
- local email/password accounts and PostgreSQL-backed sessions through Better Auth;
- reauthenticated owner-created local users with cross-user authorization boundaries;
- owner-mediated, expiring, one-use trainee reset with session revocation and a
  cause-neutral return to the exact persisted workout after sign-in;
- host-issued, expiring, one-use owner credential recovery through protected CLI files or
  web redemption, with CLI redemption retained as the host-trust escape path;
- claimed-instance sign-in guidance for trainee, owner, and no-account visitors;
- trainee units, timezone, goal, experience, schedule, equipment, baseline loads, and
  trainee-reported limitation context;
- deterministic, versioned program revisions with normalized-input and output hashes;
- safety/content eligibility gates that fail closed;
- Today, start, pause/resume, persisted set logging, timestamp-derived rest context,
  explicit skip/abandon, pain stop, completion, and application-restart recovery;
- factual session history and a development-only, bounded future-load decision that
  creates a new revision rather than rewriting completed work;
- on-demand History explanation through one digest-locked local Q4/CUDA runtime, with a
  closed grounded-output validator, PostgreSQL cache, and correction-ledger invalidation;
- versioned subject export with provenance, category hashes, and explicit omissions;
- previewed member account/data deletion and owner-only full-instance reset, each with
  reauthentication, exact row counts, and a non-personal tombstone; and
- PostgreSQL constraints/triggers for ownership, lifecycle, immutability, and audit
  immutability outside the explicit deletion workflow.

No reviewed exercise substitution is bundled. The workout UI sends a typed proposal
through the authenticated application boundary and returns an explicit denial without
changing the prescription or session facts, rather than inventing an equivalent.

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
pnpm install --frozen-lockfile
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
pnpm docs:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
INDIGO_CONTENT_MODE=reviewed INDIGO_LLM_MODE=disabled pnpm build
```

Optional operator-only suite for the local GPU language layer (not part of the normal
gate; requires a healthy NVIDIA GPU and a loopback model server — see
`docs/architecture/LLM_RUNTIME_AND_GPU.md`):

```sh
pnpm llm:build-cuda
pnpm llm:serve   # separate terminal, pinned all-layer CUDA offload + attestation
pnpm llm:preflight
pnpm test:e2e:llm
RUNS=3 pnpm llm:archive-product-path   # multi-run archive → tmp/llm-runs/
```

`pnpm validate` runs static checks, documentation link/anchor validation, unit/domain tests, and a
production-mode build. The database-backed suites are intentionally separate because they require
PostgreSQL.

Two opt-in operational proofs are also checked in:

```sh
pnpm db:backup-restore-drill
bash scripts/e2e/run-network-denied.sh
```

The first creates, wipes, restores, verifies, and removes only a guarded random
disposable database; the second runs the default browser suite in a Linux namespace with
no non-loopback interface or default route. Read
[`docs/operations/BACKUP_RESTORE.md`](docs/operations/BACKUP_RESTORE.md) and
[`docs/operations/OUTBOUND_NETWORK_BLOCKED_ACCEPTANCE.md`](docs/operations/OUTBOUND_NETWORK_BLOCKED_ACCEPTANCE.md)
before using them. The current committed 19-test isolation proof is retained in
[`docs/operations/evidence/2026-07-13-outbound-network-blocked.md`](docs/operations/evidence/2026-07-13-outbound-network-blocked.md).
Neither substitutes for encrypted off-host retention, a second-person cold restore, or
independent security/accessibility review.

Before the first browser run, install the pinned Playwright Chromium build and create the
ignored local E2E configuration from the checked-in template:

```sh
pnpm exec playwright install chromium
cp .env.e2e.example .env.e2e.local
```

The canonical `pnpm test:e2e` and `pnpm test:e2e:llm` wrappers hold one per-UID,
machine-local non-blocking lock across reset and Playwright, so a second
default/live/worktree run by the same operating-system user fails before it can
terminate the first run's database connections or bind its ports. The optional
`INDIGO_E2E_APPLICATION_PORT` and `INDIGO_E2E_SUPERVISOR_PORT` overrides are for
explicitly isolated diagnostics; the committed defaults remain 3100/3101.

Both checked-in Playwright configurations also validate and pin the disposable database
target while loading, and per-test application-data cleanup revalidates the original
administration/target pair immediately before opening a database connection. Direct
Playwright CLI and VS Code extension runs therefore cannot bypass the destructive-target
guard. They do not perform the wrapper's serialized drop/recreate step, so use the
documented `pnpm` commands for canonical evidence and direct invocation only for an
explicitly isolated diagnostic.

Review `.env.e2e.local` before running the suite. Give it a distinct test-only secret and
keep its target on the same explicit loopback PostgreSQL host, port, and username as
`DATABASE_URL`. Playwright browser installation may require operating-system packages;
those host prerequisites are intentionally outside the application runtime.

The Playwright suite includes targeted 390×844 mobile reflow, 200% text sizing,
keyboard/focus continuation, reduced-motion, status-announcement, control-size, distinct
page-title, and non-loopback browser-request checks. Those automated checks are useful
evidence, not a full WCAG audit or manual screen-reader certification.

Integration tests force `NODE_ENV=test` and the conspicuously labeled development content
fixture regardless of the production-safe content-mode default in `.env.local`. They
require a separate administration connection and never fall back to `DATABASE_URL`:

```dotenv
INTEGRATION_ADMIN_DATABASE_URL=postgresql://indigo:change-me@127.0.0.1:5432/postgres
```

That URL must be PostgreSQL on the literal loopback host `127.0.0.1` or `[::1]`, name an
explicit user, and contain no query parameters. The role must be allowed to create and
drop databases. Each suite derives a 96-bit random target named
`indigo_<suite>_<24 lowercase hex characters>_integration`; cleanup can terminate and
drop only after that process receives a successful `CREATE DATABASE` result. A collision
or failed create is never cleaned up destructively.

The browser suite also needs the separate disposable database and secret copied into
`.env.e2e.local`:

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

## Owner bootstrap

A fresh installation cannot be claimed through generic signup. First issue a short-lived,
one-use capability from the host into a protected directory owned by the invoking user:

```sh
pnpm owner:bootstrap issue \
  --code-file /absolute/private/path/owner-bootstrap-code \
  --ttl-minutes 15
```

Open `/bootstrap` and enter that code with the initial owner details. The code is stored in
PostgreSQL only as an authenticated digest, expires after 5–60 whole minutes, and is
consumed in the same transaction that creates the credential and closes installation
bootstrap. Delete the host file after a successful claim; replay cannot create another
owner.

## Owner recovery

Owner recovery is deliberately host-anchored and two-step. Issuance always requires the
host command and writes the one-time code to an absolute-path file owned by the invoking
POSIX effective user. Redemption may use protected CLI files or the unauthenticated
`/recover` form; the web path sends the code and replacement password only in a POST body,
never a URL, and applies fixed-window admission limits. The resolved parent directory for
CLI files must have the same owner and must not be writable by group or other users.

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
not already exist. For CLI redemption, the password file must already exist as a regular,
owner-only file with mode `0400` or `0600` and contain exactly one line with 12–128
characters. Symbolic links, oversized files, extra lines, and NUL bytes are refused. The
TTL must be 5–60 whole minutes. Both redemption channels change the credential, revoke
existing owner sessions, and record a redacted channel-aware audit event. Successful CLI
redemption removes the code only if its path still names the opened inode.

## Repository map

- `docs/MVP_STATUS.md` — implementation traceability, evidence, open release gates, and
  known architecture debt
- `docs/discovery/` — source coverage and failure synthesis
- `docs/product/` — vision, canonical requirements, methodology gate, and claim policy
- `docs/architecture/` — runtime shape, stack, self-hosting contract, and ADRs
- `docs/operations/` — guarded operator procedures and retained drill evidence
- `docs/design/` — experience and visual-design direction
- `docs/ROADMAP.md` — gated path from the engineering MVP to a releasable product
- `docs/DEFERRED.md` — explicit non-goals and re-entry criteria
- `src/modules/` — identity, athlete, methodology, program, training, and portability
  behavior
- `src/platform/db/` and `drizzle/` — PostgreSQL schema, preflight, and the sole committed
  migration ledger
- `src/platform/llm/` and `llm/` — optional grounded-language contracts, guarded
  loopback runtime integration, exact artifact/runtime locks, and operator tooling
- `test/integration/` and `test/e2e/` — database and real-browser proof

Start with [the product vision](docs/product/VISION.md), then read
[the core specification](docs/product/PRODUCT_SPEC.md) and
[the open Methodology v1 decision pack](docs/product/METHODOLOGY_V1_DECISION_PACK.md).

No legacy code, branded imagery, program prose, or third-party training material was
copied into this implementation.

## License

Indigo Synthesis is available under the [MIT License](LICENSE).
