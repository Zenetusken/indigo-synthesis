import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { detectLocalDrizzleWrites, SchemaLocalFlowError } from './local-flow'

const bindingToSql = new Map([
  ['account', 'account'],
  ['auditEvents', 'audit_event'],
  ['safetyHolds', 'safety_hold'],
  ['session', 'session'],
  ['user', 'user'],
  ['verification', 'verification'],
])

function sourceFile(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function scan(source: string, file = 'src/modules/progress/local-flow.ts') {
  const ast = sourceFile(file, source)
  return detectLocalDrizzleWrites(ast, file, 'progress', bindingToSql)
}

function diagnostic(
  source: string,
  file = 'src/modules/progress/local-flow.ts',
): SchemaLocalFlowError {
  try {
    scan(source, file)
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaLocalFlowError)
    return error as SchemaLocalFlowError
  }
  throw new Error('Expected the local-flow scanner to reject the fixture.')
}

describe('schema ownership compact local flow - accepted writes', () => {
  it('resolves named aliases, namespaces, const chains, and compact alternatives', () => {
    const writes = scan(`
      import { auditEvents as audit, safetyHolds } from '@/platform/db/schema'
      import * as schema from '@/platform/db/schema'
      export function go(db: any, choose: boolean) {
        const first = audit
        const second = first
        db.insert(second)
        db.update(choose ? safetyHolds : schema.auditEvents)
        db.delete(choose && audit)
      }
    `)

    expect(writes.map(({ op, table }) => `${op}:${table}`).sort()).toEqual([
      'delete:audit_event',
      'insert:audit_event',
      'update:audit_event',
      'update:safety_hold',
    ])
  })

  it('resolves schema imports relative to the importing source file', () => {
    const writes = scan(
      "import { user } from './schema'\nexport const go = (db: any) => db.delete(user)",
      'src/platform/db/probe.ts',
    )

    expect(writes.map(({ op, table }) => `${op}:${table}`)).toEqual(['delete:user'])
  })

  it('attributes both insert and update for an upsert chain', () => {
    const writes = scan(`
      import { auditEvents } from '@/platform/db/schema'
      export const go = (db: any) => db
        .insert(auditEvents)
        .values({})
        .onConflictDoUpdate({ target: auditEvents.id, set: {} })
    `)

    expect(writes.map(({ op, table }) => `${op}:${table}`).sort()).toEqual([
      'insert:audit_event',
      'update:audit_event',
    ])
  })
})

describe('schema ownership compact local flow - approved controls', () => {
  it('allows select roots, table columns, vetted imports, globals, and non-table args', () => {
    expect(() =>
      scan(`
        import { eq, getTableColumns as columns } from 'drizzle-orm'
        import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
        import { createHash as hash } from 'node:crypto'
        import { auditEvents, safetyHolds } from '@/platform/db/schema'
        export function go(db: NodePgDatabase) {
          db.select({ id: auditEvents.id })
            .from(auditEvents)
            .leftJoin(safetyHolds, eq(safetyHolds.id, auditEvents.id))
            .for('update', { of: auditEvents })
          db.select({ record: auditEvents }).from(auditEvents)
          columns(auditEvents)
          new Map().delete(auditEvents)
          const seen = new Set()
          seen.delete(safetyHolds)
          new Headers().delete('x-test')
          hash('sha256').update(auditEvents)
          db.delete('not-a-table')
        }
      `),
    ).not.toThrow()
    expect(
      diagnostic(`
        import { auditEvents } from '@/platform/db/schema'
        export const go = (db: any) => db
          .select()
          .from(auditEvents)
          .for('update', { of: auditEvents, noWait: true })
      `).code,
    ).toBe('object-or-array-table-storage')
  })

  it('allows only the exact O5 Better Auth schema registration', () => {
    const file = 'src/modules/identity/infrastructure/identity-auth-config.ts'
    const fixture = `
      import { account, session, user, verification } from '@/platform/db/schema'
      export const identityAuthDatabaseSchema = Object.freeze({
        user,
        session,
        account,
        verification,
      })
    `
    expect(() => scan(fixture, file)).not.toThrow()
    expect(
      diagnostic(fixture.replace('verification,', 'verification, extra: user,'), file)
        .code,
    ).toBe('object-or-array-table-storage')
    expect(diagnostic(fixture, 'src/modules/identity/infrastructure/other.ts').code).toBe(
      'object-or-array-table-storage',
    )
  })

  it('keeps aliased collection and hash controls out of the write census', () => {
    const writes = scan(`
      import { createHash } from 'node:crypto'
      import { auditEvents } from '@/platform/db/schema'
      export function go() {
        const first = new Map()
        const second = first
        second.delete(auditEvents)
        const hash = createHash('sha256')
        const hashAlias = hash
        hashAlias.update(auditEvents)
      }
    `)

    expect(writes).toEqual([])
  })
})

