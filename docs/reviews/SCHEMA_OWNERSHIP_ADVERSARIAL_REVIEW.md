# Schema ownership arc — adversarial swarm review

Status: **findings accepted; spec/ADR revision applied** — Part A implementation and
Part B maintainer decision still open (blocker 4 not closed)  
Source: six parallel adversarial reviewers on branch `feat/schema-ownership-spec`  
Review id: `d9a005ec`  
Date: 2026-07-14  
Maintainer verification: every load-bearing factual claim re-checked against the live
tree (census, H2/H3/H7/H9, Better Auth, DP verbs, dual SoT). Disposition recorded below;
revision landed in the spec and ADR 0007 the same day.

Targets:

- `docs/architecture/SCHEMA_OWNERSHIP_SPEC.md` (revised: write fence, 36-row seed, scanner
  contract, C1–C5 decision pack, O1–O6)
- `docs/architecture/adr/0007-schema-table-ownership.md` (revised: provisional debt
  template; blocker 4 cite fixed; not accepted)

Lenses:

| Lens | Focus | Artifact |
| --- | --- | --- |
| Census verification | Re-derive write-authority census from live tree | `/tmp/grok-1000/adversarial-census-d9a005ec.md` |
| Contract consistency | AGENTS / ARCHITECTURE / ADR 0001 / MVP_STATUS | `/tmp/grok-1000/adversarial-contracts-d9a005ec.md` |
| Enforcement attack | Bypass paths for proposed CI invariant | `/tmp/grok-1000/adversarial-enforcement-d9a005ec.md` |
| Ownership model | Is write-authority = ownership sound? | `/tmp/grok-1000/adversarial-ownership-model-d9a005ec.md` |
| Decision pack | Does Option B dominate? | `/tmp/grok-1000/adversarial-decision-d9a005ec.md` |
| Completeness / implementability | Can Part A ship without guessing? | `/tmp/grok-1000/adversarial-completeness-d9a005ec.md` |

---

## Executive verdict

| Layer | Verdict |
| --- | --- |
| **Measurement (census §2–§3)** | **Strong.** Independent recount confirms 36 tables, 28/34 single-writer, exact 6 co-writes, owner counts 8/14/4/2/2. Spot-check line refs hold. |
| **Part A intent (manifest + write fence)** | **Worth shipping** as a fork-independent debt fence — after the missing seed, scanner contract, and fidelity fixes land. |
| **Part A as drafted enforcement** | **Not production-blocker quality yet.** Real paths (Better Auth adapter, `execute`/`sql.raw`/`getPool().query`, non-module writers, CASCADE, whole-schema grant semantics) can keep CI green while unauthorized or invisible writes land. |
| **Part B / ADR 0007 Option B** | **Does not dominate as written.** False dichotomy vs targeted intermediates; 82% table rhetoric underweights the completion spine; “fence” is mostly paperwork; accepting B without amending AGENTS/ARCHITECTURE creates dual source of truth. |
| **Blocker 4 closure via B + thin Part A** | **Letter yes, substance half.** Closes the disjunction only if docs and residual debt are rewritten honestly; a green ownership test alone is subsystem theater. |

**Maintainer disposition (accepted; drives the revision):**

1. **Part A:** harden and ship as a **write fence over current writers** (not domain
   ownership) — full 36-row seed with primary owners for co-writes, scanner contract
   (adapter = write authority for O5, execute/perimeter, DP op matrix including
   `installation_state` UPDATE), H9 fidelity fix.
2. **ADR 0007:** revise as **provisional debt ratification** template (or pair any future
   acceptance with same-change AGENTS/ARCHITECTURE/MVP amends). Pre-review "Option B as
   terminal boundary without amends" stays **reject**. Fix blocker 5→4 cite.
3. **Decision pack:** re-open with **C1–C5**; re-cost Option A unbundled. Presenting C1 is
   in-scope for the revision; **building C1 stays the maintainer's Part B call** — do not
   silently convert the recommendation to implement C1.
4. **Blocker 4:** do not tick on ADR merge alone. O1–O6 + doc/status convergence is DoD.
5. **H8 note:** review slightly overclaimed that Part A CI "enforces Option B" if 0007 is
   rejected — the seed is current reality / migration checklist either way. Remediation
   (currentWriters / write fence framing) still applied for H6.

