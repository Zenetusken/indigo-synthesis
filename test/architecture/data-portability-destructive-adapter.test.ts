import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { temporaryDestructiveAdapterManifest } from '@/modules/data-portability/infrastructure/destructive-adapter-manifest'
import { crossCuttingOperator, tableWriteFence } from '@/platform/db/schema/ownership'
import {
  buildSchemaTableMap,
  executableSqlText,
  scanWrites,
  type WriteOp,
} from './schema-ownership-scan'

const sourceRoot = resolve(process.cwd(), 'src')
const adapterPath = resolve(
  sourceRoot,
  'modules/data-portability/infrastructure/scoped-destructive-adapter.ts',
)
const adapterProjectPath =
  'src/modules/data-portability/infrastructure/scoped-destructive-adapter.ts'
const deletionPath = resolve(
  sourceRoot,
  'modules/data-portability/application/deletion.ts',
)
const adapterSource = readFileSync(adapterPath, 'utf8')
const deletionSource = readFileSync(deletionPath, 'utf8')
const adapterAst = ts.createSourceFile(
  adapterPath,
  adapterSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)
const deletionAst = ts.createSourceFile(
  deletionPath,
  deletionSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)
const { bindingToSql, sqlNames } = buildSchemaTableMap(sourceRoot)

function namedImportContract(
  ast: ts.SourceFile,
): Readonly<Record<string, readonly string[]>> {
  const contract: Record<string, string[]> = {}
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue
    }
    const clause = statement.importClause
    const named = clause?.namedBindings
    const observed = contract[statement.moduleSpecifier.text] ?? []
    if (!clause || clause.name || !named || !ts.isNamedImports(named)) {
      observed.push('<broad-import>')
      contract[statement.moduleSpecifier.text] = observed
      continue
    }
    observed.push(
      ...named.elements.map((element) =>
        element.propertyName
          ? `${element.propertyName.text} as ${element.name.text}`
          : element.name.text,
      ),
    )
    contract[statement.moduleSpecifier.text] = observed.sort()
  }
  return Object.fromEntries(
    Object.entries(contract).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function exportedNames(ast: ts.SourceFile): readonly string[] {
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

function functionSource(ast: ts.SourceFile, source: string, name: string): string {
  const declarations: ts.FunctionDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      declarations.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (declarations.length !== 1 || declarations[0]?.parent !== ast) {
    throw new Error(`Expected exactly one top-level function: ${name}`)
  }
  const [declaration] = declarations
  if (!declaration) throw new Error(`Missing destructive function: ${name}`)
  return source.slice(declaration.getStart(ast), declaration.getEnd())
}

function functionLineSpan(name: string): readonly [number, number] {
  let found: readonly [number, number] | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = [
        adapterAst.getLineAndCharacterOfPosition(node.getStart(adapterAst)).line + 1,
        adapterAst.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      ]
    }
    ts.forEachChild(node, visit)
  }
  visit(adapterAst)
  if (!found) throw new Error(`Missing destructive adapter function: ${name}`)
  return found
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

const destructiveOperationFunctions = new Set([
  'executeInstanceReset',
  'executeSubjectDeletion',
  'invalidatePreviewAfterDenial',
])
const destructiveOperationCallers = new Map<string, readonly string[]>([
  ['executeInstanceReset', ['createScopedInstanceResetGateway']],
  ['executeSubjectDeletion', ['createScopedSubjectDeletionGateway']],
  [
    'invalidatePreviewAfterDenial',
    [
      'createScopedInstanceResetAttemptGateway',
      'createScopedSubjectDeletionAttemptGateway',
    ],
  ],
])
const approvedDatabasePasses = new Set([
  ...destructiveOperationFunctions,
  'countInstanceRows',
  'countSubjectRows',
])
const approvedDatabaseMethods = new Set([
  'delete',
  'execute',
  'insert',
  'select',
  'update',
])
const databaseMethodShapes = new Set([
  ...approvedDatabaseMethods,
  '$with',
  'query',
  'raw',
  'returning',
  'selectDistinct',
  'selectDistinctOn',
  'transaction',
  'with',
])
const exactPlanProjection = [
  'deletionPlans.consumedAt',
  'deletionPlans.expiresAt',
  'deletionPlans.id',
  'deletionPlans.planDigest',
]

function taggedTemplateText(statement: ts.TaggedTemplateExpression): string {
  return ts.isTemplateExpression(statement.template)
    ? [
        statement.template.head.text,
        ...statement.template.templateSpans.map((span) => ` ? ${span.literal.text}`),
      ].join('')
    : statement.template.text
}

type FluentCall = Readonly<{ call: ts.CallExpression; method: string }>

function fluentCallsFrom(root: ts.CallExpression): readonly FluentCall[] {
  const expression = root.expression
  if (!ts.isPropertyAccessExpression(expression)) return []
  const calls: FluentCall[] = [{ call: root, method: expression.name.text }]
  let current: ts.Expression = root
  while (true) {
    const property = current.parent
    if (!ts.isPropertyAccessExpression(property) || property.expression !== current) {
      break
    }
    const call = property.parent
    if (!ts.isCallExpression(call) || call.expression !== property) break
    calls.push({ call, method: property.name.text })
    current = call
  }
  return calls
}

function rootFluentCall(call: ts.CallExpression): ts.CallExpression {
  let current = call
  while (
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isCallExpression(current.expression.expression)
  ) {
    current = current.expression.expression
  }
  return current
}

function compactTypeScript(value: string): string {
  return value.replaceAll(/\s+/g, '')
}

function destructivePlanLookupViolations(ast: ts.SourceFile): readonly string[] {
  const violations: string[] = []
  const scopes = new Map([
    ['executeInstanceReset', 'instance-reset'],
    ['executeSubjectDeletion', 'trainee-data'],
  ])
  for (const [operation, scope] of scopes) {
    const declarations = ast.statements.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === operation,
    )
    if (declarations.length !== 1) {
      violations.push(`destructive plan lookup declaration:${operation}`)
      continue
    }
    const selects: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'select' &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'database'
      ) {
        selects.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(declarations[0] as ts.FunctionDeclaration)
    if (selects.length !== 1) {
      violations.push(`destructive plan lookup count:${operation}`)
      continue
    }
    const calls = fluentCallsFrom(selects[0] as ts.CallExpression)
    if (calls.map(({ method }) => method).join(',') !== 'select,from,where,for,limit') {
      violations.push(`destructive plan lookup chain:${operation}`)
      continue
    }
    const byMethod = new Map(calls.map((item) => [item.method, item.call]))
    const argument = (method: string): string | undefined => {
      const value = byMethod.get(method)?.arguments[0]
      return value ? compactTypeScript(value.getText(ast)) : undefined
    }
    const expectedWhere = compactTypeScript(
      `and(
        eq(deletionPlans.id, binding.planId),
        eq(deletionPlans.userId, binding.actorUserId),
        eq(deletionPlans.scope, '${scope}'),
        gt(deletionPlans.expiresAt, sql\`CURRENT_TIMESTAMP\`),
      )`,
    )
    if (
      argument('from') !== 'deletionPlans' ||
      argument('where') !== expectedWhere ||
      argument('for') !== "'update'" ||
      argument('limit') !== '1'
    ) {
      violations.push(`destructive plan lookup contract:${operation}`)
    }
  }
  return violations
}

