import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { analyzeImportGraph, readCodeSources } from './import-graph'

const sourceRoot = resolve(process.cwd(), 'src')
const externalHostOwnerPath = resolve(sourceRoot, 'platform/db/external-host-one-shot.ts')
const rawOwnerSymbol = 'withExternalHostClientOwner'
const safeOneShotSymbol = 'withExternalHostOneShot'

function projectPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/')
}

function isProductionSource(path: string): boolean {
  return !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
}

function productionFiles(): ReadonlyMap<string, string> {
  return new Map(
    [
      ...readCodeSources(sourceRoot),
      ...readCodeSources(resolve(process.cwd(), 'scripts')),
    ].filter(([path]) => isProductionSource(projectPath(path))),
  )
}

function runtimeReachabilityViolations(
  files: ReadonlyMap<string, string>,
  entries: readonly string[],
  forbiddenTargets: ReadonlySet<string>,
): readonly string[] {
  const graph = analyzeImportGraph(files, { sourceRoot })
  const outgoing = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (!edge.to || !edge.runtime) continue
    const targets = outgoing.get(edge.from) ?? new Set<string>()
    targets.add(edge.to)
    outgoing.set(edge.from, targets)
  }

  const violations = new Set<string>()
  for (const root of entries) {
    const pending: Array<{ readonly current: string; readonly path: readonly string[] }> =
      [{ current: root, path: [root] }]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const { current, path } = pending.pop() as {
        readonly current: string
        readonly path: readonly string[]
      }
      if (seen.has(current)) continue
      seen.add(current)
      for (const target of outgoing.get(current) ?? []) {
        const nextPath = [...path, target]
        if (forbiddenTargets.has(target)) {
          violations.add(nextPath.map(projectPath).join(' -> '))
        } else {
          pending.push({ current: target, path: nextPath })
        }
      }
    }
  }
  return [...violations].sort()
}

type RawOwnerAudit = {
  readonly consumers: readonly string[]
  readonly violations: readonly string[]
}

function safeOneShotAudit(files: ReadonlyMap<string, string>): RawOwnerAudit {
  const graph = analyzeImportGraph(files, { sourceRoot })
  const consumers = new Set<string>()
  const violations = new Set<string>()
  const allowedConsumer = 'src/platform/db/host-preflight.ts'

  for (const edge of graph.edges) {
    if (edge.to !== externalHostOwnerPath || edge.from === externalHostOwnerPath) continue
    const source = projectPath(edge.from)
    if (!isProductionSource(source) || edge.kind === 'import-type') continue
    const sourceFile = ts.createSourceFile(
      edge.from,
      files.get(edge.from) ?? '',
      ts.ScriptTarget.Latest,
      true,
      edge.from.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === edge.specifier
      ) {
        const bindings = statement.importClause?.namedBindings
        if (!bindings || !ts.isNamedImports(bindings)) continue
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text
          if (element.isTypeOnly || importedName !== safeOneShotSymbol) continue
          consumers.add(source)
          if (source !== allowedConsumer) {
            violations.add(`${source}: unauthorized import of ${safeOneShotSymbol}`)
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === edge.specifier &&
        !statement.isTypeOnly
      ) {
        const exports = statement.exportClause
        if (
          !exports ||
          ts.isNamespaceExport(exports) ||
          exports.elements.some(
            (element) =>
              !element.isTypeOnly &&
              (element.propertyName?.text ?? element.name.text) === safeOneShotSymbol,
          )
        ) {
          violations.add(`${source}: re-export exposes the safe external-host one-shot`)
        }
      }
    }
  }

  return { consumers: [...consumers].sort(), violations: [...violations].sort() }
}

