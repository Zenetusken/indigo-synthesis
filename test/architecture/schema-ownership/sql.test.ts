import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  declarationTokenStream,
  detectRawSqlWrites,
  executableSqlText,
  SqlScanError,
} from './sql'

const names = new Set(['audit_event', 'installation_state', 'safety_hold'])
const schemaBindingToSql = new Map([
  ['auditEvents', 'audit_event'],
  ['installationState', 'installation_state'],
  ['safetyHolds', 'safety_hold'],
])

function scanAt(file: string, source: string) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  return detectRawSqlWrites(sourceFile, file, 'progress', names, schemaBindingToSql)
}

function scan(source: string) {
  return scanAt('src/modules/progress/application/sql-probe.ts', source)
}

function declarationTokens(source: string): string {
  const sourceFile = ts.createSourceFile(
    'helper.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const declaration = sourceFile.statements[0]
  if (!declaration) throw new Error('missing helper declaration')
  return declarationTokenStream(declaration, sourceFile)
}

describe('closed raw-SQL ownership grammar', () => {
  it('normalizes PostgreSQL comments and literal forms without erasing tokens', () => {
    const normalized = executableSqlText(
      [
        "SELECT 'DELETE FROM audit_event'",
        "SELECT E'DELETE FROM audit_event\\''",
        'SELECT $body$DELETE FROM audit_event$body$',
        'SELECT 1 /* DELETE FROM audit_event */',
        'SELECT 1 AS foo$tag$; DELETE /* gap */ FROM audit_event',
      ].join('; '),
    )
    expect(normalized).not.toMatch(/body.*DELETE/)
    expect(normalized).toContain('foo$tag$; DELETE')
    expect(normalized).toMatch(/DELETE\s+FROM audit_event/)
    expect(executableSqlText('DELETE FROM "update"')).toContain('"update"')
    expect(executableSqlText('DELETE FROM "update"', false)).not.toMatch(/\bUPDATE\b/i)
  })

  it('accepts only proven drizzle sql tags plus the bare fixture tag', () => {
    expect(
      scan(
        "import { sql as q } from 'drizzle-orm'\n" +
          'export const a = q`DELETE FROM audit_event`\n' +
          'export const b = sql`UPDATE safety_hold AS "target" SET id = id`',
      ).map(({ op, table }) => `${op}:${table}`),
    ).toEqual(['delete:audit_event', 'update:safety_hold'])
    expect(
      scan(
        "import { sql } from './html'\n" +
          'export const render = () => sql`DELETE FROM audit_event`',
      ),
    ).toEqual([])
    expect(
      scan(
        "import { sql as q } from 'drizzle-orm'\n" +
          'export const render = (q: any) => q`DELETE FROM audit_event`',
      ),
    ).toEqual([])
  })

  it('separates potential SQL tags from sink-reached executable evidence', () => {
    expect(
      scan(
        "import { sql } from 'drizzle-orm'\n" +
          'const unused = sql`DELETE FROM audit_event`\nvoid unused',
      ).map(({ evidence }) => evidence),
    ).toEqual(['potential'])
    expect(
      scan(
        "import { sql } from 'drizzle-orm'\n" +
          'db.execute(sql`DELETE FROM audit_event`)',
      ).map(({ evidence }) => evidence),
    ).toEqual(['executable'])
  })

  it('keeps Drizzle raw providers potential until a proven SQL sink reaches them', () => {
    expect(
      scan(
        "import { sql } from 'drizzle-orm'\n" +
          "const unused = sql.raw('DELETE FROM audit_event')\nvoid unused",
      ).map(({ evidence, op, table }) => `${evidence}:${op}:${table}`),
    ).toEqual(['potential:delete:audit_event'])

    const executable = [
      "import { sql } from 'drizzle-orm'\ndb.execute(sql.raw('DELETE FROM audit_event'))",
      "db.query(helper.raw('DELETE FROM audit_event'))",
    ]
    for (const source of executable) {
      expect(
        scan(source).map(({ evidence, op, table }) => `${evidence}:${op}:${table}`),
        source,
      ).toEqual(['executable:delete:audit_event'])
    }

    const potential = [
      "const run = db.raw\nrun('DELETE FROM audit_event')",
      "db.raw.call(db, 'DELETE FROM audit_event')",
      "db.raw.bind(db)('DELETE FROM audit_event')",
      "db.raw.apply(db, ['DELETE FROM audit_event'])",
      "Reflect.apply(db.raw, db, ['DELETE FROM audit_event'])",
      "(0, store.raw)('DELETE FROM audit_event')",
      "const store = { raw: helper.raw }\nstore.raw('DELETE FROM audit_event')",
      "class Runner { run() { this.client.raw('DELETE FROM audit_event') } }",
      "helper.raw('DELETE FROM audit_event')",
      "const run = helper.raw\nrun('DELETE FROM audit_event')",
      "helper.raw.call(helper, 'DELETE FROM audit_event')",
      "helper.raw.bind(helper)('DELETE FROM audit_event')",
    ]
    for (const source of potential) {
      expect(
        scan(source).map(({ evidence, op, table }) => `${evidence}:${op}:${table}`),
        source,
      ).toEqual(['potential:delete:audit_event'])
    }
  })

  it('composes verified Drizzle raw fragments with catalogued table bindings', () => {
    const potential =
      "import { sql } from 'drizzle-orm'\n" +
      "import { auditEvents } from '@/platform/db/schema'\n" +
      'const statement = sql`$' +
      "{sql.raw('DELETE FROM')} $" +
      '{auditEvents}`\n' +
      'void statement'
    expect(
      scan(potential).map(({ evidence, op, table }) => `${evidence}:${op}:${table}`),
    ).toEqual(['potential:delete:audit_event'])
    expect(
      scan(`${potential}\ndb.execute(statement)`).map(
        ({ evidence, op, table }) => `${evidence}:${op}:${table}`,
      ),
    ).toEqual(['executable:delete:audit_event'])

    expect(
      scan(
        "import { sql } from 'drizzle-orm'\n" +
          "import * as schema from '@/platform/db/schema'\n" +
          'db.query(sql`$' +
          "{sql.raw('UPDATE')} $" +
          '{schema.safetyHolds} $' +
          "{sql.raw('SET id = id')}`)",
      ).map(({ evidence, op, table }) => `${evidence}:${op}:${table}`),
    ).toEqual(['executable:update:safety_hold'])
  })

  it('keeps TypeScript namespace bindings inside their module block', () => {
    expect(
      scan(
        "import { sql } from 'drizzle-orm'\n" +
          'namespace Docs { var sql = (value: unknown) => value; void sql }\n' +
          'export const statement = sql`DELETE FROM audit_event`',
      ).map(({ op, table }) => `${op}:${table}`),
    ).toEqual(['delete:audit_event'])
  })

  it('keeps class static-block bindings inside their static block', () => {
    expect(
      scan(
        "import { sql } from 'drizzle-orm'\n" +
          'class Docs { static { var sql = (value: unknown) => value; void sql } }\n' +
          'export const statement = sql`DELETE FROM audit_event`',
      ).map(({ op, table }) => `${op}:${table}`),
    ).toEqual(['delete:audit_event'])
  })

  it('accepts direct literal, template, immutable const, config, and alternatives', () => {
    const found = scan(
      [
        "const direct = 'DELETE FROM audit_event'",
        "const config = { text: 'INSERT INTO safety_hold (id) VALUES (1)' }",
        'const text = \'UPDATE installation_state * AS "state" SET singleton = 1\'',
        'db.execute(direct)',
        'db.query(config)',
        'db.query({ text })',
        "db.raw(flag ? 'DELETE FROM safety_hold' : 'SELECT 1')",
        'db.execute(`DELETE FROM public.audit_event WHERE id = $' + '{id}`)',
      ].join('\n'),
    )
    expect(found.map(({ op, table }) => `${op}:${table}`)).toEqual([
      'delete:audit_event',
      'insert:safety_hold',
      'update:installation_state',
      'delete:safety_hold',
      'delete:audit_event',
    ])
  })

  it('resolves closed static concatenations and immutable template substitutions', () => {
    const found = scan(
      [
        "const verb = 'DELETE'",
        "const target = flag ? 'audit_event' : 'safety_hold'",
        "db.execute(verb + ' FROM ' + target)",
        "const updateTarget = 'installation_state'",
        'db.query(`UPDATE $' + '{updateTarget} SET singleton = 1`)',
      ].join('\n'),
    )

    expect(found.map(({ op, table }) => `${op}:${table}`).sort()).toEqual([
      'delete:audit_event',
      'delete:safety_hold',
      'update:installation_state',
    ])
  })

  it('evaluates closed return-only helpers and rejects unresolved providers', () => {
    expect(
      scan(
        "function statement() { return 'DELETE FROM audit_event' }\ndb.query(statement())",
      ).map(({ op, table }) => `${op}:${table}`),
    ).toEqual(['delete:audit_event'])
    expect(
      scan(
        "db.query.bind(db)('DELETE FROM audit_event')\n" +
          "const run = db.query.bind(db)\nrun('DELETE FROM audit_event')\n" +
          "db['query']('DELETE FROM audit_event')\n" +
          "db[method]('DELETE FROM audit_event')",
      ).map(({ op, table }) => `${op}:${table}`),
    ).toEqual([
      'delete:audit_event',
      'delete:audit_event',
      'delete:audit_event',
      'delete:audit_event',
    ])
    const resolvedIndirectProviders = [
      ["const { query: run } = db\nrun('DELETE FROM audit_event')", 'executable'],
      ["invoke(db.query, 'DELETE FROM audit_event')", 'potential'],
    ] as const
    for (const [source, evidence] of resolvedIndirectProviders) {
      expect(() => scan(source), source).not.toThrow()
      expect(
        scan(source).map(({ evidence: kind, op, table }) => `${kind}:${op}:${table}`),
        source,
      ).toEqual([`${evidence}:delete:audit_event`])
    }

    const sources = [
      "let statement = 'DELETE FROM audit_event'\ndb.query(statement)",
      "let statement\nstatement = 'DELETE FROM audit_event'\ndb.query(statement)",
      "const holder = { statement: 'DELETE FROM audit_event' }\ndb.query(holder.statement)",
      "const config = { text: 'DELETE FROM audit_event' }\ndb.query({ ...config })",
      "db.query.apply(db, ['DELETE FROM audit_event'])",
      "Reflect.apply(db.query, db, ['DELETE FROM audit_event'])",
      "const run = forward(db.query)\nrun('DELETE FROM audit_event')",
      "db.query(flag ? 'DELETE FROM audit_event' : buildSql())",
      "db.query(flag ? { text: 'DELETE FROM audit_event' } : { text: buildSql() })",
    ]
    for (const source of sources) {
      expect(() => scan(source), source).toThrowError(SqlScanError)
      expect(() => scan(source), source).toThrow('accepted static grammar')
    }
  })

  it('fails closed on destructured static SQL providers', () => {
    const sources = [
      "const { text } = { text: 'DELETE FROM audit_event' }\ndb.query(text)",
      "let text\n;({ text } = { text: 'DELETE FROM audit_event' })\ndb.query(text)",
      "const { text = 'DELETE FROM audit_event' } = {}\ndb.query(text)",
      "const { nested: { text = 'DELETE FROM audit_event' } = {} } = {}\ndb.query(text)",
      "const [text = 'DELETE FROM audit_event'] = []\ndb.query(text)",
      "function run({ text = 'DELETE FROM audit_event' } = {}) { db.query(text) }\nrun()",
      "let text\n;({ text = 'DELETE FROM audit_event' } = {})\ndb.query(text)",
    ]

    for (const source of sources) {
      expect(() => scan(source)).toThrowError(SqlScanError)
      expect(() => scan(source)).toThrow('accepted static grammar')
    }
  })

  it('fails closed on unsupported mutable and composed SQL providers', () => {
    const sources = [
      "const holder: any = {}\nholder.text = 'DELETE FROM audit_event'\ndb.query(holder.text)",
      "const holder: any = {}\nholder[0] = 'DELETE FROM audit_event'\ndb.query(holder[0])",
      "const holder: any = {}\n;({ text: holder.text } = { text: 'DELETE FROM audit_event' })\ndb.query(holder.text)",
      "const holder: any = {}\nObject.assign(holder, { text: 'DELETE FROM audit_event' })\ndb.query(holder.text)",
      "let text = 'DELETE FROM '\ntext += 'audit_event'\ndb.query(text)",
      "const run = (statement: string) => db.query(statement)\nrun('DELETE FROM audit_event')",
      "const send = db.query\nconst run = (statement: string) => send(statement)\nrun('DELETE FROM audit_event')",
      "function join(a: string, b: string) { return a + b }\ndb.query(join('DELETE FROM ', 'audit_event'))",
      "class Provider { statement() { return 'DELETE FROM audit_event' } }\ndb.query(new Provider().statement())",
      "db.query(['DELETE FROM', 'audit_event'].join(' '))",
      "for (const text of ['DELETE FROM audit_event']) db.query(text)",
      "function statement() { return 'DELETE FROM audit_event' }\nstatement = buildSql\ndb.query(statement())",
    ]

    for (const source of sources) {
      expect(() => scan(source)).toThrowError(SqlScanError)
      expect(() => scan(source)).toThrow('accepted static grammar')
    }
  })

  it('fails closed on opaque providers through every indirect sink form', () => {
    const sources = [
      "db['query'](buildSql())",
      'db[method](buildSql())',
      'const { query: run } = db\nrun(buildSql())',
      'const run = db.query\nrun(buildSql())',
      'db.query.bind(db)(buildSql())',
      'Reflect.apply(db.query, db, [buildSql()])',
      'invoke(db.query, buildSql())',
    ]
    for (const source of sources) {
      expect(() => scan(source), source).toThrowError(SqlScanError)
      expect(() => scan(source), source).toThrow('accepted static grammar')
    }
  })

  it('tracks sequence-expression SQL sinks by their evaluated operand', () => {
    const literalSources = [
      ["(0, db.query)('DELETE FROM audit_event')", 'executable'],
      ["(0, db.query.bind(db))('DELETE FROM audit_event')", 'executable'],
      ["const run = (0, db.query)\nrun('DELETE FROM audit_event')", 'executable'],
      [
        "const run = (0, db.query.bind(db))\nrun('DELETE FROM audit_event')",
        'executable',
      ],
      ["invoke((0, db.query), 'DELETE FROM audit_event')", 'potential'],
    ] as const
    for (const [source, evidence] of literalSources) {
      expect(
        scan(source).map(({ evidence: kind, op, table }) => `${kind}:${op}:${table}`),
        source,
      ).toEqual([`${evidence}:delete:audit_event`])
      expect(() =>
        scan(source.replace("'DELETE FROM audit_event'", 'buildSql()')),
      ).toThrowError(SqlScanError)
    }

    const safeControls = [
      "(db.query, console.log)('DELETE FROM audit_event')",
      "const run = (db.query, console.log)\nrun('DELETE FROM audit_event')",
    ]
    for (const source of safeControls) expect(scan(source), source).toEqual([])

    expect(
      scan("const run = db.query.bind(db)\nrun('DELETE FROM audit_event')").map(
        ({ evidence }) => evidence,
      ),
    ).toEqual(['executable'])
  })

  it('tracks bound SQL sinks transported through arbitrary helpers', () => {
    const literalSources = [
      "function invoke(fn: any, provider: any) { return fn(provider) }\ninvoke(db.query.bind(db), 'DELETE FROM audit_event')",
      "import { invoke } from './invoke'\ninvoke(db.query.bind(db), 'DELETE FROM audit_event')",
      "function invoke(fn: any, provider: any) { return fn(provider) }\nconst run = db.query.bind(db)\ninvoke(run, 'DELETE FROM audit_event')",
      "function invoke(fn: any, provider: any) { return fn(provider) }\ninvoke((0, db.query.bind(db)), 'DELETE FROM audit_event')",
      "function invoke(fn: any, provider: any) { return fn(provider) }\ninvoke.call(null, db.query.bind(db), 'DELETE FROM audit_event')",
      "function invoke(fn: any, provider: any) { return fn(provider) }\nconst run = db.query.bind(db)\ninvoke.call(null, run, 'DELETE FROM audit_event')",
      "import { invoke } from './invoke'\ninvoke.call(null, (0, db.query.bind(db)), 'DELETE FROM audit_event')",
    ]
    for (const source of literalSources) {
      expect(
        scan(source).map(({ evidence, op, table }) => `${evidence}:${op}:${table}`),
        source,
      ).toEqual(['potential:delete:audit_event'])
      expect(() =>
        scan(source.replace("'DELETE FROM audit_event'", 'buildSql()')),
      ).toThrowError(SqlScanError)
    }

    const safeControls = [
      "function invoke(fn: any, provider: any) { return fn(provider) }\ninvoke(console.log.bind(console), 'DELETE FROM audit_event')",
      "import { invoke } from './invoke'\ninvoke(console.log.bind(console), 'DELETE FROM audit_event')",
      "function invoke(fn: any, provider: any) { return fn(provider) }\nconst query = console.log\ninvoke(query.bind(console), 'DELETE FROM audit_event')",
      "function invoke(fn: any, provider: any) { return fn(provider) }\ninvoke((db.query.bind(db), console.log.bind(console)), 'DELETE FROM audit_event')",
    ]
    for (const source of safeControls) expect(scan(source), source).toEqual([])
  })

  it('rejects SQL sink capabilities transported through arbitrary template tags', () => {
    const sources = [
      "import { render } from './render'\nrender`$" +
        '{db.query.bind(db)} $' +
        "{'DELETE FROM audit_event'}`",
      'function render(parts: TemplateStringsArray, ...values: unknown[]) { return [parts, values] }\nrender`$' +
        '{db.query.bind(db)} $' +
        "{'DELETE FROM audit_event'}`",
    ]
    for (const source of sources) {
      expect(() => scan(source), source).toThrowError(SqlScanError)
      expect(() => scan(source), source).toThrow('accepted static grammar')
    }

    expect(
      scan(
        "import { sql } from 'drizzle-orm'\n" +
          'const statement = sql`DELETE FROM audit_event WHERE id = $' +
          '{id}`',
      ).map(({ evidence, op, table }) => `${evidence}:${op}:${table}`),
    ).toEqual(['potential:delete:audit_event'])
  })

  it('rejects sink capability storage in class members, generators, JSX, and throws', () => {
    const sources = [
      'class Runner { method() { return db.query } }',
      'class Runner { get method() { return db.query.bind(db) } }',
      'function* runners() { yield db.query.bind(db) }',
      'throw db.query.bind(db)',
    ]
    for (const source of sources) {
      expect(() => scan(source), source).toThrowError(SqlScanError)
      expect(() => scan(source), source).toThrow('accepted static grammar')
    }
    expect(() =>
      scanAt(
        'src/modules/progress/application/sql-probe.tsx',
        'const view = <Runner execute={db.query.bind(db)} />\nvoid view',
      ),
    ).toThrowError(SqlScanError)
  })

  it('tracks sink capabilities through alternatives, object storage, and computed destructuring', () => {
    const literalSources = [
      "(flag ? db.query : noop)('DELETE FROM audit_event')",
      "const run = flag ? db.query : noop\nrun('DELETE FROM audit_event')",
      "const holder = { run: db.query }\nholder.run('DELETE FROM audit_event')",
      "const holder = { nested: { run: db.query.bind(db) } }\nholder.nested.run('DELETE FROM audit_event')",
      "const { [method]: run } = db\nrun('DELETE FROM audit_event')",
      "let run = console.log\nrun = db.query\nrun('DELETE FROM audit_event')",
      "let run = console.log\n;({ query: run } = db)\nrun('DELETE FROM audit_event')",
      "const getRun = () => db.query\ngetRun()('DELETE FROM audit_event')",
      "const getRunner = () => ({ run: db.query })\ngetRunner().run('DELETE FROM audit_event')",
      "const key = 'run'\nconst holder = { [key]: db.query }\nholder.run('DELETE FROM audit_event')",
    ]
    for (const source of literalSources) {
      expect(
        scan(source).map(({ op, table }) => `${op}:${table}`),
        source,
      ).toEqual(['delete:audit_event'])
    }

    for (const source of literalSources.map((item) =>
      item.replace("'DELETE FROM audit_event'", 'buildSql()'),
    )) {
      expect(() => scan(source), source).toThrowError(SqlScanError)
      expect(() => scan(source), source).toThrow('accepted static grammar')
    }

    expect(() =>
      scan('const holder = { run: db.query }\ninvoke(holder.run, buildSql())'),
    ).toThrowError(SqlScanError)
  })

  it('rejects sink capability collection, dynamic storage, and exports', () => {
    const sources = [
      "const bag = new Map([['run', db.query]])\nbag.get('run')('DELETE FROM audit_event')",
      "const bag = new Map()\nbag.set('run', db.query)\nbag.get('run')('DELETE FROM audit_event')",
      "const bag = { [key]: db.query }\nbag.run('DELETE FROM audit_event')",
      "const bag: any = {}\nbag.run = db.query\nbag.run('DELETE FROM audit_event')",
      "export const run = db.query\nrun('DELETE FROM audit_event')",
      "export const getRun = () => db.query\ngetRun()('DELETE FROM audit_event')",
      "const run = db.query\nexport { run }\nrun('DELETE FROM audit_event')",
      "const bag: any = {}\nObject.assign(bag, { run: db.query })\nbag.run('DELETE FROM audit_event')",
      "class Bag { run = db.query }\nnew Bag().run('DELETE FROM audit_event')",
      "const bag = [db.query]\nbag.at(0)!('DELETE FROM audit_event')",
      "const bag = new Set([db.query])\nconst [run] = bag\nrun('DELETE FROM audit_event')",
    ]

    for (const source of sources) {
      expect(() => scan(source), source).toThrowError(SqlScanError)
      expect(() => scan(source), source).toThrow('accepted static grammar')
    }
  })

  it('allows analogous storage and assignment when no SQL sink capability is present', () => {
    const sources = [
      "let run = console.log\n;({ info: run } = console)\nrun('hello')",
      "const bag: any = {}\nObject.assign(bag, { run: console.log })\nbag.run('hello')",
      "class Bag { run = console.log }\nnew Bag().run('hello')",
      "const bag = [console.log]\nbag.at(0)!('hello')",
      "const bag = new Set([console.log])\nconst [run] = bag\nrun('hello')",
      "const getRunner = () => ({ run: console.log })\ngetRunner().run('hello')",
    ]

    for (const source of sources) {
      expect(() => scan(source), source).not.toThrow()
      expect(scan(source), source).toEqual([])
    }
  })

  it('tracks provider mutation by lexical binding rather than identifier text', () => {
    const source = `
      function mutate() {
        let text = 'ignored'
        text = 'still ignored'
      }
      function execute() {
        const text = 'SELECT 1'
        db.query(text)
      }
    `

    expect(() => scan(source)).not.toThrow()
    expect(scan(source)).toEqual([])
  })

  it('accepts only the six exact runtime SQL pass-through contracts', () => {
    const files = [
      'src/platform/application-coordination/postgres-unit-of-work.ts',
      'src/platform/application-coordination/prelocked-session.ts',
      'src/platform/application-coordination/scoped-drizzle.ts',
      'src/platform/db/disposable-integration-database.ts',
      'src/platform/db/external-host-one-shot.ts',
      'src/platform/db/preflight.ts',
    ]
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(scanAt(file, source), file).toEqual([])
    }
  }, 15_000)

  it('requires every file-scoped opaque contract before encountering a call', () => {
    const preflightFile = 'src/platform/db/preflight.ts'
    const preflight = readFileSync(resolve(process.cwd(), preflightFile), 'utf8')
    const disposableFile = 'src/platform/db/disposable-integration-database.ts'
    const disposable = readFileSync(resolve(process.cwd(), disposableFile), 'utf8')
    const unitOfWorkFile =
      'src/platform/application-coordination/postgres-unit-of-work.ts'
    const unitOfWork = readFileSync(resolve(process.cwd(), unitOfWorkFile), 'utf8')
    const mutants = [
      [
        preflightFile,
        preflight.replace(
          '  return query.query<Row>(compiled.sql, compiled.params)',
          '  return Promise.resolve({ rows: [] } as unknown as QueryResult<Row>)',
        ),
      ],
      [
        disposableFile,
        disposable.replace(
          '    query: (text, values) => client.query(text, values ? [...values] : undefined),',
          '    query: async () => ({ rows: [] }) as never,',
        ),
      ],
      [
        unitOfWorkFile,
        unitOfWork.replace(
          '      promise = Reflect.apply(\n' +
            '        this.#client.query,\n' +
            '        this.#client,\n' +
            '        queryArgs,\n' +
            '      ) as Promise<unknown>',
          '      promise = Promise.resolve(undefined)',
        ),
      ],
      [
        disposableFile,
        disposable.replace(
          '    end: () => client.end(),',
          '    end: () => client.query,',
        ),
      ],
      [
        disposableFile,
        disposable.replace(
          '    end: () => client.end(),',
          '    end: () => client.query.bind(client),',
        ),
      ],
    ] as const

    for (const [file, source] of mutants) {
      expect(source, file).not.toBe(
        file === preflightFile
          ? preflight
          : file === disposableFile
            ? disposable
            : unitOfWork,
      )
      expect(() => scanAt(file, source), file).toThrowError(SqlScanError)
      expect(() => scanAt(file, source), file).toThrow('accepted static grammar')
    }
  })

  it('pins opaque direct seams to their top-level function, bindings, receiver, and cardinality', () => {
    const file = 'src/platform/application-coordination/postgres-unit-of-work.ts'
    const mutants = [
      `
        function outer() {
          function queryWithGuard(client: any, text: string, values?: readonly unknown[]) {
            return values ? client.query(text, [...values]) : client.query(text)
          }
        }
      `,
      `
        const queryWithGuard = (client: any, text: string, values?: readonly unknown[]) =>
          values ? client.query(text, [...values]) : client.query(text)
      `,
      `
        function queryWithGuard(client: any, text: string, values?: readonly unknown[]) {
          return values ? client.query(text, [...values]) : attacker.raw(text)
        }
      `,
      `
        function queryWithGuard(client: any, text: string, values?: readonly unknown[]) {
          attacker.execute(text)
          return values ? client.query(text, [...values]) : client.query(text)
        }
      `,
      `
        function queryWithGuard(client: any, text: string, values?: readonly unknown[]) {
          if (values) return client.query(text, [...values])
          { const text = buildSql(); return client.query(text) }
        }
      `,
      `
        function queryWithGuard(client: any, text: string, values?: readonly unknown[]) {
          text = buildSql()
          return values ? client.query(text, [...values]) : client.query(text)
        }
      `,
      `
        function queryWithGuard(client: any, text: string, values?: readonly unknown[]) {
          client = attacker
          return values ? client.query(text, [...values]) : client.query(text)
        }
      `,
      `
        function queryWithGuard(client: any, text: string, values?: readonly unknown[]) {
          const mutate = Object.assign
          mutate(client, { query: attacker })
          return values ? client.query(text, [...values]) : client.query(text)
        }
      `,
      `
        function queryWithGuard(client: any, text: string = buildSql(), values?: readonly unknown[]) {
          return values ? client.query(text, [...values]) : client.query(text)
        }
      `,
    ]
    for (const source of mutants) {
      expect(() => scanAt(file, source), source).toThrowError(SqlScanError)
      expect(() => scanAt(file, source), source).toThrow('accepted static grammar')
    }

    const preflightFile = 'src/platform/db/preflight.ts'
    const preflightMutants = [
      `
        function execute(query: any, statement: any) {
          const compiled = dialect.sqlToQuery(statement)
          compiled.sql = buildSql()
          return query.query(compiled.sql, compiled.params)
        }
      `,
      `
        function execute(query: any, statement: any) {
          const compiled = dialect.sqlToQuery(statement)
          query = attacker
          return query.query(compiled.sql, compiled.params)
        }
      `,
    ]
    for (const source of preflightMutants) {
      expect(() => scanAt(preflightFile, source), source).toThrowError(SqlScanError)
      expect(() => scanAt(preflightFile, source), source).toThrow(
        'accepted static grammar',
      )
    }
  })

  it('pins opaque provider helpers and client constructors to reviewed provenance', () => {
    const preflightFile = 'src/platform/db/preflight.ts'
    const preflight = readFileSync(resolve(process.cwd(), preflightFile), 'utf8')
    const scopedFile = 'src/platform/application-coordination/scoped-drizzle.ts'
    const scoped = readFileSync(resolve(process.cwd(), scopedFile), 'utf8')
    const disposableFile = 'src/platform/db/disposable-integration-database.ts'
    const disposable = readFileSync(resolve(process.cwd(), disposableFile), 'utf8')
    const externalFile = 'src/platform/db/external-host-one-shot.ts'
    const external = readFileSync(resolve(process.cwd(), externalFile), 'utf8')
    const mutants = [
      [
        preflightFile,
        preflight.replace(
          'const dialect = new PgDialect()',
          "const dialect = { sqlToQuery: () => ({ sql: 'DELETE FROM audit_event', params: [] }) }",
        ),
      ],
      [
        scopedFile,
        scoped.replace(
          '  return descriptor',
          "  return { value: 'DELETE FROM audit_event' } as PropertyDescriptor",
        ),
      ],
      [
        disposableFile,
        disposable.replace(
          "import { Client } from 'pg'",
          'class Client { query(..._args: unknown[]) { return null } }',
        ),
      ],
      [
        externalFile,
        external.replace(
          "import { Client, type QueryResult, type QueryResultRow } from 'pg'",
          "import type { QueryResult, QueryResultRow } from 'pg'\nclass Client { query(..._args: unknown[]) { return null } }",
        ),
      ],
    ] as const

    for (const [file, source] of mutants) {
      expect(() => scanAt(file, source), file).toThrowError(SqlScanError)
      expect(() => scanAt(file, source), file).toThrow('accepted static grammar')
    }
  })

  it('preserves behavior-significant whitespace inside trusted helper tokens', () => {
    const scopedFile = 'src/platform/application-coordination/scoped-drizzle.ts'
    const scoped = readFileSync(resolve(process.cwd(), scopedFile), 'utf8')
    const unitOfWorkFile =
      'src/platform/application-coordination/postgres-unit-of-work.ts'
    const unitOfWork = readFileSync(resolve(process.cwd(), unitOfWorkFile), 'utf8')
    const mutants = [
      [
        scopedFile,
        scoped,
        scoped.replace("!('value' in descriptor)", "!('va lue' in descriptor)"),
      ],
      [
        unitOfWorkFile,
        unitOfWork,
        unitOfWork.replace(
          "Object.defineProperty(config, 'text', {",
          "Object.defineProperty(config, 'te xt', {",
        ),
      ],
      [
        unitOfWorkFile,
        unitOfWork,
        unitOfWork.replace("query.form === 'positional'", "query.form === 'posi tional'"),
      ],
    ] as const

    for (const [file, original, mutant] of mutants) {
      expect(mutant, file).not.toBe(original)
      expect(mutant.replace(/\s+/g, ''), file).toBe(original.replace(/\s+/g, ''))
      expect(() => scanAt(file, mutant), file).toThrowError(SqlScanError)
      expect(() => scanAt(file, mutant), file).toThrow('accepted static grammar')
    }

    const literalCollisions = [
      ["function helper() { return 'value' }", "function helper() { return 'va lue' }"],
      ['function helper() { return /value/ }', 'function helper() { return /va lue/ }'],
      ['function helper() { return `value` }', 'function helper() { return `va lue` }'],
    ] as const
    for (const [left, right] of literalCollisions) {
      expect(left.replace(/\s+/g, '')).toBe(right.replace(/\s+/g, ''))
      expect(declarationTokens(left)).not.toBe(declarationTokens(right))
    }
    expect(declarationTokens('function helper(){return `value`}')).toBe(
      declarationTokens('function helper ( ) { return `value` }'),
    )
  })

  it('rejects arbitrary-helper mutation or escape of every opaque seam value', () => {
    const preflightFile = 'src/platform/db/preflight.ts'
    const preflight = readFileSync(resolve(process.cwd(), preflightFile), 'utf8')
    const disposableFile = 'src/platform/db/disposable-integration-database.ts'
    const disposable = readFileSync(resolve(process.cwd(), disposableFile), 'utf8')
    const unitOfWorkFile =
      'src/platform/application-coordination/postgres-unit-of-work.ts'
    const unitOfWork = readFileSync(resolve(process.cwd(), unitOfWorkFile), 'utf8')
    const mutants = [
      [
        preflightFile,
        preflight
          .replace(
            'function execute<Row extends QueryResultRow>(',
            'function poison(value: any): void { value.sql = buildSql() }\n\n' +
              'function execute<Row extends QueryResultRow>(',
          )
          .replace(
            '  const compiled = dialect.sqlToQuery(statement)\n',
            '  const compiled = dialect.sqlToQuery(statement)\n  poison(compiled)\n',
          ),
      ],
      [
        preflightFile,
        preflight
          .replace(
            'function execute<Row extends QueryResultRow>(',
            'function leak(value: any): object { return { value } }\n\n' +
              'function execute<Row extends QueryResultRow>(',
          )
          .replace(
            '  const compiled = dialect.sqlToQuery(statement)\n',
            '  const compiled = dialect.sqlToQuery(statement)\n  void leak(compiled)\n',
          ),
      ],
      [
        preflightFile,
        preflight
          .replace(
            'function execute<Row extends QueryResultRow>(',
            'function poison(value: any): void { value.sql = buildSql() }\n\n' +
              'function execute<Row extends QueryResultRow>(',
          )
          .replace(
            '  const compiled = dialect.sqlToQuery(statement)\n',
            '  const compiled = dialect.sqlToQuery(statement)\n' +
              '  Reflect.apply(poison, null, [compiled])\n',
          ),
      ],
      [
        disposableFile,
        disposable
          .replace(
            'function defaultClientFactory(',
            'function poison(value: any): void { value.query = buildSql() }\n\n' +
              'function defaultClientFactory(',
          )
          .replace(
            '  const client = new Client({ connectionString })\n',
            '  const client = new Client({ connectionString })\n  poison(client)\n',
          ),
      ],
      [
        unitOfWorkFile,
        unitOfWork
          .replace(
            'function materializeQueryArgs(',
            'function poison(value: any): void { value[0] = buildSql() }\n\n' +
              'function materializeQueryArgs(',
          )
          .replace(
            '      queryArgs = materializeQueryArgs(query, rowMode)\n',
            '      queryArgs = materializeQueryArgs(query, rowMode)\n' +
              '      poison(queryArgs)\n',
          ),
      ],
    ] as const

    for (const [file, source] of mutants) {
      expect(() => scanAt(file, source), file).toThrowError(SqlScanError)
      expect(() => scanAt(file, source), file).toThrow('accepted static grammar')
    }
  })

  it('rejects mutation and escape through immutable aliases of opaque seam values', () => {
    const preflightFile = 'src/platform/db/preflight.ts'
    const preflight = readFileSync(resolve(process.cwd(), preflightFile), 'utf8')
    const disposableFile = 'src/platform/db/disposable-integration-database.ts'
    const disposable = readFileSync(resolve(process.cwd(), disposableFile), 'utf8')
    const unitOfWorkFile =
      'src/platform/application-coordination/postgres-unit-of-work.ts'
    const unitOfWork = readFileSync(resolve(process.cwd(), unitOfWorkFile), 'utf8')
    const mutants = [
      [
        preflightFile,
        preflight.replace(
          '  return query.query<Row>(compiled.sql, compiled.params)',
          '  const alias = compiled\n' +
            '  alias.sql = buildSql()\n' +
            '  return query.query<Row>(compiled.sql, compiled.params)',
        ),
      ],
      [
        preflightFile,
        preflight.replace(
          '  return query.query<Row>(compiled.sql, compiled.params)',
          '  let alias = compiled\n' +
            '  void alias.params\n' +
            '  return query.query<Row>(compiled.sql, compiled.params)',
        ),
      ],
      [
        preflightFile,
        preflight.replace(
          '  return query.query<Row>(compiled.sql, compiled.params)',
          '  const alias = compiled.sql\n' +
            '  globalThis.leakedSql = alias\n' +
            '  return query.query<Row>(compiled.sql, compiled.params)',
        ),
      ],
      [
        preflightFile,
        preflight.replace(
          '  return query.query<Row>(compiled.sql, compiled.params)',
          '  globalThis.leakedCompiled = compiled\n' +
            '  return query.query<Row>(compiled.sql, compiled.params)',
        ),
      ],
      [
        preflightFile,
        preflight.replace(
          '  return query.query<Row>(compiled.sql, compiled.params)',
          '  void query.query<Row>(compiled.sql, compiled.params)\n' +
            '  return compiled',
        ),
      ],
      [
        preflightFile,
        preflight
          .replace(
            'function execute<Row extends QueryResultRow>(',
            'function leak(value: any): unknown { return value.sql }\n\n' +
              'function execute<Row extends QueryResultRow>(',
          )
          .replace(
            '  return query.query<Row>(compiled.sql, compiled.params)',
            '  void leak(compiled)\n' +
              '  return query.query<Row>(compiled.sql, compiled.params)',
          ),
      ],
      [
        preflightFile,
        preflight.replace(
          '  return query.query<Row>(compiled.sql, compiled.params)',
          '  const alias = compiled\n' +
            '  const secondAlias = alias\n' +
            '  secondAlias.sql = buildSql()\n' +
            '  return query.query<Row>(compiled.sql, compiled.params)',
        ),
      ],
      [
        preflightFile,
        preflight.replace(
          '  return query.query<Row>(compiled.sql, compiled.params)',
          '  void query.query<Row>(compiled.sql, compiled.params)\n' +
            '  const alias = compiled\n' +
            '  return alias',
        ),
      ],
      [
        preflightFile,
        preflight
          .replace(
            'function execute<Row extends QueryResultRow>(',
            'function leak(value: any): object { return { value } }\n\n' +
              'function execute<Row extends QueryResultRow>(',
          )
          .replace(
            '  return query.query<Row>(compiled.sql, compiled.params)',
            '  const alias = compiled\n' +
              '  void leak(alias)\n' +
              '  return query.query<Row>(compiled.sql, compiled.params)',
          ),
      ],
      [
        disposableFile,
        disposable.replace(
          '  return {\n    connect:',
          '  const alias = client\n' + '  alias.end()\n' + '  return {\n    connect:',
        ),
      ],
      [
        unitOfWorkFile,
        unitOfWork.replace(
          '    let promise: Promise<unknown>',
          '    const alias = queryArgs\n' +
            '    alias[0] = buildSql()\n' +
            '    let promise: Promise<unknown>',
        ),
      ],
    ] as const

    for (const [file, source] of mutants) {
      expect(() => scanAt(file, source), file).toThrowError(SqlScanError)
      expect(() => scanAt(file, source), file).toThrow('accepted static grammar')
    }

    const readOnlyAlias = preflight.replace(
      '  return query.query<Row>(compiled.sql, compiled.params)',
      '  const alias = compiled\n' +
        '  const text = alias.sql\n' +
        '  void alias.params.length + text.length\n' +
        '  return query.query<Row>(compiled.sql, compiled.params)',
    )
    expect(() => scanAt(preflightFile, readOnlyAlias)).not.toThrow()
    expect(scanAt(preflightFile, readOnlyAlias)).toEqual([])
  })

  it('pins the tracked Reflect query to one class method, receiver, and materializer', () => {
    const file = 'src/platform/application-coordination/postgres-unit-of-work.ts'
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    expect(scanAt(file, source)).toEqual([])

    const mutants = [
      source.replace('this.#client.query', 'attacker.query'),
      source.replace(
        '      promise = Reflect.apply(',
        '      Reflect.apply(this.#client.query, this.#client, queryArgs)\n' +
          '      promise = Reflect.apply(',
      ),
      source.replace('materializeQueryArgs(query, rowMode)', 'buildSql(query, rowMode)'),
      source.replace(
        'let queryArgs: readonly unknown[]',
        'const materializeQueryArgs = buildSql\n    let queryArgs: readonly unknown[]',
      ),
      source.replace(
        '    let promise: Promise<unknown>',
        '    queryArgs[0] = buildSql()\n    let promise: Promise<unknown>',
      ),
      source.replace(
        '    let promise: Promise<unknown>',
        '    this.#client = attacker\n    let promise: Promise<unknown>',
      ),
      source.replace(
        '    let promise: Promise<unknown>',
        '    Reflect.apply(poison, null, queryArgs)\n' +
          '    let promise: Promise<unknown>',
      ),
      source.replace(
        '  const values = materializePgValues(query.values)',
        '  return [buildSql()]\n  const values = materializePgValues(query.values)',
      ),
      source.replace('    value: query.sql,', '    value: buildSql(),'),
      source.replace(
        "  rowMode: 'array' | null,\n): readonly unknown[] {",
        "  rowMode: 'array' | null,\n" +
          "  _poison = Reflect.set(query, 'sql', buildSql()),\n" +
          '): readonly unknown[] {',
      ),
      source.replace(
        "  rowMode: 'array' | null,\n): readonly unknown[] {",
        "  rowMode: 'array' | null,\n  ..._extra: unknown[]\n): readonly unknown[] {",
      ),
    ]
    for (const mutant of mutants) {
      expect(() => scanAt(file, mutant), mutant).toThrowError(SqlScanError)
    }

    const signatureWhitespaceControl = source.replace(
      '  query: StableQuery,\n  rowMode:',
      '  query: StableQuery, \n\n  rowMode:',
    )
    expect(scanAt(file, signatureWhitespaceControl)).toEqual([])
  }, 15_000)

  it('attributes raw upserts as insert plus update', () => {
    expect(
      scan(
        "db.execute('INSERT INTO audit_event (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = excluded.id')",
      ).map(({ op }) => op),
    ).toEqual(['insert', 'update'])
  })

  it('binds each conflict update to its own INSERT target', () => {
    const outerUpsert = scan(`
      db.execute(\`
        WITH first AS (
          INSERT INTO audit_event (id) VALUES (1)
        )
        INSERT INTO safety_hold (id) VALUES (1)
        ON CONFLICT (id) DO UPDATE SET id = excluded.id
      \`)
    `)
    expect(outerUpsert.map(({ op, table }) => `${op}:${table}`)).toEqual([
      'insert:audit_event',
      'insert:safety_hold',
      'update:safety_hold',
    ])

    const cteUpsert = scan(`
      db.execute(\`
        WITH first AS (
          INSERT INTO audit_event (id) VALUES (1)
          ON CONFLICT (id) DO UPDATE SET id = excluded.id
        )
        INSERT INTO safety_hold (id) VALUES (1)
      \`)
    `)
    expect(cteUpsert.map(({ op, table }) => `${op}:${table}`)).toEqual([
      'insert:audit_event',
      'update:audit_event',
      'insert:safety_hold',
    ])
  })

  it('supports INSERT INTO ONLY without losing the real target', () => {
    expect(
      scan(
        "db.execute('INSERT INTO ONLY audit_event * (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = excluded.id')",
      ).map(({ op, table }) => `${op}:${table}`),
    ).toEqual(['insert:audit_event', 'update:audit_event'])
  })

  it('supports simple quoted and Unicode-quoted schema targets', () => {
    const found = scan(
      [
        'db.execute(\'DELETE FROM "audit_event"\')',
        'db.execute(\'DELETE FROM U&"audit_event"\')',
        'db.execute(\'UPDATE public."safety_hold" AS "target" SET id = id\')',
      ].join('\n'),
    )
    expect(found.map(({ op, table }) => `${op}:${table}`)).toEqual([
      'delete:audit_event',
      'delete:audit_event',
      'update:safety_hold',
    ])
  })

  it('fails closed on Unicode-escaped quoted identifiers', () => {
    const statements = [
      String.raw`DELETE FROM U&"audit\005fevent"`,
      `DELETE FROM U&"audit!005fevent" UESCAPE '!'`,
      `DELETE FROM U&"audit_005fevent" UESCAPE '_'`,
      `DELETE FROM U&"audit_005fevent" /* trivia */ UESCAPE '_'`,
    ]
    for (const statement of statements) {
      expect(() => scan(`db.execute(${JSON.stringify(statement)})`)).toThrow(
        'Unicode-escaped SQL identifiers',
      )
    }
  })

  it('fails closed on unsupported schema mutations and every TRUNCATE target', () => {
    const statements = [
      'MERGE INTO ONLY audit_event * target USING incoming ON false WHEN MATCHED THEN DELETE',
      'TRUNCATE scratch, audit_event RESTART IDENTITY CASCADE',
      'COPY public.audit_event (id) FROM STDIN',
    ]
    for (const statement of statements) {
      expect(() => scan(`db.execute(${JSON.stringify(statement)})`)).toThrow(
        'Unsupported raw',
      )
    }
  })

  it('ignores non-executed prose and SQL-looking literal bodies', () => {
    expect(
      scan(
        "export const message = 'DELETE FROM audit_event'\n" +
          'db.query("SELECT \'DELETE FROM audit_event\'")',
      ),
    ).toEqual([])
  })
})
