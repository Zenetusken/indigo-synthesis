import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { analyzeImportGraph, readCodeSources } from './import-graph'

const sourceRoot = resolve(process.cwd(), 'src')

type WorkflowBoundaryViolation = {
  readonly line: number
  readonly reason: string
}

const nominalCoordinationCapabilities = new Set([
  'AuthenticatedSessionReference',
  'ContentLockedUnitOfWorkExecution',
  'ContentLockIssuanceScope',
  'ContentLockSourceProjection',
  'ContentLockTransactionScope',
  'CredentialLifecycleAuthority',
  'DestructiveReauthenticationAttempt',
  'DestructiveReauthenticationLease',
  'ExactReplayAuthorizer',
  'HostBootstrapAuthority',
  'HostInvocationAuthority',
  'InstallationMutationEpoch',
  'LockedContentPlanAttestor',
  'NewCommandAuthorizer',
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

function isNonPlatformApplicationSurface(path: string): boolean {
  if (!isProductionSource(path)) return false
  if (path.startsWith('src/application/coordination/')) return false
  return (
    path.startsWith('src/app/') ||
    path.startsWith('src/components/') ||
    path.startsWith('src/application/') ||
    /^src\/modules\/[^/]+\/(?:application|domain)\//.test(path)
  )
}

function isCoordinationInfrastructureSource(path: string): boolean {
  return (
    isProductionSource(path) &&
    (path.startsWith('src/application/coordination/') ||
      isConcreteCoordinationInfrastructure(path))
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

function isStringLike(
  node: ts.Expression,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
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
      node.name.text === 'subtle' &&
      (ts.isIdentifier(node.expression)
        ? node.expression.text === 'crypto'
        : ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'globalThis' &&
          node.expression.name.text === 'crypto')
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

function staticSqlText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map(({ literal }) => literal.text),
    ].join('<dynamic>')
  }
  return null
}

function hardCodedRelations(sql: string): readonly string[] {
  const normalizedSql = sql.replace(/--[^\r\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  if (
    !/(?:^|;)\s*(?:explain(?:\s+\([^)]*\))?\s+)?(?:with\b[\s\S]*?\b(?:select|insert|update|delete|merge)\b|select\b|insert\b|update\b|delete\b|merge\b|truncate\b|copy\b)/i.test(
      normalizedSql,
    )
  ) {
    return []
  }
  const relation = '(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)'
  const qualifiedRelation = `${relation}(?:\\s*\\.\\s*${relation})?`
  const relationClause = new RegExp(
    String.raw`\b(?:from|join|insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|copy)\s+(?:only\s+)?(${qualifiedRelation})`,
    'gi',
  )
  return [...normalizedSql.matchAll(relationClause)].flatMap((match) => {
    const matchedRelation = match[1]
    if (matchedRelation === undefined) return []
    const segments = matchedRelation.match(/"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*/gi)
    const terminal = segments?.at(-1)
    return terminal === undefined
      ? []
      : [terminal.replace(/^"|"$/g, '').replaceAll('""', '"').toLowerCase()]
  })
}

function declaredDatabaseRelations(
  source: string,
  filename = 'schema-relation-audit.ts',
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const relations: string[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'pgTable' &&
      node.arguments[0] !== undefined &&
      isStringLike(node.arguments[0])
    ) {
      relations.push(node.arguments[0].text.toLowerCase())
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return relations
}

function hardCodedRelationSqlViolations(
  source: string,
  databaseRelations: ReadonlySet<string>,
  filename = 'coordination-sql-audit.ts',
): readonly WorkflowBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const violations: WorkflowBoundaryViolation[] = []

  const visit = (node: ts.Node): void => {
    const sql = staticSqlText(node)
    const relations =
      sql === null
        ? []
        : hardCodedRelations(sql).filter((relation) => databaseRelations.has(relation))
    for (const relation of relations) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      violations.push({ line: line + 1, reason: `hard-coded relation SQL:${relation}` })
    }
    if (relations.length > 0 && ts.isTemplateExpression(node)) return
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return unwrapExpression(node.expression)
  }
  return node
}

function isEnumerableRegistryInitializer(node: ts.Expression): boolean {
  const initializer = unwrapExpression(node)
  if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
    return ['Array', 'Map', 'Set'].includes(initializer.expression.text)
  }
  if (
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === 'Object' &&
    initializer.expression.name.text === 'create'
  ) {
    return true
  }
  return (
    ts.isArrayLiteralExpression(initializer) || ts.isObjectLiteralExpression(initializer)
  )
}

function isIntrinsicEnumerableRegistry(node: ts.Expression): boolean {
  const initializer = unwrapExpression(node)
  if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
    return ['Map', 'Set'].includes(initializer.expression.text)
  }
  return (
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === 'Object' &&
    initializer.expression.name.text === 'create'
  )
}

function isCapabilityRegistryName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/i)
    .map((word) => word.toLowerCase())
  const capabilityWords = new Set([
    'authority',
    'authorities',
    'authorizer',
    'authorizers',
    'attestor',
    'attestors',
    'capability',
    'capabilities',
    'client',
    'clients',
    'connection',
    'connections',
    'execution',
    'executions',
    'gateway',
    'gateways',
    'intent',
    'intents',
    'lease',
    'leases',
    'plan',
    'plans',
    'prelocked',
    'projection',
    'projections',
    'scope',
    'scopes',
    'session',
    'sessions',
    'transaction',
    'transactions',
  ])
  const registryWords = new Set([
    'active',
    'by',
    'cache',
    'director',
    'live',
    'pool',
    'registry',
    'registries',
    'state',
    'states',
    'store',
  ])
  const capabilitySubject = words.some((word) => capabilityWords.has(word))
  const registrySemantics = words.some(
    (word) =>
      registryWords.has(word) || (capabilityWords.has(word) && word.endsWith('s')),
  )
  return capabilitySubject && registrySemantics
}