function rawOwnerAudit(files: ReadonlyMap<string, string>): RawOwnerAudit {
  const graph = analyzeImportGraph(files, { sourceRoot })
  const targetSpecifiers = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (edge.to !== externalHostOwnerPath || edge.from === externalHostOwnerPath) {
      continue
    }
    const specifiers = targetSpecifiers.get(edge.from) ?? new Set<string>()
    specifiers.add(edge.specifier)
    targetSpecifiers.set(edge.from, specifiers)
  }

  const allowedConsumers = new Set([
    'src/platform/db/external-host-command.ts',
    'src/platform/db/host-migrate.ts',
  ])
  const consumers = new Set<string>()
  const violations = new Set<string>()

  for (const computed of graph.computedImports) {
    const source = projectPath(computed.from)
    if (isProductionSource(source)) {
      violations.add(
        `${source}: computed ${computed.kind} could bypass the raw external-host owner policy`,
      )
    }
  }

  for (const [path, specifiers] of targetSpecifiers) {
    const source = projectPath(path)
    if (!isProductionSource(source)) continue
    const sourceFile = ts.createSourceFile(
      path,
      files.get(path) ?? '',
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const matchedStaticSpecifiers = new Set<string>()

    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        specifiers.has(statement.moduleSpecifier.text)
      ) {
        matchedStaticSpecifiers.add(statement.moduleSpecifier.text)
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        const bindings = clause?.namedBindings
        if (!clause || clause.name || !bindings || ts.isNamespaceImport(bindings)) {
          violations.add(`${source}: broad import exposes the raw external-host owner`)
          continue
        }
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue
          const importedName = element.propertyName?.text ?? element.name.text
          if (importedName !== rawOwnerSymbol) continue
          consumers.add(source)
          if (!allowedConsumers.has(source)) {
            violations.add(`${source}: unauthorized import of ${rawOwnerSymbol}`)
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        specifiers.has(statement.moduleSpecifier.text)
      ) {
        matchedStaticSpecifiers.add(statement.moduleSpecifier.text)
        if (statement.isTypeOnly) continue
        const exports = statement.exportClause
        const exposesRawOwner =
          !exports ||
          ts.isNamespaceExport(exports) ||
          exports.elements.some(
            (element) =>
              !element.isTypeOnly &&
              (element.propertyName?.text ?? element.name.text) === rawOwnerSymbol,
          )
        if (exposesRawOwner) {
          violations.add(`${source}: re-export exposes the raw external-host owner`)
        }
      }
    }

    for (const edge of graph.edges) {
      if (
        edge.from === path &&
        edge.to === externalHostOwnerPath &&
        edge.kind !== 'import' &&
        edge.kind !== 're-export' &&
        edge.kind !== 'import-type'
      ) {
        violations.add(`${source}: non-static import exposes the raw external-host owner`)
      }
    }
    for (const specifier of specifiers) {
      const hasOnlyImportType = graph.edges.every(
        (edge) =>
          edge.from !== path ||
          edge.specifier !== specifier ||
          edge.kind === 'import-type',
      )
      if (!matchedStaticSpecifiers.has(specifier) && !hasOnlyImportType) {
        violations.add(`${source}: non-static import exposes the raw external-host owner`)
      }
    }
  }

  return {
    consumers: [...consumers].sort(),
    violations: [...violations].sort(),
  }
}

