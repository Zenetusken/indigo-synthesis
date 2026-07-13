# Core product specification

Status: provisional until the Methodology v1 decision pack is approved  
Scope: first coherent self-hosted product release

Implementation status is tracked separately in
[MVP status and traceability](../MVP_STATUS.md). The working development slice does not
weaken this specification or make its unreviewed fixture a Release 1 program.

## Actors

### Instance owner

Bootstraps the installation, controls signup policy, manages local accounts, applies
approved methodology/template releases, and owns backup/export responsibilities.

### Trainee

Maintains a profile, follows a program, records training, reviews history, and can export
or delete personal data.

The first release may use the same person for both product actors. Coach, reviewer, and
content editor are not application-account roles until their workflows exist; Gate 0
review independence remains an external release requirement.

### Account, profile, and vocabulary

To keep identity terms stable across this spec and the code:

- **Account** — an authenticated identity with a credential and a derived role (owner
  or trainee); the unit of authentication, authorization, session, and audit.
- **Profile** — a training context (units, timezone, program, history, safety state).
  Today exactly one profile per account; the code's existing **subject** /
  `subjectUserId` vocabulary refers to this profile-today.
- **Member** — a synonym for a non-owner (trainee) account, used where the contrast is
  "owner versus the accounts the owner administers". Not a separate role.

Access, recovery, and administration operate on the **account** axis. Detailed
journeys, invariants, hardening, and success metrics live in
[Access and recovery](./ACCESS_AND_RECOVERY_SPEC.md).

## Core journeys

### J1 — Bootstrap and sign in

1. A fresh instance detects that no owner exists.
2. The first owner creates a local email/password account.
3. Public signup becomes disabled by default.
4. The owner signs in through a secure database-backed session.

### J2 — Set up a trainee

1. Choose display units and timezone.
2. Record primary goal and experience.
3. Select available equipment and training days.
4. Record session-length constraints and reviewed strength baselines.
5. Record limitations as trainee-provided context, without diagnosis.
6. Confirm the exact inputs before program creation.

### J3 — Instantiate one reviewed program

1. Select one licensed, published template release.
2. Run the approved methodology release with explicit inputs and date.
3. Validate all prescriptions against safety and equipment bounds.
4. Save an immutable program revision, input hash, output hash, reasons, and versions.
5. Show the trainee a readable overview before activation.

### J4 — Train today

1. Today shows the active program, phase/week, and prescribed workout.
2. Start creates one active session and snapshots the prescription.
3. The active screen shows the current exercise, target, prior comparable performance,
   and ordered set ledger.
4. The trainee records actual load, reps, optional RPE, rest, and notes.
5. Pause and resume recover the exact persisted session.
6. A reviewed substitution preserves the original and replacement reason.

### J5 — Complete and learn

1. Completion validates set state and asks about missing work explicitly.
2. The completed session becomes immutable except through an audited correction.
3. A summary shows only facts and labeled estimates.
4. History shows the completed session and the factual data that produced its summary.
5. A deterministic rule may propose one future adjustment with its reason and bounds.

### J6 — Control data

1. Export produces a versioned, documented archive.
2. Account/data deletion previews exactly what will be removed, requires explicit
   confirmation, and reports completion without retaining personal training content.
3. The instance owner can back up PostgreSQL plus local media as the complete data
   boundary.

### J7 — Recover a trainee credential (owner-mediated)

1. The owner, re-authenticating, issues a one-use, expiring reset code for a trainee
   account and hands it over out of band.
2. The trainee redeems it on a public page, choosing a new password.
3. Redemption revokes that account's sessions and is audited; the owner does not learn
   the chosen password in the honest flow.

### J8 — Recover the owner credential (host-mediated)

1. The owner issues a one-use, expiring recovery code from the host (shell access).
2. The owner redeems it — on the host CLI or a public web page — sets a new password,
   revokes sessions, and the event is audited.

### J9 — Orient a locked-out visitor (cold start)

1. A claimed instance's sign-in page offers an explicit next action for a trainee who
   forgot their password, an owner who forgot theirs, and a person with no account —
   without revealing whether any account exists.

