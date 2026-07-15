# Access and recovery specification

Status: decision-complete implementation contract, revised after adversarial +
consistency review (2026-07-13)
Scope: the administration model for local accounts, unauthenticated cold start,
credential recovery for both actors, and the sign-in surface of a claimed instance

Extends [Core product specification](./PRODUCT_SPEC.md) journeys J1–J6 with J7–J9.
Implementation status belongs in [MVP status](../MVP_STATUS.md); nothing here weakens
[Claims and safety](./CLAIMS_AND_SAFETY.md).

> **Review provenance.** This revision folds in two code-verified reviews: an
> adversarial security review and a consistency/testability review. Findings that
> corrected a factual claim in the prior draft are marked `[corrected]`; hardening
> that was added in response is marked `[added]`. The reconciliation summary lives at
> the end under "Review reconciliation".

## Problem addressed by this slice

A claimed instance previously greeted every visitor with an email/password form and
exactly one outcome on failure: "The email or password was not accepted." There was no
path for:

- a trainee who forgot their password (no reset or owner-administered
  deletion/recreation path existed, so the account had no supported recovery path);
- an owner who forgot their password and does not know that `pnpm owner:recover`
  exists (the mechanism was complete but invisible to the product surface);
- a person with no account (the page footnote implies self-signup is absent but
  did not state how access is actually granted).

The implementation now resolves those dead ends through J7–J9. The threat model and
requirements below remain the durable contract, not a historical implementation diary.

## Terminology

To keep this doc and the code aligned (and to stop "member"/"subject"/"local user"
drifting apart), these terms are fixed here and proposed for a shared block in
PRODUCT_SPEC:

- **Account** — an authenticated identity with a credential and a derived role. The
  unit of authentication, authorization, session, and audit.
- **Owner** — the single administrative account (role derived, not stored).
- **Trainee** — a non-owner account.
- **Member** — synonym for a trainee account, used where the contrast is
  "owner vs the accounts the owner administers". Not a separate role.
- **Profile** — a training context (units, timezone, program, history, safety
  state). Today exactly one profile per account; the code's existing **subject** /
  `subjectUserId` vocabulary refers to this profile-today.

## Prior art and positioning

The nearest FOSS reference for locally-administered access is Pi-hole: a
self-hosted service with a single local admin credential, application passwords,
optional TOTP, and no cloud identity. The current implementation already keeps
local-only trust, no email dependency, and no third-party identity. The
administration model specified here goes further where Pi-hole stops:

- **true multi-user**: separate owner and trainee accounts with per-account data
  isolation, not one shared admin secret;
- **administered lifecycle**: the owner can create trainee accounts today; this spec adds
  credential reset inside the product, with every credential-lifecycle step audited to
  an append-only log. Owner-directed member removal is a separate lifecycle decision,
  not an implemented or implicit part of this recovery slice;
- **ephemeral recovery secrets**: owner recovery already uses a one-use, TTL-bound,
  HMAC-keyed code; this spec extends that pattern, with its additional abuse controls, to
  trainee recovery instead of introducing static app passwords;
- **host-anchored root of trust**: owner recovery deliberately requires shell
  access to the installation, mirroring bootstrap.

## Administration model (invariant)

The owner-administers-members model is the backbone; every requirement must preserve
it:

- **A1** — Exactly one owner account exists per installation, created only by
  bootstrap (J1); never created, promoted, or demoted through UI or API.
- **A2** — Trainee accounts are created only by the authenticated owner. Public
  signup does not exist in any configuration.
- **A3** — Only the owner can issue trainee reset codes, and only for non-owner
  accounts. The owner account is never a valid target of J7.
- **A4** — The owner does not learn, set, or store a trainee's *final* password in
  the normal flow. **This is a trust assumption, not a mechanism-enforced
  invariant** `[corrected]`: the owner is the root of trust for trainees and, being
  able to issue and self-redeem a reset code, *can* set a live trainee credential.
  The design's contribution is that the honest owner never needs to and never
  incidentally sees the trainee's chosen password — not that a malicious owner is
  prevented. Every such action is audited (A6), which is the actual control.
- **A5** — Role mutation (owner transfer, promotion, demotion) is out of scope; no
  such surface exists (role is derived by `deriveIdentityRole`, not stored), so the
  invariant is enforced by *absence*, not by a reject-and-audit path.
- **A6** — For the credential-lifecycle commands added or adapted by this slice—member
  reset issue/redeem, owner-recovery issue/redeem, and secure local-user creation—every
  admitted attempt or successful transition writes exactly one append-only audit event
  with the identifiers that were actually resolved, its outcome, channel, and — **for
  web-originated actions** — a minimized client-address value `[corrected]`. An
  unauthenticated attempt may legitimately have a null actor, target, or code id when
  that identity did not resolve; audit must never invent one. Requests rejected by an
  already-active throttle are not admitted, do not write another row, and do not extend
  the throttle. Host-CLI owner-recovery events legitimately carry a null actor and no
  client address. Bootstrap predates this slice and retains its own audit contract;
  ordinary password sign-in is credential use rather than a lifecycle mutation, and its
  failure-audit feature remains explicitly deferred with the security-events view.

## Account and profile separation (forward compatibility)

This release ships one training profile per account, but a planned future feature
lets **one account own several training profiles** (the same person maintaining,
e.g., a strength block and a return-from-layoff block). To keep that additive:

- **P1** — Everything here (bootstrap, sign-in, J7/J8 recovery, session revocation,
  admin actions, audit, A1–A6) operates on the **account** axis only. No requirement
  may assume a one-to-one account↔profile relationship or key credential/lifecycle
  behavior on a profile.