function moduleGlobalRegistryViolations(
  source: string,
  filename = 'coordination-registry-audit.ts',
): readonly WorkflowBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const violations: WorkflowBoundaryViolation[] = []

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.initializer === undefined ||
        !isEnumerableRegistryInitializer(declaration.initializer) ||
        (!isCapabilityRegistryName(declaration.name.text) &&
          !isIntrinsicEnumerableRegistry(declaration.initializer))
      ) {
        continue
      }
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        declaration.getStart(sourceFile),
      )
      violations.push({
        line: line + 1,
        reason: `module-global enumerable registry:${declaration.name.text}`,
      })
    }
  }

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

function mutationAuthorityRuntimeImportViolations(
  files: ReadonlyMap<string, string>,
  allowedRuntimeImports: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const mutationAuthorityPath = resolve(
    sourceRoot,
    'platform/application-coordination/mutation-authority.ts',
  )
  const graph = analyzeImportGraph(files, { sourceRoot })
  const concreteSpecifiers = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (edge.to !== mutationAuthorityPath) continue
    const specifiers = concreteSpecifiers.get(edge.from) ?? new Set<string>()
    specifiers.add(edge.specifier)
    concreteSpecifiers.set(edge.from, specifiers)
  }

  const violations: string[] = []
  for (const computed of graph.computedImports) {
    const source = projectPath(computed.from)
    if (isProductionSource(source)) {
      violations.push(
        `${source}: computed ${computed.kind} could bypass mutation-authority import policy`,
      )
    }
  }
  for (const [path, sourceText] of files) {
    const source = projectPath(path)
    if (!isProductionSource(source) || path === mutationAuthorityPath) continue
    const specifiers = concreteSpecifiers.get(path)
    if (!specifiers) continue
    const sourceFile = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const matchedSpecifiers = new Set<string>()
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !specifiers.has(statement.moduleSpecifier.text)
      ) {
        continue
      }
      matchedSpecifiers.add(statement.moduleSpecifier.text)
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) continue
      if (
        clause.name ||
        (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      ) {
        violations.push(`${source}: broad mutation-authority runtime import`)
        continue
      }
      if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
      const allowed = allowedRuntimeImports.get(source) ?? new Set<string>()
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue
        const importedName = element.propertyName?.text ?? element.name.text
        if (!allowed.has(importedName)) {
          violations.push(
            `${source}: unauthorized mutation-authority runtime import:${importedName}`,
          )
        }
      }
    }
    for (const specifier of specifiers) {
      if (!matchedSpecifiers.has(specifier)) {
        violations.push(`${source}: non-static mutation-authority import:${specifier}`)
      }
    }
  }
  return violations.sort()
}