Owner recovery (FR-006) already exists; trainee reset (J7) and cold-start orientation
(J9) are the new additions. These access/recovery journeys are governed by the success
metrics in [Access and recovery](./ACCESS_AND_RECOVERY_SPEC.md), not the Release 1
J1–J6 acceptance gate.

## Functional requirements

### Identity and access

- **FR-001** A fresh instance supports first-owner bootstrap exactly once and only with
  an expiring, one-use capability issued from the host.
- **FR-001A** Bootstrap is serialized by a singleton installation record and database
  transaction; two concurrent requests cannot create two first owners.
- **FR-002** Authentication uses opaque, revocable, PostgreSQL-backed sessions in secure
  cookies.
- **FR-003** Every application use case derives actor identity from the server session.
- **FR-004** Cross-user reads and mutations are denied and tested.
- **FR-005** Generic public signup is disabled; an authenticated owner controls creation
  of any additional local users.
- **FR-006** Sole-owner recovery requires local host/administrative access, an expiring
  one-use recovery code, session revocation, and a non-secret audit record. It is never a
  public browser-only reset path.
- **FR-007** An authenticated, re-authenticated owner may issue a one-use, expiring,
  HMAC-keyed reset code for a trainee account (at most one outstanding, throttled under
  abuse, never destroyed by wrong guesses). Redemption lets the trainee set their own
  password, revokes that account's sessions, and writes a non-secret audit record.
  Trainee recovery never routes through account deletion, and the owner does not learn
  the chosen password in the honest flow.
- **FR-008** A claimed instance's sign-in surface provides an explicit next action for
  each locked-out persona — trainee, owner, no-account — without disclosing whether any
  account exists; failure responses are uniform across cause and across whether the
  submitted account exists.

### Athlete profile

- **FR-010** Store units, IANA timezone, goals, experience, schedule, session length,
  equipment, and reviewed baselines.
- **FR-011** Keep limitations and subjective context distinguishable from measured data.
- **FR-012** Changes that would alter an active program create a reviewed future revision;
  they do not rewrite history.
- **FR-013** A coaching/neurotype questionnaire is absent until its instrument, claims,
  scoring, rights, and UI language pass Gate 0.

### Methodology and programs

- **FR-020** Methodology releases and template versions are immutable after publication.
- **FR-021** Program creation is deterministic for a normalized input and explicit
  `asOfDate`.
- **FR-022** Every program stores engine, methodology, and template versions plus input
  and output hashes.
- **FR-023** Every material prescription includes reason codes and source-rule IDs.
- **FR-024** Manual override records actor, timestamp, reason, prior value, and replacement.
- **FR-025** A methodology release may only use approved rules inside code-enforced safety
  bounds.
- **FR-026** Adaptation creates a future program revision and never mutates completed work.

### Today and workout execution

- **FR-030** Today shows a truthful empty, unavailable, rest-day, planned, active, or
  completed state.
- **FR-031** Only one session may be active per trainee.
- **FR-032** A planned workout is not a session. Start creates a session in `active`;
  session lifecycle is active ↔ paused → completed or abandoned.
- **FR-033** Session exercises snapshot exercise identity, order, prescription, and
  rationale.
- **FR-034** Performed sets store canonical load, reps, optional RPE, completion time,
  optional note, and whether defaulted values were copied, edited, and explicitly
  confirmed by the trainee.
- **FR-035** Set writes and session completion are idempotent.
- **FR-036** Rest time is based on timestamps so backgrounding does not corrupt it.
- **FR-037** Substitution is limited to approved, equipment-compatible alternatives and
  preserves an audit trail.
- **FR-038** Application restart recovers the exact active session from PostgreSQL.

### First-slice history and explanation

- **FR-050** History is derived from completed sessions and performed sets.
- **FR-054** Missing data remains unavailable; no default score is substituted.
- **FR-055** Rest days do not count as missed training.

### Post-slice progress (Phase 3; not part of the Release 1 gate)

- **FR-051** Personal records state their definition and source set.
- **FR-052** Estimated 1RM is labeled as an estimate and names the formula.
- **FR-053** Volume is shown only where its definition is mathematically meaningful.

### Explanation and safety

