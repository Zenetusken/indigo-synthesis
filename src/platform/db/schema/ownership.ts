/**
 * Schema write-authority fence — Part A of production-release blocker 4.
 *
 * Maps every SQL table to the module(s) currently authorized to issue DML
 * against it. This is a DEBT FENCE over *current writers* and a migration
 * checklist — NOT a claim that write sites equal domain ownership. Domain
 * ownership (who owns the invariants and the public mutation API) may differ
 * from who currently issues DML; that is why residual co-writes carry
 * `debt: true`.
 *
 * Source of truth: docs/architecture/SCHEMA_OWNERSHIP_SPEC.md §4 (the seed).
 * Decision record: docs/architecture/adr/0007-schema-table-ownership.md
 * (status: proposed).
 *
 * Enforcement split:
 * - Compile time (O1, at `tsc`): `SqlTableName` is derived from the parsed
 *   `pgTable` schema, NOT from this file's own keys, so
 *   `satisfies Record<SqlTableName, …>` plus the bijection guard below fail the
 *   build if a table is added, renamed, or dropped without a matching manifest
 *   edit. This realizes spec §4.1's mapped-type contract.
 * - Runtime (O2–O5): the write census and authorization checks live in
 *   test/architecture/schema-ownership.test.ts (landed in #9), run by
 *   `pnpm test` / `pnpm validate` — so *authorization* is checked by the suite,
 *   not merely declared. (There is no in-repo CI pipeline; the check is the
 *   local / pre-merge suite.) *coverage* (O1) is additionally enforced here by
 *   the type system.
 *
 * Keys are SQL table names (the `pgTable` first argument), not Drizzle export
 * bindings.
 */

import type * as authSchema from './auth'
import type * as installationSchema from './installation'
import type * as productSchema from './product'

/**
 * SQL table names extracted from the live `pgTable` definitions at the type
 * level via Drizzle's branded `_.name`. Deriving this from the schema — rather
 * than from `keyof typeof tableWriteFence` — is what makes the manifest's
 * coverage bijective with reality at compile time (spec §4.1).
 */
type TableNamesOf<M> = {
  [K in keyof M]: M[K] extends { _: { name: infer N extends string } } ? N : never
}[keyof M]

export type SqlTableName =
  | TableNamesOf<typeof authSchema>
  | TableNamesOf<typeof installationSchema>
  | TableNamesOf<typeof productSchema>

/** Product module folder names under src/modules/. */
export type ModuleId =
  | 'athletes'
  | 'data-portability'
  | 'exercises'
  | 'identity'
  | 'methodology'
  | 'programs'
  | 'progress'
  | 'training'

/**
 * Principals that write schema tables but are not product modules. They may
 * appear only in `externalWriters` attribution, never as `owner` or in
 * `additionalWriters`.
 */
export type NonModulePrincipal =
  | 'platform'
  | 'app'
  | 'scripts'
  | 'db-trigger'
  | 'library-adapter'

export type WriteOp = 'insert' | 'update' | 'delete'

export type WriterGrant = {
  /** Module authorized to issue the listed ops in addition to the owner. */
  readonly module: ModuleId
  readonly ops: readonly WriteOp[]
  /** Non-empty rationale. Debt grants cite ADR 0007 / the spec. */
  readonly reason: string
  /** True when the grant is vertical-slice debt, not terminal co-ownership. */
  readonly debt?: boolean
}

/** Optional documentation of a table's mutation shape; not enforced in v1. */
export type Mutability =
  | 'append-only'
  | 'lifecycle-status'
  | 'mutable'
  | 'cache'
  | 'deletion-ledger'

/**
 * A non-module writer the static AST scan will not attribute (a library adapter
 * or DB trigger). `principal` is type-checked against NonModulePrincipal so the
 * O5 attribution vocabulary is enforced, not merely documented.
 */
export type ExternalWriter = {
  readonly principal: NonModulePrincipal
  readonly note: string
}

export type TableWriteFence = {
  /**
   * Seed primary writer — the migration-checklist default and review anchor.
   * Under the fence invariant `owner` and `additionalWriters` are the same
   * boolean grant; `owner` is documentation, not a superuser bit.
   */
  readonly owner: ModuleId
  /** Additional modules currently authorized to issue DML, each with a reason. */
  readonly additionalWriters?: readonly WriterGrant[]
  /** Optional mutation-shape annotation; unset in the v1 seed. */
  readonly mutability?: Mutability
  /** Non-module writers (adapters, triggers) — attribution for the O5 rules. */
  readonly externalWriters?: readonly ExternalWriter[]
}