- **P2** — Credential recovery restores access to an **account** and therefore to
  all profiles that account will later own; it neither selects nor mutates a profile.
  A future multi-profile release adds profile selection *after* authentication and
  must not touch the recovery surface. (Reviewed for confused-deputy risk: because a
  profile is never a login identity (P4) and recovery resolves email→account only,
  restoring an account cannot cross an account boundary.)
- **P3** `[corrected, deferred]` — Today there is **no distinct profile identifier**:
  `athlete_profile.userId` is itself the primary key referencing `user.id`, and ~10
  training tables key on that `userId`. A future multi-profile model therefore needs
  a profile table plus a re-keying migration — it is **not** achievable "without
  schema rework". A future multi-profile slice introduces a `profileRef`, migrates call
  sites through a server-side resolver, and changes that resolver when the schema is
  re-keyed. **J7–J9 remain account-only and do not introduce a profile reference, so P3
  is a named future guardrail rather than an artifact or acceptance gate in this slice.**
- **P4** — Administration stays at the account level. An owner never manages another
  account's individual profiles; a future account may manage its **own** profiles.
  No profile is ever a login identity.
- **P5 — Profile ownership is resolved server-side, never trusted from the request**
  `[added, deferred]`. This system has **no Postgres RLS** (every table is `isRLSEnabled:
  false`); cross-account isolation is 100% application-layer, resting on the single
  invariant "the data key is the authenticated principal (`actor.userId`)." The DB
  ownership triggers (`indigo_assert_workout_owner`, etc.) only enforce row-to-row
  *consistency* against the `user_id` the app supplies — they authorize nothing.
  Therefore, the moment a profile-scoped operation keys on a `profileId` (the
  multi-profile future, where the client selects the profile *after* auth), that
  `profileId` becomes a request-supplied object reference and **each operation must
  resolve `profileId → owning account` and assert it equals the session-derived
  `actor.userId` before use.** A `profileId` is never an authorization key on its
  own. Re-authentication (H-reauth) proves *who* you are, not *what* you may touch,
  so destructive profile-scoped actions need this ownership check in addition to
  re-auth. Because a "default to the sole profile" convention (P3) would make a missing
  check invisible while 1:1 holds, the future P3 implementation must not ship without
  P5's check and its test.
  Durable option when multi-profile lands: add RLS keyed on a per-connection
  `indigo.account_id` GUC so a forgotten `WHERE` clause fails closed instead of open.
- **P6 — Profile→account binding is immutable** `[added, deferred]`. The
  profile→account FK is set at creation and never mutated; **no profile reparenting is in
  scope.** This is what makes P2 safe: "recovery restores all the account's profiles"
  and "deletion
  removes all the account's profiles" are only well-defined if the profile set is
  stable and non-transferable — otherwise reparent-then-recover, or recover-and-
  inherit-a-former-other-account's-profile, become cross-boundary capture paths.
- **P7 — No profile is authenticatable** `[added, deferred]`. Profile rows carry no
  credential, email, or otherwise authenticatable column, and no authentication or
  session-resolution path ever reads a profile — auth stays bound to the better-auth
  `user`/`account` tables. This is what keeps P4 falsifiable rather than aspirational.

P1, P2, and P4 are the account-axis invariants for J7–J9. P3 and P5–P7 stay together as
the entry contract for the deferred multi-profile slice; this recovery work neither
implements nor partially stages them.

## Trust model (inherited, not invented)

- The **host** (shell access) is root of trust for the **owner** (bootstrap J1 and
  `scripts/identity/recover-owner.ts`).
- The **owner** is root of trust for **trainee** accounts (owner-created local users
  with an initial password shared out of band).
- **No email, SMS, or cloud identity** by design; recovery must not depend on them.
- Secrets are one-use, TTL-bound, HMAC-keyed to `BETTER_AUTH_SECRET`, digest-only at
  rest, audited, and idempotent (`owner-bootstrap.ts` / `owner-recovery.ts`).

## Implementation checkpoint

| Capability | State |
| --- | --- |
| Owner bootstrap (fresh instance) | Complete: CLI issue + web redeem (`/bootstrap`) |
| Owner recovery | Complete: host-only issue, CLI or `/recover` redemption, session revocation, web admission controls, and redacted channel-aware audit |
| Trainee password reset | Complete: reauthenticated Settings issuance plus public `/reset` redemption, one-use code, session revocation, and preserved training state |
| Sign-in guidance for the locked-out | Complete: J9 disclosure names trainee, owner, and no-account next actions; recovery routes redirect an open instance to bootstrap |
| Anti-enumeration on sign-in | Uniform message and existence-independent lock/work classes for known and unknown submitted emails; no impossible wall-clock constant-time claim |
| Sign-in failure auditing | **None** — `handleAuthRequest` writes no audit row. Any security-events view (H6) depends on adding this first. |
| Re-authentication for destructive owner actions | Current password is required for deletion/reset, member-reset issuance, and local-user creation; standalone session administration is deferred |
| Session visibility / remote revocation | Does not exist |

## Journeys

### J7 — Trainee credential recovery (owner-mediated)

1. A trainee tells the owner, out of band, that they cannot sign in.
2. Owner, in **Settings → Local users**, opens the target-specific **"Issue password
   reset code for {name}"** control and **re-enters their own current password** to
   authorize (the sudo-mode pattern the deletion flows use). The form warns that
   issuing a new code invalidates any earlier unused code. The new code is shown
   **once**, with expiry and a hand-over-out-of-band instruction (at most one
   outstanding per account).
