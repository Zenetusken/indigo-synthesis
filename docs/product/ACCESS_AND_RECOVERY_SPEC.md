# Access and recovery specification

Status: hardened draft, revised after adversarial + consistency review (2026-07-12)
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

## Problem

A claimed instance greets every visitor with an email/password form and exactly one
outcome on failure: "The email or password was not accepted." There is no path for:

- a trainee who forgot their password (no reset or owner-administered
  deletion/recreation path exists, so the account has no supported recovery path today);
- an owner who forgot their password and does not know that `pnpm owner:recover`
  exists (the mechanism is complete but invisible to the product surface);
- a person with no account (the page footnote implies self-signup is absent but
  never states how access is actually granted).

The instance behaves correctly and honestly at the protocol level while being a
dead end at the human level. That violates the product's own experience principle:
explicit state must include the explicit next action.

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
- **A6** — Every credential lifecycle action writes exactly one append-only audit
  event with actor, target, outcome, and — **for web-originated actions** — client
  address `[corrected]`. Host-CLI events legitimately carry a null actor and no
  client address, matching the existing owner-recovery/bootstrap rows.

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
- **P3** `[corrected]` — Today there is **no distinct profile identifier**:
  `athlete_profile.userId` is itself the primary key referencing `user.id`, and ~10
  training tables key on that `userId`. A future multi-profile model therefore needs
  a profile table plus a re-keying migration — it is **not** achievable "without
  schema rework". The requirement for *this* release is an application-layer
  convention: new call sites thread a `profileRef` that resolves to the account's
  sole profile (its `userId`) today, so the later migration changes the resolver, not
  every call site. This is a direction, not a migration mandate for this release.
- **P4** — Administration stays at the account level. An owner never manages another
  account's individual profiles; a future account may manage its **own** profiles.
  No profile is ever a login identity.