**Revision applied:** see current `SCHEMA_OWNERSHIP_SPEC.md` and ADR 0007 on this branch.
**Still open:** implement Part A code (`ownership.ts` + scanner test); Part B decision;
blocker 4 closeout.

---

## What the swarm independently confirmed (do not re-litigate)

- Exactly **36** `pgTable`s: 7 auth + 1 installation + 28 product.
- Excluding data-portability whole-schema deletes: **28 single-writer, 6 co-written** — same six tables named in the spec.
- Co-write sites live: `program_revision` at `programs.ts:228` and `training/workouts.ts:2331`; `safety_hold` at `athletes/profile.ts:221` and `training/workouts.ts:1664`.
- Training’s 14 (ellipsis expanded): `workout_session`, `performed_set`, `session_exercise`, `session_feedback`, `adjustment_decision`, `training_fact_correction`, `session_feedback_correction`, `performed_set_correction`, `adjustment_decision_invalidation`, `program_revision_invalidation`, `training_command_receipt`, `future_load_explanation_cache`, `safety_hold_resolution`, `program_revision_lineage`.
- `src/app/**` has no direct schema DML; methodology/exercises/progress write zero tables.

---

## Cross-cutting findings (severity-ranked)

Severity bands used across the swarm: **H** = must fix before treating this arc as blocker-ready; **M** = should fix before ADR acceptance or first implementation PR; **L** = polish / trust.

### H1 — Exhaustive ownership seed missing (implementers invent primary owners)

**Sources:** completeness, census  
**Where:** `SCHEMA_OWNERSHIP_SPEC.md` §3–§4  

Counts and ellipsis are not a 36-row seed. Primary `owner` for co-written tables (`audit_event`, Programs↔Training cluster, `safety_hold`) is a **policy choice**, not measurement. First PR will invent different primary owners; gateway migration checklists become unreviewable.

**Required:** Full table of SQL name → owner → sharedWriters (no `…`). Primary owners for all six co-writes explicit.

### H2 — Enforcement mechanism bypassable on live paths

**Sources:** enforcement  
**Where:** Spec §5; live identity/data-portability/platform paths  

| Hole | Evidence |
| --- | --- |
| Better Auth adapter writes | Session/account inserts live inside `better-auth` via `drizzleAdapter` — no local `.insert(session)` |
| Plain-string / `sql.raw` execute | `owner-bootstrap.ts`, `local-users.ts`; `getPool().query` available |
| Whole-schema grant wrong | Data Portability **INSERT**s plans/tombstones and **UPDATE**s `installation_state` — not delete/redact only |
| Perimeter undefined | Invariant is “module”; platform/app/scripts DML not classified |
| CASCADE / triggers | Parent delete mutates child-owned rows without call-site attribution |
| “AST already in boundaries.test.ts” | No reusable write-call AST; network walkers only — cost “~a day” understated |

**Required:** Scanner contract (roots, principals, symbol→SQL map, adapter registration as write authority, op matrix for DP); residual-risk section if dynamic SQL remains accepted.

### H3 — Option B is a silent target rewrite (dual source of truth)

**Sources:** contracts, ownership model  
**Where:** Spec §70–73 “by design”; ADR Decision; contrast ARCHITECTURE / AGENTS  

| Accepted rule | Option B effect if accepted without amends |
| --- | --- |
| Modules only via exported application API | Programs↔Training + DP remain direct table access |
| Never private tables across modules | Authorized via sharedWriters + wholeSchemaReaderDeleter |
| UnitOfWork for multi-module writes | Deferred; co-writes continue in initiator transactions |
| DP coordinates via ports; no arbitrary tables | Elevated from debt to permanent whole-schema role |
| No module reaches across to another module’s tables | Replaced by write-only ownership scan |

**Required:** Either amend AGENTS + ARCHITECTURE in the same change as ADR acceptance, or rewrite ADR as provisional debt fence that **does not** claim terminal boundary and keeps residual items open.

### H4 — False dichotomy; Option B does not dominate

**Sources:** decision pack  
**Where:** Spec §6; ADR alternatives  

Missing intermediates that dominate both poles for this arc:

| Option | Scope | Why it matters |
| --- | --- | --- |
| **C1** | Programs write API for 4 tables on completion path | Highest-churn product spine; Training already calls `activatePersistedProgramRevision` |
| **C2** | Audit append port | Cross-cutting; should not be four private inserts forever |
| **C3** | safety_hold owner + raise/clear API | DB already has two policies; sharedWriter freezes the wrong design |
| **C4** | DP ports only | Matches ARCHITECTURE target independently |
| **C5** | UnitOfWork only for multi-module writes | Aligns AGENTS without full repository extraction |