3. Trainee opens **Sign in → "Can't sign in?" → "Use a trainee reset code"**
   (`/reset`) and submits: account email, reset code, new password (12–128 chars,
   twice).
4. On success: password replaced, **all sessions for that account revoked**, code
   consumed, audit event written, redirect to `/sign-in?reset=1`.
5. On failure: uniform rejection ("The email, code, or password was not accepted.")
   across wrong-email / wrong-code / expired / consumed / throttled
   `[added]`. Repeated wrong attempts **throttle the code, they do not destroy it**
   `[corrected]` (see H-DoS) so a legitimate holder can still redeem after the noise
   subsides.

Profile, programs, history, and audit trail are untouched. Recovery never routes
through account deletion.

### J8 — Owner credential recovery (host-mediated)

1. Owner runs on the host:
   `pnpm owner:recover issue --owner-email EMAIL --code-file ABSOLUTE_PATH --ttl-minutes 15`
   (code written only to a **chmod 0600 owner-only file in an owner-owned directory**
   `[corrected]`).
2. Owner opens **Sign in → "Can't sign in?" → "Use a host-issued owner recovery
   code"** (`/recover`) and submits owner email, host-issued code, new password twice.
3. On success: password replaced, all owner sessions revoked, audit event written
   with `channel: 'web'` (not the hard-coded `host-local-cli` — see M-channel),
   redirect to `/sign-in?recovered=1`.
4. The CLI redeem path remains, and is the **owner's guaranteed anti-DoS escape**
   `[added]`: it bypasses all web rate limits, so a flood against `/recover` or
   `/sign-in` can never wall the owner out of their own instance.

### J9 — Cold-start orientation on a claimed instance

The sign-in page must answer, without leaking account existence, the three
locked-out questions:

- **Trainee forgot password** → ask the owner for a reset code; link to `/reset`.
- **Owner forgot password** → recovery requires host access; show the exact
  `pnpm owner:recover issue …` invocation; link to `/recover`.
- **No account** → accounts are created only by the owner; no public signup, by
  design.

Presentation: one collapsed "Can't sign in?" disclosure beneath the form keeps the
primary (knows-credentials) path dominant. The implemented sign-in surface renders the
instance wordmark **and the content-mode label** before credential entry so a visitor
can tell which installation, and in which mode, they are talking to.

`/reset` and `/recover` on an **unclaimed** instance redirect to `/bootstrap`
`[added]`, matching sign-in's existing open-instance behavior.

## Design decisions and rejected alternatives

| Decision | Alternatives rejected, and why |
| --- | --- |
| Trainee reset code lets the trainee choose the new password | Owner sets a temporary password: forces a rotation state machine and makes the owner routinely handle a live credential. (Note A4: neither option *prevents* a malicious owner; this one just keeps the honest path clean.) |
| Reset code shown once in the owner UI, behind re-auth | Host-file handover for trainees: wrong ergonomics; trainee resets are routine owner tasks, not host-trust events |
| Store member-reset codes in the `verification` table for digest/one-use/TTL/one-outstanding, with target-keyed attempt/cooldown state in the identity-owned `member_reset_state` sibling table | Extending Better Auth's `verification` shape would couple product policy to an adapter-owned table. Reusing owner-recovery wholesale is also insufficient because it has no attempt counter. The sibling row points to the active verification id, survives successful redemption long enough to enforce the issuance cooldown, and cascades with the target account. |
| Store web admission buckets in identity-owned `web_recovery_rate_limit_bucket` rows keyed only by a versioned HMAC digest | Raw submitted email and client address do not belong in mutable throttle state. In-memory-only limits would reset on process restart and would not coordinate multiple Node workers. |
| Web redeem for owner recovery | CLI-only: forces terminal use for a flow the web already performs for bootstrap; invisibility was the observed failure. **But `/recover` is a permanent, network-reachable owner-password-reset endpoint** (unlike `/bootstrap`, which only works on an open instance), so the code's secrecy+TTL+rate-limit are now load-bearing network-facing controls |
| Uniform failure across all credential causes, including an active throttle | Distinct errors enable account/code-state enumeration; ingress-configuration failures remain a separate pre-credential class |
| No self-service reset without owner/host mediation | Email reset (no email infra), security questions (guessable/unauditable) |
| Static app passwords (Pi-hole) rejected for recovery | Long-lived bearer secrets, no expiry, no per-use audit, shared custody |

## Requirements

### Command and request context

Browser input never supplies actor, channel, or client-address authority. A server
boundary derives those values and passes this server-only context to the domain:

```ts
type WebCredentialContext = {
  readonly channel: 'web'
  readonly clientAddress: ResolvedCredentialClientAddress
}
```

`ResolvedCredentialClientAddress` is either a validated IP from the trusted-proxy
resolver or the fixed `loopback-direct` sentinel defined under H-ingress. The raw
address is used only transiently to derive the rate-bucket HMAC. Audit receives only the
minimized representation defined under A6/H-audit.

Workout resume is a narrower routing contract, not part of `WebCredentialContext`. A
workout request may carry a candidate session ID or `returnTo` value, but the server
accepts only a UUIDv7 session ID, reconstructs the canonical same-origin
`/workouts/<uuid>` path, and rejects every other return shape. After sign-in, the normal
actor-scoped workout lookup rechecks that the authenticated account owns the session.

The shared email normalization for admission and locking is `trim().toLowerCase()` for a
string of 1–320 characters. Missing, empty, non-string, or overlong input uses the fixed
`invalid-email` bucket/lock material and continues through the dummy target/digest path;
it does not create an unbounded attacker-controlled key.

The canonical public failure result is an application value, not a thrown domain error:

