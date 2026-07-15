import { describe, expect, it } from 'vitest'
import {
  analyzeImportGraph,
  findModuleCycles,
  isApplicationBoundaryViolation,
} from './import-graph'

const sourceRoot = '/virtual/src'

function sourceFiles(
  entries: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(entries).map(([path, source]) => [`${sourceRoot}/${path}`, source]),
  )
}

describe('TypeScript import graph analysis', () => {
  it('resolves aliases, relative imports, re-exports, and literal dynamic imports', () => {
    const graph = analyzeImportGraph(
      sourceFiles({
        'app/page.tsx': `
          import { localUsers } from '@/modules/identity/server/local-users'
          export { formatActor } from '../modules/identity/application/format-actor'
          const loadHistory = () => import('../modules/training/application/history')
          void localUsers
          void loadHistory
        `,
        'modules/identity/server/local-users.ts': 'export const localUsers = true',
        'modules/identity/application/format-actor.ts':
          'export const formatActor = () => "actor"',
        'modules/training/application/history.ts': 'export const history = []',
      }),
      { sourceRoot },
    )

    expect(
      graph.edges.map(({ from, kind, to }) => ({
        from: from.replace(`${sourceRoot}/`, ''),
        kind,
        to: to?.replace(`${sourceRoot}/`, ''),
      })),
    ).toEqual([
      {
        from: 'app/page.tsx',
        kind: 'import',
        to: 'modules/identity/server/local-users.ts',
      },
      {
        from: 'app/page.tsx',
        kind: 're-export',
        to: 'modules/identity/application/format-actor.ts',
      },
      {
        from: 'app/page.tsx',
        kind: 'dynamic-import',
        to: 'modules/training/application/history.ts',
      },
    ])
    expect(graph.computedImports).toEqual([])
  })

  it('detects cycles even when modules mix alias and relative import spellings', () => {
    const graph = analyzeImportGraph(
      sourceFiles({
        'modules/alpha/application/a.ts': "import '@/modules/beta/application/b'",
        'modules/beta/application/b.ts': "import '../../alpha/application/a'",
      }),
      { sourceRoot },
    )

    expect(findModuleCycles(graph.edges, sourceRoot)).toEqual(['alpha -> beta -> alpha'])
  })

  it('exposes relative and dynamic application-to-infrastructure dependencies', () => {
    const graph = analyzeImportGraph(
      sourceFiles({
        'app/settings/page.tsx':
          "import { users } from '../../modules/identity/infrastructure/users'",
        'components/export-button.tsx':
          "export const loadExport = () => import('@/platform/db/client')",
        'modules/identity/infrastructure/users.ts': 'export const users = []',
        'platform/db/client.ts': 'export const database = true',
      }),
      { sourceRoot },
    )

    expect(
      graph.edges
        .filter((edge) => isApplicationBoundaryViolation(edge, sourceRoot))
        .map(({ specifier }) => specifier),
    ).toEqual(['../../modules/identity/infrastructure/users', '@/platform/db/client'])
  })

  it('reports computed dynamic imports and requires instead of silently omitting them', () => {
    const graph = analyzeImportGraph(
      sourceFiles({
        'modules/alpha/application/a.ts': `
          const target = './runtime'
          void import(target)
          void require(target)
        `,
      }),
      { sourceRoot },
    )

    expect(graph.computedImports).toEqual([
      {
        from: `${sourceRoot}/modules/alpha/application/a.ts`,
        kind: 'dynamic-import',
      },
      {
        from: `${sourceRoot}/modules/alpha/application/a.ts`,
        kind: 'require',
      },
    ])
  })
})
