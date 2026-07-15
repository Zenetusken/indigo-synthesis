# Schema/table write-fence enforcement (arc spec)

Status: **Part A implemented and shipped (#9); Part B decided (#12)** — retained as the
write-fence contract, measured census, and historical decision pack. Active Part B implementation
is sequenced by [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md).
Scope owner: architecture / platform

This specifies production-release blocker 4 in
[MVP_STATUS.md](../MVP_STATUS.md#production-release-blockers) ("Extend architecture
enforcement to schema/table ownership and either implement the intended public module
gateways or accept a narrower boundary in an ADR"). The quoted wording records the original fork;
the proper-gateway branch is now selected. The blocker remains two things, and this spec keeps them
separate:

- **Part A (mandatory and shipped):** a checked-in **write-authority fence** —
  who may currently issue DML against each table — plus an architecture test that enforces
  it. This is a **debt fence and migration checklist**, not a claim that write sites equal domain
  ownership.
- **Part B (decided):** the maintainer chose the proper structural boundary—public module ports,
  a shared UnitOfWork, and removal of current debt/operator breadth—rather than provisional debt
  ratification. See [§6](#6-part-b--decision-provenance-and-disposition) and accepted
  [ADR 0007](adr/0007-schema-table-ownership.md).

Every quantitative claim below is grounded in a measured census of the live tree (and
independently re-verified during adversarial review), not intent.

**What this arc does not claim**

- Part A did **not** change product journeys (J1–J6), implement UnitOfWork, or extract Progress.
- Part A did **not** close blocker 4 on merge — see [§8](#8-definition-of-done-o1o6).
- Part A does **not** enforce read boundaries, public application APIs, or domain aggregate
  ownership. Those remain the AGENTS.md / ARCHITECTURE.md target until Part B changes them.

---

## 1. What the architecture docs already claim

`MVP_STATUS.md` records the gap: the architecture suite proves the module graph is acyclic
and enforces several import/runtime dependency rules plus current write authority, but does not yet
require all cross-module work to use public gateways or reject peer-table reads. Under **Known
architecture debt** it lists (among other items) that Programs and Training currently
coordinate through direct Drizzle over the shared schema, and that Data Portability
intentionally uses a direct, repeatable-read projection and ordered deletion transaction
**while public per-module export/deletion ports are still absent**. Those are tracked debt,
not evidence that the documented boundaries already exist.

The **target** boundary rules live in [AGENTS.md](../../AGENTS.md) and
[ARCHITECTURE.md](ARCHITECTURE.md) (public application APIs; multi-module writes via a
shared `UnitOfWork` port; modules do not reach across to another module's tables).
[ADR 0001](adr/0001-modular-monolith.md) decides the modular-monolith deployment shape; it
does **not** itself define gateways or UnitOfWork. The vertical slice has not built those
gateways. Part A turns the *measured write sites* into a local/pre-merge architecture fence; it does not silently
rewrite the target rules.

---

## 2. Measurement method

Schema: **36** tables across `src/platform/db/schema/{auth,installation,product}.ts`
(7 + 1 + 28). For each product module under `src/modules/*`, a static census classified
access:

- **write** — a Drizzle `.insert(SYM)` / `.update(SYM)` / `.delete(SYM)` (including
  upserts such as `.onConflictDoUpdate`) on the table's schema symbol, **or** a raw SQL
  `INSERT` / `UPDATE` / `DELETE` against the SQL table name;
- **read** — `.from(SYM)` / `.select` only (not used as ownership).

**Write sites ≠ domain ownership.** A module that only `.select()`s is a consumer for
this fence, not an aggregate owner. Domain ownership (who owns invariants and the public
mutation API) may differ from who currently issues DML — that is why residual co-writes
are labeled **debt**, not co-ownership of the domain.

An earlier import-presence census (any schema-symbol import) reported 34/36 tables
"shared" and even attributed tables to `methodology`, which writes **zero** tables —
local variables named `session` / `performed_set`, not schema references. The
write-authority census is the corrected, decision-grade measurement for Part A.

**Fidelity notes (carried into the scanner contract, §5):**

- Scan both Drizzle write calls and raw-SQL write literals. Example: `identity` uses
  Drizzle `.insert` / `.update` on `web_recovery_rate_limit_bucket`
  (`web-recovery-rate-limit.ts`) **and** a raw SQL `DELETE` cleanup path — an import-only
  scan sees the symbol; a raw-SQL scan is still required for the delete half and for other
  modules' raw deletes.
- Test files (`*.test.ts` / `*.test.tsx`) are excluded.
- Spot-checked co-write sites (no line drift at review time): `program_revision` at
  `programs/application/programs.ts:228` and `training/application/workouts.ts:2331`;
  `safety_hold` at `athletes/application/profile.ts:221` and
  `training/application/workouts.ts:1664`; `audit_event` inserted in athletes, identity,
  programs, and training.
- Non-AST writers that still matter for a honest fence: Better Auth `drizzleAdapter`
  (session/account/user/verification mutations with no local `.insert(session)`);
  PostgreSQL triggers (e.g. `installation_state` updates on authorized `user` insert);
  FK CASCADE; `transaction.execute` / `sql.raw` / `getPool().query` shapes.

---

## 3. Measured write-authority census

**Data Portability** is a **cross-cutting lifecycle operator in the current
implementation** (tracked debt relative to ARCHITECTURE's port-based target). It reads
broadly for export, deletes nearly every personal table in ordered deletion, INSERTs
`deletion_plan` / `deletion_tombstone`, and UPDATEs `installation_state` on instance
reset. It is **owner** of those two deletion tables and holds a **verb-scoped operator
grant** for the rest (§4). The single-writer counts below **exclude** its non-owned
deletes/updates so product-module write sites are visible.

Excluding Data Portability's non-owned DML: **28 of 34 candidate tables have a single
product-module writer**; **6 are co-written**. Partition of all 36:

```text
36 total = 28 single-writer + 6 co-written + 2 data-portability-owned
         (data-portability's deletes of non-owned tables are operator grants, not co-ownership)
```

| Co-written table | Product writers | Debt class |
| --- | --- | --- |
| `audit_event` | athletes, identity, programs, training | Cross-cutting append log — needs audit **port**, not multi-writer forever |
| `exercise_prescription` | programs, training | Programs↔Training cluster (gateway-target debt) |
| `planned_workout` | programs, training | Programs↔Training cluster |
| `program_revision` | programs, training | Programs↔Training cluster (Training constructs future revision on completion) |
| `set_prescription` | programs, training | Programs↔Training cluster |
| `safety_hold` | athletes, training | Two lifecycles (eligibility vs session-pain); not one shared domain |

**Primary-owner policy for the seed (explicit, not re-derived at implement time):**

| Co-written table | `owner` (primary) | Rationale |
| --- | --- | --- |
| `audit_event` | `identity` | Natural home for actor/security events and a future audit port |
| Programs↔Training cluster (4) | `programs` | Programs aggregate; Training construction is vertical-slice debt |
| `safety_hold` | `athletes` | Eligibility policy home; session-pain raise is debt until an athletes API |

Single-writer product modules (28 tables): **identity** 8, **training** 14, **athletes** 4,
**programs** 2. **data-portability** owns 2. Full rows: [§4 seed](#42-exhaustive-seed-36-tables).

`exercises`, `methodology`, and `progress` currently write **zero** tables:

- `methodology` — pure domain engine; zero tables is healthy.
- `exercises` / `progress` — unfinished extraction / missing content schema relative to
  ARCHITECTURE; zero writes is an enforceable **current** fact, not proof the module map
  is complete.

**How to read the 28/34 figure:** most tables already have a single product writer. That
justifies a cheap write fence (Part A). It does **not** by itself prove that ratifying the
residual 6 as a terminal architecture (old Option B packaging) is best — those 6 include
the completion → future-revision spine, safety holds, and audit emission. Decision quality
for Part B is in §6, not in the percentage alone.

---

## 4. Part A — the write-authority manifest (mandatory)

A single checked-in manifest (`src/platform/db/schema/ownership.ts`, new) maps every SQL
table to write grants. Naming in prose: **write fence** / **current writers**. The file
path may keep `ownership.ts` for short import paths; comments and exported types must say
write-authority fence, not "domain ownership."

### 4.1 TypeScript contract (normative)

```ts
/** Exact folder names under src/modules/. */
export type ModuleId =
  | 'athletes'
  | 'data-portability'
  | 'exercises'
  | 'identity'
  | 'methodology'
  | 'programs'
  | 'progress'
  | 'training'

/** Non-module principals that may appear only in externalWriters / scan attribution. */
export type NonModulePrincipal = 'platform' | 'app' | 'scripts' | 'db-trigger' | 'library-adapter'

export type WriteOp = 'insert' | 'update' | 'delete'

export type WriterGrant = {
  readonly module: ModuleId
  readonly ops: readonly WriteOp[]
  /** Non-empty. Debt grants cite ADR/spec; do not use empty strings. */
  readonly reason: string
  /** When true, grant is vertical-slice debt, not terminal domain co-ownership. */
  readonly debt?: boolean
}

/**
 * A non-module writer the AST scan will not attribute (library adapter or DB
 * trigger). `principal` is type-checked against NonModulePrincipal so the O5
 * attribution vocabulary is enforced, not merely documented.
 */
export type ExternalWriter = {
  readonly principal: NonModulePrincipal
  readonly note: string
}

export type TableWriteFence = {
  /** Module that is the seed primary for reviews and gateway migration checklists. */
  readonly owner: ModuleId
  /**
   * Additional modules currently authorized to issue DML.
   * Under the fence invariant, owner and additionalWriters are the same boolean grant
   * unless ops differ — owner is documentation + migration checklist, not a superuser bit.
   */
  readonly additionalWriters?: readonly WriterGrant[]
  readonly mutability?: 'append-only' | 'lifecycle-status' | 'mutable' | 'cache' | 'deletion-ledger'
  /** Non-module writers the AST will not see (triggers, adapters). O5 attribution. */
  readonly externalWriters?: readonly ExternalWriter[]
}

/**
 * Keys = SQL table names (pgTable first arg / explicit name), not Drizzle export ids.
 * Must be exhaustive over the 36 product schema tables.
 */
export declare const tableWriteFence: { readonly [Table in SqlTableName]: TableWriteFence }

/**
 * Verb-scoped cross-cutting operator for data-portability (current implementation debt).
 * Does not make DP the domain owner of product tables.
 */
export declare const crossCuttingOperator: {
  readonly module: 'data-portability'
  readonly reason: string
  readonly allow: {
    readonly read: '*'
    readonly delete: '*' // ordered deletion of personal/product rows
    readonly update: readonly SqlTableName[] // non-owned tables only
    readonly insert: readonly SqlTableName[] // non-owned tables only
  }
}
```

`SqlTableName` is derived from the live `pgTable(...)` definitions in
`src/platform/db/schema/{auth,installation,product}.ts` **at the type level** (via
Drizzle's branded `_.name`), not from the manifest's own keys. The manifest is then
declared `as const satisfies Record<SqlTableName, TableWriteFence>` with a bijection guard,
so O1 (every schema table manifested, no stale entries) is enforced at **compile time** —
adding, renaming, or dropping a table without a matching manifest edit fails `tsc` (and
therefore `pnpm validate`). The §5 runtime test additionally asserts O2–O5. Platform is
**not** a product module and must never appear as `owner` / `additionalWriters` module.
Schema DDL and the migration ledger (`drizzle/`, `drizzle.__drizzle_migrations`) are **out
of the 36**. Owned tables (`deletion_plan`, `deletion_tombstone`) are authorized by their
owner grant, so they do **not** appear in the operator's `update` / `insert` arrays.

### 4.2 Exhaustive seed (36 tables)

Primary owners for co-writes follow §3. Debt reasons are abbreviated; the checked-in file
should use full reason strings.

| SQL table | owner | additionalWriters (module → ops → debt class) |
| --- | --- | --- |
| `user` | identity | — (external: Better Auth adapter) |
| `session` | identity | — (external: Better Auth adapter; identity recovery deletes) |
| `account` | identity | — (external: Better Auth adapter) |
| `verification` | identity | — (external: Better Auth adapter) |
| `destructive_reauthentication_state` | identity | — |
| `member_reset_state` | identity | — |
| `web_recovery_rate_limit_bucket` | identity | — (Drizzle insert/update + raw DELETE cleanup) |
| `installation_state` | identity | — (external: bootstrap trigger; DP update via operator grant) |
| `athlete_profile` | athletes | — |
| `athlete_training_day` | athletes | — |
| `athlete_equipment` | athletes | — |
| `strength_baseline` | athletes | — |
| `safety_hold` | athletes | training → insert (+ eligibility update remains athletes) — debt: session-pain hold raise until athletes API |
| `safety_hold_resolution` | training | — |
| `program` | programs | — |
| `program_revision` | programs | training → insert — debt: completion constructs Programs aggregate |
| `content_release_revocation` | programs | — |
| `planned_workout` | programs | training → insert — debt: Programs↔Training cluster |
| `exercise_prescription` | programs | training → insert — debt: Programs↔Training cluster |
| `set_prescription` | programs | training → insert — debt: Programs↔Training cluster |
| `workout_session` | training | — |
| `session_exercise` | training | — |
| `performed_set` | training | — |
| `session_feedback` | training | — |
| `program_revision_lineage` | training | — |
| `training_command_receipt` | training | — |
| `adjustment_decision` | training | — |
| `training_fact_correction` | training | — |
| `session_feedback_correction` | training | — |
| `performed_set_correction` | training | — |
| `adjustment_decision_invalidation` | training | — |
| `program_revision_invalidation` | training | — |
| `future_load_explanation_cache` | training | — |
| `audit_event` | identity | athletes, programs, training → insert — debt: until audit port |
| `deletion_plan` | data-portability | — |
| `deletion_tombstone` | data-portability | — |

**Training's 14 single-writer tables (no ellipsis):** `workout_session`, `session_exercise`,
`performed_set`, `session_feedback`, `program_revision_lineage`, `training_command_receipt`,
`adjustment_decision`, `training_fact_correction`, `session_feedback_correction`,
`performed_set_correction`, `adjustment_decision_invalidation`,
`program_revision_invalidation`, `future_load_explanation_cache`, `safety_hold_resolution`.

**Cross-cutting operator seed (`data-portability`):**

| Allow | Tables |
| --- | --- |
| `read` | `*` (export projection — current implementation debt) |
| `delete` | `*` (ordered personal/product deletion; not a domain-owner claim) |
| `update` | `installation_state` (instance reset reopen) — **non-owned only** |
| `insert` | — (none; DP's `deletion_plan` / `deletion_tombstone` inserts are its **owner** grants, not operator breadth) |

The operator arrays list **only non-owned** tables. DP-owned tables (`deletion_plan`,
`deletion_tombstone`) are authorized through their owner grant per §5.3(7), so listing them
here would be a redundant second authority that could mask a removed owner grant — they are
intentionally excluded. No other module may hold whole-schema read/delete breadth.

### 4.3 What the seed means under selected Part B

The seed encodes **current measured reality**. Under selected Option A / C1–C5 it is the
migration checklist: debt grants shrink to zero and the operator is removed. Provisional ADR
ratification remains historical option analysis only. Encoding today's writers is not the same as
permanently blessing them as domain co-owners — debt flags and Part B exist for that distinction.

---

## 5. Part A — enforcement invariant and scanner contract

### 5.1 Invariant

**Write-fence invariant:** *No production principal issues DML against a table unless
authorized by that table's owner grant, an `additionalWriters` grant (matching op), the
`crossCuttingOperator` op matrix, or an explicitly documented `externalWriters` rule
(adapter / trigger) that still attributes authority to the table's owner module.*

*Falsified by:* unauthorized write; new schema table without manifest entry; extra
manifest entry for a dropped table; stale **debt** grant whose module no longer writes
(see stale policy); second whole-schema operator; adapter registration for auth tables
outside `identity`.

This invariant is a **subset** of AGENTS/ARCHITECTURE (writes only). Cross-module
`.select` is **not** fenced here; Progress reading Training tables would stay green under
Part A alone — ARCHITECTURE's read-model rules remain unpaid debt unless Part B addresses
them.

### 5.2 Test location and integration

- New file: `test/architecture/schema-ownership.test.ts` (additive; does **not** replace
  `boundaries.test.ts` / import-graph tests).
- Included by existing `vitest.config.ts` `test/architecture/**/*.test.ts` — runs under
  `pnpm test` / `pnpm validate`; no DB (`pnpm test:integration` not required).
- Optional shared helper: `test/architecture/schema-ownership-scan.ts` (preferred over
  bolting into the network-capability walker in `boundaries.test.ts`).

### 5.3 Scanner contract (normative)

**1. Perimeter (scanned roots)**

| Root | Policy |
| --- | --- |
| `src/modules/**` | Primary; attribute to module id = first path segment under `modules/` |
| `src/app/**` | Scanned; product DML here is a **fail** (no app principal grants) |
| `src/platform/**` | Scanned; product table DML is a **fail** except documented non-DML (`set_config`, locks, migrate/preflight admin) |
| `src/application/**` | Scanned; no product DML expected today |
| `scripts/**` | Scanned or explicitly allowlisted; `scripts/db/backup-restore-drill.ts` issues a raw `INSERT INTO audit_event` **and** a raw `UPDATE audit_event` (a `{"tampered":true}` tamper-detection probe) — **both** must be allowlisted or moved, not just the insert. Because the UPDATE mutates an `append-only` table, the allowlist entry must be explicit that this is a test/operational exception, never a product sharedWriter or a licence for app code to update audit rows |
| `**/*.{test,spec}.{ts,tsx}` and `test/**` | Excluded |

**2. Module id** — exact folder names (`data-portability`, not `dataPortability`).

**3. Symbol ↔ SQL map** — parse schema files: Drizzle export binding → SQL table name.
Drizzle detectors use bindings (including import aliases and `namespace.table`); raw SQL
detectors use **SQL** names (snake_case, quoted `"user"`).

**4. Drizzle write detection (TypeScript AST, `ts.Node`)**

Detect call expressions whose callee property is `insert` | `update` | `delete` and whose
first argument resolves to a schema table binding. Include chained builders
(`.insert(t).values()`, `.update(t).set()`, `.onConflictDoUpdate`).

Must **not** treat as writes: `Map`/`Set`/Headers `.delete`, `Hash.update`, non-table
arguments, schema symbols appearing only inside SQL expressions for column math (write
target is the `.update(SYM)` argument only).

Import binding resolution is required (aliases, `import * as schema`). There is **no**
existing write-call scanner in `boundaries.test.ts` to "extend" — only general `ts`
usage for import/network classification. Budget for a new analyzer accordingly; a brittle
regex census is acceptable for exploration, **not** for O1–O6.

**5. Raw / execute paths**

Scan for:

- `sql\`...\`` / `sql.raw(...)` containing `INSERT INTO` / `UPDATE` / `DELETE FROM` + table;
- string or template-literal arguments to `.execute(...)` / `.query(...)` with the same;
- multi-line templates and `DELETE FROM table AS alias`.

Admitted residual risk: fully dynamic table names with no static token. Document as residual
in ADR/spec; do not pretend the fence is airtight against hostile dynamic SQL without a
follow-on ban on non-owner raw DML.

**6. Better Auth / library adapter (required for O5)**

- Only `src/modules/identity/**` may configure `drizzleAdapter` / Better Auth DB binding
  for `user`, `session`, `account`, `verification`.
- **Adapter registration counts as write authority** for those four tables attributed to
  `identity`. Without this rule, the scanner observes few/no session inserts and
  identity's auth-table grants are **unverifiable** under stale-grant logic.
- Optional fixture: assert adapter schema keys ⊆ identity-owned auth tables.

**7. Cross-cutting operator**

`data-portability` non-owned DML is authorized only via `crossCuttingOperator.allow`, not
by exploding every table into `additionalWriters`. Owned tables (`deletion_plan`,
`deletion_tombstone`) use normal owner grants.

**8. Stale-grant policy**

| Case | Policy |
| --- | --- |
| `additionalWriters` entry with `debt: true` and zero observed writes for that module+ops | **Fail** (stale debt grant) |
| `owner` with zero observed product writes **and** no `externalWriters` covering the table | **Fail**, unless table is explicitly `mutability` reserved (none in v1 seed) |
| Auth tables with adapter external writer | Owner `identity` satisfied by adapter registration rule even without local `.insert(session)` |
| Intentional dormant debt | Not used in v1; prefer removing the grant |

**9. Failure order (diagnostics)**

1. Schema tables ↔ manifest bijective coverage  
2. Manifest validity (unknown module ids, empty reasons, illegal second whole-schema operator)  
3. Observed writes ⊆ grants (op-aware)  
4. Stale grants / adapter path rules  

Prefer machine-readable codes: `ownership.table.unmanifested`, `ownership.write.unauthorized`,
`ownership.grant.stale`, `ownership.adapter.unauthorized`.

**10. Required fixtures (synthetic snippets in the test file)**

- Undeclared module write → fail  
- New table name absent from manifest → fail  
- Unused debt `additionalWriters` → fail  
- Control: `Map.delete` / non-DML `sql` → pass  
- Raw `DELETE FROM <table>` unauthorized → fail  
- Adapter config outside identity → fail (O5)

**11. Residual non-goals (static-only fence)**

FK CASCADE, true dynamic SQL, and DB role separation are out of static enforcement.
PostgreSQL immutability triggers remain the authority for append-only tables; the fence
does not grant rewrite rights.

---

## 6. Part B — decision provenance and disposition

This section preserves the alternatives that were presented before the maintainer decision.
Part B is now resolved: build the proper boundary through the accepted calibration/UnitOfWork arc,
then remove the current grants/operator and complete O6. The options below remain historical
decision provenance, not open implementation forks.

### 6.1 Options (including intermediates)

| Option | What it is | Relative cost | Notes |
| --- | --- | --- | --- |
| **A — Full public module gateways** | Ports for cross-module access; DP via module ports; UnitOfWork for multi-module writes | Large (bundle of C1–C5 + composition) | Realizes ARCHITECTURE/AGENTS target fully |
| **B — Provisional debt ratification** | Accept Part A fence + declare residual debt in ADR with residual tracker; **amend or explicitly suspend** conflicting AGENTS/ARCHITECTURE sentences if treated as production boundary | Small (docs + process) if provisional; larger if docs must converge | **Not** "terminal ownership architecture" without doc amends |
| **C1 — Programs completion write API** | Training stops inserting program graph rows; calls Programs application API inside the same transaction for future revision + prescriptions | Bounded extract vs full A | Highest-churn spine; fair comparison for "gateway debt" |
| **C2 — Audit append port** | Single owner inserts `audit_event`; modules call `recordAuditEvent` | Small | Removes four-way private inserts |
| **C3 — safety_hold API / single owner path** | Athletes (or safety port) owns rows; training raises session holds via API | Small–medium | Matches two-policy DB model better than open sharedWriter |
| **C4 — Data Portability ports** | Export/deletion via per-module ports | Medium | Matches ARCHITECTURE target; independent of Programs↔Training |
| **C5 — UnitOfWork for multi-module writes** | Workflow composition without full table extraction | Medium | AGENTS multi-module write rule; currently README-only |

**Costing note:** Do **not** cost Option A as if C1 alone were Phase-3-scale. Unbundle:
C1 is a bounded extract around an existing completion transaction; audit and safety are
separate small ports; DP and UnitOfWork are independent decisions.

### 6.2 Historical recommendation posture

- **Ship Part A** regardless of Part B (mandatory floor).
- **Do not accept ADR 0007 as drafted in the pre-review form** (terminal "narrower
  ownership boundary" without doc convergence). The ADR was revised as a provisional-debt
  template before the maintainer later selected the proper boundary.
- **Present C1–C5 as first-class alternatives.** Preferring census "only 6 tables" as an
  argument for pure B is weak: those tables include the product spine. Preferring pure A
  as the only alternative overstates cost.
- **Building C1 (or any C*) was the maintainer's Part B call.** #12 selected the full proper
  boundary; the active roadmap sequences C1–C5 rather than treating them as optional debt.

**AGENTS.md and ARCHITECTURE.md remain the binding target**; Part A is still only a fence on
current writers. Accepted decision record: [ADR 0007](adr/0007-schema-table-ownership.md).

### 6.3 Blocker 4 closure rule

The selected proper boundary closes blocker 4 only when
[§8](#8-definition-of-done-o1o6) is satisfied, every current grant/operator is removed, and the
binding architecture/status docs converge. ADR merge alone does **not** tick the blocker.
Provisional debt ratification is historical alternative analysis, not an open closure path.

---

## 7. Out of scope (with conditions)

| Item | Deferred? | Condition |
| --- | --- | --- |
| Full UnitOfWork + workflow adapters | No; active Part B work | Development roadmap Stages 3/6 |
| Progress read-model / History split | Yes | Part A will **not** catch Progress SELECTs of Training tables |
| Exercises content schema | Yes | Do not invent catalog tables in this arc |
| Data Portability export **shape** | No for newly persisted personal data | New tables enter export/deletion immediately; Stage 9 later replaces operator breadth with ports |
| DB role separation / RLS | Yes | Residual static-only limit |
| Implementing C1–C5 | No; selected | Active Part B endpoint; sequenced by the development roadmap |

---

## 8. Definition of done (O1–O6)

A green architecture test alone did **not** complete this arc. O1–O5 shipped in #9; O6 remains
open until the selected Part B boundary is implemented and status/docs converge. Blocker 4 closes
only then.

| ID | Claim | Proof |
| --- | --- | --- |
| **O1** | All 36 tables manifested bijectively | **Compile time:** `SqlTableName` is schema-derived and the manifest is `satisfies Record<SqlTableName, …>` + a bijection guard, so `tsc` fails on any add/rename/drop. Runtime test re-asserts set equality vs `pgTable` parse as belt-and-suspenders |
| **O2** | No undeclared write in perimeter | Live scan + synthetic unauthorized-write fixture |
| **O3** | Stale debt grants fail | Synthetic unused `additionalWriters` fixture + live stale check |
| **O4** | Only `data-portability` holds cross-cutting operator breadth; ops match matrix | Scan + fixture; includes `installation_state` UPDATE authorization |
| **O5** | Auth tables identity-owned; adapter registration = write authority; no second adapter | Adapter path assertion + owner seed; no local `.insert(session)` required for identity satisfaction |
| **O6** | Docs/status honest | Same change: this spec and ADRs reflect the selected proper boundary; AGENTS/ARCHITECTURE match executable public-port/read rules; `MVP_STATUS.md` closes known debt/blocker 4 only after every current grant/operator is removed |

Part A's `externalWriters` vocabulary attributes declared database triggers, but its TypeScript DML
scanner cannot discover trigger-function bodies. Before Stage 4 adds a second product trigger, the
Part B roadmap therefore requires a bidirectional migration-trigger **edge** census of the effective
post-ledger live graph. The test replays checked-in migrations in order into disposable PostgreSQL,
reads live `pg_trigger` plus `pg_get_functiondef`, and maps each object to its last effective source
migration; an equivalent ordered create/replace/drop resolver is acceptable only if catalog parity is
proved. Historical superseded function bodies and dropped triggers/functions remain migration history
but are not live edges. Every effective DML edge records trigger/function, last source migration,
firing source table/event and source owner, plus target table/op and target owner; every target has a
physical `db-trigger` attribution and every attribution resolves to a live edge. Fixtures replace a
function body and drop a trigger/function so stale historical DML can neither false-fail nor survive
the census. `db-trigger` is not neutral module authority. Cross-owner edges require explicit bounded
debt and a removal stage. The live Training `program_revision_invalidation` effect trigger's
Programs targets are therefore visible debt, and Stage 6 must replace them with Training/Programs
owner gateway calls and drop the effect trigger/function. Final Part B architecture proof rejects all
trigger-mediated cross-owner DML. This extension strengthens future O2/O5 coverage; it does not
retroactively overstate #9's recorded proof.

**Non-claims:** Part A does not advance J1–J6 product truth, does not implement UnitOfWork,
and does not close independent security/operator blocker 5.

### 8.1 Historical Part A implementation checklist

1. Land `ownership.ts` with the §4.2 seed (no invented primary owners).  
2. Land scanner + `schema-ownership.test.ts` meeting O1–O5 fixtures.  
3. Correct any residual doc drift; do **not** mark blocker 4 closed without Part B + O6.  
4. Reviewer questions for any new debt grant: Why not an owner API? New co-ownership
   cluster? Transaction boundary? DP deletion order? Sunset/removal plan?

---

## 9. Adversarial review disposition

Maintainer-verified findings from
[SCHEMA_OWNERSHIP_ADVERSARIAL_REVIEW.md](../reviews/SCHEMA_OWNERSHIP_ADVERSARIAL_REVIEW.md)
drive the Part A revision: Part A hardened as a write fence; ADR 0007 rejected terminal
provisional debt as the endpoint; C1–C5 were exposed separately; O1–O6 remained the arc DoD.
Subsequently #9 shipped O1–O5 and #12 selected the proper Part B boundary. Blocker 4 remains open
until implementation plus O6, not merely the decision.