```ts
type PublicCredentialFailure = {
  readonly kind: 'rejected'
  readonly message:
    | 'The email or password was not accepted.'
    | 'The email, code, or password was not accepted.'
}
```

Every failure cause admitted by one surface maps to the same `kind`, message, and public
HTTP status for that surface. A raw JSON route handler, where one exists, returns `401`
with the same serialized body and content type. A Next server action returns the same
application value and rendered error state; **the framework's opaque Flight envelope is
not a byte-stability contract and is not compared.** Ingress misconfiguration (missing or
malformed trusted forwarding data in network mode) remains the existing pre-credential
`400 Authentication request denied` response and is outside the credential-failure set.

### Member-reset domain (`src/modules/identity/recovery/member-reset.ts`)

- `issueMemberReset({ actor, targetUserId, currentPassword, ttlMinutes = 15,
  requestContext, now? })` — owner-only (A3); rejects owner targets; requires fresh
  re-authentication (H-reauth); takes the deterministic owner+target lock set (H-lock);
  invalidates a prior unredeemed code only after the cooldown check admits issuance;
  enforces a 30 s issuance cooldown per target; returns
  `{ resetId, code, expiresAt }` once; TTL 5–60 min.
- `redeemMemberReset({ email, code, newPassword, requestContext, now? })` — serializes
  on the submitted-email key before resolving email→account and, once admitted, computes
  the password hash unconditionally before credential-state branches, compares the
  supplied-code digest against the real or fixed dummy digest with `timingSafeEqual`, and
  maps every internal failure to the canonical public result. It is one-use, applies the
  fixed per-code backoff without destroying the code, and revokes all target sessions
  under the target-scoped lifecycle lock.
- Audit events, **flat-hyphenated to match convention** `[corrected]`:
  `member-reset-issued`, `member-reset-redeemed`, `member-reset-rejected`,
  `entityType: 'member-reset'`. An admitted attempt carries resolved actor/target/code ids
  where available, outcome, channel, and the minimized web client address — never email,
  code, code digest, bucket digest, or password. The admitted rejection that starts a
  backoff remains one `member-reset-rejected` row with `retryAfter`; requests arriving
  during that backoff write nothing.

### Existing identity commands adapted by this slice

- Host-local `redeemOwnerRecovery({ ownerEmail, code, newPassword, now? })` remains the
  detailed, unthrottled CLI redemption command and records
  `channel: 'host-local-cli'`. The separate network-facing
  `redeemOwnerRecoveryWeb({ ownerEmail, code, newPassword, requestContext, now? })`
  owns web admission, uniform public failure, email-first locking, unconditional
  password hashing, real-or-dummy digest comparison, and the installed-owner target
  lock. A web success writes
  `owner-recovery-redeemed` with `channel: 'web'`, null unauthenticated actor, resolved
  owner target/code ids, minimized client address, and session count. One admitted web
  failure writes `owner-recovery-rejected` with only resolved IDs; an active throttle
  writes nothing. Host issuance remains CLI-only. One admitted host issue/redeem
  rejection also writes `owner-recovery-rejected` with `channel: 'host-local-cli'`, null
  actor, whichever owner/code IDs resolved, and no client address; shell access is already
  the root of trust, so it needs no web throttle.
- The production server boundary is
  `createLocalUserAsOwner({ actor, name, email, initialPassword, currentPassword,
  requestContext })`; it delegates to the infrastructure command's optional clock seam.
  The command normalizes and HMACs email, preallocates the target UUID, takes the email
  lock plus sorted owner/target account locks, verifies the owner's password inside them
  under the `local-user-create` purpose, and creates the user and credential atomically.
  Success writes `local-user-created`; one admitted validation, authorization, conflict,
  or re-authentication failure writes
  `local-user-create-rejected` when a trustworthy actor/request context reached the
  command boundary. The initial password is never audited. Test fixtures may call a
  lower-level seed adapter only inside disposable-database setup; production application
  call sites cannot bypass this command.

### Persistence and deletion integration (implemented)

- The `indigo:member-reset:<targetUserId>` verification namespace and identity-owned
  `member_reset_state` sibling table are installed. The table is keyed by target user id,
  references the active verification id with `ON DELETE SET NULL`, stores
  `lastIssuedAt`, `failedAttempts`, `retryAfter`, and `lastAttemptAt`, and cascades when
  the target account is deleted. Reissue atomically replaces the verification reference
  and resets attempt state; redemption consumes the verification, clears attempt state,
  and retains `lastIssuedAt` only for the 30 s issuance cooldown.
- The identity-owned `web_recovery_rate_limit_bucket` table is keyed by
  `(scope, bucketKey)`, where `bucketKey` is a versioned HMAC-SHA-256 digest and scope is
  one of sign-in/member-reset/owner-recovery × submitted-email/client-address. It stores
  the fixed-window start/count, retry deadline, last attempt, and update timestamps; no
  raw identifier is persisted.
- The `destructive_reauthentication_purpose_check` constraint admits the existing
  `trainee-data-deletion` and `instance-reset` purposes plus the baseline additions
  `member-reset-issue` and `local-user-create`.
- `executeSubjectDeletion` and instance reset purge the
  `indigo:member-reset:<userId>` namespace and its target state, and add member-reset
  state to subject-deletion **counts**. HMAC-only rate buckets deliberately carry no
  subject FK or reversible identity and are installation-scoped operational state, not
  subject export or deletion data; they expire through bounded cleanup rather than
  teaching Data Portability to derive Identity's secret keys. Instance reset counts and
  purges both new tables completely.

### Hardening requirements