function externalHostConnectionSeamViolations(
  files: ReadonlyMap<string, string>,
  allowedConsumers: ReadonlySet<string>,
): readonly string[] {
  const prelockedSessionPath = resolve(
    sourceRoot,
    'platform/application-coordination/prelocked-session.ts',
  )
  const graph = analyzeImportGraph(files, { sourceRoot })
  const targetSpecifiers = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (edge.to !== prelockedSessionPath || edge.from === prelockedSessionPath) continue
    const specifiers = targetSpecifiers.get(edge.from) ?? new Set<string>()
    specifiers.add(edge.specifier)
    targetSpecifiers.set(edge.from, specifiers)
  }
  const restrictedSymbols = new Set([
    'PlatformExternalHostConnection',
    'withPlatformExternalHostConnection',
  ])
  const violations: string[] = []
  for (const computed of graph.computedImports) {
    const source = projectPath(computed.from)
    if (isProductionSource(source)) {
      violations.push(
        `${source}: computed ${computed.kind} could bypass external-host connection seam policy`,
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
      ts.ScriptKind.TS,
    )
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        specifiers.has(statement.moduleSpecifier.text)
      ) {
        const clause = statement.importClause
        const bindings = clause?.namedBindings
        const broad = clause?.name || !bindings || ts.isNamespaceImport(bindings)
        const importsRestrictedSymbol =
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some((element) =>
            restrictedSymbols.has(element.propertyName?.text ?? element.name.text),
          )
        if (broad || (importsRestrictedSymbol && !allowedConsumers.has(source))) {
          violations.push(`${source}: unauthorized external-host connection seam import`)
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        specifiers.has(statement.moduleSpecifier.text)
      ) {
        const restricted =
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause) ||
          statement.exportClause.elements.some((element) =>
            restrictedSymbols.has(element.propertyName?.text ?? element.name.text),
          )
        if (restricted) {
          violations.push(
            `${source}: unauthorized external-host connection seam re-export`,
          )
        }
      }
    }
    for (const edge of graph.edges) {
      if (
        edge.from === path &&
        edge.to === prelockedSessionPath &&
        edge.kind !== 'import' &&
        edge.kind !== 're-export'
      ) {
        violations.push(`${source}: non-static external-host connection seam import`)
      }
    }
  }
  return [...new Set(violations)].sort()
}

