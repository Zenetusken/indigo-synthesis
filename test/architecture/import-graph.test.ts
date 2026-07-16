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

  it('keeps absolute filesystem and local file-URL imports inside the scanned graph', () => {
    const graph = analyzeImportGraph(
      sourceFiles({
        'modules/alpha/application/a.ts': `
          import '/virtual/src/modules/beta/application/runtime'
          import 'file:///virtual/src/modules/beta/application/runtime.ts?fresh=1#proof'
        `,
        'modules/beta/application/runtime.ts': 'export const runtime = true',
      }),
      { sourceRoot },
    )

    expect(graph.edges).toHaveLength(2)
    expect(graph.edges).toEqual([
      expect.objectContaining({
        internal: true,
        specifier: '/virtual/src/modules/beta/application/runtime',
        to: '/virtual/src/modules/beta/application/runtime.ts',
      }),
      expect.objectContaining({
        internal: true,
        specifier:
          'file:///virtual/src/modules/beta/application/runtime.ts?fresh=1#proof',
        to: '/virtual/src/modules/beta/application/runtime.ts',
      }),
    ])
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

  it('fails closed when CommonJS loading authority is forwarded or manufactured', () => {
    const graph = analyzeImportGraph(
      sourceFiles({
        'modules/alpha/application/aliased.ts': `
          const load = require
          void load('@/modules/beta/application/runtime')
        `,
        'modules/alpha/application/created.ts': `
          import { createRequire as makeRequire } from 'node:module'
          const load = makeRequire(import.meta.url)
          void load('@/modules/beta/application/runtime')
        `,
        'modules/alpha/application/namespace-created.ts': `
          import * as nodeModule from 'node:module'
          const load = nodeModule.createRequire(import.meta.url)
          void load('@/modules/beta/application/runtime')
        `,
        'modules/beta/application/runtime.ts': 'export const runtime = true',
      }),
      { sourceRoot },
    )

    expect(
      graph.computedImports.map(({ from, kind }) => ({
        from: from.replace(`${sourceRoot}/`, ''),
        kind,
      })),
    ).toEqual([
      { from: 'modules/alpha/application/aliased.ts', kind: 'require' },
      { from: 'modules/alpha/application/created.ts', kind: 'require' },
      {
        from: 'modules/alpha/application/namespace-created.ts',
        kind: 'require',
      },
    ])
  })

  it('fails closed on every supported Node module-loader acquisition shape', () => {
    const graph = analyzeImportGraph(
      sourceFiles({
        'modules/alpha/application/cjs-destructured.cjs': `
          const { createRequire } = require('node:module')
          const load = createRequire(__filename)
          void load('@/modules/beta/application/runtime')
        `,
        'modules/alpha/application/cjs-namespace.cjs': `
          const nodeModule = require('module')
          const load = nodeModule.createRequire(__filename)
          void load('@/modules/beta/application/runtime')
        `,
        'modules/alpha/application/dynamic.ts': `
          const { createRequire } = await import('node:module')
          const load = createRequire(import.meta.url)
          void load('@/modules/beta/application/runtime')
        `,
        'modules/alpha/application/default.ts': `
          import nodeModule from 'node:module'
          const load = nodeModule.createRequire(import.meta.url)
          void load('@/modules/beta/application/runtime')
        `,
        'modules/alpha/application/module-class.ts': `
          import { Module } from 'node:module'
          const load = Module.createRequire(import.meta.url)
          void load('@/modules/beta/application/runtime')
        `,
        'modules/alpha/application/process.ts': `
          const nodeModule = process.getBuiltinModule('module')
          const load = nodeModule.createRequire(import.meta.url)
          void load('@/modules/beta/application/runtime')
        `,
        'modules/alpha/application/global-forwarded.cjs': `
          const load = globalThis.require
          void load('@/modules/beta/application/runtime')
        `,
        'modules/alpha/application/global-literal.cjs': `
          void global.require('@/modules/beta/application/runtime')
          void globalThis.module.require('@/modules/beta/application/runtime')
        `,
        'modules/beta/application/runtime.ts': 'export const runtime = true',
      }),
      { sourceRoot },
    )

    expect(
      graph.computedImports.map(({ from }) => from.replace(`${sourceRoot}/`, '')),
    ).toEqual([
      'modules/alpha/application/cjs-destructured.cjs',
      'modules/alpha/application/cjs-namespace.cjs',
      'modules/alpha/application/dynamic.ts',
      'modules/alpha/application/default.ts',
      'modules/alpha/application/module-class.ts',
      'modules/alpha/application/process.ts',
      'modules/alpha/application/global-forwarded.cjs',
    ])
    expect(
      graph.edges.filter(
        ({ from, to }) =>
          from.endsWith('/global-literal.cjs') &&
          to?.endsWith('/modules/beta/application/runtime.ts'),
      ),
    ).toHaveLength(2)
  })

  it('does not invent loader edges for lexically shadowed CommonJS globals', () => {
    const graph = analyzeImportGraph(
      sourceFiles({
        'modules/alpha/application/shadowed.ts': `
          function load(require: (value: string) => unknown) {
            return require('@/modules/beta/application/runtime')
          }
          function inspect(module: { require(value: string): unknown }) {
            return module.require('@/modules/beta/application/runtime')
          }
          function unused(require: unknown, process: unknown) {
            return { require: 'documentation', process }
          }
          function shadowGlobals(
            globalThis: { require(value: string): unknown },
            global: { module: { require(value: string): unknown } },
          ) {
            globalThis.require('@/modules/beta/application/runtime')
            global.module.require('@/modules/beta/application/runtime')
          }
          void load
          void inspect
          void unused
          void shadowGlobals
        `,
        'modules/beta/application/runtime.ts': 'export const runtime = true',
      }),
      { sourceRoot },
    )

    expect(graph.edges).toEqual([])
    expect(graph.computedImports).toEqual([])
  })

  it('tracks literal module.require while leaving require.resolve as a control', () => {
    const graph = analyzeImportGraph(
      sourceFiles({
        'modules/alpha/application/a.cjs': `
          void module.require('@/modules/beta/application/runtime')
          void require.resolve('@/modules/beta/application/runtime')
        `,
        'modules/beta/application/runtime.ts': 'export const runtime = true',
      }),
      { sourceRoot },
    )

    expect(
      graph.edges.map(({ kind, specifier, to }) => ({
        kind,
        specifier,
        to: to?.replace(`${sourceRoot}/`, ''),
      })),
    ).toEqual([
      {
        kind: 'require',
        specifier: '@/modules/beta/application/runtime',
        to: 'modules/beta/application/runtime.ts',
      },
    ])
    expect(graph.computedImports).toEqual([])
  })
})
