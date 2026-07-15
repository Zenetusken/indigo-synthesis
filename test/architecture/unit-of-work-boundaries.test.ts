import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { analyzeImportGraph, readTypeScriptSources } from './import-graph'

const sourceRoot = resolve(process.cwd(), 'src')

type WorkflowBoundaryViolation = {
  readonly line: number
  readonly reason: string
}

const nominalCoordinationCapabilities = new Set([
  'AuthenticatedSessionReference',
  'ContentLockIssuanceScope',
  'ContentLockSourceProjection',
  'ContentLockTransactionScope',
  'CredentialLifecycleAuthority',
  'DestructiveReauthenticationAttempt',
  'DestructiveReauthenticationLease',
  'HostBootstrapAuthority',
  'HostInvocationAuthority',
  'InstallationMutationEpoch',
  'LockedContentPlanAttestor',
  'PrelockedSessionIntent',
  'PrelockedSessionLease',
  'PreparedContentLockPlan',
  'SubjectDataGeneration',
  'VerifiedContentLockPlan',
])

function projectPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/')
}

function isProductionSource(path: string): boolean {
  return !/\.(?:test|spec)\.tsx?$/.test(path)
}

function hasDependencyPrefix(specifier: string, dependency: string): boolean {
  return specifier === dependency || specifier.startsWith(`${dependency}/`)
}

function isNeutralCoordinationImport(edge: {
  readonly specifier: string
  readonly to: string | null
}): boolean {
  if (!edge.specifier.startsWith('.')) return false
  return (
    edge.to !== null && projectPath(edge.to).startsWith('src/application/coordination/')
  )
}

function isCryptographyDependency(specifier: string): boolean {
  return /(?:^|[-_/])(?:crypto|cryptography|hash|hashes|hmac)(?:[-_/]|$)/i.test(specifier)
}

function isConcreteCoordinationInfrastructure(path: string): boolean {
  return (
    /^src\/platform\/(?:application-)?coordination(?:\/|\.ts$)/.test(path) ||
    /^src\/platform\/db\/(?:coordination|unit-of-work)(?:\/|\.ts$)/.test(path)
  )
}

function isWorkflowOrProductPolicy(path: string): boolean {
  if (!isProductionSource(path)) return false
  if (path.startsWith('src/application/coordination/')) return false
  return (
    path.startsWith('src/application/workflows/') ||
    /^src\/modules\/[^/]+\/(?:application|domain)\//.test(path)
  )
}

function targetsSourceOwner(
  edge: { readonly specifier: string; readonly to: string | null },
  owner: 'modules' | 'platform',
): boolean {
  if (edge.to && projectPath(edge.to).startsWith(`src/${owner}/`)) return true
  return edge.specifier === `@/${owner}` || edge.specifier.startsWith(`@/${owner}/`)
}

function importDescription(edge: {
  readonly from: string
  readonly specifier: string
  readonly to: string | null
}): string {
  return `${projectPath(edge.from)} -> ${edge.to ? projectPath(edge.to) : edge.specifier}`
}

function declarationName(node: ts.Node): string | null {
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isPropertyAssignment(node)) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text
  }
  return null
}

function isRawLockKeyName(name: string): boolean {
  return /^(?:(?:raw|content|canonical|advisory)(?:Lock)?Keys?|lockKeys?)$/i.test(name)
}

function isStringLike(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

function isContentCoordinate(value: string): boolean {
  const parts = value.split(':')
  return parts.length >= 3 && parts.every((part) => part.length > 0)
}

function templateContainsContentCoordinate(node: ts.TemplateExpression): boolean {
  const literalText = [
    node.head.text,
    ...node.templateSpans.map(({ literal }) => literal.text),
  ]
    .join('')
    .toLowerCase()
  return literalText.includes('methodology:') || literalText.includes('template:')
}

function arrayLiteralForDeclaration(node: ts.Node): ts.ArrayLiteralExpression | null {
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node)) &&
    node.initializer &&
    ts.isArrayLiteralExpression(node.initializer)
  ) {
    return node.initializer
  }
  if (ts.isPropertyAssignment(node) && ts.isArrayLiteralExpression(node.initializer)) {
    return node.initializer
  }
  return null
}

