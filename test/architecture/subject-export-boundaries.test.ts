import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  subjectExportReadContract,
  subjectExportReadManifest,
} from '@/modules/data-portability/infrastructure/scoped-subject-export'

const approvedAdapterImports = new Map<string, ReadonlySet<string>>([
  ['drizzle-orm', new Set(['and', 'asc', 'eq', 'inArray', 'sql'])],
  ['drizzle-orm/node-postgres', new Set(['NodePgDatabase'])],
  [
    '@/modules/data-portability/application/export',
    new Set(['DataExportError', 'DataExportFiles']),
  ],
  [
    '@/modules/programs/domain/content-eligibility',
    new Set(['evaluatePersistedContentEligibility']),
  ],
  ['@/platform/config/server', new Set(['getServerConfig'])],
  ['@/platform/db/schema', new Set(Object.keys(subjectExportReadContract))],
])
const approvedSubjectReadMethods = new Set([
  'from',
  'fullJoin',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'select',
])
const subjectDatabaseMethodShapes = new Set([
  '$with',
  'delete',
  'execute',
  ...approvedSubjectReadMethods,
  'insert',
  'query',
  'raw',
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'transaction',
  'update',
  'with',
])

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function exportedNames(value: string): readonly string[] {
  const ast = ts.createSourceFile(
    'export-surface.ts',
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const names: string[] = []
  const bindings = (name: ts.BindingName): readonly string[] =>
    ts.isIdentifier(name)
      ? [name.text]
      : name.elements.flatMap((element) =>
          ts.isOmittedExpression(element) ? [] : bindings(element.name),
        )
  for (const statement of ast.statements) {
    if (ts.isExportAssignment(statement)) {
      names.push(statement.isExportEquals ? '<export-equals>' : 'default')
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (!clause) {
        const module =
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : '<unknown>'
        names.push(`<export-all:${module}>`)
      } else if (ts.isNamespaceExport(clause)) {
        names.push(clause.name.text)
      } else {
        names.push(...clause.elements.map((element) => element.name.text))
      }
      continue
    }
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    const defaultExport =
      ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)
    if (defaultExport) {
      names.push('default')
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.push(...bindings(declaration.name))
      }
    } else if (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text)
    }
  }
  return names.sort()
}

function unwrapCapabilityExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text
  }
  return undefined
}

function queryBuilderHasTerminalUse(call: ts.CallExpression): boolean {
  const approvedFluentMethods = new Set(['from', 'limit', 'orderBy', 'where'])
  let current: ts.Expression = call
  while (true) {
    const parent = current.parent
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      if (!approvedFluentMethods.has(parent.name.text)) return false
      current = parent.parent
      continue
    }
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent
      continue
    }
    break
  }
  if (ts.isAwaitExpression(current.parent) && current.parent.expression === current) {
    return true
  }
  const callback = current.parent
  if (!ts.isArrowFunction(callback) || callback.body !== current) return false
  const invocation = callback.parent
  return (
    ts.isCallExpression(invocation) &&
    invocation.arguments[1] === callback &&
    ts.isIdentifier(invocation.expression) &&
    invocation.expression.text === 'collectInBoundedChunks'
  )
}