/**
 * Verb-scoped cross-cutting operator. Data Portability's whole-schema breadth
 * is an operator grant (current-implementation debt vs the port-based target),
 * not domain ownership of the tables it touches.
 */
export type CrossCuttingOperator = {
  readonly module: 'data-portability'
  readonly reason: string
  readonly allow: {
    /** Export projection reads across the schema. */
    readonly read: '*'
    /** Ordered deletion of personal/product rows across the schema. */
    readonly delete: '*'
    /** Non-owned tables it may UPDATE (owned tables use their owner grant). */
    readonly update: readonly SqlTableName[]
    /** Non-owned tables it may INSERT (owned tables use their owner grant). */
    readonly insert: readonly SqlTableName[]
  }
}

const BETTER_AUTH_ADAPTER: ExternalWriter = {
  principal: 'library-adapter',
  note:
    'Better Auth drizzleAdapter — configured only in src/modules/identity; ' +
    'adapter registration is identity write authority (O5).',
}

const PROGRAMS_TRAINING_CLUSTER =
  'Programs/Training cluster: Training writes program-graph rows on session ' +
  'completion, then activates via the Programs API. Gateway-target debt ' +
  '(ADR 0007; spec C1) — fenced against growth, not blessed.'

const AUDIT_APPEND =
  'Cross-cutting append-only audit log; each module emits its own events. ' +
  'Debt until a single audit append port (ADR 0007; spec C2).'

/**
 * Write-authority fence for all product schema tables, grouped by owner.
 * `as const satisfies Record<SqlTableName, …>` enforces bijection with the live
 * schema at compile time (see the guard below).
 */
export const tableWriteFence = {
  // --- identity (auth + installation + audit primary) ---
  user: { owner: 'identity', externalWriters: [BETTER_AUTH_ADAPTER] },
  session: {
    owner: 'identity',
    // Identity recovery also deletes sessions directly — that is an owner path,
    // not an external writer.
    externalWriters: [BETTER_AUTH_ADAPTER],
  },
  account: { owner: 'identity', externalWriters: [BETTER_AUTH_ADAPTER] },
  verification: { owner: 'identity', externalWriters: [BETTER_AUTH_ADAPTER] },
  destructive_reauthentication_state: { owner: 'identity' },
  member_reset_state: { owner: 'identity' },
  // Drizzle insert/update on the bucket plus a raw-SQL DELETE cleanup path, both
  // by identity (owner) — the raw DELETE is why the scanner must read raw SQL,
  // not just Drizzle calls.
  web_recovery_rate_limit_bucket: { owner: 'identity' },
  installation_state: {
    owner: 'identity',
    // Data Portability UPDATEs this on instance reset via the cross-cutting
    // operator grant below, not as an additionalWriter.
    externalWriters: [
      {
        principal: 'db-trigger',
        note: 'owner bootstrap seeds the initial row on authorized user insert',
      },
    ],
  },
  audit_event: {
    owner: 'identity',
    mutability: 'append-only',
    additionalWriters: [
      { module: 'athletes', ops: ['insert'], reason: AUDIT_APPEND, debt: true },
      { module: 'programs', ops: ['insert'], reason: AUDIT_APPEND, debt: true },
      { module: 'training', ops: ['insert'], reason: AUDIT_APPEND, debt: true },
    ],
  },

  // --- athletes (profile aggregate + shared hold) ---
  athlete_profile: { owner: 'athletes' },
  athlete_training_day: { owner: 'athletes' },
  athlete_equipment: { owner: 'athletes' },
  strength_baseline: { owner: 'athletes' },
  safety_hold: {
    owner: 'athletes',
    mutability: 'lifecycle-status',
    // Data Portability also deletes rows here via the operator grant (delete
    // '*'), so it is not listed as an additionalWriter.
    additionalWriters: [
      {
        module: 'training',
        ops: ['insert'],
        reason:
          'Training raises a session-pain hold during workout logging; ' +
          'eligibility-clear holds remain athletes. Debt until an athletes ' +
          'safety-hold API (ADR 0007; spec C3).',
        debt: true,
      },
    ],
  },

  // --- programs (aggregate + Programs/Training cluster) ---
  program: { owner: 'programs' },
  content_release_revocation: { owner: 'programs' },
  program_revision: {
    owner: 'programs',
    additionalWriters: [
      {
        module: 'training',
        ops: ['insert'],
        reason: PROGRAMS_TRAINING_CLUSTER,
        debt: true,
      },
    ],
  },
  planned_workout: {
    owner: 'programs',
    additionalWriters: [
      {
        module: 'training',
        ops: ['insert'],
        reason: PROGRAMS_TRAINING_CLUSTER,
        debt: true,
      },
    ],
  },
  exercise_prescription: {
    owner: 'programs',
    additionalWriters: [
      {
        module: 'training',
        ops: ['insert'],
        reason: PROGRAMS_TRAINING_CLUSTER,
        debt: true,
      },
    ],
  },
  set_prescription: {
    owner: 'programs',
    additionalWriters: [
      {
        module: 'training',
        ops: ['insert'],
        reason: PROGRAMS_TRAINING_CLUSTER,
        debt: true,
      },
    ],
  },

  // --- training (14 single-writer tables) ---
  safety_hold_resolution: { owner: 'training', mutability: 'lifecycle-status' },
  workout_session: { owner: 'training' },
  session_exercise: { owner: 'training' },
  performed_set: { owner: 'training' },
  session_feedback: { owner: 'training' },
  program_revision_lineage: { owner: 'training', mutability: 'append-only' },
  training_command_receipt: { owner: 'training', mutability: 'append-only' },
  adjustment_decision: { owner: 'training' },
  training_fact_correction: { owner: 'training', mutability: 'append-only' },
  session_feedback_correction: { owner: 'training', mutability: 'append-only' },
  performed_set_correction: { owner: 'training', mutability: 'append-only' },
  adjustment_decision_invalidation: { owner: 'training', mutability: 'append-only' },
  program_revision_invalidation: { owner: 'training', mutability: 'append-only' },
  future_load_explanation_cache: { owner: 'training', mutability: 'cache' },

  // --- data-portability (owns its own ledger tables) ---
  deletion_plan: { owner: 'data-portability', mutability: 'deletion-ledger' },
  deletion_tombstone: { owner: 'data-portability', mutability: 'deletion-ledger' },
} as const satisfies Record<SqlTableName, TableWriteFence>

