import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const TABLE_FILES = ['auth.ts', 'installation.ts', 'product.ts'] as const
const AUXILIARY_FILES = ['index.ts', 'ownership.ts'] as const
const SCHEMA_FILES = new Set<string>([...TABLE_FILES, ...AUXILIARY_FILES])
const ALLOWED_PG_CORE_SCHEMA_IMPORTS = new Set([
  'boolean',
  'check',
  'date',
  'foreignKey',
  'index',
  'integer',
  'jsonb',
  'pgTable',
  'primaryKey',
  'smallint',
  'text',
  'timestamp',
  'uniqueIndex',
  'uuid',
])

export type SchemaTableCatalog = {
  readonly bindingToSql: ReadonlyMap<string, string>
  readonly sqlNames: ReadonlySet<string>
}

export class SchemaCatalogError extends Error {
  readonly diagnostics: readonly string[]

  constructor(diagnostics: readonly string[]) {
    super(
      `Invalid schema table catalog:\n${diagnostics.map((item) => `- ${item}`).join('\n')}`,
    )
    this.name = 'SchemaCatalogError'
    this.diagnostics = diagnostics
  }
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    : false
}

function location(root: string, file: ts.SourceFile, node: ts.Node): string {
  const path = relative(root, file.fileName).split(sep).join('/')
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file))
  return `${path}:${line + 1}:${character + 1}`
}

type PgTableImportContract = Readonly<{
  broadImports: readonly ts.ImportDeclaration[]
  factories: ReadonlyMap<string, ts.ImportSpecifier>
}>

function pgTableImports(file: ts.SourceFile): PgTableImportContract {
  const broadImports: ts.ImportDeclaration[] = []
  const factories = new Map<string, ts.ImportSpecifier>()
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'drizzle-orm/pg-core'
    ) {
      continue
    }
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly) continue
    if (clause.name) broadImports.push(statement)
    const named = clause.namedBindings
    if (!named) continue
    if (ts.isNamespaceImport(named)) {
      broadImports.push(statement)
      continue
    }
    for (const element of named.elements) {
      if (
        !element.isTypeOnly &&
        (element.propertyName ?? element.name).text === 'pgTable'
      ) {
        factories.set(element.name.text, element)
      }
    }
  }
  return { broadImports, factories }
}

function isRuntimeModuleReference(node: ts.StringLiteralLike): boolean {
  const parent = node.parent
  if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) {
    const clause = parent.importClause
    if (!clause) return true
    if (clause.isTypeOnly) return false
    if (clause.name) return true
    const bindings = clause.namedBindings
    return (
      !bindings ||
      ts.isNamespaceImport(bindings) ||
      bindings.elements.length === 0 ||
      bindings.elements.some((element) => !element.isTypeOnly)
    )
  }
  if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) {
    return (
      !parent.isTypeOnly &&
      (!parent.exportClause ||
        ts.isNamespaceExport(parent.exportClause) ||
        parent.exportClause.elements.length === 0 ||
        parent.exportClause.elements.some((element) => !element.isTypeOnly))
    )
  }
  if (
    ts.isExternalModuleReference(parent) &&
    ts.isImportEqualsDeclaration(parent.parent)
  ) {
    return !parent.parent.isTypeOnly
  }
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return false
    if (ts.isStatement(current) || ts.isExpression(current)) return true
  }
  return true
}

function pgCoreModule(value: string): boolean {
  return value === 'drizzle-orm/pg-core' || value.startsWith('drizzle-orm/pg-core/')
}

function topLevelConstInitializers(
  file: ts.SourceFile,
): ReadonlyMap<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>()
  for (const statement of file.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        bindings.set(declaration.name.text, declaration.initializer)
      }
    }
  }
  return bindings
}