function subjectExportDatabaseCapabilityViolations(value: string): readonly string[] {
  const ast = ts.createSourceFile(
    'scoped-subject-export.ts',
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const capabilityNames = new Set(['database', 'db', 'transaction'])
  const databaseTypeNames = new Set(['NodePgDatabase'])
  const aliases = new Set<string>()
  const violations: string[] = []
  let readerDeclarations = 0
  let readerCalls = 0
  let chunkReaderDeclarations = 0
  for (let changed = true; changed; ) {
    changed = false
    const collectTypes = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node)) {
        const text = node.type.getText(ast)
        if (
          [...databaseTypeNames].some((name) => new RegExp(`\\b${name}\\b`).test(text)) &&
          !databaseTypeNames.has(node.name.text)
        ) {
          databaseTypeNames.add(node.name.text)
          changed = true
        }
      }
      ts.forEachChild(node, collectTypes)
    }
    collectTypes(ast)
  }
  const isCapability = (expression: ts.Expression): boolean => {
    const candidate = unwrapCapabilityExpression(expression)
    return (
      ts.isIdentifier(candidate) &&
      (capabilityNames.has(candidate.text) || aliases.has(candidate.text))
    )
  }

  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'readSubjectExportFiles') {
      readerDeclarations += 1
      if (node.parent !== ast) violations.push('subject export reader is not top-level')
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'collectInBoundedChunks') {
      chunkReaderDeclarations += 1
      if (node.parent !== ast) violations.push('bounded chunk reader is not top-level')
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'readSubjectExportFiles'
    ) {
      violations.push('subject export reader shadow')
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'collectInBoundedChunks'
    ) {
      violations.push('bounded chunk reader shadow')
    }
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      node.type &&
      [...databaseTypeNames].some((name) =>
        new RegExp(`\\b${name}\\b`).test(node.type?.getText(ast) ?? ''),
      )
    ) {
      capabilityNames.add(node.name.text)
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isCapability(node.initializer)
    ) {
      if (ts.isIdentifier(node.name)) aliases.add(node.name.text)
      violations.push('database capability alias')
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isCapability(node.right)
    ) {
      if (ts.isIdentifier(node.left)) aliases.add(node.left.text)
      violations.push('database capability reassignment')
    }
    ts.forEachChild(node, collect)
  }
  collect(ast)
  if (readerDeclarations !== 1) {
    violations.push('subject export reader declaration count')
  }
  if (chunkReaderDeclarations !== 1) {
    violations.push('bounded chunk reader declaration count')
  }

  const visit = (node: ts.Node): void => {
    const computedCall =
      ts.isElementAccessExpression(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node
    if (
      ts.isElementAccessExpression(node) &&
      (isCapability(node.expression) || computedCall)
    ) {
      violations.push('computed database method use')
      const method = node.argumentExpression
      if (method && ts.isStringLiteralLike(method) && method.text !== 'select') {
        violations.push(`unapproved database method:${method.text}`)
      }
      if (computedCall && enclosingFunctionName(node) !== 'readSubjectExportFiles') {
        violations.push('database method outside subject export reader')
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      (isCapability(node.expression) || subjectDatabaseMethodShapes.has(node.name.text))
    ) {
      const directCall =
        ts.isCallExpression(node.parent) && node.parent.expression === node
      if (!approvedSubjectReadMethods.has(node.name.text)) {
        violations.push(`unapproved database method:${node.name.text}`)
      }
      if (!directCall) violations.push(`indirect database method:${node.name.text}`)
      if (enclosingFunctionName(node) !== 'readSubjectExportFiles') {
        violations.push('database method outside subject export reader')
      }
      if (
        node.name.text === 'select' &&
        isCapability(node.expression) &&
        directCall &&
        !queryBuilderHasTerminalUse(node.parent as ts.CallExpression)
      ) {
        violations.push('subject query builder capability escape')
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'readSubjectExportFiles'
    ) {
      readerCalls += 1
      if (enclosingFunctionName(node) !== 'createScopedSubjectExportGateway') {
        violations.push('subject export reader call outside scoped gateway')
      }
    }
    if (ts.isIdentifier(node) && node.text === 'readSubjectExportFiles') {
      const declarationName =
        ts.isFunctionDeclaration(node.parent) && node.parent.name === node
      const directCall =
        ts.isCallExpression(node.parent) && node.parent.expression === node
      const typeQuery = ts.isTypeQueryNode(node.parent)
      if (!declarationName && !directCall && !typeQuery) {
        violations.push('indirect subject export reader use')
      }
    }
    if (
      ts.isIdentifier(node) &&
      (capabilityNames.has(node.text) || aliases.has(node.text))
    ) {
      const parent = node.parent
      const declaration =
        (ts.isParameter(parent) || ts.isVariableDeclaration(parent)) &&
        parent.name === node
      const capabilityReceiver =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node
      const approvedFactoryPass =
        ts.isCallExpression(parent) &&
        parent.arguments.includes(node) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'readSubjectExportFiles' &&
        enclosingFunctionName(node) === 'createScopedSubjectExportGateway'
      if (!declaration && !capabilityReceiver && !approvedFactoryPass) {
        violations.push(`database capability escape:${node.text}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (readerCalls !== 1) violations.push('subject export reader call count')
  return [...new Set(violations)].sort()
}

function scopedAdapterViolations(value: string): readonly string[] {
  const violations: string[] = []
  if (/\.select\(\s*\)/.test(value)) violations.push('zero-argument select')
  if (/\bsql\s*\./.test(value)) violations.push('sql property API')
  for (const method of ['delete', 'execute', 'insert', 'transaction', 'update']) {
    if (new RegExp(`\\.${method}\\s*\\(`).test(value)) {
      violations.push(`database mutation:${method}`)
    }
  }
  if (
    /from ['"]@\/platform\/db\/(?:client|database-runtime|runtime-registry)['"]/.test(
      value,
    )
  ) {
    violations.push('raw database runtime import')
  }
  violations.push(...subjectExportDatabaseCapabilityViolations(value))
  return [...new Set(violations)].sort()
}

function adapterRelationContract(value: string): Readonly<{
  relations: readonly string[]
  violations: readonly string[]
}> {
  const ast = ts.createSourceFile(
    'scoped-subject-export.ts',
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const relations = new Set<string>()
  const importedByModule = new Map<string, Set<string>>()
  const sqlBindings = new Set<string>()
  const violations: string[] = []
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const module = statement.moduleSpecifier.text
    const approved = approvedAdapterImports.get(module)
    if (!approved) violations.push(`unapproved import:${module}`)
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    if (!clause || clause.name || !bindings) {
      violations.push(`broad import:${module}`)
      continue
    }
    if (ts.isNamespaceImport(bindings)) {
      violations.push(`namespace import:${module}`)
      continue
    }
    const names = importedByModule.get(module) ?? new Set<string>()
    importedByModule.set(module, names)
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      names.add(importedName)
      if (element.propertyName) {
        violations.push(`aliased import:${module}:${importedName}`)
      }
      if (module === '@/platform/db/schema') relations.add(element.name.text)
      if (module === 'drizzle-orm' && importedName === 'sql') {
        sqlBindings.add(element.name.text)
      }
    }
  }
  for (const [module, approved] of approvedAdapterImports) {
    const observed = importedByModule.get(module) ?? new Set<string>()
    if (
      observed.size !== approved.size ||
      [...approved].some((name) => !observed.has(name))
    ) {
      violations.push(`import contract:${module}`)
    }
  }

  const observedReads = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['from', 'fullJoin', 'innerJoin', 'leftJoin', 'rightJoin'].includes(
        node.expression.name.text,
      )
    ) {
      const relation = node.arguments[0]
      if (!relation || !ts.isIdentifier(relation)) {
        violations.push(`non-identifier relation:${node.expression.name.text}`)
      } else {
        observedReads.add(relation.text)
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'select'
    ) {
      const projection = node.arguments[0]
      if (!projection || !ts.isObjectLiteralExpression(projection)) {
        violations.push('non-explicit select projection')
      } else {
        for (const property of projection.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            !ts.isPropertyAccessExpression(property.initializer) ||
            !ts.isIdentifier(property.initializer.expression) ||
            !relations.has(property.initializer.expression.text)
          ) {
            violations.push('non-column select projection')
          }
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      if (!ts.isIdentifier(node.tag) || !sqlBindings.has(node.tag.text)) {
        violations.push('unapproved tagged template')
        ts.forEachChild(node, visit)
        return
      }
      const spans = ts.isTemplateExpression(node.template)
        ? node.template.templateSpans
        : []
      let statement = ts.isTemplateExpression(node.template)
        ? node.template.head.text
        : node.template.text
      for (const [index, span] of spans.entries()) {
        statement += ` __INDIGO_RELATION_${index}__ ${span.literal.text}`
      }
      violations.push(...sqlStatementViolations(statement, { rejectCommas: true }))
      for (const relation of sqlRelations(statement)) {
        const marker = /^__INDIGO_RELATION_(\d+)__$/.exec(relation)
        if (!marker) {
          violations.push(`static sql relation:${relation}`)
          continue
        }
        const index = Number(marker[1])
        const expression = spans[index]?.expression
        if (!expression || !ts.isIdentifier(expression)) {
          violations.push(`indirect sql relation:${relation}`)
        } else if (!relations.has(expression.text)) {
          violations.push(`indirect sql relation:${expression.text}`)
        } else {
          observedReads.add(expression.text)
        }
      }
    }
    if (ts.isIdentifier(node) && sqlBindings.has(node.text)) {
      const parent = node.parent
      const importBinding =
        ts.isImportSpecifier(parent) &&
        (parent.name === node || parent.propertyName === node)
      const directTag = ts.isTaggedTemplateExpression(parent) && parent.tag === node
      if (!importBinding && !directTag) violations.push(`sql non-tag use:${node.text}`)
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'raw') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'raw')
    ) {
      violations.push('raw SQL property access')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  for (const relation of observedReads) {
    if (!relations.has(relation)) violations.push(`indirect relation:${relation}`)
  }
  for (const relation of relations) {
    if (!observedReads.has(relation))
      violations.push(`unused schema relation:${relation}`)
  }
  return Object.freeze({
    relations: [...relations].sort(),
    violations: [...new Set(violations)].sort(),
  })
}

function sqlRelations(value: string): readonly string[] {
  const relations = new Set<string>()
  const pattern =
    /\b(?:FROM|JOIN)\s+((?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*))?)/gi
  for (const match of value.matchAll(pattern)) {
    const qualified = match[1]
    if (!qualified) continue
    const relation = qualified.split('.').at(-1)?.trim().replaceAll('"', '')
    if (relation) relations.add(relation)
  }
  return [...relations].sort()
}

function sqlStatementViolations(
  value: string,
  options: Readonly<{ rejectCommas?: boolean }> = {},
): readonly string[] {
  const violations: string[] = []
  if (/--|\/\*/.test(value)) {
    violations.push('unsupported SQL comment')
  }
  const identifier = '(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)'
  const relationToken = `(?:__INDIGO_RELATION_\\d+__|${identifier})(?:\\s*\\.\\s*${identifier})?`
  const alias = `(?:\\s+(?:AS\\s+)?${identifier}(?:\\s*\\([^)]*\\))?)?`
  if (
    (options.rejectCommas && value.includes(',')) ||
    new RegExp(`\\b(?:FROM|JOIN)\\s+${relationToken}${alias}\\s*,`, 'i').test(value)
  ) {
    violations.push('unsupported comma relation grammar')
  }
  if (/\bTABLE\b/i.test(value)) {
    violations.push('unsupported TABLE relation grammar')
  }
  const mutation =
    /\b(?:ALTER|CALL|COPY|CREATE|DELETE|DO|DROP|GRANT|INSERT|INTO|LOCK|MERGE|REFRESH|RESET|REVOKE|SET|TRUNCATE|UPDATE|VACUUM)\b/i.exec(
      value,
    )
  if (mutation?.[0]) {
    violations.push(`SQL mutation verb:${mutation[0].toUpperCase()}`)
  }
  return violations
}

function compactSql(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim()
}

function splitSqlProjectionItems(value: string): readonly string[] {
  const items: string[] = []
  let depth = 0
  let quoted: 'single' | 'double' | null = null
  let itemStart = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    const next = value[index + 1]
    if (quoted === 'single') {
      if (character === "'" && next === "'") index += 1
      else if (character === "'") quoted = null
      continue
    }
    if (quoted === 'double') {
      if (character === '"' && next === '"') index += 1
      else if (character === '"') quoted = null
      continue
    }
    if (character === "'") quoted = 'single'
    else if (character === '"') quoted = 'double'
    else if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === ',' && depth === 0) {
      items.push(compactSql(value.slice(itemStart, index)))
      itemStart = index + 1
    }
  }
  items.push(compactSql(value.slice(itemStart)))
  return items
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cteProjection(
  statement: string,
  cte: string,
  relation: string,
): readonly string[] | undefined {
  const match = new RegExp(
    `\\b${regexEscape(cte)}\\s+AS\\s+MATERIALIZED\\s*\\(\\s*SELECT\\s+([\\s\\S]*?)\\s+FROM\\s+${regexEscape(relation)}(?=\\s|\\))`,
    'i',
  ).exec(statement)
  return match?.[1] ? splitSqlProjectionItems(match[1]) : undefined
}

function identityAuthorityProjectionViolations(statement: string): readonly string[] {
  const violations: string[] = []
  const cteInventory = [
    ...statement.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+(?:MATERIALIZED\s+)?\(/gi),
  ].map((match) => match[1])
  if (
    JSON.stringify(cteInventory) !==
    JSON.stringify(['installation', 'matched_sessions', 'actors'])
  ) {
    violations.push('authority CTE inventory')
  }
  const expectedCtes = new Map<string, Readonly<{ relation: string; items: string[] }>>([
    [
      'installation',
      {
        relation: 'installation_state',
        items: [
          'product_mutation_epoch::text AS product_mutation_epoch',
          'owner_user_id AS installation_owner_user_id',
          'bootstrap_closed_at',
        ],
      },
    ],
    [
      'matched_sessions',
      {
        relation: '"session"',
        items: [
          'candidate.id',
          'candidate.user_id',
          'candidate.expires_at',
          'candidate.created_at',
          'candidate.updated_at',
          'candidate.expires_at > CURRENT_TIMESTAMP AS active',
        ],
      },
    ],
    [
      'actors',
      {
        relation: '"user"',
        items: [
          'candidate.id',
          'candidate.name',
          'candidate.email',
          'candidate.email_verified',
          'candidate.created_at',
          'candidate.updated_at',
        ],
      },
    ],
  ])
  for (const [cte, expected] of expectedCtes) {
    const observed = cteProjection(statement, cte, expected.relation)
    if (!observed || JSON.stringify(observed) !== JSON.stringify(expected.items)) {
      violations.push(`authority CTE projection:${cte}`)
    }
  }

  const finalStart = /\bSELECT\s+installation\.product_mutation_epoch\s*,/i.exec(
    statement,
  )
  const finalEnd = statement.lastIndexOf('FROM installation')
  const finalItems =
    finalStart && finalEnd > finalStart.index
      ? splitSqlProjectionItems(
          statement.slice(finalStart.index + 'SELECT'.length, finalEnd),
        )
      : undefined
  const expectedFinalItems = [
    'installation.product_mutation_epoch',
    'installation.installation_owner_user_id',
    'installation.bootstrap_closed_at',
    `COALESCE( ( SELECT jsonb_agg( jsonb_build_object( 'id', candidate.id, 'userId', candidate.user_id, 'expiresAt', candidate.expires_at, 'createdAt', candidate.created_at, 'updatedAt', candidate.updated_at, 'active', candidate.active ) ORDER BY candidate.id COLLATE "C" ) FROM matched_sessions AS candidate ), '[]'::jsonb ) AS session_rows`,
    `COALESCE( ( SELECT jsonb_agg( jsonb_build_object( 'id', candidate.id, 'name', candidate.name, 'email', candidate.email, 'emailVerified', candidate.email_verified, 'createdAt', candidate.created_at, 'updatedAt', candidate.updated_at ) ORDER BY candidate.id COLLATE "C" ) FROM actors AS candidate ), '[]'::jsonb ) AS actor_rows`,
  ]
  if (!finalItems || JSON.stringify(finalItems) !== JSON.stringify(expectedFinalItems)) {
    violations.push('authority final projection')
  }

  const parameters = [...statement.matchAll(/\$(\d+)/g)].map((match) => match[0])
  const tokenReferences = [...statement.matchAll(/\bcandidate\.token\b/g)]
  const sessionTail =
    /FROM\s+"session"\s+AS\s+candidate\s+([\s\S]*?)\)\s*,\s*actors\s+AS\s+MATERIALIZED/i.exec(
      statement,
    )?.[1]
  if (
    JSON.stringify(parameters) !== JSON.stringify(['$1']) ||
    tokenReferences.length !== 1 ||
    compactSql(sessionTail ?? '') !==
      'WHERE candidate.token = $1 ORDER BY candidate.id COLLATE "C" LIMIT 2'
  ) {
    violations.push('authority session token predicate')
  }
  return violations
}

function identityAuthorityQueryContract(value: string): Readonly<{
  relations: readonly string[]
  violations: readonly string[]
}> {
  const ast = ts.createSourceFile(
    'subject-export-authority.ts',
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const violations: string[] = []
  let statement: string | undefined
  let statementDeclarations = 0
  let queryCalls = 0
  let statementDeclaration: ts.VariableDeclaration | undefined
  const queryCapabilities = new Set(['query'])
  const queryAliases = new Set<string>()
  let snapshotReaderDeclarations = 0
  let snapshotReaderCalls = 0
  const approvedSnapshotCallers = new Set([
    'captureSubjectExportAuthority',
    'recheckSubjectExportAuthority',
  ])

  const collectCapabilities = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'readSnapshot') {
      snapshotReaderDeclarations += 1
      if (node.parent !== ast) violations.push('snapshot reader is not top-level')
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'readSnapshot'
    ) {
      violations.push('snapshot reader shadow')
    }
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      node.type?.getText(ast).includes('IdentitySubjectExportQuery')
    ) {
      queryCapabilities.add(node.name.text)
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const value = unwrapCapabilityExpression(node.initializer)
      if (
        ts.isIdentifier(value) &&
        (queryCapabilities.has(value.text) || queryAliases.has(value.text))
      ) {
        queryAliases.add(node.name.text)
        violations.push('query capability alias')
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const value = unwrapCapabilityExpression(node.right)
      if (
        ts.isIdentifier(value) &&
        (queryCapabilities.has(value.text) || queryAliases.has(value.text))
      ) {
        queryAliases.add(node.left.text)
        violations.push('query capability reassignment')
      }
    }
    ts.forEachChild(node, collectCapabilities)
  }
  collectCapabilities(ast)
  if (snapshotReaderDeclarations !== 1) {
    violations.push('snapshot reader declaration count')
  }

  const isQueryCapability = (expression: ts.Expression): boolean => {
    const value = unwrapCapabilityExpression(expression)
    return (
      ts.isIdentifier(value) &&
      (queryCapabilities.has(value.text) || queryAliases.has(value.text))
    )
  }

  const enclosingFunction = (node: ts.Node): string | undefined => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current)) return current.name?.text
    }
    return undefined
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      (queryCapabilities.has(node.text) || queryAliases.has(node.text))
    ) {
      const parent = node.parent
      const declaration =
        ((ts.isParameter(parent) || ts.isVariableDeclaration(parent)) &&
          parent.name === node) ||
        ((ts.isMethodSignature(parent) || ts.isPropertySignature(parent)) &&
          parent.name === node)
      const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node
      const capabilityReceiver =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node
      const approvedSnapshotPass =
        ts.isCallExpression(parent) &&
        parent.arguments.includes(node) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'readSnapshot' &&
        approvedSnapshotCallers.has(enclosingFunction(node) ?? '')
      if (!declaration && !propertyName && !capabilityReceiver && !approvedSnapshotPass) {
        violations.push('query capability escape')
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'subjectExportAuthorityStatement'
    ) {
      statementDeclarations += 1
      statementDeclaration = node
      const declarationList = node.parent
      const declarationStatement = declarationList.parent
      if (
        !ts.isVariableDeclarationList(declarationList) ||
        (declarationList.flags & ts.NodeFlags.Const) === 0 ||
        !ts.isVariableStatement(declarationStatement) ||
        declarationStatement.parent !== ast
      ) {
        violations.push('authority statement is not one top-level const')
      }
      if (!node.initializer || !ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
        violations.push('authority statement is not one static template')
      } else {
        statement = node.initializer.text
      }
    }
    if (ts.isIdentifier(node) && node.text === 'subjectExportAuthorityStatement') {
      const declarationName = statementDeclaration?.name === node
      const directQueryArgument =
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node &&
        ts.isPropertyAccessExpression(node.parent.expression) &&
        ts.isIdentifier(node.parent.expression.expression) &&
        node.parent.expression.expression.text === 'query' &&
        node.parent.expression.name.text === 'query'
      if (!declarationName && !directQueryArgument) {
        violations.push('indirect authority statement use')
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'readSnapshot'
    ) {
      snapshotReaderCalls += 1
      if (!approvedSnapshotCallers.has(enclosingFunction(node) ?? '')) {
        violations.push('snapshot reader call outside approved authority')
      }
    }
    if (ts.isIdentifier(node) && node.text === 'readSnapshot') {
      const declarationName =
        ts.isFunctionDeclaration(node.parent) && node.parent.name === node
      const directCall =
        ts.isCallExpression(node.parent) && node.parent.expression === node
      if (!declarationName && !directCall) {
        violations.push('indirect snapshot reader use')
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      isQueryCapability(node.expression) &&
      node.name.text !== 'query'
    ) {
      violations.push(`unapproved query method:${node.name.text}`)
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'query' &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      violations.push('indirect query method use')
    }
    if (
      ts.isElementAccessExpression(node) &&
      (isQueryCapability(node.expression) ||
        (ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === 'query') ||
        (ts.isCallExpression(node.parent) && node.parent.expression === node))
    ) {
      violations.push('computed query method use')
      if (
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node &&
        enclosingFunction(node) !== 'readSnapshot'
      ) {
        violations.push('query call outside snapshot reader')
      }
    }
    if (
      ts.isBindingElement(node) &&
      !node.dotDotDotToken &&
      ((node.propertyName &&
        (ts.isIdentifier(node.propertyName) ||
          ts.isStringLiteralLike(node.propertyName)) &&
        node.propertyName.text === 'query') ||
        (!node.propertyName && ts.isIdentifier(node.name) && node.name.text === 'query'))
    ) {
      violations.push('indirect query method use')
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query'
    ) {
      queryCalls += 1
      if (
        !isQueryCapability(node.expression.expression) ||
        enclosingFunction(node) !== 'readSnapshot'
      ) {
        violations.push('query call outside snapshot reader')
      }
      if (
        !ts.isIdentifier(node.expression.expression) ||
        node.expression.expression.text !== 'query'
      ) {
        violations.push('indirect query capability use')
      }
      const statementArgument = node.arguments[0]
      if (
        !statementArgument ||
        !ts.isIdentifier(statementArgument) ||
        statementArgument.text !== 'subjectExportAuthorityStatement'
      ) {
        violations.push('query does not use the authority statement')
      }
      const values = node.arguments[1]
      if (
        node.arguments.length !== 2 ||
        !values ||
        !ts.isArrayLiteralExpression(values) ||
        values.elements.length !== 1 ||
        !ts.isIdentifier(values.elements[0]) ||
        values.elements[0].text !== 'verifiedSessionToken'
      ) {
        violations.push('authority query values contract')
      }
      if (!ts.isAwaitExpression(node.parent) || node.parent.expression !== node) {
        violations.push('query builder capability escape')
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.left.text === 'verifiedSessionToken' &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      violations.push('verified session token reassignment')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (statementDeclarations !== 1) {
    violations.push('authority statement declaration count')
  }
  if (queryCalls !== 1) violations.push('authority query call count')
  if (snapshotReaderCalls !== 2) violations.push('snapshot reader call count')
  if (statement) {
    violations.push(...sqlStatementViolations(statement))
    violations.push(...identityAuthorityProjectionViolations(statement))
  }
  return Object.freeze({
    relations: statement ? sqlRelations(statement) : [],
    violations: [...new Set(violations)].sort(),
  })
}

describe('subject export boundaries', () => {
  it('keeps archive finalization pure and database-blind', () => {
    const application = source('src/modules/data-portability/application/export.ts')
    expect(application).toContain('finalizeDataExport')
    expect(application).not.toMatch(
      /drizzle-orm|@\/platform\/db|\.select\(|\.transaction\(/,
    )
  })

  it('keeps the route on nominal command and production composition seams only', () => {
    const route = source('src/app/api/export/route.ts')
    expect(route).toContain('captureSubjectExportCommand')
    expect(route).toContain('getProductionDataPortabilitySubjectExportPort')
    expect(route).not.toMatch(
      /getActor|createDataExport|scoped-subject-export|subject-export-authority|@\/platform\/db/,
    )
  })

  it('pins the temporary scoped adapter to explicit SELECT projections only', () => {
    const adapter = source(
      'src/modules/data-portability/infrastructure/scoped-subject-export.ts',
    )
    expect(exportedNames(adapter)).toEqual(
      [
        'ScopedSubjectExportGateway',
        'SubjectExportFiles',
        'SubjectExportGatewayScopeError',
        'SubjectExportGraphInvariantError',
        'createScopedSubjectExportGateway',
        'subjectExportReadContract',
        'subjectExportReadManifest',
      ].sort(),
    )
    for (const [suffix, leakedName] of [
      ['export { readSubjectExportFiles }', 'readSubjectExportFiles'],
      ["export { readSubjectExportFiles as leaked } from './leak'", 'leaked'],
      ['export default readSubjectExportFiles', 'default'],
    ] as const) {
      expect(exportedNames(`${adapter}\n${suffix}\n`)).toContain(leakedName)
    }
    expect(scopedAdapterViolations(adapter)).toEqual([])
    expect(adapter).toContain('subjectExportReadManifest')
    expect(adapter).toContain('SubjectExportGraphInvariantError')
    expect(adapter).toContain('metadata: _metadata')
    expect(adapter).toContain('metadata: {}')
    expect(adapterRelationContract(adapter)).toEqual({
      relations: Object.keys(subjectExportReadContract).sort(),
      violations: [],
    })
    expect(subjectExportReadManifest).toEqual(Object.values(subjectExportReadContract))

    expect(
      scopedAdapterViolations(`${adapter}\nvoid database.select().from(secretTable)`),
    ).toContain('zero-argument select')
    expect(
      scopedAdapterViolations(`${adapter}\nvoid database.insert(secretTable)`),
    ).toContain('database mutation:insert')
    expect(
      scopedAdapterViolations(
        `${adapter}\nvoid (database as any)['execute']('SELECT password FROM account')`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'computed database method use',
        'unapproved database method:execute',
      ]),
    )
    expect(
      scopedAdapterViolations(
        `${adapter}\nconst escaped = transaction\nvoid escaped.select({ password: account.password }).from(account)`,
      ),
    ).toContain('database capability alias')
    expect(
      scopedAdapterViolations(
        `${adapter}\nvoid Reflect.apply(transaction.execute, transaction, ['SELECT password FROM account'])`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'database capability escape:transaction',
        'indirect database method:execute',
        'unapproved database method:execute',
      ]),
    )
    expect(
      scopedAdapterViolations(
        `${adapter}\nconst { execute: rawQuery } = transaction\nvoid rawQuery('SELECT password FROM account')`,
      ),
    ).toContain('database capability escape:transaction')
    expect(
      scopedAdapterViolations(
        `${adapter}\nexport const leak = (database: NodePgDatabase, subjectUserId: string) => readSubjectExportFiles(database, subjectUserId)`,
      ),
    ).toContain('database capability escape:database')
    expect(
      scopedAdapterViolations(
        `${adapter}\nasync function leak(database: NodePgDatabase) { return database.select({ email: user.email }).from(user) }`,
      ),
    ).toContain('database method outside subject export reader')
    expect(
      scopedAdapterViolations(
        `${adapter}\ntype DbAlias = NodePgDatabase\nasync function leak(db: DbAlias) { return db.select({ email: user.email }).from(user) }`,
      ),
    ).toContain('database method outside subject export reader')
    expect(
      scopedAdapterViolations(
        `${adapter}\nfunction leak(builder: any) { return builder.from(user) }\nexport function leaked(database: NodePgDatabase) { return leak(database.select({ id: user.id })) }`,
      ),
    ).toContain('database method outside subject export reader')
    expect(
      scopedAdapterViolations(
        `${adapter}\ntype DbAlias = NodePgDatabase\nasync function leak(db: DbAlias) { return db.selectDistinct({ email: user.email }).from(user) }`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'database method outside subject export reader',
        'unapproved database method:selectDistinct',
      ]),
    )
    expect(
      scopedAdapterViolations(
        `${adapter}\ntype DbAlias = NodePgDatabase\nasync function leak(db: DbAlias) { return (db as any).query('SELECT password FROM account') }`,
      ),
    ).toContain('unapproved database method:query')
    expect(
      scopedAdapterViolations(
        `${adapter}\ntype EscapedDb = Parameters<typeof readSubjectExportFiles>[0]\nasync function leak(conn: EscapedDb) { return conn.query('SELECT password FROM account') }`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'database method outside subject export reader',
        'unapproved database method:query',
      ]),
    )
    expect(
      scopedAdapterViolations(
        `${adapter}\ntype DbAlias = NodePgDatabase\nexport const leak = (db: DbAlias, id: string) => readSubjectExportFiles(db, id)`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'subject export reader call count',
        'subject export reader call outside scoped gateway',
      ]),
    )
    expect(
      scopedAdapterViolations(
        `${adapter}\nconst leakedReader = readSubjectExportFiles\nexport const leak = (database: NodePgDatabase, id: string) => leakedReader(database, id)`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'database capability escape:database',
        'indirect subject export reader use',
      ]),
    )
    expect(
      scopedAdapterViolations(
        adapter.replace(
          "programRevision:\n        'Each revision carries immutable engine, methodology, template, input-hash, output-hash, review-status, and activation fields.',",
          'programRevision: transaction.select({ id: user.id }).from(user) as unknown as string,',
        ),
      ),
    ).toContain('subject query builder capability escape')
    expect(
      scopedAdapterViolations(
        adapter.replace(
          'const [identity] = await transaction',
          'const collectInBoundedChunks = (_values: unknown, read: () => unknown) => read()\n  void collectInBoundedChunks\n  const [identity] = await transaction',
        ),
      ),
    ).toContain('bounded chunk reader shadow')
    expect(
      scopedAdapterViolations(
        adapter.replace(
          "programRevision:\n        'Each revision carries immutable engine, methodology, template, input-hash, output-hash, review-status, and activation fields.',",
          'programRevision: await transaction.select({ id: user.id }).from(user).prepare() as unknown as string,',
        ),
      ),
    ).toContain('subject query builder capability escape')
    expect(
      scopedAdapterViolations(
        adapter.replace(
          'const subjectUserId = binding.subjectUserId',
          "const readSubjectExportFiles = (escaped: any) => escaped['execute']('SELECT password FROM account')\n  void readSubjectExportFiles\n  const subjectUserId = binding.subjectUserId",
        ),
      ),
    ).toEqual(expect.arrayContaining(['subject export reader shadow']))
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ id: account.id }).from(account)`,
      ).violations,
    ).toContain('indirect relation:account')
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ password: sql\`(SELECT password FROM account LIMIT 1)\` }).from(user)`,
      ).violations,
    ).toContain('static sql relation:account')
    expect(
      adapterRelationContract(
        adapter.replace(
          ['FROM $', '{programRevisions} AS revision'].join(''),
          ['FROM $', '{programRevisions} AS revision, account AS credential'].join(''),
        ),
      ).violations,
    ).toContain('unsupported comma relation grammar')
    expect(
      adapterRelationContract(
        adapter.replace(
          ['FROM $', '{programRevisions} AS revision'].join(''),
          [
            'FROM $',
            '{programRevisions} AS revision /* reviewed */, account AS credential',
          ].join(''),
        ),
      ).violations,
    ).toContain('unsupported SQL comment')
    expect(
      adapterRelationContract(
        adapter.replace(
          ['FROM $', '{programRevisions} AS revision'].join(''),
          ['FROM $', '{programRevisions} AS "revision", account AS credential'].join(''),
        ),
      ).violations,
    ).toContain('unsupported comma relation grammar')
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ password: sql\`EXISTS (TABLE account)\` }).from(user)`,
      ).violations,
    ).toContain('unsupported TABLE relation grammar')
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ password: sql.raw('(SELECT password FROM account LIMIT 1)') }).from(user)`,
      ).violations,
    ).toContain('raw SQL property access')
    expect(
      adapterRelationContract(
        `${adapter}\nconst q = sql\nvoid database.select({ password: q\`(SELECT password FROM account LIMIT 1)\` }).from(user)`,
      ).violations,
    ).toContain('sql non-tag use:sql')
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ password: sql /* comment */ ['raw']('(SELECT password FROM account LIMIT 1)') }).from(user)`,
      ).violations,
    ).toContain('raw SQL property access')
    const aliasedSql = adapter
      .replace(
        "import { and, asc, eq, inArray, sql } from 'drizzle-orm'",
        "import { and, asc, eq, inArray, sql as q } from 'drizzle-orm'",
      )
      .replace('sql`EXISTS', 'q`EXISTS')
    expect(adapterRelationContract(aliasedSql).violations).toContain(
      'aliased import:drizzle-orm:sql',
    )
  })

  it('keeps composition database-blind outside the reviewed UoW and capture factories', () => {
    const composition = source('src/composition/data-portability-subject-export.ts')
    expect(composition).toContain('createRuntimePostgresUnitOfWork')
    expect(composition).toContain('withTrustedCredentialCapture')
    expect(composition).toContain('recheckSubjectExportAuthority')
    expect(composition).not.toMatch(
      /@\/platform\/db\/(?:client|schema|database-runtime|runtime-registry)|\.transaction\(/,
    )
  })

  it('keeps the Identity capture query credential-secret blind', () => {
    const identity = source(
      'src/modules/identity/infrastructure/subject-export-authority.ts',
    )
    expect(identity).toContain('FROM installation_state')
    expect(identity).toContain('FROM "session"')
    expect(identity).toContain('FROM "user"')
    const cteRelations = new Set(['actors', 'installation', 'matched_sessions'])
    const contract = identityAuthorityQueryContract(identity)
    expect(contract.violations).toEqual([])
    expect(contract.relations.filter((name) => !cteRelations.has(name))).toEqual([
      'installation_state',
      'session',
      'user',
    ])
    expect(identity).not.toMatch(/credential_rows|\b[A-Za-z_][\w]*\.password\b/)

    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'FROM installation_state',
          ['FROM $', '{relationName}'].join(''),
        ),
      ).violations,
    ).toContain('authority statement is not one static template')
    expect(
      identityAuthorityQueryContract(
        `${identity}\nvoid query.query('SELECT credential.password FROM public.account AS credential')`,
      ).violations,
    ).toContain('query does not use the authority statement')
    expect(
      identityAuthorityQueryContract(
        identity
          .replace(
            'const subjectExportAuthorityStatement',
            'let subjectExportAuthorityStatement',
          )
          .replace(
            'const result = await query.query<SnapshotRow>',
            "subjectExportAuthorityStatement = ['SELECT credential_secret FROM ', 'account'].join('')\n  const result = await query.query<SnapshotRow>",
          ),
      ).violations,
    ).toEqual(
      expect.arrayContaining([
        'authority statement is not one top-level const',
        'indirect authority statement use',
      ]),
    )
    expect(
      identityAuthorityQueryContract(
        identity.replace('query.query<SnapshotRow>', "query['query']<SnapshotRow>"),
      ).violations,
    ).toEqual(
      expect.arrayContaining(['computed query method use', 'authority query call count']),
    )
    expect(
      identityAuthorityQueryContract(
        identity.replace('query.query<SnapshotRow>', 'query[method]<SnapshotRow>'),
      ).violations,
    ).toEqual(
      expect.arrayContaining(['computed query method use', 'authority query call count']),
    )
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'const result = await query.query<SnapshotRow>',
          "const escaped = query\n  const method = 'query'\n  const result = await escaped[method]<SnapshotRow>",
        ),
      ).violations,
    ).toEqual(
      expect.arrayContaining(['query capability escape', 'authority query call count']),
    )
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'const result = await query.query<SnapshotRow>(subjectExportAuthorityStatement, [\n    verifiedSessionToken,\n  ])',
          'const result = await Reflect.apply(query.query, query, [subjectExportAuthorityStatement, [verifiedSessionToken]])',
        ),
      ).violations,
    ).toEqual(
      expect.arrayContaining([
        'indirect query method use',
        'query capability escape',
        'authority query call count',
      ]),
    )
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'const result = await query.query<SnapshotRow>',
          'const { query: rawQuery } = query\n  const result = await rawQuery<SnapshotRow>',
        ),
      ).violations,
    ).toContain('query capability escape')
    expect(
      identityAuthorityQueryContract(
        `${identity}\nasync function leak(q: IdentitySubjectExportQuery, method: string) { return q[method]('SELECT password FROM account') }`,
      ).violations,
    ).toEqual(
      expect.arrayContaining([
        'computed query method use',
        'query call outside snapshot reader',
      ]),
    )
    expect(
      identityAuthorityQueryContract(
        `${identity}\ntype QueryAlias = IdentitySubjectExportQuery\nasync function leak(q: QueryAlias) { const method = 'query'; return q[method]('SELECT password FROM account') }`,
      ).violations,
    ).toEqual(
      expect.arrayContaining([
        'computed query method use',
        'query call outside snapshot reader',
      ]),
    )
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'const commandSnapshot = commandState(command)',
          "const readSnapshot = (escaped: any) => escaped['query']('SELECT password FROM account')\n  void readSnapshot\n  const commandSnapshot = commandState(command)",
        ),
      ).violations,
    ).toEqual(expect.arrayContaining(['snapshot reader shadow']))
    expect(
      identityAuthorityQueryContract(
        `${identity}\nexport const leak = (query: IdentitySubjectExportQuery, token: string) => readSnapshot(query, token, 'capture')`,
      ).violations,
    ).toEqual(
      expect.arrayContaining([
        'query capability escape',
        'snapshot reader call count',
        'snapshot reader call outside approved authority',
      ]),
    )
    expect(
      identityAuthorityQueryContract(
        `${identity}\nconst leakedSnapshotReader = readSnapshot\nvoid leakedSnapshotReader`,
      ).violations,
    ).toContain('indirect snapshot reader use')
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'WITH installation AS MATERIALIZED (',
          'WITH deleted AS (DELETE FROM "user" WHERE false RETURNING id), installation AS MATERIALIZED (',
        ),
      ).violations,
    ).toContain('SQL mutation verb:DELETE')
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'SELECT\n    installation.product_mutation_epoch,',
          'SELECT\n    (SELECT token FROM "session" ORDER BY id LIMIT 1) AS leaked_token,\n    installation.product_mutation_epoch,',
        ),
      ).violations,
    ).toContain('authority final projection')
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'SELECT\n      candidate.id,\n      candidate.user_id,',
          'SELECT\n      candidate.id,\n      candidate.token,\n      candidate.user_id,',
        ),
      ).violations,
    ).toContain('authority CTE projection:matched_sessions')
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'WITH installation AS MATERIALIZED (',
          'WITH leaked AS (SELECT token FROM "session"), installation AS MATERIALIZED (',
        ),
      ).violations,
    ).toContain('authority CTE inventory')
    expect(
      identityAuthorityQueryContract(
        identity.replace('WHERE candidate.token = $1', 'WHERE candidate.token = $2'),
      ).violations,
    ).toContain('authority session token predicate')
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'WHERE candidate.token = $1',
          'WHERE candidate.token = $1 OR candidate.user_id IS NOT NULL',
        ),
      ).violations,
    ).toContain('authority session token predicate')
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'subjectExportAuthorityStatement, [\n    verifiedSessionToken,\n  ]',
          'subjectExportAuthorityStatement, [phase]',
        ),
      ).violations,
    ).toContain('authority query values contract')
  })
})