/**
 * Compile-time bijection guard (belt-and-suspenders around the `satisfies`
 * above, and the check that catches a `SqlTableName` collapsing to `never` —
 * which would make the `Record<>` constraint pass vacuously). Both aliases must
 * be `never`; a table added, renamed, or dropped without a matching manifest
 * edit makes one of them non-`never` and fails this assignment.
 */
type SchemaTableMissingFromManifest = Exclude<SqlTableName, keyof typeof tableWriteFence>
type ManifestKeyNotInSchema = Exclude<keyof typeof tableWriteFence, SqlTableName>
const _assertBijection: [SchemaTableMissingFromManifest, ManifestKeyNotInSchema] extends [
  never,
  never,
]
  ? true
  : never = true

export const crossCuttingOperator = {
  module: 'data-portability',
  reason:
    'Data Portability is the single cross-cutting lifecycle operator in the ' +
    'current implementation (tracked debt vs the ARCHITECTURE port-based ' +
    'target). It reads broadly for export and deletes personal/product rows in ' +
    'one ordered transaction. This breadth is an operator grant, not domain ' +
    'ownership; no other module may hold it (ADR 0007; spec C4).',
  allow: {
    read: '*',
    delete: '*',
    // installation_state is identity-owned, so DP's instance-reset UPDATE needs
    // an explicit operator grant. DP-owned tables (deletion_plan,
    // deletion_tombstone) are authorized by their owner grants, not here
    // (spec §5.3(7)), so they are intentionally absent.
    update: ['installation_state'],
    // DP performs no non-owned INSERTs; its own ledger inserts are owner grants.
    insert: [],
  },
} as const satisfies CrossCuttingOperator

/**
 * Modules that intentionally write zero tables in the current slice —
 * `exercises` (content schema not yet built), `methodology` (pure domain
 * engine), and `progress` (read-model not yet built). They never appear above;
 * that absence is itself an enforceable fact. `satisfies readonly ModuleId[]`
 * keeps the list honest against the module union.
 */
export const NON_WRITING_MODULES = [
  'exercises',
  'methodology',
  'progress',
] as const satisfies readonly ModuleId[]