function staticModuleStrings(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): readonly string[] | undefined {
  let value = expression
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isAwaitExpression(value)
  ) {
    value = value.expression
  }
  if (ts.isStringLiteralLike(value)) return [value.text]
  if (ts.isIdentifier(value)) {
    const initializer = bindings.get(value.text)
    return initializer && !seen.has(value.text)
      ? staticModuleStrings(initializer, bindings, new Set(seen).add(value.text))
      : undefined
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticModuleStrings(value.left, bindings, seen)
    const right = staticModuleStrings(value.right, bindings, seen)
    return left && right
      ? left.flatMap((prefix) => right.map((suffix) => prefix + suffix))
      : undefined
  }
  if (ts.isConditionalExpression(value)) {
    const alternatives = [
      ...(staticModuleStrings(value.whenTrue, bindings, seen) ?? []),
      ...(staticModuleStrings(value.whenFalse, bindings, seen) ?? []),
    ]
    return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const alternatives = [
      ...(staticModuleStrings(value.left, bindings, seen) ?? []),
      ...(staticModuleStrings(value.right, bindings, seen) ?? []),
    ]
    return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return staticModuleStrings(value.right, bindings, seen)
  }
  if (ts.isTemplateExpression(value)) {
    let alternatives: readonly string[] = [value.head.text]
    for (const span of value.templateSpans) {
      const substitution = staticModuleStrings(span.expression, bindings, seen)
      if (!substitution) return undefined
      alternatives = alternatives.flatMap((prefix) =>
        substitution.map((item) => prefix + item + span.literal.text),
      )
    }
    return alternatives
  }
  return undefined
}

function isCatalogLoader(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): boolean {
  let value = expression
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    value = value.expression
  }
  if (value.kind === ts.SyntaxKind.ImportKeyword) return true
  if (ts.isIdentifier(value)) {
    if (value.text === 'require') return true
    const initializer = bindings.get(value.text)
    return initializer && !seen.has(value.text)
      ? isCatalogLoader(initializer, bindings, new Set(seen).add(value.text))
      : false
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const member = ts.isPropertyAccessExpression(value)
      ? value.name.text
      : value.argumentExpression && ts.isStringLiteralLike(value.argumentExpression)
        ? value.argumentExpression.text
        : undefined
    return member === 'require'
  }
  if (ts.isConditionalExpression(value)) {
    return (
      isCatalogLoader(value.whenTrue, bindings, seen) ||
      isCatalogLoader(value.whenFalse, bindings, seen)
    )
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.CommaToken)
  ) {
    return (
      isCatalogLoader(value.left, bindings, seen) ||
      isCatalogLoader(value.right, bindings, seen)
    )
  }
  return false
}

function runtimePgCoreAcquisitions(file: ts.SourceFile): readonly ts.Node[] {
  const bindings = topLevelConstInitializers(file)
  const acquisitions: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      pgCoreModule(node.moduleSpecifier.text) &&
      isRuntimeModuleReference(node.moduleSpecifier)
    ) {
      acquisitions.push(node)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      pgCoreModule(node.moduleReference.expression.text)
    ) {
      acquisitions.push(node)
    } else if (ts.isCallExpression(node) && isCatalogLoader(node.expression, bindings)) {
      const providers = node.arguments[0]
        ? staticModuleStrings(node.arguments[0], bindings)
        : undefined
      if (providers?.some(pgCoreModule)) acquisitions.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return acquisitions
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return false
  }
  return true
}

type Declaration = Readonly<{
  binding: string
  call: ts.CallExpression
  sqlName: string
}>