Option A is costed as C1–C5 + Phase-3 UnitOfWork bundle (“scare figure”); Option B defers all. Fair comparison for “gateway debt” is **C1 alone**, not full A.

### H5 — 82% single-writer underweights the product spine

**Sources:** decision, ownership, contracts  

The residual 18% includes completion → future `program_revision` + full prescription graph (J5 spine), `safety_hold` (safety-critical), and `audit_event`. Table-count equality treats `web_recovery_rate_limit_bucket` like the next-load path. Better metric: multi-module write sites on J1–J6 / completion transaction, not % of tables.

### H6 — Write-authority ≠ domain ownership (model defect if B is terminal)

**Sources:** ownership model  

- Training **constructs** Program aggregate rows then activates via Programs API — layering violation, not “co-ownership.”
- `safety_hold` is two lifecycles (eligibility clear vs session-pain + resolution table).
- `audit_event` many-writers-by-design contradicts multi-module write rules; correct shape is an audit port.
- Owner vs sharedWriter is **operationally identical** under the stated invariant (boolean union).
- Verbs (insert/update/delete) and mutability (append-only vs lifecycle) are collapsed.
- Reads are unconstrained — Progress can SELECT Training tables under a green ownership suite.

**Required if Part A only:** Call the artifact `currentWriters` / debt fence, not “ownership boundary.”  
**Required if ADR accepted as architecture:** Verb-scoped grants, mutability class, aggregateOwner ≠ currentWriter, declared readers or explicit unpaid debt.

### H7 — Blocker 4 closure / maintainability row / beta category error

**Sources:** decision, contracts  

- Spec correctly cites **blocker 4**; ADR body says **blocker 5** (security/privacy) — factual mis-cite.
- “Doesn’t block the beta” is the wrong gate for a **production-release** blocker.
- MVP Maintainability row still says “resolve the cross-module gateway debt,” not “declare exceptions.”
- Closing blocker 4 via ADR without refiling residual gateway debt launders incompleteness into “done.”

### H8 — Part A not fork-independent as claimed

**Sources:** contracts, completeness  

Manifest seeds permanent-looking `sharedWriters` (gateway-target debt, ADR 0007) and first-class `wholeSchemaReaderDeleter`. Under Option A those are migration checklist items; under B they are the terminal boundary. Encoding B roles into “fork-independent” Part A makes CI enforce B even if 0007 is rejected, unless a second PR rewrites the manifest.

### H9 — Fidelity bug: rate-limit “raw SQL only”

**Sources:** census, completeness  
**Where:** Spec §2 lines 57–59  

Live `web-recovery-rate-limit.ts` uses Drizzle **insert/update** and raw SQL **DELETE**. Import-only scan *does* see the symbol. Mis-trains scanner design and undermines “decision-grade measurement” rhetoric.

### H10 — Arc DoD missing vs AGENTS definition of done

**Sources:** completeness  

No explicit acceptance matrix. A green architecture test with no MVP_STATUS/ADR/ARCHITECTURE update is the failure mode AGENTS exists to prevent.

**Minimum proof matrix:**

| ID | Claim | Proof |
| --- | --- | --- |
| O1 | All 36 tables manifested | set equality vs schema parse |
| O2 | No undeclared write | live scan + synthetic violation fixture |
| O3 | Stale grants / owners policy | documented rule + fixture |
| O4 | DP breadth only | only DP may non-owner delete (op matrix) |
| O5 | Auth tables identity-owned | adapter path assertion + owner seed |
| O6 | Docs/status | ADR status + MVP_STATUS + (if B) AGENTS/ARCHITECTURE amends |

---

## Medium findings (should fix before first implementation PR)

