# PR #1 adversarial remediation

Status: in progress — phases 1 and 2 complete
Source: PR #1 adversarial swarm review  
Scope: every unresolved implementation and release-evidence finding

This document is the execution contract for hardening the engineering MVP. A finding is
not closed by code alone: its named proof must pass against a fresh PostgreSQL database
and, where the behavior is user-visible, through the real browser path.

The independent Methodology Gate 0 and the working-name/brand-rights decision remain
external review gates. They cannot be truthfully converted into code fixes. The source
license finding was resolved separately by commit `0c9b5f1`.

## Cross-cutting decisions

1. **Fail closed at trust boundaries.** Generic Better Auth signup is disabled. Owner
   bootstrap requires a host-issued, expiring, one-use code and a database transaction
   that creates the credential and closes the installation together.
2. **Serialize credential authority.** Password sign-in and owner recovery use the same
   per-user PostgreSQL advisory lock, covering password verification through session
   creation or recovery session revocation respectively.
3. **Make safety precedence durable in phase 3 (H1).** A post-completion pain report
   must append an invalidation and permanently block/supersede every progression
   descendant carrying that decision. It must never invent replacement loads. Until
   that path exists, completed-source holds remain active and non-resolvable; once it
   exists, resolving a hold must never reactivate an invalidated revision.
4. **Resolve holds without implying medical clearance.** In this self-directed product,
   the trainee may resolve a hold only after abandoning an affected live session,
   selecting a factual reason, acknowledging that the product does not assess or clear
   symptoms, and creating an append-only audit record.
5. **Bind provenance to executable facts.** One canonical projection contains every
   persisted workout, exercise, rationale, safety tier, set kind, target, rest value,
   and release/version field. Activation rebuilds this projection and rejects a hash
   mismatch.
6. **Preserve original facts; append corrections.** Aggregate ownership, session
   snapshots, resolved sets, released prescriptions, decisions, revocations,
   invalidations, and audit records are never rewritten. Any supported correction is a
   separate attributed record.
7. **Record successful command delivery.** Set completion, set skip, workout completion,
   and pain reporting commit an append-only receipt containing command kind, target, and
   canonical request hash. A byte-for-byte semantic replay succeeds before current
   eligibility is reconsidered; command-ID reuse with a different payload fails.
8. **Separate installation identity from trainee data.** The owner may delete their
   trainee profile and training history without deleting the owner credential or other
   users. Full instance reset remains the only owner-identity deletion path.
9. **Treat forwarding as configuration, not inference.** Authentication accepts client
   addresses only from the documented forwarded header chain through explicit loopback
   trusted proxies. The ingress must overwrite client-supplied forwarding headers.

## Finding-to-proof matrix