- **H-reauth (sudo mode)**: issuing a reset code and creating a local user require the
  owner's current password in the request. A cached session alone is insufficient.
  `member-reset-issue` and `local-user-create` use independent attempt windows so one
  purpose cannot lock the other. Standalone session administration is deferred and does
  not reserve a `session-revoke` purpose in this migration.
- **H-lock (concurrency)** `[corrected]`: credential serialization uses typed lock keys.
  The email lock material is
  `HMAC-SHA-256(secret, "credential-email-lock-v1\0" + normalizedEmail)`; an operation
  with a submitted email takes that lock first, then
  takes all resolved `account:<userId>` locks in bytewise sorted, duplicate-free order on
  one PostgreSQL session. An unresolved lookup uses a deterministic
  `unknown-account:<email-HMAC>` target lock. Owner-on-trainee issuance holds both owner
  and target account locks, with owner re-authentication performed inside that lock set.
  Member redemption holds the email lock and resolved/synthetic target lock through
  comparison, credential replacement, code consumption, and session revocation. Local
  user creation preallocates the target UUID before locking, then holds the submitted-email
  lock plus sorted owner/preallocated-target locks through re-authentication and insert;
  sign-in uses the same email-first order, so create/sign-in cannot cross. No operation may
  acquire these classes in the reverse order. Genuine issue/redeem races surface as a
  serializable **abort → 500**; a bounded retry on redeem is a UX nicety, not correctness.
- **H-DoS (availability is the top risk)** `[added]`: web admission uses fixed,
  non-extending 60 s windows scoped independently to sign-in, member reset, and owner
  recovery. Each normalized submitted-email bucket admits **5** requests per window; each
  resolved client-address bucket admits **30**. The command checks every applicable
  existing throttle, including a resolved code's backoff, before reserving admission; if
  any is active, it changes no throttle or audit state. Otherwise it reserves the email
  and address budgets atomically, only if both still admit. The window is anchored by its
  first admitted request; a throttled request does not increment a counter, move
  `retryAfter`, write an audit row, or expose `Retry-After`. At the first request after
  expiry, the row starts a fresh window. Successful requests consume admission budget
  like failures.

  On an admitted request, each bucket increments `attemptCount`; reaching its limit sets
  `retryAfter` to exactly `windowStartedAt + 60 seconds`. A row at its limit rejects until
  that fixed instant. The identity admission module is the single limiter for these three
  surfaces; any overlapping Better Auth sign-in rule must be bypassed or adapted so it
  cannot emit a competing status, body, or extending in-memory limit. Unrelated auth
  endpoints retain their provider limits.

  An active member-reset code additionally applies target-state backoff after each admitted
  wrong-code comparison: **1, 2, 4, 8, 16, then 30 seconds**, capped at 30 seconds for all
  later failures. Requests during `retryAfter` are not admitted at the code layer and do
  not change any state; the next admitted attempt can still redeem the same code. Reissue
  after the 30 s issuance cooldown resets this attempt sequence. There is no permanent
  lock and guesses never consume the code. CLI owner redemption bypasses all web buckets
  and remains the guaranteed owner escape.

  **Part B connection-topology amendment (accepted, Stage 3; not live at the J7–J9
  checkpoint):** `INDIGO_DATABASE_POOL_MAX` is an integer from **6 through 64**, defaults to
  **10**, and is the one installation-wide `poolMax` replacing the live normal pool plus four raw
  lifecycle clients. Ordinary page/UoW/Better Auth read work receives `poolMax - 4` connections
  (minimum 2) with a FIFO queue of 128; two connections are reserved for credential/recovery/reset/
  bootstrap control leases; one priority-admitted capture connection resolves the pre-wait
  installation/owner boundary; and one installation-wide slot is reserved for a separate host/
  operator process. Application pool maxima therefore sum to `poolMax - 1`, and preflight validates
  the PostgreSQL role allowance against the full budget. Stage 3 adds no runtime database-health
  endpoint or reserved health lane: the existing startup database preflight is a serialized host
  one-shot using the external slot, and any later accepted in-process diagnostic must use bounded
  ordinary admission or amend this contract explicitly.

  The capture lane and two-connection control pool each have separate submitted-email and
  trusted queues capped at **64** waiters. Overflow fails through the surface's canonical
  rejection without allocating another connection, bucket, or audit row. Trusted account-
  scoped work has strict priority after current work; FIFO is preserved within a priority,
  so submitted-email floods cannot stand ahead of authenticated recovery/reset/bootstrap.
  Lease-bearing work reuses its control client and never re-enters the ordinary pool. The
  production host bootstrap/recovery/preflight/backup/restore commands acquire one shared
  host `flock`, open exactly one client against the reserved external slot, never instantiate
  an application pool, and release it on every exit. A separate-process saturation test
  proves runtime plus one host command never exceed `poolMax`.

  This amendment supersedes only the original four-client/separate-CLI-pool allocation; the
  already shipped H-DoS admission, priority, uniformity, and durable bucket semantics remain
  binding. Until Stage 3 lands, the repository still uses the earlier bounded lifecycle-
  client topology and must not claim the amended budget as live.
  Configuration validation happens before a slot is reserved. Each shared-fence request
  captures the claimed owner before waiting and requires the same non-null claim after it
  enters, so a queued pre-reset request cannot write into an open or newly re-bootstrapped
  installation generation.

  Mutable admission state has bounded cleanup: every admitted web credential transaction
  deletes at most **64** expired bucket rows ordered by `updatedAt`/key, where a bucket is
  expired once its fixed window has ended. Throttled requests perform no cleanup write.
  Member reset state is at most one row per target and cascades on account deletion;
  consuming/expiring a code clears its active verification and attempt fields. This bounds
  database work per request and prevents write amplification during a flood.
