import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSchemaTableMap, SchemaCatalogError } from './catalog'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const validFiles = {
  'auth.ts':
    "import { pgTable as defineTable } from 'drizzle-orm/pg-core'\n" +
    "export const user = defineTable('user', {})\n",
  'installation.ts':
    "import { pgTable } from 'drizzle-orm/pg-core'\n" +
    "export const installationState = pgTable('installation_state', {})\n",
  'product.ts':
    "import { pgTable } from 'drizzle-orm/pg-core'\n" +
    "const columns = {}\nexport const athleteProfiles = pgTable('athlete_profile', columns)\n",
  'index.ts':
    "export * from './auth'\nexport * from './installation'\nexport * from './product'\n",
  'ownership.ts': 'export const tableWriteFence = {}\n',
} as const

function schemaRoot(overrides: Readonly<Record<string, string | null>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'indigo-schema-catalog-'))
  roots.push(root)
  const directory = resolve(root, 'platform/db/schema')
  mkdirSync(directory, { recursive: true })
  const files: Record<string, string | null> = { ...validFiles, ...overrides }
  for (const [filename, contents] of Object.entries(files)) {
    if (contents !== null) writeFileSync(resolve(directory, filename), contents)
  }
  return root
}

function diagnostics(root: string): readonly string[] {
  try {
    buildSchemaTableMap(root)
    return []
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaCatalogError)
    return (error as SchemaCatalogError).diagnostics
  }
}