describe('UnitOfWork and coordination architecture boundaries', () => {
  const sourceFiles = readCodeSources(sourceRoot)
  const productionFiles = new Map([
    ...sourceFiles,
    ...readCodeSources(resolve(process.cwd(), 'scripts')),
  ])
  const importGraph = analyzeImportGraph(sourceFiles, { sourceRoot })
  const databaseRelations = new Set(
    [...sourceFiles]
      .filter(([path]) => projectPath(path).startsWith('src/platform/db/schema/'))
      .flatMap(([path, source]) => declaredDatabaseRelations(source, path)),
  )

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
          (source.startsWith('src/modules/') ||
            source.startsWith('src/application/') ||
            source.startsWith('src/app/') ||
            source.startsWith('src/components/'))
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

  it('keeps production UoW runtime wiring schema-blind and limited to Platform factories', () => {
    const runtimeFactory = 'src/platform/application-coordination/runtime-unit-of-work.ts'
    const imports = importGraph.edges
      .filter(({ from }) => projectPath(from) === runtimeFactory)
      .map(({ specifier }) => specifier)
      .sort()

    expect(imports).toEqual([
      './mutation-authority',
      './postgres-unit-of-work',
      './prelocked-session',
      '@/application/coordination',
      '@/application/coordination/prelocked-session',
      '@/platform/db/runtime-registry',
    ])
  })

  it('keeps concrete UoW adapters schema-blind', () => {
    const violations = importGraph.edges
      .filter(({ from }) => {
        const source = projectPath(from)
        return isProductionSource(source) && isConcreteCoordinationInfrastructure(source)
      })
      .filter(({ specifier, to }) => {
        if (to && projectPath(to).startsWith('src/platform/db/schema')) return true
        return /^@\/platform\/db\/schema(?:\/|$)/.test(specifier)
      })
      .map(importDescription)
      .sort()

    expect(violations).toEqual([])
  })

  it('keeps neutral and concrete coordination code free of hard-coded relation SQL', () => {
    const violations = [...sourceFiles]
      .filter(([path]) => isCoordinationInfrastructureSource(projectPath(path)))
      .flatMap(([path, source]) =>
        hardCodedRelationSqlViolations(source, databaseRelations, path).map(
          ({ line, reason }) => `${projectPath(path)}:${line} ${reason}`,
        ),
      )
      .sort()

    expect([...databaseRelations]).toEqual(
      expect.arrayContaining(['athlete_profile', 'training_command_receipt', 'session']),
    )
    expect(violations).toEqual([])
  })

  it('detects relation-bearing SQL without rejecting schema-blind transaction SQL', () => {
    const sampleRelations = new Set([
      'athlete_profile',
      'training_command_receipt',
      'program_revision',
      'session',
      'deletion_tombstone',
    ])
    expect(
      hardCodedRelationSqlViolations(
        `
        await client.query('SELECT value FROM /* owner projection */ athlete_profile WHERE user_id = $1')
        await client.query(\`INSERT INTO "training_command_receipt" (id) VALUES (\${id})\`)
        await client.query('WITH changed AS (UPDATE public.program_revision SET active = false RETURNING *) SELECT * FROM changed')
        await client.query('DELETE FROM ONLY "public"."session" WHERE id = $1')
        await client.query('TRUNCATE TABLE deletion_tombstone')
      `,
        sampleRelations,
      ).map(({ reason }) => reason),
    ).toEqual([
      'hard-coded relation SQL:athlete_profile',
      'hard-coded relation SQL:training_command_receipt',
      'hard-coded relation SQL:program_revision',
      'hard-coded relation SQL:session',
      'hard-coded relation SQL:deletion_tombstone',
    ])

    expect(
      hardCodedRelationSqlViolations(
        `
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        await client.query('COMMIT')
        await client.query('ROLLBACK')
        await client.query('SELECT pg_advisory_lock($1)')
        await client.query('SELECT pid FROM pg_catalog.pg_locks')
        await client.query("SELECT set_config('statement_timeout', $1, true)")
        await client.query(ownerSuppliedSql, values)
        const message = 'Failed to update session state'
      `,
        sampleRelations,
      ),
    ).toEqual([])
  })

  it('forbids enumerable module-global coordination capability registries', () => {
    const violations = [...sourceFiles]
      .filter(([path]) => isCoordinationInfrastructureSource(projectPath(path)))
      .flatMap(([path, source]) =>
        moduleGlobalRegistryViolations(source, path).map(
          ({ line, reason }) => `${projectPath(path)}:${line} ${reason}`,
        ),
      )
      .sort()

    expect(violations).toEqual([])
  })

  it('detects enumerable global registries while allowing opaque and local state', () => {
    expect(
      moduleGlobalRegistryViolations(`
        const capabilityRegistry = new Map<string, object>()
        const activeConnections = new Set<object>()
        const attestors = new Set<object>()
        const sessionByToken = Object.create(null) as Record<string, object>
        const liveLeaseStore: object[] = []
        const r = new Map<string, object>()
        const values = new Set<object>()
      `).map(({ reason }) => reason),
    ).toEqual([
      'module-global enumerable registry:capabilityRegistry',
      'module-global enumerable registry:activeConnections',
      'module-global enumerable registry:attestors',
      'module-global enumerable registry:sessionByToken',
      'module-global enumerable registry:liveLeaseStore',
      'module-global enumerable registry:r',
      'module-global enumerable registry:values',
    ])

    expect(
      moduleGlobalRegistryViolations(`
        const capabilityStates = new WeakMap<object, object>()
        const sessionStates = new WeakSet<object>()
        const contentLockPlanShapes = ['none', 'programs'] as const
        function useRequestLocalRegistry() {
          const connectionRegistry = new Map<string, object>()
          return connectionRegistry
        }
        void capabilityStates
        void sessionStates
        void contentLockPlanShapes
        void useRequestLocalRegistry
      `),
    ).toEqual([])
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

  it('keeps concrete capability subclassing in the audited Platform issuers', () => {
    const allowedIssuers = new Set([
      'src/platform/application-coordination/content-lock-plan.ts',
      'src/platform/application-coordination/lifecycle-values.ts',
      'src/platform/application-coordination/mutation-authority.ts',
      'src/platform/application-coordination/prelocked-session.ts',
    ])
    const violations = [...sourceFiles]
      .filter(([path]) => {
        const source = projectPath(path)
        return (
          isProductionSource(source) &&
          source.startsWith('src/platform/') &&
          !allowedIssuers.has(source)
        )
      })
      .flatMap(([path, source]) =>
        capabilityConstructionViolations(source, path)
          .filter(({ reason }) => reason.startsWith('coordination capability subclass:'))
          .map(({ line, reason }) => `${projectPath(path)}:${line} ${reason}`),
      )

    expect(violations).toEqual([])
  })

  it('keeps transaction-only mutation-authority helpers on exact production consumers', () => {
    const allowedRuntimeImports = new Map<string, ReadonlySet<string>>([
      [
        'src/composition/identity-auth-mutations.ts',
        new Set(['createPlatformMutationAuthorityIssuer']),
      ],
      [
        'src/composition/identity-bootstrap-mutations.ts',
        new Set(['createPlatformMutationAuthorityIssuer']),
      ],
      [
        'src/composition/identity-credential-administration.ts',
        new Set(['createPlatformMutationAuthorityIssuer']),
      ],
      [
        'src/composition/data-portability-destructive-mutations.ts',
        new Set(['createPlatformMutationAuthorityIssuer']),
      ],
      [
        'src/composition/identity-recovery-mutations.ts',
        new Set(['createPlatformMutationAuthorityIssuer']),
      ],
      [
        'src/composition/identity-host-recovery-mutations.ts',
        new Set(['createPlatformMutationAuthorityIssuer']),
      ],
      [
        'src/composition/identity-session-maintenance.ts',
        new Set(['createPlatformMutationAuthorityIssuer']),
      ],
      [
        'src/platform/application-coordination/postgres-unit-of-work.ts',
        new Set(['consumePreparedMutationAuthority']),
      ],
      [
        'src/platform/application-coordination/prelocked-session.ts',
        new Set([
          'assertPlatformMutationAuthorityScope',
          'bindPlatformMutationAuthorityScope',
          'consumePlatformCredentialPrelockPlan',
          'revokePlatformMutationAuthorityScope',
        ]),
      ],
      [
        'src/platform/application-coordination/request-matrix.ts',
        new Set(['prepareMutationAuthorityClaim']),
      ],
    ])
    expect(
      mutationAuthorityRuntimeImportViolations(productionFiles, allowedRuntimeImports),
    ).toEqual([])

    const rogueScript = resolve(process.cwd(), 'scripts/identity/rogue-authority.ts')
    const syntheticFiles = new Map(productionFiles)
    syntheticFiles.set(
      rogueScript,
      "import { consumePreparedMutationAuthority } from '@/platform/application-coordination/mutation-authority'\nvoid consumePreparedMutationAuthority\n",
    )
    expect(
      mutationAuthorityRuntimeImportViolations(syntheticFiles, allowedRuntimeImports),
    ).toContain(
      'scripts/identity/rogue-authority.ts: unauthorized mutation-authority runtime import:consumePreparedMutationAuthority',
    )

    syntheticFiles.set(
      rogueScript,
      "const target = '@/platform/application-coordination/mutation-authority'\nvoid import(target)\n",
    )
    expect(
      mutationAuthorityRuntimeImportViolations(syntheticFiles, allowedRuntimeImports),
    ).toContain(
      'scripts/identity/rogue-authority.ts: computed dynamic-import could bypass mutation-authority import policy',
    )

    syntheticFiles.set(
      rogueScript,
      "const target = '@/platform/application-coordination/mutation-authority'\nvoid require(target)\n",
    )
    expect(
      mutationAuthorityRuntimeImportViolations(syntheticFiles, allowedRuntimeImports),
    ).toContain(
      'scripts/identity/rogue-authority.ts: computed require could bypass mutation-authority import policy',
    )
  })

  it('reserves raw external-host connection ownership for an audited host adapter', () => {
    const allowedExternalHostAdapters = new Set([
      'src/platform/db/external-host-command.ts',
    ])
    expect(
      externalHostConnectionSeamViolations(productionFiles, allowedExternalHostAdapters),
    ).toEqual([])

    const rogueScript = resolve(process.cwd(), 'scripts/identity/rogue-host.ts')
    const syntheticFiles = new Map(productionFiles)
    syntheticFiles.set(
      rogueScript,
      "import { withPlatformExternalHostConnection } from '@/platform/application-coordination/prelocked-session'\nvoid withPlatformExternalHostConnection\n",
    )
    expect(
      externalHostConnectionSeamViolations(syntheticFiles, allowedExternalHostAdapters),
    ).toContain(
      'scripts/identity/rogue-host.ts: unauthorized external-host connection seam import',
    )

    syntheticFiles.set(
      rogueScript,
      "export * as HostConnection from '@/platform/application-coordination/prelocked-session'\n",
    )
    expect(
      externalHostConnectionSeamViolations(syntheticFiles, allowedExternalHostAdapters),
    ).toContain(
      'scripts/identity/rogue-host.ts: unauthorized external-host connection seam re-export',
    )

    syntheticFiles.set(
      rogueScript,
      "const target = '@/platform/application-coordination/prelocked-session'\nvoid import(target)\n",
    )
    expect(
      externalHostConnectionSeamViolations(syntheticFiles, allowedExternalHostAdapters),
    ).toContain(
      'scripts/identity/rogue-host.ts: computed dynamic-import could bypass external-host connection seam policy',
    )

    syntheticFiles.set(
      rogueScript,
      "const target = '@/platform/application-coordination/prelocked-session'\nvoid require(target)\n",
    )
    expect(
      externalHostConnectionSeamViolations(syntheticFiles, allowedExternalHostAdapters),
    ).toContain(
      'scripts/identity/rogue-host.ts: computed require could bypass external-host connection seam policy',
    )
  })

  it('keeps the non-Platform application surface away from raw content keys and content-plan crypto', () => {
    const workflowFiles = [...sourceFiles].filter(([path]) => {
      const source = projectPath(path)
      return isNonPlatformApplicationSurface(source)
    })

    const importViolations = importGraph.edges
      .filter(({ from }) => {
        const source = projectPath(from)
        return isNonPlatformApplicationSurface(source)
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
      [
        'src/app/today/actions.ts',
        'src/components/action-button.tsx',
        'src/application/workflows/example.ts',
        'src/modules/training/application/workouts.ts',
        'src/modules/programs/domain/program.ts',
        'src/application/coordination/content-lock-plan.ts',
        'src/modules/identity/infrastructure/credential-lifecycle-lock.ts',
        'src/platform/application-coordination/content-lock-plan.ts',
      ].map(isNonPlatformApplicationSurface),
    ).toEqual([true, true, true, true, true, false, false, false])

    expect(
      workflowBoundaryViolations(`
        const lockKeys = ['methodology:release-id:1']
        const direct = seal('template:release-id:1')
        const templated = \`methodology:\${releaseId}:\${version}\`
        const signature = createHmac('sha256', secret).update(payload).digest()
        const browserSignature = globalThis.crypto.subtle.sign(algorithm, key, payload)
        void lockKeys
        void direct
        void templated
        void signature
        void browserSignature
      `).map(({ reason }) => reason),
    ).toEqual([
      'raw lock-key declaration:lockKeys',
      'raw content-coordinate call argument',
      'raw content-coordinate template',
      'content-plan crypto:createHmac',
      'content-plan crypto:web-crypto',
    ])

    expect(
      workflowBoundaryViolations(`
        declare const methodologyProjection: ContentLockSourceProjection
        declare const programsProjection: ContentLockSourceProjection
        const projections = [methodologyProjection, programsProjection]
        const commandId = globalThis.crypto.randomUUID()
        void projections
        void commandId
      `),
    ).toEqual([])
  })
})