- **H-uniformity**: `/sign-in`, `/reset`, and `/recover` return their canonical public
  failure result and status across wrong-email / wrong-code / expired / consumed /
  throttled causes `[added]`; `/recover` and `/reset` collapse all internal error codes
  (for example `owner-mismatch` versus `code-invalid`) to one result. This contract covers
  the application result, HTTP status where the application owns a raw route, rendered
  copy, and redirect behavior — not opaque Next Flight bytes.

  The outer path is existence-independent: normalize and HMAC the submitted email, inspect
  both admission buckets, take the email lock, resolve the account, and take either the
  resolved target lock or deterministic synthetic target lock. Every admitted
  reset/recovery request computes the new-password hash unconditionally and compares
  against a real or fixed dummy digest with `timingSafeEqual`; sign-in invokes the
  credential handler while holding the same lock classes for known and unknown accounts.
  No admitted-path early return skips an entire work class.
  This narrows observable variance without claiming impossible wall-clock constant time
  across database/cache states.
- **H-transport**: satisfied by the existing origin-level config guard
  (`src/platform/config/server.ts` — non-loopback ⇒ HTTPS ⇒ `secureCookies`, cookies
  `httpOnly`+`SameSite=lax`); `/reset` and `/recover` inherit it with no per-route
  work. Recovery pages carry secrets in **POST bodies only**, never URLs.
- **H-secret**: codes ≥ 128-bit entropy (`randomBytes(32)`), shown once, digest-only
  at rest (HMAC keyed to `BETTER_AUTH_SECRET`, so secret rotation invalidates all
  outstanding codes), never logged, never in query strings. Rate keys are hex
  `HMAC-SHA-256(secret, "indigo-web-recovery-rate-v1\0" + scope + "\0" + normalizedKey)`;
  email-lock and rate-key purpose strings are distinct. A missing/invalid capability uses
  the 32-byte `HMAC-SHA-256(secret, "credential-dummy-v1\0")` digest so real and dummy
  comparisons always pass equal-length buffers to `timingSafeEqual`.
- **H-sessioncache** `[added]`: session-revocation completeness depends on every
  session-read path keeping `disableCookieCache: true` (as `actor.ts:12` does today)
  and on no bearer/refresh token existing for the credential provider. Record as an
  executable architecture invariant; any future cookie-cache TTL is the window a revoked
  session survives.
- **H-ingress** `[added]`: per-address rate limiting only holds if the app is
  loopback-bound behind a trusted on-host TLS terminator (the existing forwarded-
  address resolver trusts loopback hops only). State loopback-binding + trusted-proxy
  as a **security prerequisite**, not a deployment footnote — a directly reachable
  app lets an attacker rotate `X-Forwarded-For` and defeat per-address budgets.

  Network/HTTPS mode continues to fail closed before credential work when a trustworthy
  address cannot be resolved. For direct loopback HTTP only (configured origin hostname is
  loopback and `secureCookies === false`), an absent forwarding header resolves to the
  fixed `loopback-direct` sentinel; the sentinel is never accepted for network/HTTPS mode.
  It receives its own address bucket and is the auditable E2E/development value.
- **H-audit minimization and cardinality** `[added]`: rate buckets HMAC the full
  normalized submitted email or resolved address with `BETTER_AUTH_SECRET` and a versioned
  purpose string; neither raw values nor bucket digests enter audit. Web audit stores only
  `loopback-direct`, an IPv4 network rendered as `a.b.c.0/24`, or a canonical IPv6 `/56`
  prefix. Exactly one event is written
  for an admitted attempt/transition: `member-reset-issued|redeemed|rejected`,
  `owner-recovery-issued|redeemed|rejected`, or
  `local-user-created|local-user-create-rejected`, with its matching entity type.
  Automatic session revocation is metadata on the redeem event, not a second event. A
  denied owner reauthentication inside reset issuance or user creation is represented by
  that command's single rejection event; the generic helper must not also append a
  destructive-action denial. IDs that did not resolve remain null. Audit contains no raw
  email, code, password, code/bucket digest, or full network address.

### Deferred to a named "Account security" follow-on phase `[corrected]`

These were mis-parked in the ship-blocking baseline; they are separate features, not
credential recovery, and one has an unbuilt dependency:

- **Session-management surface**: per-account session list (created, last-seen,
  address), owner revoke-all-per-trainee, self-service "sign out everywhere". (The
  *recovery-triggered* revoke-all in J7/J8 stays in baseline; the standalone
  management UI and its `session-revoke` re-authentication purpose do not. That purpose
  is added only with the follow-on action so the baseline does not stage dead policy.)
- **Security-events view**: owner-only read-only render of recent credential
  lifecycle audit events. Depends on **sign-in-failure auditing**, which does not
  exist today — that auditing is a prerequisite and must land with this phase.

### Application / UI

- Settings → Local users: per-row, target-specific "Issue password reset code for
  {name}" control (owner only, re-authenticated), a visible warning that reissue
  invalidates the earlier unused code, and one-time code display with expiry + handover
  instruction.
- `/reset` and `/recover`: unauthenticated pages **placed in `src/app`**
  `[corrected]` (not `src/modules/identity/ui`), because the architecture boundary
  test forbids `src/modules → src/components`; only `src/app` may consume the shared
  `Field`/`ErrorSummary`/`SubmitButton` primitives. The existing identity forms style
  locally *because* they live under `src/modules` — the fix is placement, not
  "stop bypassing the library". New forms in `src/app` must use the shared primitives
  and their built-in per-field `aria-invalid`/`aria-describedby` wiring.