describe('external-host one-shot architecture contract', () => {
  it('keeps production database preflight and migration off application pools', () => {
    const files = productionFiles()
    const entries = [
      resolve(process.cwd(), 'scripts/db/preflight.ts'),
      resolve(process.cwd(), 'scripts/db/migrate.ts'),
    ]
    const forbiddenTargets = new Set(
      [
        'platform/db/bounded-pool.ts',
        'platform/db/client.ts',
        'platform/db/database-runtime.ts',
        'platform/db/runtime-registry.ts',
      ].map((path) => resolve(sourceRoot, path)),
    )

    for (const entry of entries) {
      expect(
        files.has(entry),
        `missing production entrypoint ${projectPath(entry)}`,
      ).toBe(true)
    }
    expect(runtimeReachabilityViolations(files, entries, forbiddenTargets)).toEqual([])

    const direct = new Map(files)
    direct.set(
      entries[0],
      `${files.get(entries[0]) ?? ''}\nimport { getDb } from '@/platform/db/client'\nvoid getDb\n`,
    )
    expect(runtimeReachabilityViolations(direct, entries, forbiddenTargets)).toContain(
      'scripts/db/preflight.ts -> src/platform/db/client.ts',
    )

    const alternateLoader = new Map(files)
    alternateLoader.set(
      entries[0],
      `${files.get(entries[0]) ?? ''}\nvoid globalThis.module.require('@/platform/db/client')\n`,
    )
    expect(
      runtimeReachabilityViolations(alternateLoader, entries, forbiddenTargets),
    ).toContain('scripts/db/preflight.ts -> src/platform/db/client.ts')

    const helper = resolve(sourceRoot, 'platform/db/rogue-host-helper.ts')
    const transitive = new Map(files)
    transitive.set(
      helper,
      "import { getDb } from './client'\nexport const rogueHostHelper = getDb\n",
    )
    transitive.set(
      entries[1],
      `${files.get(entries[1]) ?? ''}\nimport { rogueHostHelper } from '../../src/platform/db/rogue-host-helper'\nvoid rogueHostHelper\n`,
    )
    expect(
      runtimeReachabilityViolations(transitive, entries, forbiddenTargets),
    ).toContain(
      'scripts/db/migrate.ts -> src/platform/db/rogue-host-helper.ts -> src/platform/db/client.ts',
    )
  })

  it('reserves the raw client owner for the platform bridge and host migration', () => {
    const files = productionFiles()
    expect(files.has(externalHostOwnerPath)).toBe(true)
    expect(rawOwnerAudit(files)).toEqual({
      consumers: [
        'src/platform/db/external-host-command.ts',
        'src/platform/db/host-migrate.ts',
      ],
      violations: [],
    })

    const rogue = resolve(process.cwd(), 'scripts/db/rogue-host.ts')
    const unauthorized = new Map(files)
    unauthorized.set(
      rogue,
      "import { withExternalHostClientOwner as own } from '../../src/platform/db/external-host-one-shot'\nvoid own\n",
    )
    expect(rawOwnerAudit(unauthorized).violations).toContain(
      `scripts/db/rogue-host.ts: unauthorized import of ${rawOwnerSymbol}`,
    )

    unauthorized.set(
      rogue,
      "export { withExternalHostClientOwner } from '../../src/platform/db/external-host-one-shot'\n",
    )
    expect(rawOwnerAudit(unauthorized).violations).toContain(
      'scripts/db/rogue-host.ts: re-export exposes the raw external-host owner',
    )

    unauthorized.set(
      rogue,
      "const target = '../../src/platform/db/external-host-one-shot'\nvoid import(target)\n",
    )
    expect(rawOwnerAudit(unauthorized).violations).toContain(
      'scripts/db/rogue-host.ts: computed dynamic-import could bypass the raw external-host owner policy',
    )
  })

  it('reserves the query-surface one-shot for observational host preflight', () => {
    const files = productionFiles()
    expect(safeOneShotAudit(files)).toEqual({
      consumers: ['src/platform/db/host-preflight.ts'],
      violations: [],
    })

    const rogue = resolve(process.cwd(), 'scripts/db/rogue-observer.ts')
    const unauthorized = new Map(files)
    unauthorized.set(
      rogue,
      "import { withExternalHostOneShot as observe } from '../../src/platform/db/external-host-one-shot'\nvoid observe\n",
    )
    expect(safeOneShotAudit(unauthorized).violations).toContain(
      `scripts/db/rogue-observer.ts: unauthorized import of ${safeOneShotSymbol}`,
    )

    unauthorized.set(
      rogue,
      "export { withExternalHostOneShot } from '../../src/platform/db/external-host-one-shot'\n",
    )
    expect(safeOneShotAudit(unauthorized).violations).toContain(
      'scripts/db/rogue-observer.ts: re-export exposes the safe external-host one-shot',
    )
  })
})