| ID | Finding | Required remediation | Required proof |
| --- | --- | --- | --- |
| H1 | Post-completion pain can leave an increase active | Append feedback correction and decision invalidations, permanently block/supersede all affected descendants, pause any affected live session, and expose the effective safety result in History | Deterministic completion/report races in both commit orders plus browser history assertion |
| H2 | Output hash is not bound to the executable prescription | Canonical executable projection and activation-time reconstruction/hash comparison | Hash vector unit tests and persisted-tamper activation rejection |
| H3 | Pain hold permanently dead-ends the trainee | Independent source-linked holds and append-only subject-only self-resolution with abandonment prerequisite, reason, acknowledgement, and no implicit medical clearance | Integration lifecycle/authorization/idempotency tests and end-to-end report, abandon, resolve, restart journey |
| H4 | Owner cannot perform scoped trainee-data deletion | Owner trainee-data deletion preserves installation identity, credential, sessions needed for continuity, and all other users | Owner-with-member exact-count integration and browser deletion journey |
| H5 | Old-password sign-in can survive recovery | Shared credential advisory lock across the complete sign-in and recovery critical sections | Deterministic two-connection race test proving no old-password session survives |
| H6 | First remote visitor can claim a fresh instance | Host-issued one-use bootstrap code, explicit bootstrap creation mode, and generic signup disabled | Concurrent bootstrap-code test, direct generic-signup denial, reuse/expiry tests, browser bootstrap |
| M7 | Live aggregates can be reparented | Immutable aggregate owner/source identifiers and monotonic program/session state transitions | Direct-SQL negative tests for every guarded relationship and transition |
| M8 | Session snapshots and resolved sets remain mutable | Immutable snapshot facts, one-way pending-to-resolved set transitions, and append-only attributed corrections | Direct-SQL negatives plus correction read-model/audit test |
| M9 | Adjustment revisions violate activation ordinals | Renumber remaining local schedule from one while preserving source lineage and run the shared validator before activation | First-workout progression integration test and activation-validator assertion |
| M10 | Runtime content revocation is not representable | Irreversible append-only exact-version revocations and effective-status lookup at activation, start, resume, set, skip, completion, adjustment, history, and export boundaries | Revocation-at-each-boundary integration matrix, version isolation, immutability, and visible history status |
| M11 | Proxy throttling contract is unsafe | Explicit `x-forwarded-for` header policy, loopback trusted proxies, and operator requirement to overwrite the header | Unit tests for spoofed, single-hop, and multi-hop chains plus configuration/docs checks |
| M12 | Destructive reauthentication is unthrottled | PostgreSQL-backed per-account/per-purpose attempt window, lockout, audit, and success reset | Wrong-password threshold/lockout/expiry/success integration tests |
| M13 | Recovery secret files have a path race | Open once with no-follow, descriptor `fstat`, owner/mode/type/size checks, same-descriptor read, and inode check before unlink | Filesystem tests for symlink, mode, owner where supported, oversize, and path replacement |
| M14 | Integration database setup can target unsafe databases | One shared loopback/test-name target guard and cleanup only after successful creation | Pure guard matrix plus clean integration-suite run |
| M15 | Workout errors lose values and remain stale | Action state preserving submitted values, typed focused alerts, pending controls, and success-cleared state | Playwright failure-then-retry with value preservation and cleared alert |
| M16 | Skip replay is not terminally idempotent | Shared append-only command receipts; authorize, return matching success before current eligibility, and reject ID/payload conflicts | Sequential/concurrent replay after pause, terminal state, hold, and revocation plus conflict tests |
| M17 | Auth UI mishandles transport errors | `try/catch/finally`, focused recoverable alerts, and sign-out redirect only after confirmed success | Component/browser aborted-request tests for bootstrap, sign-in, and sign-out |
| M18 | UI bypasses application boundaries | Server/application composition gateways and AST/path-resolved rules for alias, relative, export, and dynamic imports | Architecture tests with synthetic edge fixtures and a clean live graph |
| M19 | Abandon is a one-click irreversible action | Explicit reveal/confirmation, factual reason, server validation, pending lock, and audit | Browser cancellation and confirmed-abandon tests plus persisted reason |
| M20 | Clean-clone validation is underspecified | Document Chromium installation and force test/development content configuration in integration commands | Script/config assertions and clean documented command sequence |
| L21 | Display-unit cap changes canonical load domain | Derive unit-specific maxima from the canonical gram bound and centralize the input increment policy | Metric/imperial boundary and round-trip unit tests plus browser max assertions |
| L22 | Release J4 evidence is split | One unmocked Playwright journey restarts the application mid-session, replays identical set/completion requests, and attempts a denied substitution | Passing supervised-restart browser test with database assertions |

## Validation ladder

The remediation is complete only when all of the following pass from the documented
environment:

1. formatting/lint and TypeScript;
2. unit and architecture tests, including every new pure boundary matrix;
3. fresh-database migrations and database preflight with the exact required triggers;
4. identity, recovery, training, and portability integration suites;
5. the complete Playwright suite, including restart and request replay;
6. reviewed-mode production build and loopback startup smoke;
7. clean worktree/diff checks; and
8. a new independent adversarial review of the complete PR diff.