function countSqlBindingViolations(
  ast: ts.SourceFile,
  requireDrizzleImport: boolean,
): readonly string[] {
  const violations: string[] = []
  const approvedImports = ast.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'drizzle-orm'
    ) {
      return []
    }
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return []
    return bindings.elements.filter(
      (element) =>
        !element.isTypeOnly &&
        (element.propertyName ?? element.name).text === 'sql' &&
        element.name.text === 'sql',
    )
  })
  if (requireDrizzleImport && approvedImports.length !== 1) {
    violations.push('count sql import count')
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'sql') {
      const parent = node.parent
      const approvedImport =
        ts.isImportSpecifier(parent) &&
        parent.name === node &&
        approvedImports.includes(parent)
      const binding =
        ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
          parent.name === node) ||
        (ts.isBindingElement(parent) && parent.name === node) ||
        ((ts.isFunctionDeclaration(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isEnumDeclaration(parent)) &&
          parent.name === node) ||
        (ts.isCatchClause(parent) && parent.variableDeclaration?.name === node) ||
        (ts.isImportClause(parent) && parent.name === node) ||
        (ts.isNamespaceImport(parent) && parent.name === node) ||
        (ts.isImportEqualsDeclaration(parent) && parent.name === node) ||
        (ts.isImportSpecifier(parent) && parent.name === node)
      if (binding && !approvedImport) violations.push('count sql binding shadow')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return violations
}

function destructiveRawStatementViolations(statement: string): readonly string[] {
  const violations: string[] = []
  const executable = executableSqlText(statement, false)
  if (executable.includes(';')) {
    violations.push('destructive raw SQL is not a single statement')
  }
  const mutations = [
    ...executable.matchAll(/\b(?:DELETE|INSERT|MERGE|TRUNCATE|UPDATE)\b/gi),
  ]
  if (
    mutations.length !== 1 ||
    mutations[0]?.[0].toUpperCase() !== 'DELETE' ||
    !/^\s*DELETE\s+FROM\b/i.test(executable)
  ) {
    violations.push('destructive raw SQL is not a DELETE')
  }
  if (/\bRETURNING\b/i.test(executable)) {
    violations.push('destructive raw SQL exposes RETURNING data')
  }
  for (const match of executable.matchAll(/\bSELECT\s+([\s\S]*?)\s+FROM\b/gi)) {
    const projection = match[1]?.replaceAll(/\s+/g, ' ').trim()
    if (projection !== 'id' && projection !== 'pr.id') {
      violations.push(`destructive raw subquery projection:${projection ?? 'missing'}`)
    }
  }
  return violations
}

function topLevelSelectItems(statement: string): readonly string[] | null {
  const start = statement.search(/\bSELECT\b/i)
  if (start < 0) return null
  const items: string[] = []
  let depth = 0
  let quoted: 'single' | 'double' | null = null
  let itemStart = start + 'SELECT'.length
  for (let index = itemStart; index < statement.length; index += 1) {
    const character = statement[index]
    const next = statement[index + 1]
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
    if (character === "'") {
      quoted = 'single'
      continue
    }
    if (character === '"') {
      quoted = 'double'
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === ',' && depth === 0) {
      items.push(statement.slice(itemStart, index).trim())
      itemStart = index + 1
    }
  }
  items.push(statement.slice(itemStart).trim())
  return items
}