- Sign-in page: "Can't sign in?" disclosure (J9); wordmark + content-mode label
  pre-auth; success notices for `?reset=1` / `?recovered=1`.
- Mid-workout forced logout `[added]`: J7/J8 session revocation can log a trainee out
  mid-workout. On the next workout command or navigation, an absent session redirects to
  `/sign-in?expired=1&returnTo=<validated-workout-path>` and renders the
  cause-neutral notice: "Your session ended. Sign in again to resume your saved workout."
  The application cannot distinguish recovery revocation from another expiry once the
  session is absent, so it must not claim a cause it cannot prove. The route or action
  supplies a candidate session ID; `workoutPathForSessionId` accepts UUIDv7 only and
  constructs the same-origin `/workouts/<uuid>` destination. The sign-in boundary then
  accepts only that exact path shape through `workoutSignInReturnTo`, and the workout
  read rechecks ownership for the newly authenticated actor. Arbitrary URLs are never
  followed. The denied command is not retried. After successful sign-in, the app returns
  to that workout; every previously committed set/pause state is unchanged and the next
  unresolved set is shown. Unsaved browser fields are not claimed as persisted. This is
  the concrete EXPERIENCE.md "unauthorized" workout state, not a raw error page.

### Hardening ladder

- **Baseline (this spec, ship-blocking)**: A1–A6; the account-axis P1, P2, and P4
  invariants; H-reauth, H-lock, H-DoS, H-uniformity, H-transport, H-secret,
  H-sessioncache, H-ingress, H-audit; J7–J9; and the schema migrations.
- **Account-security phase (follow-on)**: session-management surface, security-events
  view + sign-in-failure auditing. It also introduces the standalone `session-revoke`
  re-auth purpose.
- **Phase 2 (compatible, deferred to ROADMAP/DEFERRED)**: TOTP (owner), passkeys
  (all). Both compose with this model — their loss-recovery path is exactly J7/J8,
  which is why recovery ships first. Static app passwords remain rejected.
- **Multi-profile phase (compatible, deferred to ROADMAP/DEFERRED)**: P3 and P5–P7,
  including the `profileRef` resolver, schema re-keying, and cross-account accessor suite.

### Explicitly out of scope

Email/SMS delivery, self-signup, owner transfer, SSO, application-layer IP
allowlisting (deployment concern), sign-in CAPTCHA (rate limiting is the control).

## End-goal success metrics

No telemetry ships (NFR-006), so success = verifiable invariants and journey budgets
enforced in tests, plus instance-local audit data.

1. **Zero dead ends** — from `/sign-in` on a claimed instance, each of the three J9
   personas reaches a concrete next action in ≤ 2 interactions. Asserted by e2e on
   the rendered page.
2. **Journey budgets** — trainee recovery ≤ 2 owner interactions + 1 trainee form;
   owner recovery 1 host command + 1 web form. Asserted as step counts in e2e.
3. **Data preservation** — the J7 browser proof creates a profile and program, starts a
   workout, commits one performed set, resets the password, verifies every session was
   revoked, resumes the exact saved workout with the remaining-set count intact, and then
   completes it. Its final database assertion covers the profile, program, completed
   session, and performed-set rows. It does not separately seed or claim preservation of
   a workout completed before recovery.
4. **Administration-model invariants** — A1, A3, A4-audit each get an
   attempt-and-reject-and-audit test. **A2 and A5 are enforced by absence**
   `[corrected]`: assert the route/API does not exist (no audit row to check), not
   an attempt+reject.
5. **Security invariants** (unit + e2e):
   - codes single-use, ≥ 128-bit (asserted via `randomBytes(32)` format/length, not
     runtime measurement `[corrected]`), TTL-bounded, ≤ 1 outstanding, cooldown
     enforced;
   - digest-only at rest; secret rotation invalidates all outstanding codes;
   - **uniform canonical application result, route status where applicable, rendered
     copy, and redirect behavior across wrong-email / wrong-code / expired / consumed /
     throttled** `[corrected]` on sign-in, `/reset`, and `/recover`;
   - throttling engages under a scripted flood (e2e loop) **and the legitimate owner
     can still authenticate via CLI during a per-account flood** `[added]`;
   - all sessions of the affected account revoked at redemption; revocation survives
     a concurrent target sign-in (H-lock);
   - owner re-authentication required for reset issue and local-user creation;
   - no secret in any URL, log line, or audit row (assert by inspecting captured logs
     and audit rows).
6. **Audit completeness without amplification** — every admitted issue/redeem/reject
   **web** attempt or transition yields exactly one row with resolved IDs (nullable when
   unresolved) and a minimized address `[corrected]`; automatic session revocation is
   metadata on redemption. Requests during an active throttle add zero rows and leave its
   deadline unchanged. Host-CLI events carry null actor / no client address by design.
7. **No regression** — bootstrap, sign-in, owner-recovery CLI suites stay green; the
   config guard is untouched.
8. **Operational proof** — the disposable-instance runbook (issue → hand over →
   redeem → sign in) runs end-to-end against the e2e supervisor. Target < 2 min wall
   clock as a **soft** goal `[corrected]`, not a hard CI assertion (flaky).

## Test and evidence allocation

- **Pure unit**: input normalization; fixed policy constants; the exact
  1/2/4/8/16/30 s backoff ladder; canonical public-result mapping; client-address
  resolution/minimization; safe workout return-path parsing; and the exact versioned,
  secret-keyed email-lock HMAC namespace. These tests do not mock PostgreSQL and make no
  persistence or atomicity claim.