describe('schema table catalog', () => {
  it('accepts the fixed inventory and named pgTable import aliases', () => {
    const catalog = buildSchemaTableMap(schemaRoot())

    expect(Object.fromEntries(catalog.bindingToSql)).toEqual({
      athleteProfiles: 'athlete_profile',
      installationState: 'installation_state',
      user: 'user',
    })
    expect([...catalog.sqlNames].sort()).toEqual([
      'athlete_profile',
      'installation_state',
      'user',
    ])
  })

  it('accepts the live schema', () => {
    const catalog = buildSchemaTableMap(resolve(process.cwd(), 'src'))

    expect(catalog.bindingToSql.get('user')).toBe('user')
    expect(catalog.bindingToSql.get('installationState')).toBe('installation_state')
    expect(catalog.sqlNames.size).toBeGreaterThan(20)
  })

  it.each([
    ['a missing required file', { 'product.ts': null }, 'product.ts is missing'],
    ['an extra TypeScript file', { 'shadow.ts': 'export {}\n' }, 'shadow.ts is outside'],
    [
      'an alternate source extension',
      { 'shadow.mts': 'export {}\n' },
      'shadow.mts is outside',
    ],
  ] as const)('rejects %s', (_label, overrides, expected) => {
    expect(diagnostics(schemaRoot(overrides)).join('\n')).toContain(expected)
  })

  it('rejects schema subdirectories', () => {
    const root = schemaRoot()
    mkdirSync(resolve(root, 'platform/db/schema/nested'))

    expect(diagnostics(root).join('\n')).toContain('nested is outside')
  })

  it.each([
    [
      'a local factory alias',
      "import { pgTable } from 'drizzle-orm/pg-core'\nconst table = pgTable\nexport const user = table('user', {})\n",
      'wrapped, rebound, or passed',
    ],
    [
      'a wrapper',
      "import { pgTable } from 'drizzle-orm/pg-core'\nconst table = (...args: any[]) => pgTable(...args)\nexport const user = table('user', {})\n",
      'direct top-level exported const',
    ],
    [
      'a dynamic SQL name',
      "import { pgTable } from 'drizzle-orm/pg-core'\nconst name = 'user'\nexport const user = pgTable(name, {})\n",
      'must be direct const pgTable',
    ],
    [
      'a nested pgTable call',
      "import { pgTable } from 'drizzle-orm/pg-core'\nexport const user = register(pgTable('user', {}))\n",
      'direct top-level exported const',
    ],
    [
      'a non-exported pgTable call',
      "import { pgTable } from 'drizzle-orm/pg-core'\nconst user = pgTable('user', {})\n",
      'direct top-level exported const',
    ],
    [
      'an exported non-table variable',
      "import { pgTable } from 'drizzle-orm/pg-core'\nexport const helper = 1\nexport const user = pgTable('user', {})\n",
      'exported variables',
    ],
    [
      'an indirect variable export',
      "import { pgTable } from 'drizzle-orm/pg-core'\nconst helper = 1\nexport { helper }\nexport const user = pgTable('user', {})\n",
      'must be exported at their direct pgTable declaration',
    ],
    [
      'an external re-export',
      "import { pgTable } from 'drizzle-orm/pg-core'\nexport const user = pgTable('user', {})\nexport { hidden } from '../hidden'\n",
      'may export only direct const pgTable declarations',
    ],
    [
      'a CommonJS hidden table factory',
      "import { pgTable } from 'drizzle-orm/pg-core'\n" +
        "export const user = pgTable('user', {})\n" +
        "const hiddenCore = require('drizzle-orm/pg-core')\n" +
        "const hiddenTable = hiddenCore['pgTable']('hidden_table', {})\nvoid hiddenTable\n",
      'cannot acquire pg-core outside a static root named import',
    ],
    [
      'a dynamic hidden table factory',
      "import { pgTable } from 'drizzle-orm/pg-core'\n" +
        "export const user = pgTable('user', {})\n" +
        "const hiddenCore = await import('drizzle-orm/pg-core')\n" +
        "const hiddenTable = hiddenCore.pgTable('hidden_table', {})\nvoid hiddenTable\n",
      'cannot acquire pg-core outside a static root named import',
    ],
    [
      'a split CommonJS hidden table factory',
      "import { pgTable } from 'drizzle-orm/pg-core'\n" +
        "export const user = pgTable('user', {})\n" +
        "const hiddenCore = require('drizzle-orm/' + 'pg-core')\n" +
        "const hiddenTable = hiddenCore['pgTable']('hidden_table', {})\nvoid hiddenTable\n",
      'cannot acquire pg-core outside a static root named import',
    ],
    [
      'an alternate table factory import',
      "import { pgTable, pgTableCreator } from 'drizzle-orm/pg-core'\n" +
        "export const user = pgTable('user', {})\n" +
        "const hiddenTable = pgTableCreator((name) => name)('hidden_table', {})\nvoid hiddenTable\n",
      'outside the pinned schema-builder set',
    ],
  ] as const)('rejects %s', (_label, auth, expected) => {
    expect(diagnostics(schemaRoot({ 'auth.ts': auth })).join('\n')).toContain(expected)
  })

  it('allows type-only pg-core additions beside the pinned runtime builder set', () => {
    const root = schemaRoot({
      'auth.ts':
        "import { pgTable, type PgTable } from 'drizzle-orm/pg-core'\n" +
        "export const user = pgTable('user', {})\ntype T = PgTable\n",
    })

    expect(diagnostics(root)).toEqual([])
  })

  it('allows inert pg-core text and unrelated factory-named properties', () => {
    const root = schemaRoot({
      'auth.ts':
        "import { pgTable } from 'drizzle-orm/pg-core'\n" +
        "export const user = pgTable('user', {})\n" +
        "const note = 'drizzle-orm/pg-core'\n" +
        'const helpers = { pgTable: () => note }\nvoid helpers.pgTable\n',
    })

    expect(diagnostics(root)).toEqual([])
  })

  it.each([
    [
      'a named pgTable call',
      "import { pgTable } from 'drizzle-orm/pg-core'\n" +
        "export const hidden = pgTable('hidden', {})\n",
      'auxiliary schema files cannot import pgTable',
    ],
    [
      'a rebound named pgTable',
      "import { pgTable as factory } from 'drizzle-orm/pg-core'\n" +
        "const rebound = factory\nexport const hidden = rebound('hidden', {})\n",
      'auxiliary schema files cannot import pgTable',
    ],
    [
      'a pg-core namespace call',
      "import * as core from 'drizzle-orm/pg-core'\n" +
        "export const hidden = core.pgTable('hidden', {})\n",
      'auxiliary schema files cannot use broad pg-core imports',
    ],
    [
      'a rebound pg-core namespace factory',
      "import * as core from 'drizzle-orm/pg-core'\n" +
        "const rebound = core.pgTable\nexport const hidden = rebound('hidden', {})\n",
      'auxiliary schema files cannot use broad pg-core imports',
    ],
    [
      'a CommonJS pg-core acquisition',
      "const { pgTable } = require('drizzle-orm/pg-core')\n" +
        "export const hidden = pgTable('hidden', {})\n",
      'auxiliary schema files cannot acquire pg-core at runtime',
    ],
    [
      'a dynamic pg-core acquisition',
      "const core = await import('drizzle-orm/pg-core')\n" +
        "export const hidden = core.pgTable('hidden', {})\n",
      'auxiliary schema files cannot acquire pg-core at runtime',
    ],
    [
      'an aliased runtime pg-core specifier',
      "const moduleName = 'drizzle-orm/pg-core'\n" +
        "const core = require(moduleName)\nexport const hidden = core.pgTable('hidden', {})\n",
      'auxiliary schema files cannot acquire pg-core at runtime',
    ],
    [
      'a split runtime pg-core specifier',
      "const core = require('drizzle-orm/' + 'pg-core')\n" +
        "export const hidden = core.pgTable('hidden', {})\n",
      'auxiliary schema files cannot acquire pg-core at runtime',
    ],
  ] as const)('rejects %s in auxiliary files', (_label, ownership, expected) => {
    const root = schemaRoot({ 'ownership.ts': ownership })

    expect(diagnostics(root).join('\n')).toContain(expected)
  })

  it('allows type-only pg-core references in auxiliary files', () => {
    const root = schemaRoot({
      'ownership.ts':
        "import type { PgTable } from 'drizzle-orm/pg-core'\ntype T = PgTable\n",
    })

    expect(diagnostics(root)).toEqual([])
  })

  it('allows inert pg-core text in auxiliary files', () => {
    const root = schemaRoot({
      'ownership.ts': "export const note = 'drizzle-orm/' + 'pg-core'\n",
    })

    expect(diagnostics(root)).toEqual([])
  })

  it('pins the schema index to the three catalogued table files', () => {
    const root = schemaRoot({
      'index.ts':
        "export * from './auth'\n" +
        "export * from './installation'\n" +
        "export * from './product'\n" +
        "export * from '../hidden'\n",
    })

    expect(diagnostics(root).join('\n')).toContain(
      'schema index may only re-export the fixed table files',
    )
  })

  it.each([
    [
      'duplicate runtime re-exports',
      "export * from './auth'\nexport * from './auth'\nexport * from './installation'\nexport * from './product'\n",
      'must re-export ./auth exactly once',
    ],
    [
      'type-only table re-exports',
      "export type * from './auth'\nexport * from './installation'\nexport * from './product'\n",
      'schema index may only re-export',
    ],
  ] as const)('rejects %s in the schema index', (_label, index, expected) => {
    expect(diagnostics(schemaRoot({ 'index.ts': index })).join('\n')).toContain(expected)
  })

  it.each([
    [
      'binding',
      "import { pgTable } from 'drizzle-orm/pg-core'\nexport const user = pgTable('other_user', {})\n",
      'duplicate schema binding',
    ],
    [
      'SQL name',
      "import { pgTable } from 'drizzle-orm/pg-core'\nexport const otherUser = pgTable('user', {})\n",
      'duplicate SQL table name',
    ],
  ] as const)('rejects a duplicate %s across table files', (_label, installation, expected) => {
    const root = schemaRoot({ 'installation.ts': installation })

    expect(diagnostics(root).join('\n')).toContain(expected)
  })
})