- **P5 — Profile ownership is resolved server-side, never trusted from the request**
  `[added]`. This system has **no Postgres RLS** (every table is `isRLSEnabled:
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
  re-auth. Because the "default to the sole profile" convention (P3) makes a missing
  check invisible while 1:1 holds, P3 must not ship without P5's check and its test.
  Durable option when multi-profile lands: add RLS keyed on a per-connection
  `indigo.account_id` GUC so a forgotten `WHERE` clause fails closed instead of open.
- **P6 — Profile→account binding is immutable** `[added]`. The profile→account FK is
  set at creation and never mutated; **no profile reparenting is in scope.** This is
  what makes P2 safe: "recovery restores all the account's profiles" and "deletion
  removes all the account's profiles" are only well-defined if the profile set is
  stable and non-transferable — otherwise reparent-then-recover, or recover-and-
  inherit-a-former-other-account's-profile, become cross-boundary capture paths.
- **P7 — No profile is authenticatable** `[added]`. Profile rows carry no credential,
  email, or otherwise authenticatable column, and no authentication or
  session-resolution path ever reads a profile — auth stays bound to the better-auth
  `user`/`account` tables. This is what keeps P4 falsifiable rather than aspirational.

## Trust model (inherited, not invented)

- The **host** (shell access) is root of trust for the **owner** (bootstrap J1 and
  `scripts/identity/recover-owner.ts`).
- The **owner** is root of trust for **trainee** accounts (owner-created local users
  with an initial password shared out of band).
- **No email, SMS, or cloud identity** by design; recovery must not depend on them.
- Secrets are one-use, TTL-bound, HMAC-keyed to `BETTER_AUTH_SECRET`, digest-only at
  rest, audited, and idempotent (`owner-bootstrap.ts` / `owner-recovery.ts`).

## Current state inventory

| Capability | State |
| --- | --- |
| Owner bootstrap (fresh instance) | Complete: CLI issue + web redeem (`/bootstrap`) |
| Owner recovery | Mechanism complete (`owner-recovery.ts`, CLI issue **and** CLI redeem, sessions revoked, audited); zero product-surface visibility |
| Trainee password reset | Does not exist in any form |
| Sign-in guidance for the locked-out | Does not exist |
| Anti-enumeration on sign-in | **Message uniform, path is NOT** `[corrected]`. `handleAuthRequest` resolves email→userId and only wraps *existing* users in the credential-lifecycle lock (`auth-handler.ts:70–73`); unknown emails skip that heavier path, so timing/behavior distinguishes real accounts. Uniform copy ≠ uniform behavior. |
| Sign-in failure auditing | **None** — `handleAuthRequest` writes no audit row. Any security-events view (H6) depends on adding this first. |
| Re-authentication for destructive owner actions | Exists for deletion/reset flows (current password required); absent for credential lifecycle (reset-issue, user-create, session-revoke) |
| Session visibility / remote revocation | Does not exist |

## Journeys

### J7 — Trainee credential recovery (owner-mediated)

1. A trainee tells the owner, out of band, that they cannot sign in.
2. Owner, in **Settings → Local users**, chooses "Issue password reset code" on that
   account, **re-entering their own current password** to authorize (the sudo-mode
   pattern the deletion flows use). The code is shown **once**, with expiry and a
   hand-over-out-of-band instruction. Issuing again invalidates any earlier
   unredeemed code (at most one outstanding per account).
3. Trainee opens **Sign in → "Can't sign in?" → "I have a reset code"** (`/reset`)
   and submits: account email, reset code, new password (12–128 chars, twice).
4. On success: password replaced, **all sessions for that account revoked**, code
   consumed, audit event written, redirect to `/sign-in?reset=1`.
5. On failure: uniform rejection ("The email, code, or password was not accepted.")
   across wrong-email / wrong-code / expired / consumed / throttled / locked
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
2. Owner opens **Sign in → "Can't sign in?" → "I'm the owner and have host access"**
   (`/recover`) and submits owner email, host-issued code, new password twice.
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

Presentation: one collapsed "Can't sign in?" disclosure beneath the form; the
primary (knows-credentials) path stays dominant. **New UI requirement** `[corrected]`:
the sign-in page must also render the instance wordmark **and the content-mode
label** so a visitor can tell which installation, and in which mode, they are talking
to before entering anything — today the content-mode label is post-auth only
(`ProductFrame`), so this is a deliberate addition, not existing behavior.

`/reset` and `/recover` on an **unclaimed** instance redirect to `/bootstrap`
`[added]`, matching sign-in's existing open-instance behavior.

## Design decisions and rejected alternatives

| Decision | Alternatives rejected, and why |
| --- | --- |
| Trainee reset code lets the trainee choose the new password | Owner sets a temporary password: forces a rotation state machine and makes the owner routinely handle a live credential. (Note A4: neither option *prevents* a malicious owner; this one just keeps the honest path clean.) |
| Reset code shown once in the owner UI, behind re-auth | Host-file handover for trainees: wrong ergonomics; trainee resets are routine owner tasks, not host-trust events |
| Store member-reset codes in the `verification` table for digest/one-use/TTL/one-outstanding, **but** the attempt-counter + lockout in a dedicated structure | "Reuse owner-recovery wholesale" is **only partly feasible** `[corrected]`: owner-recovery has no attempt counter and `verification` has no counter column. The lockout pattern lives in `destructive_reauthentication_state`. Member-reset needs schema work for the counter — see requirements |
| Web redeem for owner recovery | CLI-only: forces terminal use for a flow the web already performs for bootstrap; invisibility was the observed failure. **But `/recover` is a permanent, network-reachable owner-password-reset endpoint** (unlike `/bootstrap`, which only works on an open instance), so the code's secrecy+TTL+rate-limit are now load-bearing network-facing controls |
| Uniform failure across all causes incl. throttled/locked | Distinct errors enable account/code-state enumeration |
| No self-service reset without owner/host mediation | Email reset (no email infra), security questions (guessable/unauditable) |
| Static app passwords (Pi-hole) rejected for recovery | Long-lived bearer secrets, no expiry, no per-use audit, shared custody |

## Requirements

### Domain (`src/modules/identity/recovery/member-reset.ts`, new)

- `issueMemberReset(actor, targetUserId, ttlMinutes)` — owner-only (A3); rejects
  owner targets; requires fresh re-authentication (H-reauth); **takes the
  credential-lifecycle lock on the TARGET userId** `[corrected]` (not the owner —
  see H-lock); invalidates prior unredeemed codes; enforces a 30 s issuance cooldown
  per target; returns `{ code, expiresAt }` once; TTL 5–60 min, default 15.
- `redeemMemberReset(email, code, newPassword)` — resolves email→account, then runs
  a **constant, existence-independent path**: compute the password hash
  unconditionally up front (as `redeemOwnerRecovery` does), compare digests with
  `timingSafeEqual`, and map every internal outcome to one uniform failure; one-use;
  per-code attempt counter that **throttles** (never destroys) the code; revokes all
  target sessions under the target-scoped lifecycle lock.
- Audit events, **flat-hyphenated to match convention** `[corrected]`:
  `member-reset-issued`, `member-reset-redeemed`, `member-reset-rejected`,
  `member-reset-locked`, `entityType: 'member-reset'`; each carries target userId,
  code id, outcome, and (web actions) client address — never the code or its digest.

### Schema migrations required `[added]`

- New `member-reset` verification-namespace **plus a counter store** for
  attempts/lockout (the `verification` table has no counter column; either extend it
  or add a small sibling table keyed by code id).
- Relax the `destructive_reauthentication_purpose_check` CHECK constraint
  (`auth.ts:126`, currently `IN ('trainee-data-deletion','instance-reset')`) to add
  the new re-auth purposes: `member-reset-issue`, `local-user-create`,
  `session-revoke`.
- Extend `executeSubjectDeletion` and instance-reset to purge the
  `indigo:member-reset:<userId>` namespace and its counter rows, and add them to the
  deletion **counts** (`deletion.ts` currently purges only `email` and
  `owner-recovery:<userId>`).

### Hardening requirements

- **H-reauth (sudo mode)**: issuing a reset code, creating a local user, and
  revoking another account's sessions each require the owner's current password in
  the request. A cached session alone is insufficient.
- **H-lock (concurrency)** `[corrected]`: every **owner-on-trainee** lifecycle action
  acquires the credential-lifecycle lock on the **target** userId, with the owner's
  re-authentication performed *inside* that target-scoped lock. Do **not** reuse the
  self-scoped deletion helper verbatim (it locks `actor.userId`, which for
  owner-on-trainee is the wrong key and lets a concurrent trainee sign-in survive a
  "revoke all"). Genuine issue/redeem races surface as a serializable **abort → 500**
  (consistent with bootstrap/recovery today); a bounded retry on the redeem path is a
  UX nicety, not a correctness requirement.
- **H-DoS (availability is the top risk)** `[added]`: this feature exists because of a
  lockout dead-end, so throttling must **fail toward slowing, never hard-locking**,
  with a bounded maximum backoff. Per-account buckets are keyed by the **submitted,
  normalized email string** (independent of whether it resolves — so existent and
  non-existent targets behave identically and no per-account limit leaks existence).
  The host CLI redeem is the owner's guaranteed escape (J8.4). Recovery codes
  throttle rather than self-destruct under attack (J7.5).
- **H-uniformity**: `/sign-in`, `/reset`, and `/recover` responses are byte-identical
  across wrong-email / wrong-code / expired / consumed / **throttled / locked**
  `[added]`; `/recover` and `/reset` collapse all internal error codes (e.g.
  owner-recovery's distinct `owner-mismatch` vs `code-invalid`) to one message.
  Response-path equalization (unconditional hash work; no early return that skips it)
  **extends to sign-in's existence branch** `[added]` — take an equivalent
  lock/latency path for unknown accounts, or move throttling ahead of the existence
  check.
- **H-transport**: satisfied by the existing origin-level config guard
  (`src/platform/config/server.ts` — non-loopback ⇒ HTTPS ⇒ `secureCookies`, cookies
  `httpOnly`+`SameSite=lax`); `/reset` and `/recover` inherit it with no per-route
  work. Recovery pages carry secrets in **POST bodies only**, never URLs.
- **H-secret**: codes ≥ 128-bit entropy (`randomBytes(32)`), shown once, digest-only
  at rest (HMAC keyed to `BETTER_AUTH_SECRET`, so secret rotation invalidates all
  outstanding codes), never logged, never in query strings.
- **H-sessioncache** `[added]`: session-revocation completeness depends on every
  session-read path keeping `disableCookieCache: true` (as `actor.ts:12` does today)
  and on no bearer/refresh token existing for the credential provider. Record as an
  invariant; any future cookie-cache TTL is the window a revoked session survives.
- **H-ingress** `[added]`: per-address rate limiting only holds if the app is
  loopback-bound behind a trusted on-host TLS terminator (the existing forwarded-
  address resolver trusts loopback hops only). State loopback-binding + trusted-proxy
  as a **security prerequisite**, not a deployment footnote — a directly reachable
  app lets an attacker rotate `X-Forwarded-For` and defeat per-address budgets.

### Deferred to a named "Account security" follow-on phase `[corrected]`

These were mis-parked in the ship-blocking baseline; they are separate features, not
credential recovery, and one has an unbuilt dependency:

- **Session-management surface**: per-account session list (created, last-seen,
  address), owner revoke-all-per-trainee, self-service "sign out everywhere". (The
  *recovery-triggered* revoke-all in J7/J8 stays in baseline; the standalone
  management UI does not.)
- **Security-events view**: owner-only read-only render of recent credential
  lifecycle audit events. Depends on **sign-in-failure auditing**, which does not
  exist today — that auditing is a prerequisite and must land with this phase.

### Application / UI

- Settings → Local users: per-row "Issue password reset code" (owner only,
  re-authenticated), one-time code display with expiry + handover instruction.
- `/reset` and `/recover`: unauthenticated pages **placed in `src/app`**
  `[corrected]` (not `src/modules/identity/ui`), because the architecture boundary
  test forbids `src/modules → src/components`; only `src/app` may consume the shared
  `Field`/`ErrorSummary`/`SubmitButton` primitives. The existing identity forms style
  locally *because* they live under `src/modules` — the fix is placement, not
  "stop bypassing the library". New forms in `src/app` must use the shared primitives
  and their built-in per-field `aria-invalid`/`aria-describedby` wiring.
- Sign-in page: "Can't sign in?" disclosure (J9); wordmark + content-mode label
  pre-auth (new); success notices for `?reset=1` / `?recovered=1`.
- Mid-workout forced logout `[added]`: J7/J8 session revocation can log a trainee out
  mid-workout. Data survives (exact resume), but the UX must route through
  EXPERIENCE.md's existing "unauthorized" workout state rather than a raw error.

### Hardening ladder

- **Baseline (this spec, ship-blocking)**: A1–A6, P1–P4, H-reauth, H-lock, H-DoS,
  H-uniformity, H-transport, H-secret, H-sessioncache, H-ingress, J7–J9, the schema
  migrations.
- **Account-security phase (follow-on)**: session-management surface, security-events
  view + sign-in-failure auditing.
- **Phase 2 (compatible, deferred to ROADMAP/DEFERRED)**: TOTP (owner), passkeys
  (all). Both compose with this model — their loss-recovery path is exactly J7/J8,
  which is why recovery ships first. Static app passwords remain rejected.

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
3. **Data preservation** — 100% of the trainee's profile/program/history rows survive
   recovery; e2e completes a workout, resets the password, asserts history intact and
   sessions revoked.
4. **Administration-model invariants** — A1, A3, A4-audit each get an
   attempt-and-reject-and-audit test. **A2 and A5 are enforced by absence**
   `[corrected]`: assert the route/API does not exist (no audit row to check), not
   an attempt+reject.
5. **Security invariants** (unit + e2e):
   - codes single-use, ≥ 128-bit (asserted via `randomBytes(32)` format/length, not
     runtime measurement `[corrected]`), TTL-bounded, ≤ 1 outstanding, cooldown
     enforced;
   - digest-only at rest; secret rotation invalidates all outstanding codes;
   - **uniform responses across wrong-email / wrong-code / expired / consumed /
     throttled / locked** `[corrected]` on sign-in, `/reset`, and `/recover`;
   - throttling engages under a scripted flood (e2e loop) **and the legitimate owner
     can still authenticate via CLI during a per-account flood** `[added]`;
   - all sessions of the affected account revoked at redemption; revocation survives
     a concurrent target sign-in (H-lock);
   - re-authentication required for issue/create/revoke;
   - no secret in any URL, log line, or audit row (assert by inspecting captured logs
     and audit rows).
6. **Audit completeness** — every issue/redeem/reject/lock/revoke **web** event yields
   exactly one row with actor, target, and client address `[corrected]`; host-CLI
   events (J8 issue) carry null actor / no client address by design — the e2e assert
   must scope "client address present" to web-originated rows.
7. **No regression** — bootstrap, sign-in, owner-recovery CLI suites stay green; the
   config guard is untouched.
8. **Operational proof** — the disposable-instance runbook (issue → hand over →
   redeem → sign in) runs end-to-end against the e2e supervisor. Target < 2 min wall
   clock as a **soft** goal `[corrected]`, not a hard CI assertion (flaky).

## Test plan

- **Unit** (`member-reset.ts`, with an injectable `now?: Date` seam): TTL bounds,
  one-use, ≤1-outstanding, 30 s cooldown, throttle-not-destroy, timing-safe compare,
  owner-target rejection, re-auth requirement, target-scoped locking, session
  revocation. Cooldown/TTL assertions live here (clock seam), **not** as wall-clock
  e2e waits `[corrected]`.
- **e2e** (Playwright, against the supervisor): `reset-member-credential.spec.ts`
  (J7 happy path, uniform-failure, throttle engagement, owner-CLI-escape-during-flood);
  `recover-owner-web.spec.ts` (J8 web redemption, channel=web audit attribution);
  `signin-cold-start.spec.ts` (J9 disclosure + three persona paths + pre-auth
  content-mode label).
- **Accessibility**: new `src/app` forms use the shared primitives' aria wiring — the
  audit's setup-form finding must not recur.
- **Account/profile isolation invariants** `[added]`: (P5) a test authenticates as
  account A and asserts a B-owned `profileId` is **rejected** by every profile-scoped
  accessor — not merely that the 1:1 self-default works, since that default passes
  vacuously today and would hide the hole until a second profile exists; (P7) a test
  asserts no profile-shaped row carries a credential/email column and that no auth or
  session-resolution path reads a profile table. These land with the `profileRef`
  accessor (P3), even though multi-profile itself is deferred, so the ownership check
  exists before there is a second profile to exploit.

## Review reconciliation

Both reviews agreed the owner-administers-members backbone (A1–A6) is sound with no
clean model-break, and that availability, not enumeration, is the dominant risk for a
single-owner instance with a guessable email. Corrections folded in above:

- **Enumeration**: the "sign-in anti-enumeration: correct" claim was wrong — the path
  is existence-dependent (`auth-handler.ts:70–73`); fixed in the inventory and
  H-uniformity now covers sign-in.
- **H-lock**: the session-revoke lock must key on the *target*, not `actor.userId`.
- **A4**: downgraded from "enforced" to an honest trust assumption.
- **P3**: "without schema rework" was false (no distinct profile id today);
  downgraded to a call-site convention with a later migration acknowledged.
- **Account/profile isolation (P5–P7)**: the split is sound on the *identity* axis
  (auth/role/recovery stay account-keyed; no second-owner or second-login path), but
  a security addendum showed the 1:1 assumption was silently serving as the
  cross-account access-control check. Because there is **no RLS**, decoupling the
  data key from the session principal without an explicit server-side ownership check
  ships a dormant IDOR that only becomes reachable after a second profile exists.
  Added P5 (resolve+assert profile ownership from the session), P6 (immutable
  profile→account binding, no reparenting), P7 (no profile is authenticatable), and
  the isolation invariant tests — so the check exists before it can be exploited.
- **Scope**: session-management (old H3) and security-events (old H6) moved out of
  the ship-blocking baseline into a named follow-on; sign-in-failure auditing named
  as their prerequisite.
- **Feasibility**: the "reuse `verification`" precedent only covers digest/TTL/
  one-outstanding; the attempt-counter/lockout and new re-auth purposes need schema
  migrations (now itemized), including the CHECK-constraint relaxation.
- **Convention/accuracy**: flat-hyphenated audit event names; client-address scoped
  to web events; forms placed in `src/app` per the module→components boundary;
  content-mode label on sign-in is a new requirement; audit `channel` must be
  threaded (`web` vs `host-local-cli`) so web recovery isn't misattributed.

### Doc integration (applied 2026-07-12)

The reviewers' integration recommendation is now applied across the canonical docs:

- **PRODUCT_SPEC.md** — added the account/profile/member vocabulary block, journeys
  J7–J9 (noting owner recovery already exists and that these are governed by this
  doc's success metrics, not the Release 1 J1–J6 gate), and FR-007 (owner-mediated
  trainee reset) + FR-008 (cold-start orientation without existence disclosure).
- **DEFERRED.md** — added "Multiple profiles per account" (re-entry evidence = the
  P5–P7 isolation guardrails) and "Second factor (TOTP, passkeys)" (re-entry after
  J7/J8 ship).
- **MVP_STATUS.md** — added an "Access and recovery" subsection stating honestly that
  owner recovery is implemented-but-not-surfaced, trainee reset + cold-start are
  specified-not-implemented, and P1–P7 are a forward direction, not code.

This doc remains the home for the administration/trust model, invariants, hardening,
requirements, and test plan.