- **Disposable-PostgreSQL integration**: one-use and ≤1-outstanding atomicity,
  target-state/FK cleanup, TTL and 30 s reissue behavior through injected timestamps,
  fixed-window reset/non-extension, exact member-reset and web-bucket HMAC namespaces,
  real-or-dummy malformed/unknown credential paths, bounded 64-row cleanup, owner-target
  rejection, bounded/priority-aware capture/control/ordinary admission, exact installation-wide
  `poolMax` accounting, separate-process host-CLI-under-saturation proof, owner reauthentication for
  issue/create, deterministic
  email/owner/target lock ordering, create/sign-in and redeem/sign-in races, credential
  replacement, all-session revocation, exact-one audit cardinality with nullable
  unresolved IDs, CLI bypass, and subject/instance deletion counts. The existing
  bootstrap and CLI owner-recovery suites remain regression coverage. These clocked
  database tests—not wall-clock browser sleeps—carry cooldown, TTL, and admission-window
  claims; dummy-digest equal-length behavior is exercised through the unknown/malformed
  paths without exporting a security primitive solely for testing.
- **e2e** (Playwright, against the supervisor): `reset-member-credential.spec.ts`
  proves J7 issuance/redemption, rejection of the old password, revocation of all member
  sessions, preservation of the profile/program/active session and already performed
  set, exact mid-workout return with the remaining-set count intact, subsequent workout
  completion, final profile/program/completed-session/performed-set rows, and redacted
  issue/redeem audit;
  `recover-owner-web.spec.ts` proves J8 web redemption, channel/address attribution,
  uniform rejection, and an active web throttle that does not amplify state or audit;
  `signin-cold-start.spec.ts` proves the J9 disclosure, all three persona paths,
  open-instance redirects, pre-auth content-mode label, and mobile reflow. Integration
  tests carry the broader cause matrix, concurrency races, CLI bypass, and atomicity
  claims rather than assigning those database contracts to one browser case.
- **Accessibility**: new `src/app` forms use the shared primitives' aria wiring — the
  audit's setup-form finding must not recur.
- **Architecture contracts**: assert every application session-read path opts out of
  cookie caching, credential accounts have no browser bearer/refresh-token path, public
  signup and role mutation routes remain absent, and `loopback-direct` sentinel use is
  restricted to loopback HTTP. P3/P5–P7 accessor tests belong to the named multi-profile
  phase, not this recovery slice.

## Review reconciliation

Both reviews agreed the owner-administers-members backbone (A1–A6) is sound with no
clean model-break, and that availability, not enumeration, is the dominant risk for a
single-owner instance with a guessable email. Corrections folded in above:

- **Enumeration**: the "sign-in anti-enumeration: correct" claim was wrong — the path
  is existence-dependent (`auth-handler.ts:70–73`); fixed in the inventory and
  H-uniformity now covers sign-in.
- **H-lock**: credential replacement and its recovery-triggered session revocation must
  lock the *target*, not only `actor.userId`.
- **A4**: downgraded from "enforced" to an honest trust assumption.
- **P3**: "without schema rework" was false (no distinct profile id today); P3 and
  P5–P7 are now one explicitly deferred multi-profile entry contract rather than a
  partially staged requirement in J7–J9.
- **Account/profile isolation (P5–P7)**: the split is sound on the *identity* axis
  (auth/role/recovery stay account-keyed; no second-owner or second-login path), but
  a security addendum showed the 1:1 assumption was silently serving as the
  cross-account access-control check. Because there is **no RLS**, decoupling the
  data key from the session principal without an explicit server-side ownership check
  ships a dormant IDOR that only becomes reachable after a second profile exists.
  Defined P5 (resolve+assert profile ownership from the session), P6 (immutable
  profile→account binding, no reparenting), P7 (no profile is authenticatable), and
  their future isolation invariant tests — all must land together when a profile
  reference is actually introduced.
- **Scope**: session-management (old H3), its standalone `session-revoke` re-auth
  purpose, and security-events (old H6) moved out of the ship-blocking baseline into a
  named follow-on; sign-in-failure auditing is its prerequisite.
- **Feasibility**: the "reuse `verification`" precedent only covers digest/TTL/
  one-outstanding. The decision is now fixed: target-keyed `member_reset_state`,
  HMAC-keyed `web_recovery_rate_limit_bucket`, and only the two baseline re-auth
  purposes, with bounded non-extending policy and cleanup specified above.
- **Convention/accuracy**: flat-hyphenated audit event names; client-address scoped
  to web events; forms placed in `src/app` per the module→components boundary;
  content-mode label on sign-in is a new requirement; audit `channel` must be
  threaded (`web` vs `host-local-cli`) so web recovery isn't misattributed. Audit IDs
  are nullable when unresolved, address storage is minimized, and already-throttled
  requests produce no write amplification.

### Documentation integration (updated 2026-07-13)

The reviewers' integration recommendation is now applied across the canonical docs:

- **PRODUCT_SPEC.md** — contains the account/profile/member vocabulary, journeys J7–J9,
  FR-007/FR-008, and cause-neutral workout-return FR-009; these remain governed by this
  document rather than the methodology-dependent Release 1 J1–J6 gate.
- **DEFERRED.md** — added "Multiple profiles per account" (re-entry evidence = the
  P5–P7 isolation guardrails) and "Second factor (TOTP, passkeys)" (re-entry after
  J7/J8 ship).
- **MVP_STATUS.md**, **ROADMAP.md**, and the identity/self-hosting docs distinguish the
  implemented J7–J9 baseline from the deferred Account security and multi-profile slices,
  and keep independent security/privacy review as an external release gate.

This doc remains the home for the administration/trust model, invariants, hardening,
requirements, and test/evidence allocation.