| ID | Finding |
| --- | --- |
| M1 | Mis-attribution: gateways/UnitOfWork attributed to ADR 0001; they live in ARCHITECTURE/AGENTS |
| M2 | MVP_STATUS debt paraphrased as “deliberate exceptions”; “ports still absent” clause dropped |
| M3 | ADR “Supplements 0001” invalid for a boundary relaxation — need Amends list |
| M4 | Re-entry triggers gameable (extend sharedWriters reason → never a “second cluster”) |
| M5 | Moral hazard: after B, extending sharedWriters is cheaper forever than building gateways |
| M6 | Manifest TypeScript contract underspecified (SQL keys, ModuleId, reason shape) |
| M7 | installation_state writers include DB trigger + DP UPDATE — census method incomplete |
| M8 | scripts/backup-restore-drill raw-inserts audit_event — scope scripts explicitly |
| M9 | UnitOfWork “out of scope” while multi-module co-writes continue — must explicitly supersede AGENTS language or refile |
| M10 | Progress zero tables + write-only fence green-washes future SELECT sprawl |
| M11 | exercises zero tables is missing content schema, not healthy purity (methodology zero *is* healthy) |
| M12 | Interaction with `boundaries.test.ts`: new additive file; import of schema remains allowed |
| M13 | Ordered failure diagnostics (unmanifested table before write flood) |

---

## Low findings

| ID | Finding |
| --- | --- |
| L1 | Expand training’s 14-table list (ellipsis) |
| L2 | Spec “NOT resolved” vs strong “Recommendation: Option B” tension |
| L3 | “Near-clean reality” marketing tone |
| L4 | `data-portability` hyphenation = folder key; dual role owner-of-2 + operator |
| L5 | Spec draft vs ADR proposed vocabulary alignment |
| L6 | ROADMAP still requires ownership without ADR fork language |

---

## Decision matrix for the maintainer

| Path | What to do | Closes blocker 4? |
| --- | --- | --- |
| **Part A only (recommended floor)** | Ship hardened manifest + scanner; leave ADR proposed or reject as terminal | No — until Part B decision + doc convergence |
| **Option B honest** | Accept ADR *and* amend AGENTS/ARCHITECTURE/MVP Maintainability; freeze sharedWriters; objective re-entry; residual Phase-3 ticket | Letter yes; only if residual debt is tracked under a new explicit item |
| **Option B as drafted** | ADR + thin green test, no doc amends | **Reject** — dual SoT + half-closed architecture |
| **Option C1 (+ optional C2/C3)** | Programs completion write port; audit port; safety API; Part A fence | Stronger substance; may leave DP as declared debt |
| **Full Option A** | Gateways + UoW + DP ports | Yes for spirit of original architecture; large scope — cost honestly |

---

## Rewrite priorities — applied in spec/ADR revision

1. ~~Fix H9 fidelity note; expand training 14; fix ADR blocker number (5→4).~~
2. ~~Publish full 36-row seed with primary owners for co-writes.~~
3. ~~Spec scanner contract + `ownership.ts` types + O1–O6 DoD.~~
4. ~~Rename or reframe: write fence / current writers vs domain ownership.~~
5. ~~Add intermediate options C1–C5 to §6 and ADR alternatives; re-cost Option A without bundling.~~
6. ~~Provisional debt ratification packaging + doc-convergence path + re-entry + residual tracker.~~
7. ~~Data Portability: current implementation / tracked debt + verb-scoped operator matrix.~~
8. ~~Still open for implementation PRs: `ownership.ts`, scanner, fixtures O1–O5, Part B decision.~~

---

## What is solid (swarm consensus)

- Write authority over import presence is the right *measurement* correction.
- Part A as a mandatory floor is correctly separated from the Part B fork *in intent*.
- Declared exceptions for measured co-writes are better than silent growth.
- Proposed status / “not self-accepted” process language on the ADR is honest.
- Census arithmetic and co-write set are decision-grade for seeding a fence (not for proving B is the best terminal architecture).

---

## Swarm metadata

| Subagent | Role | Result path |
| --- | --- | --- |
| census | Write-authority recount | `/tmp/grok-1000/adversarial-census-d9a005ec.md` |
| contracts | Doc/contract contradictions | `/tmp/grok-1000/adversarial-contracts-d9a005ec.md` |
| enforcement | Invariant bypass portfolio | `/tmp/grok-1000/adversarial-enforcement-d9a005ec.md` |
| ownership-model | Conceptual model attack | `/tmp/grok-1000/adversarial-ownership-model-d9a005ec.md` |
| decision | Option B dominance attack | `/tmp/grok-1000/adversarial-decision-d9a005ec.md` |
| completeness | Implementability / first-PR risk | `/tmp/grok-1000/adversarial-completeness-d9a005ec.md` |

This consolidated document is the durable handoff. Per-lens files retain full evidence tables, bypass sketches, and expanded issue lists.
