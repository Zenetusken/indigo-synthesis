import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeImportGraph } from './import-graph'

const bridgePath = resolve(
  process.cwd(),
  'src/platform/application-coordination/scoped-drizzle.ts',
)

describe('scoped Drizzle architecture boundary', () => {
  it('keeps the bridge schema-blind and query-only with one pinned local type escape', () => {
    const source = readFileSync(bridgePath, 'utf8')
    const imports = analyzeImportGraph(new Map([[bridgePath, source]]), {
      sourceRoot: resolve(process.cwd(), 'src'),
    })

    expect(imports.computedImports).toEqual([])
    expect(
      imports.edges.map(({ kind, specifier }) => `${kind}:${specifier}`).sort(),
    ).toEqual(['import:./postgres-unit-of-work', 'import:drizzle-orm/node-postgres'])

    expect(source).not.toMatch(/from ['"]pg(?:\/|['"])/)
    expect(source).not.toMatch(/@\/modules|platform\/db\/schema/)
    expect(source).not.toContain('PoolClient')
    expect(source).not.toContain('NodePgClient')
    expect(source).not.toMatch(/\.connect\s*\(|\.release\s*\(/)
    expect(source).not.toMatch(/scoped\.transaction|scoped\.query\s*\(\s*['"]begin/i)
    expect(source.match(/as never/g)).toHaveLength(1)
    expect(source).toContain('return scoped.query(text, parameters)')
    expect(source).toContain('return scoped.queryArray(text, parameters)')
  })
})
