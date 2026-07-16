import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { analyzeImportGraph, readCodeSources } from './import-graph'

const sourceRoot = resolve(process.cwd(), 'src')

function projectPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/')
}

function isProductionSource(path: string): boolean {
  return !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
}

function prelockedControlClientImportViolations(
  files: ReadonlyMap<string, string>,
  allowedRuntimeImports: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const target = resolve(sourceRoot, 'platform/db/prelocked-control-client.ts')
  const graph = analyzeImportGraph(files, { sourceRoot })
  const targetSpecifiers = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (edge.to !== target || edge.from === target) continue
    const specifiers = targetSpecifiers.get(edge.from) ?? new Set<string>()
    specifiers.add(edge.specifier)
    targetSpecifiers.set(edge.from, specifiers)
  }
  const violations: string[] = []
  for (const computed of graph.computedImports) {
    const source = projectPath(computed.from)
    if (isProductionSource(source)) {
      violations.push(
        `${source}: computed ${computed.kind} could bypass prelocked-control import policy`,
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
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        specifiers.has(statement.moduleSpecifier.text)
      ) {
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        const bindings = clause?.namedBindings
        const allowed = allowedRuntimeImports.get(source)
        if (!allowed || clause?.name || !bindings || ts.isNamespaceImport(bindings)) {
          violations.push(`${source}: unauthorized broad prelocked-control import`)
          continue
        }
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue
          const importedName = element.propertyName?.text ?? element.name.text
          if (!allowed.has(importedName)) {
            violations.push(
              `${source}: unauthorized prelocked-control import:${importedName}`,
            )
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        specifiers.has(statement.moduleSpecifier.text)
      ) {
        violations.push(`${source}: prelocked-control re-export`)
      }
    }
    for (const edge of graph.edges) {
      if (
        edge.from === path &&
        edge.to === target &&
        edge.kind !== 'import' &&
        edge.kind !== 're-export'
      ) {
        violations.push(`${source}: non-static prelocked-control import`)
      }
    }
  }
  return [...new Set(violations)].sort()
}

function credentialConnectionImportViolations(
  files: ReadonlyMap<string, string>,
  allowedRuntimeImports: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const target = resolve(sourceRoot, 'platform/db/credential-connections.ts')
  const graph = analyzeImportGraph(files, { sourceRoot })
  const targetSpecifiers = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (edge.to !== target || edge.from === target) continue
    const specifiers = targetSpecifiers.get(edge.from) ?? new Set<string>()
    specifiers.add(edge.specifier)
    targetSpecifiers.set(edge.from, specifiers)
  }
  const violations: string[] = []
  for (const computed of graph.computedImports) {
    const source = projectPath(computed.from)
    if (isProductionSource(source)) {
      violations.push(
        `${source}: computed ${computed.kind} could bypass credential-connection import policy`,
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
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        specifiers.has(statement.moduleSpecifier.text)
      ) {
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        const bindings = clause?.namedBindings
        const allowed = allowedRuntimeImports.get(source)
        if (!allowed || clause?.name || !bindings || ts.isNamespaceImport(bindings)) {
          violations.push(`${source}: unauthorized broad credential-connection import`)
          continue
        }
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue
          const importedName = element.propertyName?.text ?? element.name.text
          if (!allowed.has(importedName)) {
            violations.push(
              `${source}: unauthorized credential-connection import:${importedName}`,
            )
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        specifiers.has(statement.moduleSpecifier.text)
      ) {
        violations.push(`${source}: credential-connection re-export`)
      }
    }
    for (const edge of graph.edges) {
      if (
        edge.from === path &&
        edge.to === target &&
        edge.kind !== 'import' &&
        edge.kind !== 're-export'
      ) {
        violations.push(`${source}: non-static credential-connection import`)
      }
    }
  }
  return [...new Set(violations)].sort()
}