function destructiveAdapterCapabilityViolations(ast: ts.SourceFile): readonly string[] {
  const capabilityNames = new Set(['database', 'db', 'transaction'])
  const databaseTypeNames = new Set(['NodePgDatabase'])
  const aliases = new Set<string>()
  const violations: string[] = []
  const operationDeclarations = new Map<string, number>()
  const operationCalls = new Map<string, string[]>()
  let returningCalls = 0
  const drizzleSqlImports = ast.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'drizzle-orm'
    ) {
      return []
    }
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return []
    return bindings.elements.filter(
      (element) =>
        (element.propertyName ?? element.name).text === 'sql' &&
        element.name.text === 'sql',
    )
  })
  if (drizzleSqlImports.length !== 1) {
    violations.push('destructive sql import count')
  }
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
    if (ts.isIdentifier(node) && node.text === 'sql') {
      const parent = node.parent
      const approvedImport =
        ts.isImportSpecifier(parent) &&
        parent.name === node &&
        drizzleSqlImports.includes(parent)
      const binding =
        ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
          parent.name === node) ||
        (ts.isBindingElement(parent) && parent.name === node) ||
        ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) &&
          parent.name === node) ||
        (ts.isCatchClause(parent) && parent.variableDeclaration?.name === node)
      if (binding && !approvedImport) violations.push('destructive sql binding shadow')
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (destructiveOperationFunctions.has(node.name.text)) {
        operationDeclarations.set(
          node.name.text,
          (operationDeclarations.get(node.name.text) ?? 0) + 1,
        )
        if (node.parent !== ast) {
          violations.push(`destructive operation is not top-level:${node.name.text}`)
        }
      } else if (approvedDatabasePasses.has(node.name.text)) {
        violations.push(`approved database helper shadow:${node.name.text}`)
      }
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      approvedDatabasePasses.has(node.name.text)
    ) {
      violations.push(`approved database helper shadow:${node.name.text}`)
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
  for (const operation of destructiveOperationFunctions) {
    if (operationDeclarations.get(operation) !== 1) {
      violations.push(`destructive operation declaration count:${operation}`)
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      destructiveOperationFunctions.has(node.expression.text)
    ) {
      const callers = operationCalls.get(node.expression.text) ?? []
      callers.push(enclosingFunctionName(node) ?? '<module>')
      operationCalls.set(node.expression.text, callers)
    }
    if (ts.isIdentifier(node) && destructiveOperationFunctions.has(node.text)) {
      const parent = node.parent
      const declarationName = ts.isFunctionDeclaration(parent) && parent.name === node
      const directCall = ts.isCallExpression(parent) && parent.expression === node
      const nonReferencePropertyName =
        ((ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isMethodSignature(parent)) &&
          parent.name === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node)
      if (!declarationName && !directCall && !nonReferencePropertyName) {
        violations.push(`indirect destructive operation reference:${node.text}`)
      }
    }
    const computedCall =
      ts.isElementAccessExpression(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node
    if (
      ts.isElementAccessExpression(node) &&
      (isCapability(node.expression) || computedCall)
    ) {
      violations.push('computed database method use')
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      (isCapability(node.expression) || databaseMethodShapes.has(node.name.text))
    ) {
      const method = node.name.text
      const directCall =
        ts.isCallExpression(node.parent) && node.parent.expression === node
      if (!approvedDatabaseMethods.has(method) && method !== 'returning') {
        violations.push(`unapproved database method:${method}`)
      }
      if (!directCall) violations.push(`indirect database method:${method}`)
      const operation = enclosingFunctionName(node)
      if (!operation || !destructiveOperationFunctions.has(operation)) {
        violations.push(
          `database method outside destructive operation:${operation ?? 'module'}`,
        )
      }
      if (method === 'select' && directCall) {
        const projection = node.parent.arguments[0]
        const observed: string[] = []
        if (!projection || !ts.isObjectLiteralExpression(projection)) {
          violations.push('non-explicit destructive select projection')
        } else {
          for (const property of projection.properties) {
            if (
              !ts.isPropertyAssignment(property) ||
              !ts.isPropertyAccessExpression(property.initializer) ||
              !ts.isIdentifier(property.initializer.expression)
            ) {
              violations.push('indirect destructive select projection')
              continue
            }
            observed.push(
              `${property.initializer.expression.text}.${property.initializer.name.text}`,
            )
          }
          if (
            observed.length !== exactPlanProjection.length ||
            [...observed]
              .sort()
              .some((column, index) => column !== exactPlanProjection[index])
          ) {
            violations.push('destructive plan projection drift')
          }
        }
      }
      if (method === 'execute' && directCall) {
        const statement = node.parent.arguments[0]
        if (
          !statement ||
          !ts.isTaggedTemplateExpression(statement) ||
          !ts.isIdentifier(statement.tag) ||
          statement.tag.text !== 'sql'
        ) {
          violations.push('indirect destructive raw SQL')
        } else {
          if (
            ts.isTemplateExpression(statement.template) &&
            statement.template.templateSpans.some(
              ({ expression }) =>
                !ts.isPropertyAccessExpression(expression) ||
                !ts.isIdentifier(expression.expression) ||
                expression.expression.text !== 'binding' ||
                expression.name.text !== 'actorUserId',
            )
          ) {
            violations.push('unapproved destructive SQL interpolation')
          }
          violations.push(
            ...destructiveRawStatementViolations(taggedTemplateText(statement)),
          )
        }
      }
      if (method === 'returning' && directCall) {
        returningCalls += 1
        const returningCall = node.parent
        const root = rootFluentCall(returningCall)
        const rootExpression = root.expression
        const projection = returningCall.arguments[0]
        const exactProjection =
          projection &&
          compactTypeScript(projection.getText(ast)) ===
            '{singleton:installationState.singleton}'
        const exactRoot =
          ts.isPropertyAccessExpression(rootExpression) &&
          rootExpression.name.text === 'update' &&
          ts.isIdentifier(rootExpression.expression) &&
          rootExpression.expression.text === 'database' &&
          root.arguments.length === 1 &&
          ts.isIdentifier(root.arguments[0]) &&
          root.arguments[0].text === 'installationState'
        if (
          enclosingFunctionName(node) !== 'executeInstanceReset' ||
          !exactProjection ||
          !exactRoot
        ) {
          violations.push('unapproved destructive returning')
        }
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
      const approvedPass =
        ts.isCallExpression(parent) &&
        parent.arguments.includes(node) &&
        ts.isIdentifier(parent.expression) &&
        approvedDatabasePasses.has(parent.expression.text)
      if (!declaration && !capabilityReceiver && !approvedPass) {
        violations.push(`database capability escape:${node.text}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  for (const [operation, expectedCallers] of destructiveOperationCallers) {
    const observedCallers = [...(operationCalls.get(operation) ?? [])].sort()
    if (
      observedCallers.length !== expectedCallers.length ||
      observedCallers.some(
        (caller, index) => caller !== [...expectedCallers].sort()[index],
      )
    ) {
      violations.push(`destructive operation call topology:${operation}`)
    }
  }
  if (returningCalls !== 1) violations.push('destructive returning count')
  violations.push(...destructivePlanLookupViolations(ast))
  return [...new Set(violations)].sort()
}

function countHelperCapabilityViolations(
  value: string,
  name: string,
  moduleValue = deletionSource,
): readonly string[] {
  const ast = ts.createSourceFile(
    `${name}.ts`,
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const violations: string[] = []
  const moduleAst = ts.createSourceFile(
    'deletion-module.ts',
    moduleValue,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  violations.push(...countSqlBindingViolations(moduleAst, true))
  violations.push(...countSqlBindingViolations(ast, false))
  let executeCalls = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const directCountExecution =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'database' &&
        node.expression.name.text === 'execute'
      if (!directCountExecution) {
        violations.push('unapproved count helper call')
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'database') {
        violations.push('computed count database method use')
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'database'
    ) {
      const directCall =
        ts.isCallExpression(node.parent) && node.parent.expression === node
      if (node.name.text !== 'execute') {
        violations.push(`unapproved count database method:${node.name.text}`)
      }
      if (!directCall) violations.push('indirect count database method')
      if (directCall) {
        executeCalls += 1
        const statement = node.parent.arguments[0]
        if (
          !statement ||
          !ts.isTaggedTemplateExpression(statement) ||
          !ts.isIdentifier(statement.tag) ||
          statement.tag.text !== 'sql'
        ) {
          violations.push('indirect count SQL')
        } else {
          const text = ts.isTemplateExpression(statement.template)
            ? [
                statement.template.head.text,
                ...statement.template.templateSpans.map(
                  (span) => ` ? ${span.literal.text}`,
                ),
              ].join('')
            : statement.template.text
          const selects = [...text.matchAll(/\bSELECT\b/gi)]
          if (selects.length === 0) violations.push('count SQL missing SELECT')
          if (
            /\b(?:EXCEPT|FETCH|GROUP\s+BY|HAVING|INTERSECT|LIMIT|OFFSET|ORDER\s+BY|TABLE|UNION|WINDOW)\b/i.test(
              text,
            )
          ) {
            violations.push('unsupported count SQL grammar')
          }
          const executableText = text
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/--[^\r\n]*/g, ' ')
            .replace(/'(?:''|[^'])*'/g, ' ')
            .replace(/"(?:""|[^"])*"/g, ' ')
          const mutation =
            /\b(?:ALTER|CALL|COPY|CREATE|DELETE|DO|DROP|GRANT|INSERT|INTO|LOCK|MERGE|REFRESH|RESET|REVOKE|SET|TRUNCATE|UPDATE|VACUUM)\b/i.exec(
              executableText,
            )
          if (mutation?.[0]) {
            violations.push(`count SQL mutation verb:${mutation[0].toUpperCase()}`)
          }
          for (const select of selects.slice(1)) {
            const tail = text.slice(select.index)
            if (!/^SELECT\s+count\(\*\)::int\s+FROM\b/i.test(tail)) {
              violations.push('non-count destructive helper projection')
            }
          }
          for (const item of topLevelSelectItems(text) ?? []) {
            const scalarCount =
              /^\(\s*SELECT\s+count\(\*\)::int\s+FROM\b[\s\S]*\)\s+AS\s+(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)$/i.test(
                item,
              )
            const conditionalCount =
              /^CASE\s+WHEN\s+\?\s+THEN\s+0\s+ELSE\s+\(\s*SELECT\s+count\(\*\)::int\s+FROM\b[\s\S]*\)\s+END\s+AS\s+(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)$/i.test(
                item,
              )
            if (!scalarCount && !conditionalCount) {
              violations.push('non-count top-level destructive projection')
            }
          }
        }
      }
    }
    if (ts.isIdentifier(node) && node.text === 'database') {
      const parent = node.parent
      const declaration = ts.isParameter(parent) && parent.name === node
      const receiver =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node
      if (!declaration && !receiver) violations.push('count database capability escape')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (executeCalls !== 1) violations.push('count SQL execution count')
  return [...new Set(violations)].sort()
}

const writes = scanWrites({ sourceRoot }).filter(
  ({ file }) => file === adapterProjectPath,
)

function observedWrites(name: string, op: WriteOp): string[] {
  const [first, last] = functionLineSpan(name)
  return [
    ...new Set(
      writes
        .filter((write) => write.line >= first && write.line <= last && write.op === op)
        .map(({ table }) => table),
    ),
  ].sort()
}

const drizzleReadRelationMethods = new Set([
  'crossJoin',
  'crossJoinLateral',
  'from',
  'fullJoin',
  'innerJoin',
  'innerJoinLateral',
  'leftJoin',
  'leftJoinLateral',
  'rightJoin',
])
const sqlRelationIdentifier = '(?:"[A-Za-z_][A-Za-z0-9_$]*"|[A-Za-z_][A-Za-z0-9_$]*)'
const sqlRelationTarget = `${sqlRelationIdentifier}(?:\\s*\\.\\s*${sqlRelationIdentifier})?`

function sqlRelationName(target: string): string {
  return (target.split(/\s*\.\s*/).at(-1) ?? target).replaceAll('"', '').toLowerCase()
}

function rawReadRelations(statement: string): readonly string[] {
  const executable = executableSqlText(statement)
  const relations = new Set<string>()
  const pattern = new RegExp(
    `\\b(DELETE\\s+FROM|FROM|JOIN|TABLE|USING)\\s+(?:LATERAL\\s+)?(?:ONLY\\s+)?(${sqlRelationTarget})`,
    'gi',
  )
  for (const match of executable.matchAll(pattern)) {
    if (/^DELETE/i.test(match[1] ?? '')) continue
    const table = match[2] ? sqlRelationName(match[2]) : undefined
    if (table && sqlNames.has(table)) relations.add(table)
  }
  const commaRelation = new RegExp(
    `\\b(?:FROM|JOIN|TABLE|USING)\\s+(?:LATERAL\\s+)?(?:ONLY\\s+)?${sqlRelationTarget}(?:\\s+(?:AS\\s+)?${sqlRelationIdentifier})?\\s*,`,
    'i',
  )
  if (commaRelation.test(executable)) {
    throw new Error('Unsupported raw comma relation grammar in destructive read census')
  }
  return [...relations]
}

function observedSelects(...sources: readonly string[]): string[] {
  const selected = new Set<string>()
  for (const [index, source] of sources.entries()) {
    const ast = ts.createSourceFile(
      `destructive-read-${index}.ts`,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        drizzleReadRelationMethods.has(node.expression.name.text)
      ) {
        const relation = node.arguments[0]
        if (!relation || !ts.isIdentifier(relation)) {
          throw new Error(
            `Unsupported Drizzle relation grammar: ${node.expression.name.text}`,
          )
        }
        const table = bindingToSql.get(relation.text)
        if (!table) {
          throw new Error(`Unknown Drizzle relation binding: ${relation.text}`)
        }
        selected.add(table)
      }
      if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isIdentifier(node.tag) &&
        node.tag.text === 'sql'
      ) {
        for (const table of rawReadRelations(taggedTemplateText(node))) {
          selected.add(table)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return [...selected].sort()
}

describe('temporary Data Portability destructive adapter boundary', () => {
  it('pins the temporary adapter to its reviewed import surface', () => {
    expect(exportedNames(adapterAst)).toEqual(
      [
        'ScopedDeletionAttemptGateway',
        'ScopedDestructiveAdapterInvariantError',
        'ScopedInstanceResetGateway',
        'ScopedSubjectDeletionGateway',
        'createScopedInstanceResetAttemptGateway',
        'createScopedInstanceResetGateway',
        'createScopedSubjectDeletionAttemptGateway',
        'createScopedSubjectDeletionGateway',
      ].sort(),
    )
    expect(namedImportContract(adapterAst)).toEqual({
      'drizzle-orm': ['and', 'eq', 'gt', 'sql'],
      'drizzle-orm/node-postgres': ['NodePgDatabase'],
      '@/modules/methodology/domain/canonical': ['CanonicalValue', 'canonicalSha256'],
      '@/platform/db/schema': [
        'account',
        'adjustmentDecisionInvalidations',
        'adjustmentDecisions',
        'athleteEquipment',
        'athleteProfiles',
        'athleteTrainingDays',
        'auditEvents',
        'contentReleaseRevocations',
        'deletionPlans',
        'deletionTombstones',
        'destructiveReauthenticationStates',
        'exercisePrescriptions',
        'futureLoadExplanationCache',
        'installationState',
        'memberResetStates',
        'performedSetCorrections',
        'performedSets',
        'plannedWorkouts',
        'programRevisionInvalidations',
        'programRevisionLineage',
        'programRevisions',
        'programs',
        'safetyHoldResolutions',
        'safetyHolds',
        'session',
        'sessionExercises',
        'sessionFeedback',
        'sessionFeedbackCorrections',
        'setPrescriptions',
        'strengthBaselines',
        'trainingCommandReceipts',
        'trainingFactCorrections',
        'user',
        'verification',
        'webRecoveryRateLimitBuckets',
        'workoutSessions',
      ],
      '@/platform/ids/uuid-v7': ['newUuidV7'],
      '../application/deletion': [
        'DeletionError',
        'countInstanceRows',
        'countSubjectRows',
        'digestInstanceResetPlan',
        'digestSubjectDeletionPlan',
      ],
      '../application/export': ['exportSchemaVersion'],
    })
    const duplicateRuntimeImport = ts.createSourceFile(
      adapterPath,
      adapterSource.replace(
        "import type { NodePgDatabase } from 'drizzle-orm/node-postgres'",
        "import { drizzle as unsafeDrizzle } from 'drizzle-orm/node-postgres'\nimport type { NodePgDatabase } from 'drizzle-orm/node-postgres'",
      ),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    expect(
      namedImportContract(duplicateRuntimeImport)['drizzle-orm/node-postgres'],
    ).toEqual(['NodePgDatabase', 'drizzle as unsafeDrizzle'])
    for (const [suffix, leakedName] of [
      ['export { executeSubjectDeletion }', 'executeSubjectDeletion'],
      ["export { executeSubjectDeletion as leaked } from './leak'", 'leaked'],
      ['export default executeSubjectDeletion', 'default'],
    ] as const) {
      const mutant = ts.createSourceFile(
        adapterPath,
        `${adapterSource}\n${suffix}\n`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      expect(exportedNames(mutant)).toContain(leakedName)
    }
  })

  it('keeps the manifest lexical, duplicate-free, and schema-bounded', () => {
    const schemaTables = new Set(Object.keys(tableWriteFence))
    for (const methods of Object.values(temporaryDestructiveAdapterManifest)) {
      for (const tables of Object.values(methods)) {
        expect([...tables]).toEqual([...new Set(tables)].sort())
        expect(tables.every((table: string) => schemaTables.has(table))).toBe(true)
      }
    }
  })

  it('matches every observed adapter DML verb and table exactly', () => {
    const implementations = {
      invalidatePreviewAfterDenial: 'invalidatePreviewAfterDenial',
      executeSubjectDeletion: 'executeSubjectDeletion',
      executeInstanceReset: 'executeInstanceReset',
    } as const
    for (const [method, implementation] of Object.entries(implementations) as [
      keyof typeof implementations,
      (typeof implementations)[keyof typeof implementations],
    ][]) {
      const manifested = temporaryDestructiveAdapterManifest[method]
      for (const op of ['insert', 'update', 'delete'] as const) {
        expect(observedWrites(implementation, op)).toEqual([...manifested[op]])
      }
    }
    const spans = Object.values(implementations).map(functionLineSpan)
    expect(
      writes.filter(
        ({ line }) => !spans.some(([first, last]) => line >= first && line <= last),
      ),
    ).toEqual([])
  })

  it('matches the exact direct and recount SELECT table surface', () => {
    const subjectDeletion = functionSource(
      adapterAst,
      adapterSource,
      'executeSubjectDeletion',
    )
    expect(
      temporaryDestructiveAdapterManifest.invalidatePreviewAfterDenial.select,
    ).toEqual(
      observedSelects(
        functionSource(adapterAst, adapterSource, 'invalidatePreviewAfterDenial'),
      ),
    )
    expect(temporaryDestructiveAdapterManifest.executeSubjectDeletion.select).toEqual(
      observedSelects(
        subjectDeletion,
        functionSource(deletionAst, deletionSource, 'countSubjectRows'),
      ),
    )
    expect(temporaryDestructiveAdapterManifest.executeInstanceReset.select).toEqual(
      observedSelects(
        functionSource(adapterAst, adapterSource, 'executeInstanceReset'),
        functionSource(deletionAst, deletionSource, 'countInstanceRows'),
      ),
    )
    expect(
      observedSelects(
        subjectDeletion.replace(
          '.from(deletionPlans)',
          '.from(deletionPlans).innerJoin(contentReleaseRevocations, sql`true`)',
        ),
      ),
    ).toContain('content_release_revocation')
    expect(
      observedSelects(
        subjectDeletion.replace(
          'WHERE correction_id IN (',
          'WHERE EXISTS (TABLE ONLY content_release_revocation) AND correction_id IN (',
        ),
      ),
    ).toContain('content_release_revocation')
    expect(() =>
      observedSelects(
        subjectDeletion.replace(
          '.from(deletionPlans)',
          '.from(deletionPlans).innerJoin(relationFor(actorUserId), sql`true`)',
        ),
      ),
    ).toThrow('Unsupported Drizzle relation grammar')
  })

  it('seals database capabilities and pins every non-count read projection', () => {
    const subjectCounts = functionSource(deletionAst, deletionSource, 'countSubjectRows')
    const instanceCounts = functionSource(
      deletionAst,
      deletionSource,
      'countInstanceRows',
    )
    expect(destructiveAdapterCapabilityViolations(adapterAst)).toEqual([])
    expect(countHelperCapabilityViolations(subjectCounts, 'countSubjectRows')).toEqual([])
    expect(countHelperCapabilityViolations(instanceCounts, 'countInstanceRows')).toEqual(
      [],
    )

    const parseAdapter = (value: string) =>
      ts.createSourceFile(
        adapterPath,
        value,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace("    .for('update')\n    .limit(1)", '    .limit(1)'),
        ),
      ),
    ).toContain('destructive plan lookup chain:executeSubjectDeletion')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace(
            "eq(deletionPlans.scope, 'trainee-data')",
            "eq(deletionPlans.scope, 'instance-reset')",
          ),
        ),
      ),
    ).toContain('destructive plan lookup contract:executeSubjectDeletion')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(`${adapterSource}\nconst escapedOperation = executeSubjectDeletion`),
      ),
    ).toContain('indirect destructive operation reference:executeSubjectDeletion')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          `${adapterSource}\nfunction leakedCall() { return executeSubjectDeletion(null as never, null as never, () => {}) }`,
        ),
      ),
    ).toContain('destructive operation call topology:executeSubjectDeletion')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace(
            'returning({ singleton: installationState.singleton })',
            'returning({ ownerUserId: installationState.ownerUserId })',
          ),
        ),
      ),
    ).toContain('unapproved destructive returning')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace(
            '.delete(safetyHolds).where(eq(safetyHolds.userId, binding.actorUserId))',
            '.delete(safetyHolds).where(eq(safetyHolds.userId, binding.actorUserId)).returning()',
          ),
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'destructive returning count',
        'unapproved destructive returning',
      ]),
    )
    expect(
      destructiveRawStatementViolations('DELETE FROM audit_event RETURNING id'),
    ).toContain('destructive raw SQL exposes RETURNING data')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          `${adapterSource}\nasync function leaked(database: NodePgDatabase) { return database.select({ password: account.password }).from(account) }`,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'database method outside destructive operation:leaked',
        'destructive plan projection drift',
      ]),
    )
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace(
            'DELETE FROM adjustment_decision_invalidation',
            'DELETE FROM adjustment_decision_invalidation AS foo$tag$; UPDATE installation_state SET claimed_at = NULL',
          ),
        ),
      ),
    ).toContain('destructive raw SQL is not a single statement')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace(
            '$' + '{binding.actorUserId}',
            '$' + '{sql`UPDATE installation_state SET claimed_at = NULL`}',
          ),
        ),
      ),
    ).toContain('unapproved destructive SQL interpolation')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          `${adapterSource}\nasync function injected(sql: any, database: NodePgDatabase) { return database.execute(sql\`DELETE FROM audit_event\`) }`,
        ),
      ),
    ).toContain('destructive sql binding shadow')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          `${adapterSource}\ntype DbAlias = NodePgDatabase\nasync function leaked(db: DbAlias) { return db.select({ password: account.password }).from(account) }`,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'database method outside destructive operation:leaked',
        'destructive plan projection drift',
      ]),
    )
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          `${adapterSource}\ntype DbAlias = NodePgDatabase\nasync function leaked(db: DbAlias) { return db.selectDistinct({ password: account.password }).from(account) }`,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'database method outside destructive operation:leaked',
        'unapproved database method:selectDistinct',
      ]),
    )
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          `${adapterSource}\ntype DbAlias = NodePgDatabase\nasync function leaked(db: DbAlias) { return (db as any).query('SELECT password FROM account') }`,
        ),
      ),
    ).toContain('unapproved database method:query')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          `${adapterSource}\ntype EscapedDb = Parameters<typeof executeSubjectDeletion>[0]\nasync function leaked(conn: EscapedDb) { return conn.query('SELECT password FROM account') }`,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'database method outside destructive operation:leaked',
        'unapproved database method:query',
      ]),
    )
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          `${adapterSource}\nvoid (database as any)['execute']('SELECT password FROM account')`,
        ),
      ),
    ).toContain('computed database method use')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace(
            'const [plan] = await database',
            'const escaped = database\n  void escaped\n  const [plan] = await database',
          ),
        ),
      ),
    ).toContain('database capability alias')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace(
            'const [plan] = await database',
            'const countSubjectRows = (value: unknown) => value\n  void countSubjectRows\n  const [plan] = await database',
          ),
        ),
      ),
    ).toContain('approved database helper shadow:countSubjectRows')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace(
            'await database.execute(sql`\n    DELETE FROM adjustment_decision_invalidation',
            'await database.execute(sql`SELECT password FROM account`)\n  await database.execute(sql`\n    DELETE FROM adjustment_decision_invalidation',
          ),
        ),
      ),
    ).toContain('destructive raw SQL is not a DELETE')
    expect(
      destructiveAdapterCapabilityViolations(
        parseAdapter(
          adapterSource.replace(
            'DELETE FROM adjustment_decision_invalidation',
            'DELETE FROM adjustment_decision_invalidation; UPDATE installation_state SET claimed_at = NULL',
          ),
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'destructive raw SQL is not a DELETE',
        'destructive raw SQL is not a single statement',
      ]),
    )
    expect(
      countHelperCapabilityViolations(
        subjectCounts.replace(
          'SELECT count(*)::int FROM account',
          'SELECT password FROM account',
        ),
        'countSubjectRows',
      ),
    ).toContain('non-count destructive helper projection')
    expect(
      countHelperCapabilityViolations(
        subjectCounts.replace(
          'SELECT count(*)::int FROM account',
          'SELECT count(*)::int + coalesce(length(max(password)), 0) FROM account',
        ),
        'countSubjectRows',
      ),
    ).toEqual(
      expect.arrayContaining([
        'non-count destructive helper projection',
        'non-count top-level destructive projection',
      ]),
    )
    const shadowedCountModule = deletionSource
      .replace(
        'export async function countSubjectRows',
        'const unsafeCount = sql`SELECT count(*)::int FROM account`\n\nexport async function countSubjectRows',
      )
      .replace(
        'const result = await database.execute<SubjectDeletionCounts>(sql`',
        'const sql = (_parts: TemplateStringsArray) => unsafeCount\n  const result = await database.execute<SubjectDeletionCounts>(sql`',
      )
    const shadowedCountAst = ts.createSourceFile(
      deletionPath,
      shadowedCountModule,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    expect(
      countHelperCapabilityViolations(
        functionSource(shadowedCountAst, shadowedCountModule, 'countSubjectRows'),
        'countSubjectRows',
        shadowedCountModule,
      ),
    ).toContain('count sql binding shadow')
    expect(
      countHelperCapabilityViolations(
        subjectCounts.replace(
          [
            '(SELECT count(*)::int FROM account WHERE user_id = $',
            '{userId}) END AS "authAccounts"',
          ].join(''),
          'password AS "authAccounts"',
        ),
        'countSubjectRows',
      ),
    ).toContain('non-count top-level destructive projection')
    expect(
      countHelperCapabilityViolations(
        subjectCounts.replace(
          'const result = await database.execute',
          'const leaked = await readSecret(database)\n  void leaked\n  const result = await database.execute',
        ),
        'countSubjectRows',
      ),
    ).toContain('count database capability escape')
    expect(
      countHelperCapabilityViolations(
        'async function countSubjectRows(database: any) { const result = await database.execute(sql`TABLE account`); return result.rows[0] }',
        'countSubjectRows',
      ),
    ).toContain('count SQL missing SELECT')
    expect(
      countHelperCapabilityViolations(
        'async function countSubjectRows(database: any) { const result = await database.execute(sql`DELETE FROM account`); return result.rows[0] }',
        'countSubjectRows',
      ),
    ).toEqual(
      expect.arrayContaining([
        'count SQL missing SELECT',
        'count SQL mutation verb:DELETE',
      ]),
    )
    expect(
      countHelperCapabilityViolations(
        subjectCounts.replace(
          'SELECT count(*)::int FROM account',
          'SELECT count(*)::int INTO leaked_counts FROM account',
        ),
        'countSubjectRows',
      ),
    ).toContain('count SQL mutation verb:INTO')
    const shadowedDeletionSource = `${deletionSource}\nfunction decoy() { function countSubjectRows() { return undefined } return countSubjectRows }`
    const shadowedDeletionAst = ts.createSourceFile(
      deletionPath,
      shadowedDeletionSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    expect(() =>
      functionSource(shadowedDeletionAst, shadowedDeletionSource, 'countSubjectRows'),
    ).toThrow('Expected exactly one top-level function: countSubjectRows')
  })

  it('pins every cross-cutting mutation grant to the adapter non-owner union', () => {
    for (const op of ['insert', 'update', 'delete'] as const) {
      const expected = [
        ...new Set(
          Object.values(temporaryDestructiveAdapterManifest).flatMap((methods) =>
            methods[op].filter(
              (table) => tableWriteFence[table].owner !== 'data-portability',
            ),
          ),
        ),
      ].sort()
      expect([...crossCuttingOperator.allow[op]]).toEqual(expected)
    }
  })

  it('exposes only purpose-specific one-use gateway methods and no database escape', () => {
    expect(adapterSource).toMatch(
      /interface ScopedDeletionAttemptGateway\s*{\s*invalidatePreviewAfterDenial\(\): Promise<void>/,
    )
    expect(adapterSource).toMatch(
      /interface ScopedSubjectDeletionGateway\s*{\s*execute\(\): Promise<void>/,
    )
    expect(adapterSource).toMatch(
      /interface ScopedInstanceResetGateway\s*{\s*execute\(\): Promise<void>/,
    )
    expect(adapterSource).not.toMatch(/\bgetDb\b|\$client|ScopedTransactionClient/)
    expect(adapterSource).not.toContain('.transaction(')
    expect(adapterSource).toContain('function oneUse')
    expect(adapterSource.match(/requireWriteAuthorized\(\)/g)).toHaveLength(3)
  })

  it('leaves previews in application code and removes legacy protected execution', () => {
    expect(deletionSource).toContain('export async function createInstanceResetPlan')
    expect(deletionSource).toContain('export async function createSubjectDeletionPlan')
    expect(deletionSource).not.toMatch(
      /withDestructiveReauthentication|executeSubjectDeletion|executeInstanceReset|deletion_mode|credential-lifecycle-lock/,
    )
  })
})
