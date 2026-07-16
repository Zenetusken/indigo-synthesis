import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type CrossCuttingOperator,
  crossCuttingOperator,
  NON_WRITING_MODULES,
  PRODUCT_MODULES,
  type TableWriteFence,
  tableWriteFence,
} from '@/platform/db/schema/ownership'
import {
  buildSchemaTableMap,
  listAdapterConfigurers,
  type ObservedWrite,
  scanSource,
  scanWrites,
  type WriteOp,
} from './schema-ownership-scan'

/** Live O1-O5 authorization gate; focused scanner grammars have separate tests. */

const sourceRoot = resolve(process.cwd(), 'src')
const scriptsRoot = resolve(process.cwd(), 'scripts')
const fence: Readonly<Record<string, TableWriteFence>> = tableWriteFence
const operator: CrossCuttingOperator = crossCuttingOperator

/**
 * File-scoped operational exceptions are not product shared-writer grants.
 * The backup drill deliberately inserts and then attempts to tamper with its
 * sentinel audit row to prove the append-only trigger survives restoration.
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
  if (op === 'delete') {
    return (operator.allow.delete as readonly string[]).includes(table)
  }
  if (op === 'update') {
    return (operator.allow.update as readonly string[]).includes(table)
  }
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
      (allowed) =>
        allowed.principal === write.principal &&
        allowed.table === write.table &&
        allowed.op === write.op &&
        allowed.file === write.file,
    )
  ) {
    return 'allowlist'
  }
  return null
}

function describeWrite(write: ObservedWrite): string {
  return `${write.principal} ${write.op} ${write.table} (${write.kind}) ${write.file}:${write.line}`
}

function staleAdditionalWriterGrants(
  manifest: Readonly<Record<string, TableWriteFence>>,
  observedWrites: readonly ObservedWrite[],
): string[] {
  const observed = new Set(
    observedWrites
      .filter((write) => write.evidence === 'executable')
      .map((write) => `${write.principal}:${write.table}:${write.op}`),
  )
  const stale: string[] = []
  for (const [table, entry] of Object.entries(manifest)) {
    for (const grant of entry.additionalWriters ?? []) {
      for (const op of grant.ops) {
        if (!observed.has(`${grant.module}:${table}:${op}`)) {
          stale.push(`${grant.module}:${table}:${op}`)
        }
      }
    }
  }
  return stale
}

const writes = scanWrites({ sourceRoot, extraDirs: [scriptsRoot] })
const { sqlNames } = buildSchemaTableMap(sourceRoot)

describe('schema/table write-authority fence', () => {
  it('O1: manifest is bijective with the closed pgTable catalog', () => {
    expect(Object.keys(fence).sort()).toEqual([...sqlNames].sort())
  })

  it('O1: manifest grants and external-writer metadata stay exact and reviewable', () => {
    for (const [table, entry] of Object.entries(fence)) {
      const additionalWriters = entry.additionalWriters ?? []
      const externalWriters = entry.externalWriters ?? []
      if (entry.additionalWriters) expect(additionalWriters.length).toBeGreaterThan(0)
      if (entry.externalWriters) expect(externalWriters.length).toBeGreaterThan(0)

      expect(additionalWriters.map((grant) => grant.module)).toEqual([
        ...new Set(additionalWriters.map((grant) => grant.module)),
      ])
      for (const grant of additionalWriters) {
        expect(grant.module, table).not.toBe(entry.owner)
        expect(grant.reason.trim(), `${table}:${grant.module}`).not.toBe('')
        expect(grant.debt, `${table}:${grant.module}`).toBe(true)
        expect(grant.ops.length, `${table}:${grant.module}`).toBeGreaterThan(0)
        expect(grant.ops, `${table}:${grant.module}`).toEqual([...new Set(grant.ops)])
      }

      expect(externalWriters.map((writer) => writer.principal)).toEqual([
        ...new Set(externalWriters.map((writer) => writer.principal)),
      ])
      for (const writer of externalWriters) {
        expect(writer.note.trim(), `${table}:${writer.principal}`).not.toBe('')
      }
    }
    expect(operator.reason.trim()).not.toBe('')
  })

  it('O1: zero-write module metadata matches both declared and executable authority', () => {
    const declaredWriters = new Set([
      operator.module,
      ...Object.values(fence).flatMap((entry) => [
        entry.owner,
        ...(entry.additionalWriters ?? []).map((grant) => grant.module),
      ]),
    ])
    const executableWriters = new Set(
      writes
        .filter(
          (write) =>
            write.evidence === 'executable' &&
            (PRODUCT_MODULES as readonly string[]).includes(write.principal),
        )
        .map((write) => write.principal),
    )
    const undeclared = PRODUCT_MODULES.filter((module) => !declaredWriters.has(module))
    const unobserved = PRODUCT_MODULES.filter((module) => !executableWriters.has(module))

    expect(PRODUCT_MODULES).toEqual([...new Set(PRODUCT_MODULES)])
    expect(NON_WRITING_MODULES).toEqual(undeclared)
    expect(NON_WRITING_MODULES).toEqual(unobserved)
  })

  it('O2: every observed write is authorized by the manifest', () => {
    expect(
      writes.filter((write) => authorization(write) === null).map(describeWrite),
    ).toEqual([])
  })

  it('O2: catalogued schema files remain inside the DML and raw-SQL perimeter', () => {
    const options = {
      file: 'src/platform/db/schema/auth.ts',
      bindingToSql: new Map([['user', 'user']]),
      sqlNames: new Set(['user']),
    } as const
    const drizzleSideEffect = scanSource(
      "import { pgTable } from 'drizzle-orm/pg-core'\n" +
        "export const user = pgTable('user', {})\n" +
        'declare const rogueDb: any\nvoid rogueDb.delete(user)',
      options,
    )
    const rawSideEffect = scanSource(
      "import { sql } from 'drizzle-orm'\n" +
        'declare const rogueDb: any\nrogueDb.execute(sql`DELETE FROM user`)',
      options,
    )

    expect(
      drizzleSideEffect.map(({ evidence, kind, op, principal, table }) => ({
        evidence,
        kind,
        op,
        principal,
        table,
      })),
    ).toEqual([
      {
        evidence: 'executable',
        kind: 'drizzle',
        op: 'delete',
        principal: 'platform',
        table: 'user',
      },
    ])
    expect(
      rawSideEffect.map(({ evidence, kind, op, principal, table }) => ({
        evidence,
        kind,
        op,
        principal,
        table,
      })),
    ).toEqual([
      {
        evidence: 'executable',
        kind: 'raw',
        op: 'delete',
        principal: 'platform',
        table: 'user',
      },
    ])
  })

  it('O2: authorization matches the exact principal, table, operation, and file', () => {
    const write = (
      principal: string,
      table: string,
      op: WriteOp,
      file = `src/modules/${principal}/probe.ts`,
    ): ObservedWrite => ({
      evidence: 'executable',
      principal,
      table,
      op,
      kind: 'drizzle',
      file,
      line: 1,
    })

    expect(authorization(write('athletes', 'athlete_profile', 'update'))).toBe('owner')
    expect(authorization(write('training', 'safety_hold', 'insert'))).toBe('shared')
    expect(authorization(write('training', 'safety_hold', 'update'))).toBeNull()
    expect(authorization(write('data-portability', 'installation_state', 'update'))).toBe(
      'operator',
    )
    expect(
      authorization(write('data-portability', 'installation_state', 'insert')),
    ).toBeNull()
    expect(
      authorization(
        write('scripts', 'audit_event', 'insert', 'scripts/db/backup-restore-drill.ts'),
      ),
    ).toBe('allowlist')
    expect(
      authorization(write('scripts', 'audit_event', 'insert', 'scripts/db/other.ts')),
    ).toBeNull()
    expect(authorization(write('rogue', 'athlete_profile', 'update'))).toBeNull()
    expect(authorization(write('athletes', 'unknown_table', 'update'))).toBeNull()
  })

  it('O2: the non-module exception surface is exactly the backup-drill proof', () => {
    expect(NON_MODULE_WRITE_ALLOWLIST).toEqual([
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
    ])
    expect(
      new Set(
        NON_MODULE_WRITE_ALLOWLIST.map(
          ({ principal, table, op, file }) => `${principal}:${table}:${op}:${file}`,
        ),
      ).size,
    ).toBe(NON_MODULE_WRITE_ALLOWLIST.length)
  })

  it('keeps the census non-vacuous across both detectors', () => {
    expect(writes.length).toBeGreaterThan(100)
    expect(writes.some((write) => write.kind === 'raw')).toBe(true)
    expect(writes.some((write) => write.kind === 'drizzle')).toBe(true)
  })

  it('O3: every additional-writer operation grant is exercised', () => {
    expect(staleAdditionalWriterGrants(fence, writes)).toEqual([])
  })

  it('O3: a missing operation observation makes an additional-writer grant stale', () => {
    const syntheticFence: Readonly<Record<string, TableWriteFence>> = {
      example_table: {
        owner: 'identity',
        additionalWriters: [
          {
            module: 'training',
            ops: ['insert', 'update'],
            reason: 'Synthetic exact-operation coverage probe.',
            debt: true,
          },
        ],
      },
    }
    const observedInsert: ObservedWrite = {
      evidence: 'executable',
      principal: 'training',
      table: 'example_table',
      op: 'insert',
      kind: 'drizzle',
      file: 'src/modules/training/probe.ts',
      line: 1,
    }

    expect(staleAdditionalWriterGrants(syntheticFence, [observedInsert])).toEqual([
      'training:example_table:update',
    ])
  })

  it('O3: potential raw SQL stays in the census without satisfying liveness', () => {
    const syntheticFence: Readonly<Record<string, TableWriteFence>> = {
      example_table: {
        owner: 'identity',
        additionalWriters: [
          {
            module: 'training',
            ops: ['delete'],
            reason: 'Synthetic executable-evidence coverage probe.',
            debt: true,
          },
        ],
      },
    }
    const options = {
      file: 'src/modules/training/sql-probe.ts',
      bindingToSql: new Map<string, string>(),
      sqlNames: new Set(['example_table']),
    } as const
    const potential = scanSource(
      "import { sql } from 'drizzle-orm'\n" +
        'const unused = sql`DELETE FROM example_table`\nvoid unused',
      options,
    )
    const executable = scanSource(
      "import { sql } from 'drizzle-orm'\n" +
        'db.execute(sql`DELETE FROM example_table`)',
      options,
    )

    expect(potential.map(({ evidence }) => evidence)).toEqual(['potential'])
    expect(staleAdditionalWriterGrants(syntheticFence, potential)).toEqual([
      'training:example_table:delete',
    ])
    expect(executable.map(({ evidence }) => evidence)).toEqual(['executable'])
    expect(staleAdditionalWriterGrants(syntheticFence, executable)).toEqual([])
  })

  it('O3: every owner writes or has an attributed external writer', () => {
    expect(
      Object.entries(fence)
        .filter(
          ([table, entry]) =>
            !writes.some(
              (write) =>
                write.evidence === 'executable' &&
                write.principal === entry.owner &&
                write.table === table,
            ) && !(entry.externalWriters && entry.externalWriters.length > 0),
        )
        .map(([table, entry]) => `${entry.owner}:${table}`),
    ).toEqual([])
  })

  it('O4: only data-portability exercises operator breadth', () => {
    expect(
      [
        ...new Set(
          writes
            .filter((write) => authorization(write) === 'operator')
            .map((write) => write.principal),
        ),
      ].sort(),
    ).toEqual(['data-portability'])
    expect(operatorAllows('installation_state', 'update')).toBe(true)
    expect(operator.module).toBe('data-portability')
  })

  it('O5: Better Auth Drizzle adapters stay inside Identity', () => {
    expect(listAdapterConfigurers(sourceRoot)).toEqual([
      'src/modules/identity/infrastructure/auth.ts',
      'src/modules/identity/infrastructure/scoped-mutation-auth.ts',
    ])
    for (const table of ['user', 'session', 'account', 'verification']) {
      const entry = fence[table]
      expect(entry?.owner).toBe('identity')
      expect(entry?.externalWriters?.map((writer) => writer.principal)).toEqual([
        'library-adapter',
      ])
      expect(entry?.externalWriters?.[0]?.note).toContain('Better Auth drizzleAdapter')
    }
  }, 15_000)
})