describe('database connection budget boundaries', () => {
  const productionFiles = new Map([
    ...readCodeSources(sourceRoot),
    ...readCodeSources(resolve(process.cwd(), 'scripts')),
  ])
  const graph = analyzeImportGraph(productionFiles, { sourceRoot })

  it('keeps admission, pool partitioning, and priority selection inside Platform', () => {
    const allowedImporters = new Map<string, ReadonlySet<string>>([
      ['src/platform/db/admission.ts', new Set(['src/platform/db/bounded-pool.ts'])],
      [
        'src/platform/db/connection-topology.ts',
        new Set([
          'src/platform/db/admission.ts',
          'src/platform/db/credential-connections.ts',
          'src/platform/db/database-runtime.ts',
        ]),
      ],
      [
        'src/platform/db/bounded-pool.ts',
        new Set(['src/platform/db/database-runtime.ts']),
      ],
      [
        'src/platform/db/database-runtime.ts',
        new Set(['src/platform/db/client.ts', 'src/platform/db/runtime-registry.ts']),
      ],
      [
        'src/platform/db/runtime-registry.ts',
        new Set([
          'src/platform/application-coordination/runtime-unit-of-work.ts',
          'src/platform/db/client.ts',
          'src/platform/db/credential-connections.ts',
          'src/platform/db/prelocked-control-client.ts',
        ]),
      ],
      [
        'src/platform/db/prelocked-control-client.ts',
        new Set(['src/platform/application-coordination/prelocked-session.ts']),
      ],
      [
        'src/platform/db/credential-connections.ts',
        new Set([
          'src/composition/identity-auth-mutations.ts',
          'src/composition/identity-bootstrap-mutations.ts',
          'src/composition/identity-credential-administration.ts',
          'src/composition/identity-recovery-mutations.ts',
          'src/composition/data-portability-destructive-mutations.ts',
          'src/composition/data-portability-subject-export.ts',
          'src/modules/identity/infrastructure/credential-lifecycle-lock.ts',
        ]),
      ],
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

  it('keeps credential capture and control symbols on exact production consumers', () => {
    const allowedRuntimeImports = new Map<string, ReadonlySet<string>>([
      [
        'src/composition/identity-auth-mutations.ts',
        new Set([
          'CredentialConnectionCapacityError',
          'withSubmittedEmailCredentialCapture',
          'withTrustedCredentialCapture',
        ]),
      ],
      [
        'src/composition/identity-bootstrap-mutations.ts',
        new Set(['withTrustedCredentialCapture']),
      ],
      [
        'src/composition/identity-credential-administration.ts',
        new Set(['CredentialConnectionCapacityError', 'withTrustedCredentialCapture']),
      ],
      [
        'src/composition/identity-recovery-mutations.ts',
        new Set([
          'CredentialConnectionCapacityError',
          'withSubmittedEmailCredentialCapture',
        ]),
      ],
      [
        'src/composition/data-portability-destructive-mutations.ts',
        new Set(['CredentialConnectionCapacityError', 'withTrustedCredentialCapture']),
      ],
      [
        'src/composition/data-portability-subject-export.ts',
        new Set(['CredentialConnectionCapacityError', 'withTrustedCredentialCapture']),
      ],
      [
        'src/modules/identity/infrastructure/credential-lifecycle-lock.ts',
        new Set([
          'CredentialConnectionCapacityError',
          'credentialLifecycleConnectionLimit',
          'credentialLifecycleSubmittedEmailQueueLimit',
          'credentialLifecycleTrustedQueueLimit',
          'withSubmittedEmailCredentialCapture',
          'withSubmittedEmailCredentialControl',
          'withTrustedCredentialCapture',
          'withTrustedCredentialControl',
        ]),
      ],
    ])
    expect(
      credentialConnectionImportViolations(productionFiles, allowedRuntimeImports),
    ).toEqual([])

    const composition = resolve(
      sourceRoot,
      'composition/identity-credential-administration.ts',
    )
    const syntheticFiles = new Map(productionFiles)
    syntheticFiles.set(
      composition,
      `${productionFiles.get(composition) ?? ''}\nimport { withTrustedCredentialControl } from '@/platform/db/credential-connections'\nvoid withTrustedCredentialControl\n`,
    )
    expect(
      credentialConnectionImportViolations(syntheticFiles, allowedRuntimeImports),
    ).toContain(
      'src/composition/identity-credential-administration.ts: unauthorized credential-connection import:withTrustedCredentialControl',
    )
  })

  it('keeps monitored prelocked-control checkout on exact named consumers', () => {
    const allowedRuntimeImports = new Map<string, ReadonlySet<string>>([
      [
        'src/platform/application-coordination/prelocked-session.ts',
        new Set([
          'acquireSubmittedEmailPrelockedControlClient',
          'acquireTrustedPrelockedControlClient',
        ]),
      ],
    ])
    expect(
      prelockedControlClientImportViolations(productionFiles, allowedRuntimeImports),
    ).toEqual([])

    const rogueScript = resolve(process.cwd(), 'scripts/db/rogue-control.ts')
    const syntheticFiles = new Map(productionFiles)
    syntheticFiles.set(
      rogueScript,
      "import { acquireTrustedPrelockedControlClient } from '@/platform/db/prelocked-control-client'\nvoid acquireTrustedPrelockedControlClient\n",
    )
    expect(
      prelockedControlClientImportViolations(syntheticFiles, allowedRuntimeImports),
    ).toContain(
      'scripts/db/rogue-control.ts: unauthorized broad prelocked-control import',
    )

    const allowedConsumer = resolve(
      sourceRoot,
      'platform/application-coordination/prelocked-session.ts',
    )
    syntheticFiles.delete(rogueScript)
    syntheticFiles.set(
      allowedConsumer,
      `${productionFiles.get(allowedConsumer) ?? ''}\nexport * as RawControl from '@/platform/db/prelocked-control-client'\n`,
    )
    expect(
      prelockedControlClientImportViolations(syntheticFiles, allowedRuntimeImports),
    ).toContain(
      'src/platform/application-coordination/prelocked-session.ts: prelocked-control re-export',
    )

    syntheticFiles.set(allowedConsumer, productionFiles.get(allowedConsumer) ?? '')
    syntheticFiles.set(
      rogueScript,
      "const target = '@/platform/db/prelocked-control-client'\nvoid import(target)\n",
    )
    expect(
      prelockedControlClientImportViolations(syntheticFiles, allowedRuntimeImports),
    ).toContain(
      'scripts/db/rogue-control.ts: computed dynamic-import could bypass prelocked-control import policy',
    )

    syntheticFiles.set(
      rogueScript,
      "const target = '@/platform/db/prelocked-control-client'\nvoid require(target)\n",
    )
    expect(
      prelockedControlClientImportViolations(syntheticFiles, allowedRuntimeImports),
    ).toContain(
      'scripts/db/rogue-control.ts: computed require could bypass prelocked-control import policy',
    )
  })
})