function workflowBoundaryViolations(
  source: string,
  filename = 'workflow-boundary-audit.ts',
): readonly WorkflowBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const violations: WorkflowBoundaryViolation[] = []
  const seen = new Set<string>()

  const addViolation = (node: ts.Node, reason: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    const key = `${line + 1}:${reason}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push({ line: line + 1, reason })
  }

  const visit = (node: ts.Node): void => {
    const name = declarationName(node)
    const array = arrayLiteralForDeclaration(node)
    if (name && isRawLockKeyName(name)) {
      addViolation(node, `raw lock-key declaration:${name}`)
    } else if (
      array &&
      array.elements.length > 0 &&
      array.elements.every(isStringLike) &&
      array.elements.some((element) =>
        isContentCoordinate((element as ts.StringLiteralLike).text),
      )
    ) {
      addViolation(node, 'raw content-coordinate array')
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['createHmac', 'timingSafeEqual'].includes(node.expression.text)
    ) {
      addViolation(node, `content-plan crypto:${node.expression.text}`)
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'crypto') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'globalThis' &&
          node.expression.name.text === 'crypto'))
    ) {
      addViolation(node, 'content-plan crypto:web-crypto')
    } else if (ts.isTemplateExpression(node) && templateContainsContentCoordinate(node)) {
      addViolation(node, 'raw content-coordinate template')
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      ts.isCallExpression(node.parent) &&
      isContentCoordinate(node.text)
    ) {
      addViolation(node, 'raw content-coordinate call argument')
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      (node.text.includes('indigo-content-lock-plan-v1') ||
        node.text === 'content-lock-plan-v1')
    ) {
      addViolation(node, 'content-plan crypto:signing-domain')
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

function capabilityConstructionViolations(
  source: string,
  filename = 'capability-construction-audit.ts',
): readonly WorkflowBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const violations: WorkflowBoundaryViolation[] = []
  const capabilityAliases = new Set<string>()
  const capabilityValueAliases = new Set<string>()
  const capabilityNamespaces = new Set<string>()

  const add = (node: ts.Node, reason: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    violations.push({ line: line + 1, reason })
  }

  const fromCoordination = (specifier: string): boolean => {
    return (
      specifier === '@/application/coordination' ||
      specifier.startsWith('@/application/coordination/') ||
      specifier.includes('/application/coordination')
    )
  }

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      fromCoordination(statement.moduleSpecifier.text)
    ) {
      const clause = statement.importClause
      if (!clause) continue
      if (clause.name && !clause.isTypeOnly) {
        add(clause.name, `coordination capability value import:${clause.name.text}`)
      }
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) {
        capabilityNamespaces.add(bindings.name.text)
        if (!clause.isTypeOnly) {
          add(bindings, `coordination capability value import:${bindings.name.text}`)
        }
      } else if (bindings) {
        for (const element of bindings.elements) {
          const importedName = (element.propertyName ?? element.name).text
          if (!nominalCoordinationCapabilities.has(importedName)) continue
          capabilityAliases.add(element.name.text)
          if (!clause.isTypeOnly && !element.isTypeOnly) {
            capabilityValueAliases.add(element.name.text)
            add(element, `coordination capability value import:${element.name.text}`)
          }
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      fromCoordination(statement.moduleSpecifier.text)
    ) {
      if (!statement.exportClause) {
        add(statement, 'coordination capability re-export:*')
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const importedName = (element.propertyName ?? element.name).text
          if (nominalCoordinationCapabilities.has(importedName)) {
            add(element, `coordination capability re-export:${element.name.text}`)
          }
        }
      }
    }
  }

  const typeReferencesCapability = (node: ts.TypeNode): boolean => {
    if (!ts.isTypeReferenceNode(node)) return false
    if (ts.isIdentifier(node.typeName)) {
      return capabilityAliases.has(node.typeName.text)
    }
    return (
      ts.isIdentifier(node.typeName.left) &&
      capabilityNamespaces.has(node.typeName.left.text) &&
      nominalCoordinationCapabilities.has(node.typeName.right.text)
    )
  }

  let discoveredAlias = true
  while (discoveredAlias) {
    discoveredAlias = false
    for (const statement of sourceFile.statements) {
      if (
        ts.isTypeAliasDeclaration(statement) &&
        !capabilityAliases.has(statement.name.text) &&
        typeReferencesCapability(statement.type)
      ) {
        capabilityAliases.add(statement.name.text)
        discoveredAlias = true
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      capabilityAliases.has(statement.name.text) &&
      statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
    ) {
      add(statement, `coordination capability alias export:${statement.name.text}`)
    }
  }

  const heritageUsesCapabilityValue = (node: ts.Expression): string | null => {
    if (ts.isIdentifier(node) && capabilityValueAliases.has(node.text)) return node.text
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      capabilityNamespaces.has(node.expression.text) &&
      nominalCoordinationCapabilities.has(node.name.text)
    ) {
      return `${node.expression.text}.${node.name.text}`
    }
    return null
  }

  let discoveredSubclass = true
  while (discoveredSubclass) {
    discoveredSubclass = false
    const discover = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const derivesCapability = (node.heritageClauses ?? []).some(
          (clause) =>
            clause.token === ts.SyntaxKind.ExtendsKeyword &&
            clause.types.some(
              (type) => heritageUsesCapabilityValue(type.expression) !== null,
            ),
        )
        const className = node.name?.text
        const variableName =
          ts.isClassExpression(node) &&
          ts.isVariableDeclaration(node.parent) &&
          ts.isIdentifier(node.parent.name)
            ? node.parent.name.text
            : null
        for (const name of [className, variableName]) {
          if (derivesCapability && name && !capabilityValueAliases.has(name)) {
            capabilityValueAliases.add(name)
            discoveredSubclass = true
          }
        }
      }
      ts.forEachChild(node, discover)
    }
    discover(sourceFile)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
        for (const type of clause.types) {
          const name = heritageUsesCapabilityValue(type.expression)
          if (name) {
            add(type, `coordination capability subclass:${name}`)
          }
        }
      }
    } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (typeReferencesCapability(node.type)) {
        add(node, `coordination capability assertion:${node.type.getText(sourceFile)}`)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

describe('UnitOfWork and coordination architecture boundaries', () => {
  const sourceFiles = readTypeScriptSources(sourceRoot)
  const importGraph = analyzeImportGraph(sourceFiles, { sourceRoot })

  it('keeps neutral application coordination infrastructure-free', () => {
    const violations = importGraph.edges
      .filter(({ from }) => {
        const source = projectPath(from)
        return (
          source.startsWith('src/application/coordination/') && isProductionSource(source)
        )
      })
      .filter((edge) => !isNeutralCoordinationImport(edge))
      .map(importDescription)
      .sort()

    expect(violations).toEqual([])
    expect(isNeutralCoordinationImport({ specifier: 'node:fs', to: null })).toBe(false)
    expect(
      isNeutralCoordinationImport({
        specifier: '../../platform/db/client',
        to: resolve(sourceRoot, 'platform/db/client.ts'),
      }),
    ).toBe(false)
    expect(
      isNeutralCoordinationImport({
        specifier: './errors',
        to: resolve(sourceRoot, 'application/coordination/errors.ts'),
      }),
    ).toBe(true)
  })

  it('prevents modules and application code from importing concrete UoW adapters', () => {
    const violations = importGraph.edges
      .filter(({ from }) => {
        const source = projectPath(from)
        return (
          isProductionSource(source) &&
          (source.startsWith('src/modules/') || source.startsWith('src/application/'))
        )
      })
      .filter(({ specifier, to }) => {
        if (to && isConcreteCoordinationInfrastructure(projectPath(to))) return true
        return (
          /^@\/platform\/(?:application-)?coordination(?:\/|$)/.test(specifier) ||
          /^@\/platform\/db\/(?:coordination|unit-of-work)(?:\/|$)/.test(specifier)
        )
      })
      .map(importDescription)
      .sort()

    expect(violations).toEqual([])
  })

  it('keeps concrete UoW adapters independent of product modules', () => {
    const violations = importGraph.edges
      .filter(({ from }) => isConcreteCoordinationInfrastructure(projectPath(from)))
      .filter((edge) => targetsSourceOwner(edge, 'modules'))
      .map(importDescription)
      .sort()

    expect(violations).toEqual([])
  })

  it('keeps the owner projection factory infrastructure-only', () => {
    const violations = importGraph.edges
      .filter(
        ({ specifier }) =>
          specifier === '@/application/coordination/content-lock-infrastructure' ||
          specifier.endsWith('/coordination/content-lock-infrastructure'),
      )
      .filter(({ from }) => {
        const source = projectPath(from)
        return !source.startsWith('src/platform/') && !source.includes('/infrastructure/')
      })
      .map(importDescription)
      .sort()

    expect(violations).toEqual([])
  })

  it('keeps nominal capability construction inside Platform', () => {
    const violations = [...sourceFiles]
      .filter(([path]) => {
        const source = projectPath(path)
        return (
          isProductionSource(source) &&
          !source.startsWith('src/platform/') &&
          !source.startsWith('src/application/coordination/')
        )
      })
      .flatMap(([path, source]) =>
        capabilityConstructionViolations(source, path).map(
          ({ line, reason }) => `${projectPath(path)}:${line} ${reason}`,
        ),
      )

    expect(violations).toEqual([])
    expect(
      capabilityConstructionViolations(`
        import { PrelockedSessionLease as Base } from '@/application/coordination'
        import {
          PrelockedSessionIntent as IntentBase,
        } from '@/application/coordination'
        import type {
          VerifiedContentLockPlan as Plan,
        } from '@/application/coordination'
        import type * as Coordination from '@/application/coordination'
        export type {
          PrelockedSessionLease as ReexportedLease,
        } from '@/application/coordination'
        export type PlanAlias = Plan
        const ForgedExpression = class extends Base {}
        class ForgedLease extends Base {}
        class IndirectForgedLease extends ForgedLease {}
        class ForgedIntent extends IntentBase<'instance-reset'> {}
        const forgedAlias = {} as unknown as PlanAlias
        const forgedQualified = {} as Coordination.VerifiedContentLockPlan
        void ForgedExpression
        void IndirectForgedLease
        void forgedAlias
        void forgedQualified
      `).map(({ reason }) => reason),
    ).toEqual([
      'coordination capability value import:Base',
      'coordination capability value import:IntentBase',
      'coordination capability re-export:ReexportedLease',
      'coordination capability alias export:PlanAlias',
      'coordination capability subclass:Base',
      'coordination capability subclass:Base',
      'coordination capability subclass:ForgedLease',
      'coordination capability subclass:IntentBase',
      'coordination capability assertion:PlanAlias',
      'coordination capability assertion:Coordination.VerifiedContentLockPlan',
    ])
  })

  it('keeps workflow code away from raw content keys and content-plan crypto', () => {
    const workflowFiles = [...sourceFiles].filter(([path]) => {
      const source = projectPath(path)
      return isWorkflowOrProductPolicy(source)
    })

    const importViolations = importGraph.edges
      .filter(({ from }) => {
        const source = projectPath(from)
        return isWorkflowOrProductPolicy(source)
      })
      .filter(
        ({ specifier }) =>
          hasDependencyPrefix(specifier, 'crypto') ||
          hasDependencyPrefix(specifier, 'node:crypto') ||
          isCryptographyDependency(specifier),
      )
      .map(importDescription)

    const syntaxViolations = workflowFiles.flatMap(([path, source]) =>
      workflowBoundaryViolations(source, path).map(
        ({ line, reason }) => `${projectPath(path)}:${line} ${reason}`,
      ),
    )

    expect([...importViolations, ...syntaxViolations].sort()).toEqual([])
  })

  it('detects raw-key and crypto mutations without rejecting opaque projections', () => {
    expect(
      workflowBoundaryViolations(`
        const lockKeys = ['methodology:release-id:1']
        const direct = seal('template:release-id:1')
        const templated = \`methodology:\${releaseId}:\${version}\`
        const signature = createHmac('sha256', secret).update(payload).digest()
        void lockKeys
        void direct
        void templated
        void signature
      `).map(({ reason }) => reason),
    ).toEqual([
      'raw lock-key declaration:lockKeys',
      'raw content-coordinate call argument',
      'raw content-coordinate template',
      'content-plan crypto:createHmac',
    ])

    expect(
      workflowBoundaryViolations(`
        declare const methodologyProjection: ContentLockSourceProjection
        declare const programsProjection: ContentLockSourceProjection
        const projections = [methodologyProjection, programsProjection]
        void projections
      `),
    ).toEqual([])
  })
})