describe('schema ownership compact local flow - rejected storage', () => {
  const schemaImport = "import { auditEvents } from '@/platform/db/schema'\n"

  it.each([
    ['mutable-table-storage', 'let table = auditEvents'],
    ['mutable-table-storage', 'let table; table ||= auditEvents'],
    ['object-or-array-table-storage', 'const tables = [auditEvents]'],
    ['object-or-array-table-storage', 'holder.table = auditEvents'],
    ['object-or-array-table-storage', 'holder.table ??= auditEvents'],
    ['object-or-array-table-storage', 'class Tables { static audit = auditEvents }'],
    [
      'object-or-array-table-storage',
      'export class Tables { static audit = auditEvents }',
    ],
    [
      'object-or-array-table-storage',
      'export const Tables = class { static audit = auditEvents }',
    ],
    ['destructured-table-storage', 'const { id } = auditEvents'],
    ['helper-table-return', 'function leak() { return auditEvents }'],
    ['helper-table-return', 'async function leak() { return await auditEvents }'],
    ['helper-table-return', 'function* leak() { yield auditEvents }'],
    ['helper-table-return', 'function leak() { throw auditEvents }'],
    ['helper-table-return', 'const leak = () => auditEvents'],
    ['helper-table-argument', 'function leak(table = auditEvents) { return table }'],
    ['helper-table-argument', 'helper(auditEvents)'],
    ['helper-table-argument', 'new Helper(auditEvents)'],
    ['exported-schema-table', 'export const leaked = auditEvents'],
    ['exported-schema-table', 'export const leaked = (0, auditEvents)'],
  ] as const)('rejects %s', (code, fixture) => {
    expect(diagnostic(schemaImport + fixture).code).toBe(code)
  })

  it('rejects schema-table back-references reached through columns', () => {
    expect(
      scan(
        `${schemaImport}export const go = (db: any) => db.delete(auditEvents.id.table)`,
      ).map(({ op, table }) => `${op}:${table}`),
    ).toEqual(['delete:audit_event'])
    expect(
      scan(
        `${schemaImport}const column = auditEvents.id\nexport const go = (db: any) => db.delete(column.table)`,
      ).map(({ op, table }) => `${op}:${table}`),
    ).toEqual(['delete:audit_event'])
  })

  it('rejects statically imported tables interpolated into raw SQL', () => {
    expect(
      diagnostic(
        `${schemaImport}export const go = (db: any) => db.execute(sql\`DELETE FROM \${auditEvents}\`)`,
      ).code,
    ).toBe('raw-table-interpolation')
    for (const statement of [
      'DELETE FROM public.',
      'INSERT INTO public.',
      'UPDATE public.',
      'MERGE INTO public.',
      'TRUNCATE TABLE public.',
      'COPY public.',
    ]) {
      expect(
        diagnostic(
          `${schemaImport}export const go = (db: any) => db.execute(sql\`${statement}\${auditEvents}\`)`,
        ).code,
        statement,
      ).toBe('raw-table-interpolation')
    }
    expect(() =>
      scan(
        `import { sql } from 'drizzle-orm'\n${schemaImport}export const go = (db: any) => db.execute(sql\`DELETE FROM audit_event WHERE id = \${auditEvents.id}\`)`,
      ),
    ).not.toThrow()
  })

  it('rejects dynamic access to table and column capabilities', () => {
    expect(
      diagnostic(
        `${schemaImport}export const go = (db: any, key: string) => db.delete(auditEvents[key])`,
      ).code,
    ).toBe('unresolved-table-member')
    expect(
      diagnostic(
        `${schemaImport}const column = auditEvents.id\nexport const go = (db: any, key: string) => db.delete(column[key])`,
      ).code,
    ).toBe('unresolved-table-member')
  })

  it.each([
    'const { x = auditEvents } = {} as any',
    'const [x = auditEvents] = [] as any',
    'function leak({ x = auditEvents } = {} as any) { return x }',
    'export const { x = auditEvents } = {} as any',
  ])('rejects schema capabilities in binding defaults: %s', (fixture) => {
    expect(diagnostic(schemaImport + fixture).code).toBe('destructured-table-storage')
  })

  it('fails closed on unresolved column table back-references used as DML targets', () => {
    expect(
      diagnostic(`${schemaImport}
        function kill(db: any, column: any) { db.delete(column.table) }
        kill(db, auditEvents.id)
      `).code,
    ).toBe('unresolved-table-member')
    expect(
      diagnostic(`${schemaImport}
        import { getTableColumns } from 'drizzle-orm'
        const columns = getTableColumns(auditEvents)
        db.delete(columns.id.table)
      `).code,
    ).toBe('unresolved-table-member')
  })

  it('does not trust locally constructed read-builder lookalikes', () => {
    expect(
      diagnostic(`${schemaImport}
        const sink = {
          select() { return sink },
          from(table: any) { db.delete(table); return sink },
        }
        sink.select().from(auditEvents)
      `).code,
    ).toBe('helper-table-argument')
    expect(
      diagnostic(`${schemaImport}
        const sink = { select(_projection: any) { return sink } }
        sink.select({ record: auditEvents })
      `).code,
    ).toBe('object-or-array-table-storage')
    expect(
      diagnostic(`${schemaImport}
        function run(sink: any) { sink.select().from(auditEvents) }
        run({
          select() { return this },
          from(table: any) { db.delete(table); return this },
        })
      `).code,
    ).toBe('helper-table-argument')
    expect(
      diagnostic(`${schemaImport}
        function run(sink: any) { sink.select().for('update', { of: auditEvents }) }
        run({ select() { return this }, for(_mode: any, value: any) { db.delete(value.of) } })
      `).code,
    ).toBe('object-or-array-table-storage')
    expect(
      diagnostic(`${schemaImport}
        const sink = { returning(value: any) { db.delete(value.record) } }
        sink.returning({ record: auditEvents })
      `).code,
    ).toBe('object-or-array-table-storage')
  })

  it.each([
    'DatabaseTransaction',
    'NodePgDatabase',
    'RateLimitDatabase',
  ])('does not trust a locally spoofed %s type name', (typeName) => {
    expect(
      diagnostic(`${schemaImport}
          type ${typeName} = { select(): { from(table: unknown): unknown } }
          function run(sink: ${typeName}) { sink.select().from(auditEvents) }
          run({ select() { return { from(table: unknown) { return db.delete(table) } } } })
        `).code,
    ).toBe('helper-table-argument')
  })

  it('does not exempt reassigned collection and hash methods', () => {
    const writes = scan(`${schemaImport}
      import { createHash } from 'node:crypto'
      export function go(db: any) {
        const map = new Map()
        map.delete = (table: any) => { db.delete(table); return true }
        map.delete(auditEvents)
        const hash = createHash('sha256')
        hash.update = (table: any) => db.update(table)
        hash.update(auditEvents)
      }
    `)

    expect(writes.map(({ op, table }) => `${op}:${table}`).sort()).toEqual([
      'delete:audit_event',
      'update:audit_event',
    ])
  })

  it('does not confuse function-scoped or duplicate Map bindings with the global', () => {
    const nested = scan(`${schemaImport}
      export function go(db: any) {
        if (true) {
          var Map = class {
            delete(table: any) { db.delete(table); return true }
          }
        }
        new Map().delete(auditEvents)
      }
    `)
    const duplicate = scan(`${schemaImport}
      export function go(db: any) {
        var Map = class {
          delete(table: any) { db.delete(table); return true }
        }
        var Map
        new Map().delete(auditEvents)
      }
    `)

    expect(nested.map(({ op, table }) => `${op}:${table}`)).toEqual([
      'delete:audit_event',
    ])
    expect(duplicate.map(({ op, table }) => `${op}:${table}`)).toEqual([
      'delete:audit_event',
    ])
  })

  it('propagates collection/hash mutation across aliases and global prototypes', () => {
    const writes = scan(`${schemaImport}
      import { createHash } from 'node:crypto'
      export function go(db: any) {
        const map = new Map()
        const mapAlias = map
        mapAlias.delete = (table: any) => { db.delete(table); return true }
        map.delete(auditEvents)
        const hash = createHash('sha256')
        const hashAlias = hash
        hashAlias.update = (table: any) => db.update(table)
        hash.update(auditEvents)
        Map.prototype.delete = function (table: any) { db.delete(table); return true }
        new Map().delete(auditEvents)
      }
    `)

    expect(writes.map(({ op, table }) => `${op}:${table}`).sort()).toEqual([
      'delete:audit_event',
      'delete:audit_event',
      'update:audit_event',
    ])
  })
})