- **FR-060** Each recommendation displays a concise explanation and ruleset version.
- **FR-061** The trainee can inspect source/evidence status for a coaching rule.
- **FR-062** Safety rules outrank template, progression, preference, and equipment rules.
- **FR-063** Pain/contraindication signals stop or escalate; the product does not diagnose.
- **FR-064** Advanced techniques require an approved safety tier and eligibility rule.

### Portability and administration

- **FR-070** Export includes schema version, identity/profile data, program revisions,
  sessions, sets, explanations, and audit events.
- **FR-071** Deletion is explicit, scoped, confirmable, and tested.
- **FR-071A** Deletion is the explicit exception to historical immutability. A single
  portability workflow orders referential deletion/redaction inside one transaction and
  retains no personal training content. Subject deletion appends a non-personal
  tombstone; whole-instance reset also reopens the non-personal installation singleton
  for bootstrap and preserves non-personal tombstone records containing event ID, actor
  class, timestamp, schema version, aggregate row counts, and completion digest.
- **FR-072** No core workflow requires a cloud identity, email provider, object store,
  analytics service, CDN, or model API.
- **FR-073** Development/demo data is visibly labeled and cannot enter production history.
- **FR-074** Export omits or references licensed methodology/template content according
  to its recorded end-user export and redistribution rights; the archive names every
  omission.

## Quality requirements

- **NFR-001 Self-hosting:** one Node process plus one PostgreSQL database; one writable
  directory only if media is enabled.
- **NFR-001A Secure access:** loopback-local operation may use plain HTTP. Any phone,
  LAN, or other non-loopback deployment uses an HTTPS origin and `Secure` cookies
  through a user-supplied TLS terminator; loopback HTTP cookies remain `HttpOnly` and
  `SameSite=Lax` but are not marked `Secure`.
- **NFR-002 Accessibility:** WCAG 2.2 AA, keyboard operation, visible focus, 200% zoom,
  reduced motion, and status beyond color.
- **NFR-003 Mobile:** 48px workout targets, 16px numeric inputs, safe-area-aware sticky
  actions, and one document scroll root.
- **NFR-004 Integrity:** database constraints enforce ownership, order, bounds,
  immutability, and uniqueness.
- **NFR-005 Reproducibility:** the same normalized inputs and versions produce the same
  prescription/output hash.
- **NFR-006 Privacy:** no telemetry or outbound runtime request by default; data
  minimization, export, and deletion are implemented and tested in the first release.
- **NFR-007 Honesty:** error and unavailable states are explicit and cannot degrade into
  realistic fallback data.
- **NFR-008 Maintainability:** module dependencies are acyclic and domain code is free of
  framework/infrastructure imports.
- **NFR-009 Performance:** complete-set feedback is immediate; persistence is confirmed
  without blocking normal interaction. Numeric SLAs follow measurement, not speculation.
- **NFR-010 Browser support:** the current Next.js-supported evergreen browser set; no
  legacy browser polyfill program.

## First vertical-slice information architecture

- **Today** — start/resume and concise current-program context
- **Program** — overview, phase/week, schedule, and explanations
- **History** — completed sessions and factual summaries
- **Settings** — profile, units, instance/account, export, deletion, and appearance

Community, Nutrition, Recovery, and Profile are not primary navigation destinations.

After the slice passes, Phase 3 expands History with exercise-specific views and adds
**Progress** for defined PR, e1RM, volume, and adherence trends.

## Acceptance gate

Release 1 is not complete until one Playwright suite, with application APIs unmocked,
proves the complete J1 through J6 journey against a fresh PostgreSQL database and:

- works with outbound network blocked;
- survives application restart during J4;
- verifies cross-user denial;
- verifies idempotent set and completion commands;
- verifies approved deterministic golden vectors and output hashes;
- proves in real browser/database paths that a contraindication blocks prescription, a
  pain signal stops or escalates training, an unsafe substitution is denied, and an
  ineligible advanced technique cannot be prescribed or started;
- proves safety precedence and bounds with methodology property tests;
- verifies that export provenance is interpretable, licensed omissions are named, and
  confirmed deletion removes the scoped personal data while retaining only the permitted
  non-personal tombstone;
- observes explicit empty/error states; and
- leaves no placeholder or simulated behavior in the tested path.

Unit tests, pass counts, health checks, direct database scripts, and mocked dashboards do
not satisfy this gate.
