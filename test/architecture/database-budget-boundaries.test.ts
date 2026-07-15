import { relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeImportGraph, readTypeScriptSources } from './import-graph'

const sourceRoot = resolve(process.cwd(), 'src')

function projectPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/')
}

describe('database connection budget boundaries', () => {
  const graph = analyzeImportGraph(readTypeScriptSources(sourceRoot), { sourceRoot })

  it('keeps admission, pool partitioning, and priority selection inside Platform', () => {
    const allowedImporters = new Map<string, ReadonlySet<string>>([
      ['src/platform/db/admission.ts', new Set(['src/platform/db/bounded-pool.ts'])],
      [
        'src/platform/db/bounded-pool.ts',
        new Set(['src/platform/db/database-runtime.ts']),
      ],
      ['src/platform/db/database-runtime.ts', new Set(['src/platform/db/client.ts'])],
    ])
    const violations = graph.edges.flatMap((edge) => {
      if (!edge.to || /\.(?:test|spec)\.tsx?$/.test(edge.from)) return []
      const target = projectPath(edge.to)
      const importers = allowedImporters.get(target)
      if (!importers) return []
      const importer = projectPath(edge.from)
      return importers.has(importer) ? [] : [`${importer} -> ${target}`]
    })

    expect(violations.sort()).toEqual([])
  })
})