describe('schema ownership compact local flow - rejected capabilities', () => {
  const schemaImport = "import { auditEvents } from '@/platform/db/schema'\n"

  it.each([
    ['unresolved-computed-method', 'db[method](auditEvents)'],
    ['method-capability-escape', 'const remove = db.delete; remove(auditEvents)'],
    ['method-capability-escape', 'const { delete: remove } = db; remove(auditEvents)'],
    ['method-capability-escape', 'db.delete.bind(db)(auditEvents)'],
    ['method-capability-escape', 'Reflect.apply(db.delete, db, [auditEvents])'],
  ] as const)('rejects %s', (code, fixture) => {
    expect(
      diagnostic(
        `${schemaImport}export function go(db: any, method: string) { ${fixture} }`,
      ).code,
    ).toBe(code)
  })

  it('rejects dynamic schema namespace members', () => {
    expect(
      diagnostic(`
        import * as schema from '@/platform/db/schema'
        export const go = (db: any, name: string) => db.insert(schema[name])
      `).code,
    ).toBe('unresolved-namespace-member')
  })

  it('fails closed on schema bindings absent from the closed table catalog', () => {
    expect(
      diagnostic(`
        import { futureTable } from '@/platform/db/schema'
        export const go = (db: any) => db.delete(futureTable)
      `).code,
    ).toBe('unresolved-table-member')
    expect(
      diagnostic(`
        import * as schema from '@/platform/db/schema'
        export const go = (db: any) => db.delete(schema.futureTable)
      `).code,
    ).toBe('unresolved-namespace-member')
  })

  it.each([
    "const schema = require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const { auditEvents } = require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(auditEvents)",
    "const load = require\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const load = (0, require)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const schema = (0, require)('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const load = enabled ? require : localLoad\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const load = enabled && require\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "export const go = async (db: any) => { const schema = await import('@/platform/db/schema'); db.delete(schema.auditEvents) }",
    "const path = '@/platform/db/' + 'schema'\nexport const go = async (db: any) => { const schema = await import(path); db.delete(schema.auditEvents) }",
    "const path = enabled && '@/platform/db/schema'\nexport const go = async (db: any) => { const schema = await import(path); db.delete(schema.auditEvents) }",
    "import schema = require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const schema = require.call(null, '@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const schema = Reflect.apply(require, null, ['@/platform/db/schema'])\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const schema = require.bind(null)('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const schema = module.require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const { createRequire } = require('node:module')\nconst load = createRequire(__filename)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const nodeModule = require('module')\nconst load = nodeModule.createRequire(__filename)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const { createRequire } = await import('node:module')\nconst load = createRequire(import.meta.url)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "import nodeModule from 'node:module'\nconst load = nodeModule.createRequire(import.meta.url)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const schema = globalThis.require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const schema = global.module.require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const nodeModule = process.getBuiltinModule('module')\nconst load = nodeModule.createRequire(import.meta.url)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const nodeModule = globalThis.process.getBuiltinModule('node:module')\nconst load = nodeModule.createRequire(import.meta.url)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "import Module = require('node:module')\nconst load = Module.createRequire(import.meta.url)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "namespace Docs { const require = (value: string) => value; void require }\nconst schema = require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "namespace Docs { var require = (value: string) => value; void require }\nconst schema = require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "declare const require: (value: string) => any\nconst schema = require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "declare const module: { require(value: string): any }\nconst schema = module.require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "declare const process: { getBuiltinModule(value: string): any }\nconst nodeModule = process.getBuiltinModule('node:module')\nconst load = nodeModule.createRequire(import.meta.url)\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "function load(path: string) { return require(path) }\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "function load(path = '@/platform/db/schema') { return require(path) }\nconst schema = load()\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    'export function load(path: string) { return require(path) }',
    'export const load = (path: string) => require(path)',
    "export function load(path = '@/platform/db/schema') { return require(path) }",
    "export const load = (path = '@/platform/db/schema') => require(path)",
    'function load(path: string) { return require(path) }\nexport { load }',
    'function load(path: string) { return require(path) }\nexport default load',
    'function load(path: string) { return require(path) }\nconst helpers = { load }\nvoid helpers',
    "function invoke(loader: any, path: string) { return loader(path) }\nconst schema = invoke(require, '@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "const apply = (loader: any, path: string) => loader(path)\nconst schema = apply(require, '@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "import { invoke } from './safe'\nconst schema = invoke(require, '@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    'class Loader { constructor(loader: any) { void loader } }\nnew Loader(require)',
    'export class Loader { load(path: string) { return require(path) } }',
    'export const loader = { load(path: string) { return require(path) } }',
    'class Loader { load(path: string) { return require(path) } }\nexport { Loader }',
    'export class Loader { get load() { return require } }',
    'export function* loaders() { yield require }',
    'function fail() { throw require }\nvoid fail',
    "const load = (path: string) => import(path)\nexport const go = async (db: any) => { const schema = await load('@/platform/db/schema'); db.delete(schema.auditEvents) }",
    "function load(path: string) { return require(path) }\nconst schema = load.call(null, '@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "function load(path: string) { return require(path) }\nconst schema = load.apply(null, ['@/platform/db/schema'])\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "function load(path: string) { return require(path) }\nconst schema = Reflect.apply(load, null, ['@/platform/db/schema'])\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "function schemaPath() { return '@/platform/db/schema' }\nconst schema = require(schemaPath())\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "function getLoader() { return require }\nconst load = getLoader()\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const getLoader = () => require\nconst schema = getLoader()('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "function getLoader() { return (path: string) => import(path) }\nconst load = getLoader()\nexport const go = async (db: any) => { const schema = await load('@/platform/db/schema'); db.delete(schema.auditEvents) }",
    "const holder = { load: require }\nconst schema = holder.load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const { load } = { load: require }\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const [load] = [require]\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "class Loader { load = require }\nconst schema = new Loader().load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "const holder: any = {}\nholder.load = require\nconst schema = holder.load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.auditEvents)",
    "import { pgTable } from 'drizzle-orm/pg-core'\nconst hidden = pgTable('hidden', {})\nexport const go = (db: any) => db.delete(hidden)",
    "import * as core from 'drizzle-orm/pg-core'\nconst hidden = core.pgTable('hidden', {})\nexport const go = (db: any) => db.delete(hidden)",
    "import { pgTable } from 'drizzle-orm/pg-core/table'\nconst hidden = pgTable('hidden', {})\nexport const go = (db: any) => db.delete(hidden)",
    "const core = (0, require)('drizzle-orm/pg-core')\nconst hidden = core.pgTable('hidden', {})\nexport const go = (db: any) => db.delete(hidden)",
    "function load(path = 'drizzle-orm/pg-core') { return require(path) }\nconst core = load()\nconst hidden = core.pgTable('hidden', {})\nexport const go = (db: any) => db.delete(hidden)",
  ])('rejects non-ESM schema module provenance case %#', (source) => {
    expect(diagnostic(source).code).toBe('unresolved-schema-load')
  })

  it('allows only the exact production PgDialect pg-core seam outside schema files', () => {
    expect(() =>
      scan(
        "import { PgDialect } from 'drizzle-orm/pg-core'\nconst dialect = new PgDialect()\nvoid dialect",
        'src/platform/db/preflight.ts',
      ),
    ).not.toThrow()
    expect(
      diagnostic(
        "import { PgDialect, pgTable } from 'drizzle-orm/pg-core'\nvoid PgDialect\nvoid pgTable",
        'src/platform/db/preflight.ts',
      ).code,
    ).toBe('unresolved-schema-load')
    expect(
      diagnostic(
        "import { PgDialect } from 'drizzle-orm/pg-core/dialect'\nvoid PgDialect",
        'src/platform/db/preflight.ts',
      ).code,
    ).toBe('unresolved-schema-load')
  })

  it('ignores type-only import-equals schema references', () => {
    expect(() =>
      scan("import type schema = require('@/platform/db/schema')\nvoid 0"),
    ).not.toThrow()
  })

  it('ignores type-only import-equals Node module references', () => {
    expect(() =>
      scan("import type Module = require('node:module')\ntype Loader = Module"),
    ).not.toThrow()
  })

  it('allows type-only Node module references and shadowed loader names', () => {
    expect(() =>
      scan(`
        import { type Module } from 'node:module'
        export type { Module as RuntimeModule } from 'node:module'
        function local(
          require: (value: string) => unknown,
          module: { require(value: string): unknown },
          process: { getBuiltinModule(value: string): unknown },
          globalThis: { require(value: string): unknown },
        ) {
          require('node:module')
          module.require('node:module')
          process.getBuiltinModule('module')
          return globalThis.require('node:module')
        }
        void local
      `),
    ).not.toThrow()
  })

  it('does not mistake an ordinary schema-path string argument for a module load', () => {
    expect(() => scan("console.log('@/platform/db/schema')")).not.toThrow()
  })

  it('keeps a non-exported loader wrapper closed over explicit safe calls', () => {
    expect(() =>
      scan(`
        function load(path: string) { return require(path) }
        load('safe-package')
        function defaulted(path = '@/platform/db/schema') { return require(path) }
        defaulted('safe-package')
      `),
    ).not.toThrow()
  })

  it('does not invent loader authority for ordinary or shadowed helper arguments', () => {
    expect(() =>
      scan(`
        function invoke(loader: any, path: string) { return loader(path) }
        invoke(console.log, '@/platform/db/schema')
        function local(require: (path: string) => unknown) {
          return invoke(require, '@/platform/db/schema')
        }
        void local
      `),
    ).not.toThrow()
  })

  it.each([
    "const runtime = module\nconst schema = runtime.require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "const root: any = globalThis\nconst schema = root.require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "const { require: load } = globalThis as any\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "const { require: load } = module\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "const runtime = process\nconst nodeModule = runtime.getBuiltinModule('module')\nvoid nodeModule",
    "const load = Reflect.get(module, 'require')\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "const schema = require.main.require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "const schema = (process as any).mainModule.require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "const runtime = enabled ? module : other\nconst schema = runtime.require('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "var load = require\nvar load\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "function load(path: string): any\nfunction load(path: any) { return require(path) }\nconst schema = load('@/platform/db/schema')\nexport const go = (db: any) => db.delete(schema.user)",
    "const schemaPath = '@/platform/db/schema'\nfunction load({ path = schemaPath } = {}) { return require(path) }\nconst schema = load()\nexport const go = (db: any) => db.delete(schema.user)",
    "const schemaPath = '@/platform/db/schema'\nfunction load({ loader = require, path = schemaPath } = {}) { return loader(path) }\nconst schema = load()\nexport const go = (db: any) => db.delete(schema.user)",
    "const schemaPath = '@/platform/db/schema'\nfunction load(path = schemaPath) { return require(path) }\nconst schema = load(undefined)\nexport const go = (db: any) => db.delete(schema.user)",
    "const schemaPath = '@/platform/db/schema'\nfunction load(path = schemaPath) { return require(path) }\nconst schema = load(void 0)\nexport const go = (db: any) => db.delete(schema.user)",
    "const schemaPath = '@/platform/db/schema'\nfunction load(path: string) { return require(path) }\nconst args = [schemaPath] as const\nconst schema = load(...args)\nexport const go = (db: any) => db.delete(schema.user)",
    "const schemaPath = '@/platform/db/schema'\nfunction load(path: string) { return require(path) }\nconst schema = load.call(...[null, schemaPath])\nexport const go = (db: any) => db.delete(schema.user)",
    "const schemaPath = '@/platform/db/schema'\nconst load = require.bind(null, schemaPath)\nconst schema = load()\nexport const go = (db: any) => db.delete(schema.user)",
    "const schemaPath = '@/platform/db/schema'\nfunction load(path: string) { return require(path) }\nconst bound = load.bind(null, schemaPath)\nconst schema = bound()\nexport const go = (db: any) => db.delete(schema.user)",
    "const schemaPath = '@/platform/db/schema'\nconst Loader: any = function (path: string) { return require(path) }\nconst schema = new Loader(schemaPath)\nexport const go = (db: any) => db.delete(schema.user)",
  ])('rejects ambient-loader alias/default/forwarding family case %#', (source) => {
    expect(diagnostic(source).code).toBe('unresolved-schema-load')
  })

  it('uses effective loader/default arguments instead of unconditional defaults', () => {
    expect(() =>
      scan(`
        const schemaPath = '@/platform/db/schema'
        function invoke(loader = require, path = schemaPath) { return loader(path) }
        invoke(console.log, schemaPath)
        function local(undefined: string) {
          function load(path = schemaPath) { return require(path) }
          load(undefined)
        }
        void local
      `),
    ).not.toThrow()
  })

  it('rejects capability transport through arbitrary tags and composed SQL targets', () => {
    expect(
      diagnostic(
        [
          "import { user } from '@/platform/db/schema'",
          'function tag(_parts: TemplateStringsArray, ...tables: any[]) { return tables }',
          'tag`' + '$' + '{user}`',
        ].join('\n'),
      ).code,
    ).toBe('helper-table-argument')
    expect(
      diagnostic(
        [
          "import { sql } from 'drizzle-orm'",
          "import { user } from '@/platform/db/schema'",
          'db.execute(sql`' + '$' + "{sql.raw('DELETE FROM')} " + '$' + '{user}`)',
        ].join('\n'),
      ).code,
    ).toBe('raw-table-interpolation')
  })

  it('allows verified Drizzle SQL column interpolation', () => {
    expect(() =>
      scan(
        [
          "import { sql as query } from 'drizzle-orm'",
          "import { user } from '@/platform/db/schema'",
          'db.execute(query`' + '$' + '{user.id} = 1`)',
        ].join('\n'),
      ),
    ).not.toThrow()
  })
})