function tableDeclarations(
  root: string,
  file: ts.SourceFile,
  diagnostics: string[],
): readonly Declaration[] {
  const imports = pgTableImports(file)
  const { factories } = imports
  const acceptedCalls = new Set<ts.CallExpression>()
  const declarations: Declaration[] = []
  const topLevelVariables = new Set<string>()

  for (const statement of imports.broadImports) {
    diagnostics.push(
      `${location(root, file, statement)} pgTable must be imported through a named pg-core import`,
    )
  }

  const visitPgCoreBoundary = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'drizzle-orm/pg-core'
    ) {
      const clause = node.importClause
      const named = clause?.namedBindings
      if (
        isRuntimeModuleReference(node.moduleSpecifier) &&
        (!clause || !named || !ts.isNamedImports(named) || named.elements.length === 0)
      ) {
        diagnostics.push(
          `${location(root, file, node)} table files may acquire pg-core only through named imports`,
        )
      }
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const imported = (element.propertyName ?? element.name).text
          if (!element.isTypeOnly && !ALLOWED_PG_CORE_SCHEMA_IMPORTS.has(imported)) {
            diagnostics.push(
              `${location(root, file, element)} pg-core runtime import ${JSON.stringify(imported)} is outside the pinned schema-builder set`,
            )
          }
        }
      }
    }
    ts.forEachChild(node, visitPgCoreBoundary)
  }
  visitPgCoreBoundary(file)
  for (const acquisition of runtimePgCoreAcquisitions(file)) {
    if (
      ts.isImportDeclaration(acquisition) &&
      ts.isStringLiteralLike(acquisition.moduleSpecifier) &&
      acquisition.moduleSpecifier.text === 'drizzle-orm/pg-core'
    ) {
      continue
    }
    diagnostics.push(
      `${location(root, file, acquisition)} table files cannot acquire pg-core outside a static root named import`,
    )
  }

  for (const statement of file.statements) {
    if (
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      (hasExportModifier(statement) && !ts.isVariableStatement(statement))
    ) {
      diagnostics.push(
        `${location(root, file, statement)} schema table files may export only direct const pgTable declarations`,
      )
    }
  }

  const rememberBinding = (binding: ts.BindingName): void => {
    if (ts.isIdentifier(binding)) {
      topLevelVariables.add(binding.text)
      return
    }
    for (const element of binding.elements) {
      if (!ts.isOmittedExpression(element)) rememberBinding(element.name)
    }
  }
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      rememberBinding(declaration.name)
    }
  }

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      const call =
        initializer && ts.isCallExpression(initializer) ? initializer : undefined
      const firstArgument = call?.arguments[0]
      if (
        isConst &&
        ts.isIdentifier(declaration.name) &&
        call &&
        ts.isIdentifier(call.expression) &&
        factories.has(call.expression.text) &&
        firstArgument &&
        ts.isStringLiteralLike(firstArgument)
      ) {
        acceptedCalls.add(call)
        declarations.push({
          binding: declaration.name.text,
          call,
          sqlName: firstArgument.text,
        })
        continue
      }
      diagnostics.push(
        `${location(root, file, declaration)} exported variables in schema table files must be direct const pgTable declarations`,
      )
    }
  }

  for (const statement of file.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (topLevelVariables.has((element.propertyName ?? element.name).text)) {
          diagnostics.push(
            `${location(root, file, element)} schema variables must be exported at their direct pgTable declaration`,
          )
        }
      }
    } else if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression) &&
      topLevelVariables.has(statement.expression.text)
    ) {
      diagnostics.push(
        `${location(root, file, statement)} schema variables cannot be exported indirectly`,
      )
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      factories.has(node.expression.text) &&
      !acceptedCalls.has(node)
    ) {
      diagnostics.push(
        `${location(root, file, node)} pgTable may only be called by a direct top-level exported const declaration`,
      )
    }
    if (
      ts.isIdentifier(node) &&
      factories.has(node.text) &&
      isIdentifierReference(node) &&
      !(
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        ts.isImportSpecifier(node.parent)
      )
    ) {
      diagnostics.push(
        `${location(root, file, node)} pgTable imports cannot be wrapped, rebound, or passed as values`,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return declarations
}

/**
 * Builds the binding-name to SQL-name catalog consumed by the schema ownership
 * scanners. The deliberately small accepted grammar keeps the catalog complete:
 * exactly three table files, with every exported variable being a direct
 * top-level call to a named `pgTable` import.
 */
export function buildSchemaTableMap(sourceRoot: string): SchemaTableCatalog {
  const schemaDirectory = resolve(sourceRoot, 'platform/db/schema')
  const diagnostics: string[] = []
  if (!existsSync(schemaDirectory)) {
    throw new SchemaCatalogError(['platform/db/schema is missing'])
  }

  const entries = readdirSync(schemaDirectory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const regularFiles = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  )
  for (const expected of SCHEMA_FILES) {
    if (!regularFiles.has(expected)) {
      diagnostics.push(
        `platform/db/schema/${expected} is missing or is not a regular file`,
      )
    }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !SCHEMA_FILES.has(entry.name)) {
      diagnostics.push(
        `platform/db/schema/${entry.name} is outside the fixed schema source inventory`,
      )
    }
  }

  const bindingToSql = new Map<string, string>()
  const bindingOrigins = new Map<string, string>()
  const sqlOrigins = new Map<string, string>()
  for (const filename of TABLE_FILES) {
    const path = resolve(schemaDirectory, filename)
    if (!regularFiles.has(filename)) continue
    const file = sourceFile(path)
    for (const declaration of tableDeclarations(sourceRoot, file, diagnostics)) {
      const at = location(sourceRoot, file, declaration.call)
      const bindingOrigin = bindingOrigins.get(declaration.binding)
      if (bindingOrigin) {
        diagnostics.push(
          `${at} duplicate schema binding ${JSON.stringify(declaration.binding)}; first declared at ${bindingOrigin}`,
        )
      } else {
        bindingOrigins.set(declaration.binding, at)
      }
      const sqlOrigin = sqlOrigins.get(declaration.sqlName)
      if (sqlOrigin) {
        diagnostics.push(
          `${at} duplicate SQL table name ${JSON.stringify(declaration.sqlName)}; first declared at ${sqlOrigin}`,
        )
      } else {
        sqlOrigins.set(declaration.sqlName, at)
      }
      if (!bindingOrigin && !sqlOrigin) {
        bindingToSql.set(declaration.binding, declaration.sqlName)
      }
    }
  }

  for (const filename of AUXILIARY_FILES) {
    const path = resolve(schemaDirectory, filename)
    if (!regularFiles.has(filename)) continue
    const file = sourceFile(path)
    if (filename === 'index.ts') {
      const expected = new Set(['./auth', './installation', './product'])
      const observed = new Map<string, number>()
      for (const statement of file.statements) {
        if (
          ts.isExportDeclaration(statement) &&
          !statement.isTypeOnly &&
          !statement.exportClause &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          expected.has(statement.moduleSpecifier.text)
        ) {
          const specifier = statement.moduleSpecifier.text
          observed.set(specifier, (observed.get(specifier) ?? 0) + 1)
        } else {
          diagnostics.push(
            `${location(sourceRoot, file, statement)} schema index may only re-export the fixed table files`,
          )
        }
      }
      for (const specifier of expected) {
        const count = observed.get(specifier) ?? 0
        if (count === 0) {
          diagnostics.push(`platform/db/schema/index.ts must re-export ${specifier}`)
        } else if (count > 1) {
          diagnostics.push(
            `platform/db/schema/index.ts must re-export ${specifier} exactly once`,
          )
        }
      }
    }
    const imports = pgTableImports(file)
    for (const imported of imports.factories.values()) {
      diagnostics.push(
        `${location(sourceRoot, file, imported)} auxiliary schema files cannot import pgTable`,
      )
    }
    for (const statement of imports.broadImports) {
      diagnostics.push(
        `${location(sourceRoot, file, statement)} auxiliary schema files cannot use broad pg-core imports`,
      )
    }
    for (const acquisition of runtimePgCoreAcquisitions(file)) {
      diagnostics.push(
        `${location(sourceRoot, file, acquisition)} auxiliary schema files cannot acquire pg-core at runtime`,
      )
    }
  }

  if (diagnostics.length > 0) throw new SchemaCatalogError(diagnostics)
  return { bindingToSql, sqlNames: new Set(bindingToSql.values()) }
}
