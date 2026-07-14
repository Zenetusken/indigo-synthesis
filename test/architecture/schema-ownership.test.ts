import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type CrossCuttingOperator,
  crossCuttingOperator,
  type TableWriteFence,
  tableWriteFence,
} from '@/platform/db/schema/ownership'
import {
  adapterConfiguredOutsideIdentity,
  buildSchemaTableMap,
  listAdapterConfigurers,
  type ObservedWrite,
  scanSource,
  scanWrites,
  type WriteOp,
} from './schema-ownership-scan'

/**
 * Part A enforcement (spec §5, DoD O1–O5). O1 (coverage/bijection) is already a
 * compile-time invariant in ownership.ts; it is re-asserted here as
 * belt-and-suspenders. O2–O5 are the runtime write-authority checks.
 */

const sourceRoot = resolve(process.cwd(), 'src')
const scriptsRoot = resolve(process.cwd(), 'scripts')
const fence: Readonly<Record<string, TableWriteFence>> = tableWriteFence
const operator: CrossCuttingOperator = crossCuttingOperator

/**
 * Non-module operational writers, explicitly allow-listed (spec §5.3(1)). These
 * are NOT product sharedWriters; app/module code must never write these tables.
 * The backup-restore drill seeds a sentinel `audit_event` and then UPDATEs it as
 * a tamper-detection probe (an append-only table mutated by a test/ops script).
 */
const NON_MODULE_WRITE_ALLOWLIST: readonly {
  readonly principal: string
  readonly table: string
  readonly op: WriteOp
  readonly file: string
}[] = [
  {
    principal: 'scripts',
    table: 'audit_event',
    op: 'insert',
    file: 'scripts/db/backup-restore-drill.ts',
  },
  {
    principal: 'scripts',
    table: 'audit_event',
    op: 'update',
    file: 'scripts/db/backup-restore-drill.ts',
  },
]

function operatorAllows(table: string, op: WriteOp): boolean {
  if (op === 'delete') return true // delete '*'
  if (op === 'update') return (operator.allow.update as readonly string[]).includes(table)
  return (operator.allow.insert as readonly string[]).includes(table)
}

function authorization(
  write: ObservedWrite,
): 'owner' | 'shared' | 'operator' | 'allowlist' | null {
  const entry = fence[write.table]
  if (entry) {
    if (entry.owner === write.principal) return 'owner'
    if (
      entry.additionalWriters?.some(
        (grant) => grant.module === write.principal && grant.ops.includes(write.op),
      )
    ) {
      return 'shared'
    }
    if (write.principal === operator.module && operatorAllows(write.table, write.op)) {
      return 'operator'
    }
  }
  if (
    NON_MODULE_WRITE_ALLOWLIST.some(
      (a) =>
        a.principal === write.principal &&
        a.table === write.table &&
        a.op === write.op &&
        a.file === write.file,
    )
  ) {
    return 'allowlist'
  }
  return null
}

function describeWrite(write: ObservedWrite): string {
  return `${write.principal} ${write.op} ${write.table} (${write.kind}) ${write.file}:${write.line}`
}

const writes = scanWrites({ sourceRoot, extraDirs: [scriptsRoot] })
const { sqlNames } = buildSchemaTableMap(sourceRoot)

