# Schema/table write-fence enforcement (arc spec)

Status: **Part A implemented and shipped (#9); Part B implementation active** — retained as the
write-fence contract, measured census, and historical decision pack. #12 selected the proper
boundary; the live working branch has reached the Stage 3 UnitOfWork/Identity/Data Portability
coordination cutovers, while the cumulative Stage 3 gate and Stages 4–9 remain open. The active
sequence is [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md).
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
- **Part B (selected and in progress):** the maintainer chose the proper structural
  boundary—public module ports, a shared UnitOfWork, and removal of current debt/operator
  breadth—rather than provisional debt ratification. Stage 3 has introduced the neutral
  transaction substrate and scoped temporary Data Portability adapters; it has not yet removed the
  manifest grants/operator or completed the public owner-port/read-boundary endpoint. See
  [§6](#6-part-b--decision-provenance-and-disposition) and accepted
  [ADR 0007](adr/0007-schema-table-ownership.md).

Every quantitative claim below is grounded in a measured census of the live tree (and
independently re-verified during adversarial review), not intent.

**What this arc does not claim**

- Part A itself did **not** change product journeys (J1–J6), implement UnitOfWork, or extract
  Progress. The later Part B branch now contains the Stage 3 UnitOfWork substrate.
- Part A did **not** close blocker 4 on merge — see [§8](#8-definition-of-done-o1o6).
- Part A does **not** enforce read boundaries, public application APIs, or domain aggregate
  ownership. Those remain the AGENTS.md / ARCHITECTURE.md target until Part B changes them.

---

## 1. What the architecture docs already claim

`MVP_STATUS.md` records the gap: the architecture suite proves the module graph is acyclic
and enforces several import/runtime dependency rules plus current write authority, but does not yet
require all cross-module work to use public gateways or reject peer-table reads. Under **Known
architecture debt** it lists (among other items) that Programs and Training currently
coordinate through direct Drizzle over the shared schema. Data Portability now enters its
destructive and subject-export work through Stage 3 scoped UnitOfWork adapters, but those adapters
still perform the broad projection/ordered DML behind temporary operator authority **while public
per-module export/deletion ports are absent**. Those are tracked migration steps, not evidence that
the final documented boundaries already exist.

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
- Matching `*.test.*` / `*.spec.*` JavaScript/TypeScript files are excluded across the scanner's
  eight production extension families.
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

A single checked-in manifest (`src/platform/db/schema/ownership.ts`) maps every SQL
table to write grants. Naming in prose and the live comments/types is **write fence** / **current
writers**; the short `ownership.ts` path does not reclassify the manifest as domain ownership.

### 4.1 TypeScript contract (normative)

```ts
/** Exact folder names under src/modules/. */
export const PRODUCT_MODULES = [
  'athletes',
  'data-portability',
  'exercises',
  'identity',
  'methodology',
  'programs',
  'progress',
  'training',
] as const

export type ModuleId = (typeof PRODUCT_MODULES)[number]

/** Non-module principals that may appear only in externalWriters. */
export type NonModulePrincipal = 'platform' | 'app' | 'scripts' | 'db-trigger' | 'library-adapter'

export type WriteOp = 'insert' | 'update' | 'delete'

export type WriterGrant = {
  readonly module: ModuleId
  readonly ops: readonly WriteOp[]
  /** Non-empty. Debt grants cite ADR/spec; do not use empty strings. */
  readonly reason: string
  /** Required marker: every cross-module grant is temporary vertical-slice debt. */
  readonly debt: true
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
    readonly delete: readonly SqlTableName[] // exact temporary non-owned adapter surface
    readonly update: readonly SqlTableName[] // non-owned tables only
    readonly insert: readonly SqlTableName[] // non-owned tables only
  }
}

/** Exact modules with neither declared nor executable write authority. */
export const NON_WRITING_MODULES = [
  'exercises',
  'methodology',
  'progress',
] as const satisfies readonly ModuleId[]
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
The runtime metadata gate enforces a unique `PRODUCT_MODULES` set, mandatory `debt: true` on every
additional writer, non-empty/unique grant shapes, and non-blank reasons/notes. It also proves
`NON_WRITING_MODULES` equals both (a) the product modules absent from all declared owner,
additional-writer, and operator authority and (b) the product modules absent from the executable
live write census. Whether a debt reason cites the right ADR/spec and explains the boundary remains
a review rule, not a string-pattern assertion.

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
| `delete` | Exact lexical union of the temporary scoped destructive adapter's non-owned DELETE targets (33 tables; enforced against `src/modules/data-portability/infrastructure/destructive-adapter-manifest.ts`) |
| `update` | `installation_state` (instance reset reopen) — **non-owned only** |
| `insert` | — (none; DP's `deletion_plan` / `deletion_tombstone` inserts are its **owner** grants, not operator breadth) |

The operator arrays list **only non-owned** tables. DP-owned tables (`deletion_plan`,
`deletion_tombstone`) are authorized through their owner grant per §5.3(8), so listing them
here would be a redundant second authority that could mask a removed owner grant — they are
intentionally excluded. No other module may hold whole-schema read or cross-cutting delete breadth.

### 4.3 What the seed means under selected Part B

The seed encodes **current measured reality**. Under selected Option A / C1–C5 it is the
migration checklist: debt grants shrink to zero and the operator is removed. Provisional ADR
ratification remains historical option analysis only. Encoding today's writers is not the same as
permanently blessing them as domain co-owners — debt flags and Part B exist for that distinction.

---

## 5. Part A — enforcement invariant and scanner contract

### 5.1 Invariant

**Write-fence invariant:** *No production principal issues DML against a table unless
authorized by that table's owner grant, an `additionalWriters` grant matching the operation,
the exact `crossCuttingOperator` operation matrix, or the two file-scoped backup-drill
exceptions.* A declared `externalWriters` entry does not authorize an observed AST write; it
attributes a non-AST library/trigger writer and currently satisfies the owner's liveness check by
declaration. O5 separately pins Better Auth's adapter configurers; the bidirectional live-trigger
census required later in this spec remains open for `db-trigger` declarations.

The live proof fails on a closed-catalog violation; schema/manifest coverage or grant-metadata
drift; an observed write outside those grants; a stale `additionalWriters` operation; an owner with
neither an observed write nor an attributed external writer; Better Auth adapter capability outside
Identity; a third non-module exception; or drift between the temporary Data Portability adapter and
any operator mutation grant. Unsupported static table/provider/capability flows in the enumerated
grammar fail closed before authorization. The `mutability` annotations remain descriptive here:
PostgreSQL triggers, not this scanner, enforce append-only/immutability behavior.

This invariant is a **subset** of AGENTS/ARCHITECTURE (writes plus the schema capability needed to
attribute those writes). It does not generally forbid peer-table `.select`; the final public/private
import and read boundary remains Part B work. The Stage 3 UnitOfWork and scoped-adapter guards are
separate architecture contracts and do not make O1–O5 a read fence.

### 5.2 Test location and integration

- `test/architecture/schema-ownership.test.ts` is the live O1–O5 authorization gate. It remains
  additive to `boundaries.test.ts`, the import-graph gates, and the Stage 3 adapter contracts.
- `test/architecture/schema-ownership-scan.ts` is its public scanner facade. The proof is split
  into `schema-ownership/catalog.ts`, `local-flow.ts`, and `sql.ts`, with focused
  `catalog.test.ts`, `local-flow.test.ts`, `sql.test.ts`, and `facade.test.ts` mutant/positive
  suites.
- `test/architecture/data-portability-destructive-adapter.test.ts` separately proves the exact
  temporary adapter DML manifest and its equality to the corresponding
  `crossCuttingOperator.allow` mutation arrays.
- The files match the existing `test/architecture/**/*.test.ts` Vitest inventory and run under
  `pnpm test` / `pnpm validate`. These static gates require no database; disposable-PostgreSQL
  transaction/trigger proofs remain integration tests.

### 5.3 Scanner contract (normative)

**1. Closed schema catalog and binding map**

`buildSchemaTableMap` first validates the complete source inventory. The directory
`src/platform/db/schema/` contains exactly the three table files `auth.ts`, `installation.ts`,
and `product.ts`, plus the auxiliary `index.ts` and `ownership.ts`; any extra file, directory,
symlink-like non-regular entry, or missing file fails. A table file may acquire
`drizzle-orm/pg-core` at runtime only through a static named import from that exact root. Runtime
imports are pinned to `boolean`, `check`, `date`, `foreignKey`, `index`, `integer`, `jsonb`,
`pgTable`, `primaryKey`, `smallint`, `text`, `timestamp`, `uniqueIndex`, and `uuid`; type-only
additions remain allowed. Default/namespace/side-effect imports, runtime re-exports, import-equals,
CommonJS/dynamic/subpath loads, and alternate factory imports such as `pgTableCreator` fail.

Every exported variable in the three table files must be a direct top-level
`export const binding = pgTable('literal_sql_name', ...)`; wrapped/rebound/nested/non-exported
factory calls, indirect exports, other exported values, duplicate bindings, and duplicate SQL
names fail. `index.ts` must contain exactly one runtime `export *` for each table file and nothing
else. Both auxiliary files reject every runtime `pg-core` acquisition, including aliased loader
paths, while allowing type-only references.

That closed grammar produces both the Drizzle binding → SQL-name map and the SQL-name set. The
catalogued schema files remain inside the production DML perimeter: their declaration-oriented
storage/export checks are relaxed, but direct Drizzle and raw-SQL side effects are still scanned,
attributed to `platform`, and authorized like every other observation. An exported catalog table
therefore cannot hide either behind an unparsed declaration shape or beside an uncounted schema-file
side effect.

**2. Production perimeter and principal attribution**

The scanner reads all conventional production JavaScript/TypeScript module extensions under
`src/**` and the supplied `scripts/**` root: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`,
and `.cts`. Matching `*.test.*` / `*.spec.*` files are excluded, and `test/**` is outside the
scanned roots. Attribution is path-derived:

| Path | Scanner principal | Grant policy |
| --- | --- | --- |
| `src/modules/<module>/**` | exact first folder under `modules` | Must be a live `ModuleId` grant/operator |
| `src/app/**` | `app` | No product-table grant |
| `src/application/**` | `application` | No product-table grant |
| `src/platform/**` | `platform` | No observed product-table DML grant |
| `scripts/**` | `scripts` | Only the two exact backup-drill exceptions below |
| Other files below a scanned root, including `src/composition/**` and `src/components/**` | `other` | No product-table grant |

The scanner-attribution vocabulary is intentionally wider than `NonModulePrincipal`:
`application` and `other` make otherwise unclassified writes fail, but cannot appear in
`externalWriters`. The only file-scoped non-module authorization is
`scripts/db/backup-restore-drill.ts` for `audit_event` INSERT plus its deliberate UPDATE tamper
probe. Neither exception changes ownership or grants product code append-only rewrite authority.

Across that full perimeter, runtime `drizzle-orm/pg-core` acquisition is permitted only in the
three catalogued table files under the stricter builder-import grammar above and in the exact static
named `PgDialect` import in `src/platform/db/preflight.ts`. A second preflight binding, a subpath,
or any other runtime import/export/import-equals/CommonJS/dynamic/forwarded-loader acquisition fails;
type-only references and inert strings do not create runtime authority. Module providers are
resolved through immutable static concatenation/template/conditional/logical alternatives, so a
split `drizzle-orm/` + `pg-core` path cannot bypass the acquisition gate.

**3. Closed local schema-capability flow**

Runtime schema tables enter scanned code only through static ESM imports. `@/platform/db/schema`,
schema subpaths, backslash-normalized paths, and relative specifiers resolved from the importing
file all share the same provenance. Named aliases, namespace static members, immutable `const`
alias chains, and closed conditional/logical alternatives are resolved; an unknown named binding or
namespace member fails instead of disappearing from the census. Type-only schema imports and
references do not create runtime capability evidence. Default schema imports, dynamic namespace
members, CommonJS/import-equals/dynamic-import schema loads, and forwarded loader forms fail when
any statically known branch reaches the schema path.

The local-flow proof deliberately closes the general Node loader factory: any runtime import,
export, import-equals, `require`/dynamic import, or ambient `process.getBuiltinModule` acquisition
of `module` or `node:module` fails, even before a schema target is visible. This covers named/
namespace/default/`Module`/CommonJS/dynamic `createRequire`, unbound `require`,
`global[This].require`, `[globalThis.]module.require`, immutable aliases, sequence/conditional/
logical loader callees, and bind/call/apply/Reflect forwarding. Closed local calls are followed
when they return a static path, return a loader, or forward a path parameter into a loader;
destructured/defaulted parameters, explicit ambient `undefined` / `void 0`, static spreads,
pre-bound arguments, overload implementations, and compatible `var` redeclarations retain their
effective runtime semantics. A non-undefined explicit argument suppresses its default.
Exported/cross-file wrappers, arbitrary helper or
constructor arguments, method/accessor/class/object/array/property storage, destructuring, and
return/yield/throw/JSX transport of a recovered loader fail closed. Type-only Node module
imports/exports/import-equals and genuinely runtime-shadowed `require`/`module`/`process`/global
names are controls. TypeScript module blocks retain lexical and `var` scope, while erased ambient
`declare` bindings do not counterfeit a runtime shadow.

Table/column capabilities cannot cross an unreviewed local seam: mutable/destructured/container or
class storage, assignment, helper/constructor/JSX arguments, return/yield/throw, export/re-export,
computed table/namespace access, and escaped/computed write methods fail closed. The reviewed
exceptions are deliberately structural:

- immutable direct table aliases and direct `insert` / `update` / `delete` targets;
- trusted Drizzle select/join/lock, projection/returning, `getTableColumns`, and conflict-target
  shapes rooted in an imported/transaction-derived database type;
- unmodified global `Map` / `Set` / `Headers` deletion and imported Node crypto hash/HMAC update
  controls (mutation/shadowing removes the exemption);
- the exact frozen four-key `identityAuthDatabaseSchema` object in
  `src/modules/identity/infrastructure/identity-auth-config.ts`; and
- the exact `drizzle(this.#ordinaryPool, { schema })` namespace registration in
  `src/platform/db/database-runtime.ts`, with `drizzle` proven as a runtime import from
  `drizzle-orm/node-postgres`.

**4. Drizzle write attribution**

A direct property call to `insert`, `update`, or `delete` is DML only when its first argument
resolves through the closed flow to a schema table. Chained builders are retained, and
`onConflictDoUpdate` attributes UPDATE to the recovered insert target in addition to the INSERT.
Column `.table` back-references are recovered only when attribution is static. Non-table arguments,
schema columns used in expressions/projections, and vetted collection/hash controls do not become
writes; an unresolved recovered target fails rather than disappearing from the census. Static
schema-table interpolation in raw INSERT/UPDATE/DELETE/MERGE/TRUNCATE/COPY target position,
including a schema-qualified target, is rejected here before the SQL text scanner. The same rule
composes statically attested `sql.raw(...)` fragments before a later table interpolation;
capability interpolation into an arbitrary non-Drizzle tag is classified as an unreviewed helper
argument.

**5. Closed raw-SQL provider and sink grammar**

The SQL scanner recognizes direct `.execute`, `.query`, and `.queryArray` sinks; imported
Drizzle `sql` tags/`sql.raw` (plus the unbound `sql` fixture identifier); destructured/aliased/
bound/forwarded sink calls; and sink parameters propagated through a local callable. Sequence
expressions are resolved by their evaluated operand, so direct or locally retained sequence/bound
sink calls are executable evidence. Transporting a recognized sink through an otherwise arbitrary
local or imported helper remains **potential** evidence rather than claiming that the helper
executes it.

Every direct/aliased/call/apply/bind `.raw` call is conservatively a static provider and therefore
**potential**, regardless of receiver spelling; it becomes executable only when that provider
reaches a recognized `execute` / `query` / `queryArray` sink. This avoids both receiver-name
heuristics and an O3 false-green from an unused or unrelated `.raw` method.

Static providers may be string/no-substitution/template literals, immutable lexical `const`
bindings, closed concatenations and conditional/logical alternatives (maximum 32 values),
one-property `{ text }` query configs, or direct local function-declaration calls whose every return
is statically closed. Mutable/destructured/composed providers and unresolved sink providers fail.
Sink capabilities are tracked through lexical aliases/reassignment, helper returns, closed object
properties and computed keys, and call/bind/apply/Reflect forwarding. Property-aware destructuring
assignment is retained; TypeScript module blocks and class static blocks retain their lexical/`var`
scope. `Object.assign`, class fields/constructors, arrays/`Array.at`, Set/Map and other mutable/
dynamic containers, and exports fail when they carry a sink, while analogous non-sink values remain
valid controls. Arbitrary tagged-template interpolation, method/accessor/class returns,
generator/yield/throw, constructor/helper transport, and JSX attributes likewise cannot carry a
sink capability outside the closed grammar.

Every recognized Drizzle `sql` tagged template first contributes `potential` evidence; reaching a
recognized direct or indirect sink upgrades the same evidence to `executable`. This is a syntactic
sink-reach classification, not control-flow-graph reachability: a sink present in a statically dead
branch is still classified executable. O2 authorizes both potential and executable observations,
so unused mutation text cannot hide an undeclared authority. O3 liveness and stale-grant checks use
only executable evidence, so an unused tag or arbitrary-helper transport cannot manufacture a live
writer.

Executable PostgreSQL text is normalized without treating comments, string literals, dollar-quoted
bodies, or non-executable prose as DML. INSERT/UPDATE/DELETE accept simple quoted or unquoted names,
an optional schema qualifier/`ONLY`, aliases, multiline text, and `ON CONFLICT DO UPDATE` (attributed
to the corresponding insert target). A simple `U&"name"` is normalized, while an identifier that
contains Unicode escapes or an explicit `UESCAPE` clause fails. MERGE, TRUNCATE (including multiple
targets), and COPY FROM against a catalogued table fail as unsupported mutation forms instead of
being ignored.

**6. Exact opaque runtime-SQL seams**

Opaque provider values are admitted only at six direct pass-through contracts and one tracked
Reflect call:

| File | Exact seam |
| --- | --- |
| `src/platform/application-coordination/postgres-unit-of-work.ts` | top-level `queryWithGuard`: its two `client.query` shapes |
| `src/platform/application-coordination/prelocked-session.ts` | top-level `guardedPrelockQuery`: its two `client.query` shapes |
| `src/platform/application-coordination/scoped-drizzle.ts` | top-level `dispatchDrizzleQuery`: exactly `scoped.query` and `scoped.queryArray` |
| `src/platform/db/disposable-integration-database.ts` | `defaultClientFactory`'s `query` property arrow over a runtime-imported `pg.Client` |
| `src/platform/db/external-host-one-shot.ts` | `runExternalHostClientOwner`'s `query` method over a runtime-imported `pg.Client` |
| `src/platform/db/preflight.ts` | top-level `execute`: `query.query(compiled.sql, compiled.params)` from immutable top-level runtime-imported `PgDialect` compilation |
| `src/platform/application-coordination/postgres-unit-of-work.ts` | one `TransactionQueryTracker.#executeQuery` `Reflect.apply(this.#client.query, this.#client, queryArgs)` |

For each exception, file path, lexical function stack, complete call-shape multiset/cardinality,
provider and receiver binding kinds/owners, defaults, mutation absence, and parameter-reference use
are pinned. Direct and interprocedural assignments/property writes, container storage, return/
alias/export escape, helper/constructor calls, and helper-return/Reflect forwarding are treated as
mutation or escape unless the argument position is one of a closed set of proven read-only
built-ins/calls; an arbitrary helper therefore cannot launder `compiled`, `client`, or `queryArgs`.
The scoped-Drizzle descriptor and tracked Reflect materializer additionally pin each complete
top-level helper declaration by SHA-256:

- `exactDataDescriptor` → `77eae4d3e5231b2019445b52246f5fdfd160aeff98707d3c170843337385bf40`;
- `materializedQueryConfig` → `e808871390391eec752f171325fafda2252c743ec3e41bf6a22d54956d2a829e`; and
- `materializeQueryArgs` → `d58c0c19c8a79ecd3ea8b5d5434d9a65e459a1336f0ab9574c5d8565e4104a96`.

The hash is over the full declaration's trivia-free token stream, including its name, parameters,
types, body, and exact string/regex/template token contents. Formatting trivia cannot churn the
attestation, while whitespace inside a literal remains semantic and changes the hash. A helper
redefinition/rebinding/declaration change, receiver/provider mutation,
extra opaque call, wrong import provenance, or use of an opaque parameter outside its accepted
calls removes the exception and yields an unresolved-provider failure.

**7. Better Auth adapter authority (O5)**

Within the bounded static grammar below, any runtime capability import/export/load of the exact
`better-auth/adapters/drizzle` root or subpath counts as adapter configuration; prefixed/lookalike
packages do not, and even an empty named runtime import **or empty named runtime re-export** counts.
A local call merely named `drizzleAdapter` is not enough. The static loader grammar covers runtime
ESM import/re-export,
import-equals, dynamic import, direct/aliased/ambient-global/`module.require` require, and
`createRequire` obtained through named/namespace/default/`Module` ESM imports, CommonJS/dynamic
module objects, or ambient `process.getBuiltinModule`. Declaration and assignment destructuring,
bounded object/array/class/property storage, statically known concatenation/template/conditional/
logical path branches, sequence/conditional/logical loader callees, exact pre-bound/spread
arguments, and call/bind/apply/Reflect forwarding are followed. Bounded local helpers (at most eight
hops) are evaluated at the exact forwarded parameter position and when they return a static path or
loader. A default parameter is effective when its argument is omitted or explicitly `undefined`;
any other explicit argument overrides that default exactly. Resolution preserves TypeScript
module-block lexical/`var` scope: real runtime shadows and unrelated same-named path bindings do not
confer authority, while erased ambient `declare` bindings cannot hide a loader that executes at
runtime. Type-only adapter and Node-loader imports/exports/import-equals are ignored. The live
configurer set is pinned exactly to:

- `src/modules/identity/infrastructure/auth.ts`; and
- `src/modules/identity/infrastructure/scoped-mutation-auth.ts`.

Both must remain under Identity. Each of the four auth tables (`user`, `session`, `account`,
`verification`) must remain Identity-owned and have exactly one `externalWriters` principal,
`library-adapter`, whose note identifies `Better Auth drizzleAdapter`. The exact frozen four-key
schema registration described in item 3 prevents the adapter schema object itself from becoming a
general table-capability container.

**8. Authorization, operator, and stale-grant policy**

Observed writes are authorized op-by-op as owner, `additionalWriters`, operator, or exact file
exception. Data Portability non-owned DML is authorized only through the exact
`crossCuttingOperator.allow` arrays; its owned `deletion_plan`/`deletion_tombstone` writes remain
ordinary owner writes. The temporary destructive-adapter architecture test derives every method's
SELECT/INSERT/UPDATE/DELETE surface, checks it against the lexical adapter manifest, and proves the
operator INSERT, UPDATE, and DELETE arrays each equal the corresponding non-owned union.

Manifest metadata is also executable: `PRODUCT_MODULES` is unique; present writer arrays are
non-empty; additional-writer modules and external-writer principals are unique per table; an owner
cannot repeat as an additional writer; every additional grant has `debt: true`; operation lists are
non-empty and duplicate-free; and grant reasons, external notes, and the operator reason are
non-blank. `NON_WRITING_MODULES` must equal both the modules with no declared authority and the
modules with no executable write evidence. The non-module exception list is independently pinned to
the two exact backup-drill tuples and checked for duplicates.

Every `additionalWriters` operation must have at least one matching **executable** live observation.
Every owner must have matching executable write evidence or at least one declared external writer;
there is no dormant owner/mutability exemption. Potential raw evidence still passes through O2
authorization but cannot satisfy either O3 check. Better Auth attribution therefore satisfies
Identity owner liveness for adapter-managed auth tables. `externalWriters` is not itself a scanned
DML grant, and the static scanner does not derive database-trigger bodies.

**9. Actual diagnostics**

- Closed-catalog failures throw `SchemaCatalogError` with deterministic prose and source locations
  for AST-node violations; inventory-level diagnostics do not have a node location, and none of
  these failures currently has a machine-readable code.
- Local-flow failures throw `SchemaLocalFlowError` with file, line, and one of
  `destructured-table-storage`, `exported-schema-table`, `helper-table-argument`,
  `helper-table-return`, `method-capability-escape`, `mutable-table-storage`,
  `object-or-array-table-storage`, `raw-table-interpolation`, `unresolved-schema-load`,
  `unresolved-computed-method`, `unresolved-namespace-member`, or `unresolved-table-member`.
- SQL failures throw `SqlScanError` with `ownership.sql.identifier-unsupported`,
  `ownership.sql.provider-unresolved`, or `ownership.sql.mutation-unsupported`.
- The live authorization/stale/adapter assertions report normalized principal/table/op/file data
  where applicable through Vitest; they do not emit the earlier aspirational
  `ownership.write.*` codes.

Catalog validation precedes per-file local-flow and SQL scanning. Cross-file authorization and O1–O5
assertions then run as Vitest tests; no stronger global failure ordering is promised.

**10. Retained proof fixtures**

The focused tests retain positive and adversarial cases for the fixed catalog inventory/direct
factory grammar/index/duplicates and pinned `pg-core` builder/acquisition surface; all eight
production extension families including schema-file DML; relative and aliased schema imports;
direct/upsert writes; type-only controls; storage/helper/export/dynamic-member/raw-interpolation
escapes; Better Auth loader/re-export/default-override shapes and outside-Identity classification;
static raw providers, sequence/bound/helper sink transport, potential/executable classification,
sink alias/reassignment/storage/export paths, SQL lexical forms, and unsupported mutation verbs;
every live opaque seam plus file/declaration/import/binding/cardinality mutants; and the live O1–O5
census. The live gate also pins manifest metadata, zero-write equivalence, exact O5 attribution, and
the two exact non-module exceptions; retains synthetic O2 cases that vary principal, table,
operation, and file across owner/shared/operator/allowlist decisions; and proves O3 ignores
potential evidence and requires each granted operation independently. The Data Portability adapter
test adds exact manifest-to-code and all-mutation-grant equality.

**11. Residual non-goals (static-only fence)**

The proof is a TypeScript-AST/static-string analyzer, not a TypeScript type checker or a database
policy. FK CASCADE, database-role separation/RLS, and trigger-function DML are outside its census;
`externalWriters` declares those authorities rather than discovering them. Truly runtime-built
module specifiers or table identifiers with no closed static value remain residual, as does opaque
SQL admitted through the seven exact pass-through seams beyond what their separate caller/shape
contracts prove. PostgreSQL triggers remain the authority for append-only/immutability behavior,
and the Part B migration-trigger census/final cross-owner-edge rejection in §8 remains required.

---

## 6. Part B — decision provenance and disposition

This section preserves the alternatives that were presented before the maintainer decision.
Part B's endpoint is resolved and implementation is underway: build the proper boundary through
the accepted calibration/UnitOfWork arc, then remove the current grants/operator and complete O6.
The options below remain historical decision provenance, not open implementation forks.

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
| Full UnitOfWork + workflow adapters | No; active Part B work | Stage 3 substrate and scoped temporary Data Portability adapters are present; owner ports continue in Stages 6/9 |
| Progress read-model / History split | Yes | Part A will **not** catch Progress SELECTs of Training tables |
| Exercises content schema | Yes | Do not invent catalog tables in this arc |
| Data Portability export **shape** | No for newly persisted personal data | New tables enter export/deletion immediately; Stage 9 later replaces operator breadth with ports |
| DB role separation / RLS | Yes | Residual static-only limit |
| Implementing C1–C5 | No; selected | Active Part B endpoint; sequenced by the development roadmap |

---

## 8. Definition of done (O1–O6)

A green architecture test alone did **not** complete this arc. O1–O5 shipped in #9 and remain live;
the Stage 3 scanner/catalog hardening strengthens their static proof but does not reclassify O6.
O6 remains open until the selected Part B boundary is implemented and status/docs converge.
Blocker 4 closes only then.

| ID | Claim | Proof |
| --- | --- | --- |
| **O1** | All 36 tables manifested bijectively; module/debt metadata is exact | **Compile time:** schema-derived `SqlTableName`, `satisfies Record<SqlTableName, …>`, the non-vacuous bijection guard, runtime `PRODUCT_MODULES`-derived `ModuleId`, and required `debt: true`. **Runtime:** the closed five-file catalog and pinned `pg-core` grammar plus set equality against parsed `pgTable` declarations; grant metadata and both declared/executable `NON_WRITING_MODULES` complements |
| **O2** | No undeclared statically attributable DML in the production perimeter | Both closed scanners over every JavaScript/TypeScript source extension plus scripts, including direct/raw DML in schema files; live op-aware authorization of all potential and executable evidence; global schema/`pg-core` capability fence; focused local-flow/raw-SQL/provider/sink/opaque-seam mutants; synthetic exact-authority cases vary principal, table, operation, and file across owner/shared/operator/allowlist outcomes |
| **O3** | Stale additional-writer operations and owner-without-writer attribution fail | Executable-only live census assertions: every `additionalWriters` module/table/op tuple is sink-reached, and every owner has executable evidence or a declared external writer. Synthetic cases prove one observed operation does not satisfy another and potential-only SQL does not satisfy either liveness rule |
| **O4** | Only `data-portability` exercises cross-cutting operator breadth; every temporary destructive mutation grant is exact | Live authorization pins the operator module; the destructive-adapter contract derives per-method DML, matches the lexical manifest, and equates each operator INSERT/UPDATE/DELETE list to its non-owned union (`[]`, `['installation_state']`, and the 33-table DELETE list respectively). DP-owned ledger writes remain owner grants |
| **O5** | Auth tables are Identity-owned; adapter capability = exact attributed write authority; no second adapter | Scope-aware static loader grammar pins the exact two Identity configurers; the exact frozen four-table registration; and, on every auth table, exactly one `library-adapter` external principal with a `Better Auth drizzleAdapter` note, satisfying adapter-managed owner paths without requiring a local `.insert(session)` |
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

**Non-claims:** Part A itself did not advance J1–J6 product truth or implement UnitOfWork; the
later Stage 3 substrate does not convert this write fence into the final Part B boundary. Neither
closes independent security/operator blocker 5.

### 8.1 Historical Part A implementation checklist

1. Land `ownership.ts` with the §4.2 seed (no invented primary owners).  
2. Land the scanner suite + `schema-ownership.test.ts` meeting O1–O5.
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
until implementation plus O6, not merely the decision. The live Stage 3 hardening subsequently
closed the scanner's catalog, schema-capability, raw-SQL provider/sink, and opaque-seam grammars;
those stronger O1–O5 proofs do not close O6 or erase the remaining Part B migration work.