No thread is marked resolved and the draft PR is not promoted until the evidence above
is attached and the re-review finds no unresolved high- or medium-severity regression.

## Remediation log

### Phase 1 — bootstrap browser proof, workout error UX, abandon confirmation

| Finding | Status | Evidence |
| --- | --- | --- |
| H6 | Fixed | `test/e2e/mvp.spec.ts` issues a host bootstrap code and fills the form; negative test rejects missing/invalid code; `pnpm test:e2e` passes (11/11). |
| M15 | Fixed | Workout actions return typed results; `src/app/workouts/[sessionId]/workout-client.tsx` preserves values, focuses alerts, and disables controls while pending; Playwright failure-then-retry test passes. |
| M19 | Fixed | `abandoned_reason` column and migration `0006_workout_abandon_reason`; reason validation; `auditEvents` `workout-abandoned` record; UI confirmation panel with acknowledgement; integration and browser tests pass. |
| Preflight | Fixed | `src/platform/db/preflight.ts` `expectedMigrationCount` updated to 7 to match the new migration. |

All phase 1 changes pass `pnpm validate`, `pnpm test:integration` (42/42), and `pnpm test:e2e` (11/11).

### Phase 2 — safety hold resolution (H3)

| Finding | Status | Evidence |
| --- | --- | --- |
| H3 | Fixed for source-linked live-session reports | Migrations `0007`–`0009` add source-linked holds, append-only resolutions, composite ownership/provenance, immutable hold facts, an exact abandoned-source rule, and a conservative `0006` upgrade bridge. Unique audit-backed or sole-candidate legacy sources are recovered; contradictory or ambiguous legacy evidence remains source-less and fail-closed for explicit administrator remediation rather than being guessed. `resolveSafetyHold` is subject-only and idempotent; the typed Today form preserves values, locks while pending, focuses errors, and states that resolution is not symptom clearance. Integration tests cover lifecycle, authorization, concurrency, direct-SQL integrity, export/deletion, and the real `0006`→`0009` upgrade. The unmocked browser journey proves report → required abandonment → resolve → process restart with persisted UI/database state. |
| H1 boundary | Fail-closed pending phase 3 | A report against a completed session remains non-resolvable and Today explains that progression invalidation is pending. H1 must append the correction and invalidate every affected decision/revision before this path can become resolvable; clearing a live-session hold cannot reactivate a completed-session progression. |
| Preflight | Fixed | `src/platform/db/preflight.ts` expects 11 migration entries, requires the canonical corrected 0004 ledger hash, and verifies the exact enabled public hold triggers/functions, ownership constraints, semantic checks, and valid/ready unique indexes. |

Phase 2 plus the compatibility follow-up pass `pnpm validate` (including 257/257
unit/architecture tests and the reviewed-mode build), 69/69 fresh/upgrade database
integration tests, the dedicated `0006`→`0009` upgrade test, current-development
migration/preflight, and the complete 12/12 Playwright suite including the
supervised-restart H3 journey.

### Compatibility follow-up — executable v1 and migration provenance

The canonical executable reader now models v1 and v2 separately, keeps all writers on
v2, rejects missing/unknown persisted discriminators, and retains a fixed historical v1
hash vector. A real `0003`-ledger fixture proves that corrected migration 0004 can
backfill an already-active prescription without weakening the released-row guard.
Migration `0010_program_migration_ledger_provenance.sql` recognizes only the exact LF
and CRLF byte hashes of origin/main and corrected 0004, normalizes them to the canonical
LF hash, and fails closed for missing, duplicate, or unknown provenance. `.gitattributes`
keeps migration SQL on LF for future clones, while preflight requires the canonical row
after all 11 migrations.

### Remaining for phase 3 or later

H1, H4, M7/M8, M10, M12, L22.