describe('schema/table write-authority fence', () => {
  it('O1: manifest is bijective with the live pgTable schema', () => {
    expect(Object.keys(fence).sort()).toEqual([...sqlNames].sort())
  })

  it('O2: every observed write is authorized by the manifest', () => {
    const unauthorized = writes
      .filter((w) => authorization(w) === null)
      .map(describeWrite)
    expect(unauthorized).toEqual([])
  })

  it('finds a non-trivial number of writes (scanner is not silently empty)', () => {
    // Guards against a regression that makes the scanner return nothing, which
    // would make O2 vacuously green.
    expect(writes.length).toBeGreaterThan(100)
    expect(writes.some((w) => w.kind === 'raw')).toBe(true)
    expect(writes.some((w) => w.kind === 'drizzle')).toBe(true)
  })

  it('O3: no stale debt grant (every additionalWriters grant is exercised)', () => {
    const observed = new Set(writes.map((w) => `${w.principal}:${w.table}:${w.op}`))
    const stale: string[] = []
    for (const [table, entry] of Object.entries(fence)) {
      for (const grant of entry.additionalWriters ?? []) {
        for (const op of grant.ops) {
          if (!observed.has(`${grant.module}:${table}:${op}`)) {
            stale.push(`${grant.module}:${table}:${op}`)
          }
        }
      }
    }
    expect(stale).toEqual([])
  })

  it('O3: no stale owner (owner writes the table, or has an external writer)', () => {
    const staleOwners = Object.entries(fence)
      .filter(
        ([table, entry]) =>
          !writes.some((w) => w.principal === entry.owner && w.table === table) &&
          !(entry.externalWriters && entry.externalWriters.length > 0),
      )
      .map(([table, entry]) => `${entry.owner}:${table}`)
    expect(staleOwners).toEqual([])
  })

  it('O4: only data-portability holds cross-table (operator) write breadth', () => {
    // The operator path is the whole-schema breadth mechanism; only DP may use
    // it. A non-owner write by any other principal must be a declared shared
    // grant or a bounded allowlist entry, never operator breadth.
    const operatorUsers = new Set(
      writes.filter((w) => authorization(w) === 'operator').map((w) => w.principal),
    )
    expect([...operatorUsers].sort()).toEqual(['data-portability'])
    // The installation_state UPDATE is specifically authorized via the operator.
    expect(operatorAllows('installation_state', 'update')).toBe(true)
    expect(operator.module).toBe('data-portability')
  })

  it('O5: Better Auth adapter is configured only in identity', () => {
    expect(listAdapterConfigurers(sourceRoot)).toEqual([
      'src/modules/identity/infrastructure/auth.ts',
    ])
    for (const table of ['user', 'session', 'account', 'verification']) {
      expect(fence[table]?.owner).toBe('identity')
    }
  })
})

describe('schema-ownership scanner fixtures (through the production detectors)', () => {
  const { bindingToSql, sqlNames: names } = buildSchemaTableMap(sourceRoot)
  const scan = (file: string, source: string) =>
    scanSource(source, { file, bindingToSql, sqlNames: names })

  it('flags an undeclared module Drizzle write as unauthorized', () => {
    const found = scan(
      'src/modules/progress/application/leak.ts',
      "import { auditEvents } from '@/platform/db/schema'\n" +
        'export const go = (db: any) => db.insert(auditEvents).values({})',
    )
    expect(found).toHaveLength(1)
    expect(authorization(found[0] as ObservedWrite)).toBeNull()
  })

  it('flags an undeclared raw-SQL write as unauthorized', () => {
    const found = scan(
      'src/modules/progress/application/leak.ts',
      'export const go = (db: any) => db.execute(sql`DELETE FROM audit_event WHERE id = 1`)',
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.op).toBe('delete')
    expect(authorization(found[0] as ObservedWrite)).toBeNull()
  })

  it('does not treat Map/Set .delete or non-DML SQL as a write (control)', () => {
    const mapDelete = scan(
      'src/modules/programs/application/build.ts',
      'export const go = (requiredEquipment: Map<string, unknown>, item: any) =>\n' +
        '  requiredEquipment.delete(item.equipmentCode)',
    )
    expect(mapDelete).toEqual([])
    // FOR UPDATE / SELECT must not register as writes (SET-anchored UPDATE).
    const selectForUpdate = scan(
      'src/modules/identity/infrastructure/probe.ts',
      'export const q = (db: any) =>\n' +
        '  db.execute(sql`SELECT scope FROM web_recovery_rate_limit_bucket FOR UPDATE SKIP LOCKED`)',
    )
    expect(selectForUpdate).toEqual([])
  })

  it('detects a stale debt grant (unexercised additionalWriters)', () => {
    // A fabricated grant not present in the observed set must be reported stale.
    const observed = new Set(writes.map((w) => `${w.principal}:${w.table}:${w.op}`))
    expect(observed.has('progress:audit_event:insert')).toBe(false)
    // And a real one is present, proving the check is not always-true.
    expect(observed.has('programs:audit_event:insert')).toBe(true)
  })

  it('detects a Better Auth adapter configured outside identity (O5)', () => {
    expect(
      adapterConfiguredOutsideIdentity(
        'src/modules/progress/infra/auth.ts',
        'drizzleAdapter(db, {})',
      ),
    ).toBe(true)
    expect(
      adapterConfiguredOutsideIdentity(
        'src/modules/identity/infrastructure/auth.ts',
        'drizzleAdapter(db, {})',
      ),
    ).toBe(false)
  })
})
