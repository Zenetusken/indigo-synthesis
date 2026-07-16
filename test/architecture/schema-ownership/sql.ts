import { createHash } from 'node:crypto'
import ts from 'typescript'

export type RawWriteOp = 'insert' | 'update' | 'delete'

export type RawObservedWrite = Readonly<{
  evidence: 'executable' | 'potential'
  principal: string
  table: string
  op: RawWriteOp
  kind: 'raw'
  file: string
  line: number
}>

export class SqlScanError extends Error {
  constructor(
    readonly code:
      | 'ownership.sql.identifier-unsupported'
      | 'ownership.sql.provider-unresolved'
      | 'ownership.sql.mutation-unsupported',
    message: string,
  ) {
    super(message)
    this.name = 'SqlScanError'
  }
}

const SQL_EXECUTION_METHODS = new Set(['execute', 'query', 'queryArray'])
const identifierContinuation = /[\p{L}\p{N}_$]/u

function blankRange(characters: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') {
      characters[index] = ' '
    }
  }
}

function skipSqlTrivia(sql: string, start: number): number {
  let index = start
  while (index < sql.length) {
    while (/\s/.test(sql[index] ?? '')) index += 1
    if (sql[index] === '-' && sql[index + 1] === '-') {
      index += 2
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1
      }
      continue
    }
    if (sql[index] !== '/' || sql[index + 1] !== '*') return index
    let depth = 1
    index += 2
    while (index < sql.length && depth > 0) {
      if (sql[index] === '/' && sql[index + 1] === '*') {
        depth += 1
        index += 2
      } else if (sql[index] === '*' && sql[index + 1] === '/') {
        depth -= 1
        index += 2
      } else {
        index += 1
      }
    }
  }
  return index
}

/**
 * Return a length-preserving view of executable PostgreSQL tokens.
 *
 * Comments and literal bodies become whitespace. Simple quoted identifiers are
 * retained; a simple `U&"name"` is canonicalized to `"name"`. The dollar-quote
 * boundary mirrors PostgreSQL: a delimiter adjacent to an identifier is part of
 * that identifier, not a string opener.
 */
export function executableSqlText(
  sql: string,
  preserveSimpleQuotedIdentifiers = true,
): string {
  const characters = sql.split('')

  for (let index = 0; index < sql.length; ) {
    const next = sql[index + 1]
    if (sql[index] === '-' && next === '-') {
      const start = index
      index += 2
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1
      }
      blankRange(characters, start, index)
      continue
    }
    if (sql[index] === '/' && next === '*') {
      const start = index
      let depth = 1
      index += 2
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1
          index += 2
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1
          index += 2
        } else {
          index += 1
        }
      }
      blankRange(characters, start, index)
      continue
    }
    if (sql[index] === "'") {
      const start = index
      const escapeString =
        index > 0 &&
        /[eE]/.test(sql[index - 1] ?? '') &&
        (index < 2 || !identifierContinuation.test(sql[index - 2] ?? ''))
      index += 1
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2
        } else if (escapeString && sql[index] === '\\' && index + 1 < sql.length) {
          index += 2
        } else if (sql[index] === "'") {
          index += 1
          break
        } else {
          index += 1
        }
      }
      blankRange(characters, start, index)
      continue
    }
    if (
      sql[index] === '$' &&
      (index === 0 || !identifierContinuation.test(sql[index - 1] ?? ''))
    ) {
      const delimiter = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0]
      if (delimiter) {
        const start = index
        index += delimiter.length
        const close = sql.indexOf(delimiter, index)
        index = close < 0 ? sql.length : close + delimiter.length
        blankRange(characters, start, index)
        continue
      }
    }
    if (sql[index] === '"') {
      const unicodePrefix =
        index >= 2 &&
        /[uU]/.test(sql[index - 2] ?? '') &&
        sql[index - 1] === '&' &&
        (index < 3 || !identifierContinuation.test(sql[index - 3] ?? ''))
      const quoteStart = index
      const start = unicodePrefix ? index - 2 : index
      let identifier = ''
      index += 1
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          identifier += '"'
          index += 2
        } else if (sql[index] === '"') {
          index += 1
          break
        } else {
          identifier += sql[index]
          index += 1
        }
      }
      const simpleIdentifier = /^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)
      const explicitUnicodeEscape =
        unicodePrefix && /^UESCAPE\b/i.test(sql.slice(skipSqlTrivia(sql, index)))
      if (unicodePrefix && (!simpleIdentifier || explicitUnicodeEscape)) {
        throw new SqlScanError(
          'ownership.sql.identifier-unsupported',
          'Unicode-escaped SQL identifiers are outside the accepted static grammar.',
        )
      }
      if (preserveSimpleQuotedIdentifiers && simpleIdentifier) {
        if (unicodePrefix) blankRange(characters, start, quoteStart)
      } else {
        blankRange(characters, start, index)
      }
      continue
    }
    index += 1
  }

  return characters.join('')
}

function templateText(template: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text
  return [
    template.head.text,
    ...template.templateSpans.map((span) => ` ${span.literal.text}`),
  ].join('')
}

type BindingKind =
  | 'const'
  | 'drizzle-sql-import'
  | 'function'
  | 'mutable'
  | 'other-import'
  | 'parameter'

type Binding = {
  readonly destructured?: boolean
  readonly importedFrom?: string
  readonly importedName?: string
  readonly importTypeOnly?: boolean
  readonly kind: BindingKind
  readonly initializer?: ts.Expression
  readonly node: ts.Node
}

type BindingIndex = Readonly<{
  assignmentIsSink(identifier: ts.Identifier): boolean
  assignmentValues(identifier: ts.Identifier): readonly ts.Expression[]
  binding(identifier: ts.Identifier): Binding | undefined
  hasAssignment(identifier: ts.Identifier): boolean
}>

function isScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isCaseBlock(node) ||
    ts.isFunctionLike(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  )
}

function nearestScope(node: ts.Node, functionScoped = false): ts.Node {
  for (
    let current: ts.Node | undefined = node.parent;
    current;
    current = current.parent
  ) {
    if (
      isScope(current) &&
      (!functionScoped ||
        ts.isFunctionLike(current) ||
        ts.isModuleBlock(current) ||
        ts.isClassStaticBlockDeclaration(current) ||
        ts.isSourceFile(current))
    ) {
      return current
    }
  }
  return node.getSourceFile()
}

function bindingNames(name: ts.BindingName): readonly ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name]
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  )
}

type AssignmentTarget = Readonly<{
  identifier: ts.Identifier
  sinkCapability: boolean
}>

function assignmentTargets(
  expression: ts.Expression,
  sinkCapability = false,
): readonly AssignmentTarget[] {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) return [{ identifier: value, sinkCapability }]
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentTargets(value.left, sinkCapability)
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return [
          {
            identifier: property.name,
            sinkCapability:
              sinkCapability || SQL_EXECUTION_METHODS.has(property.name.text),
          },
        ]
      }
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name)
        return assignmentTargets(
          property.initializer,
          sinkCapability || !name || SQL_EXECUTION_METHODS.has(name),
        )
      }
      if (ts.isSpreadAssignment(property))
        return assignmentTargets(property.expression, sinkCapability)
      return []
    })
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.flatMap((element) =>
      ts.isOmittedExpression(element)
        ? []
        : ts.isSpreadElement(element)
          ? assignmentTargets(element.expression, sinkCapability)
          : assignmentTargets(element, sinkCapability),
    )
  }
  return []
}

function createBindingIndex(sourceFile: ts.SourceFile): BindingIndex {
  const byScope = new Map<ts.Node, Map<string, Binding[]>>()
  const assignments: Array<{
    readonly sinkCapability: boolean
    readonly target: ts.Identifier
    readonly value?: ts.Expression
  }> = []
  const remember = (scope: ts.Node, name: string, binding: Binding): void => {
    const names = byScope.get(scope) ?? new Map<string, Binding[]>()
    const values = names.get(name) ?? []
    values.push(binding)
    names.set(name, values)
    byScope.set(scope, names)
  }

  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const module = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined
      const named = node.importClause?.namedBindings
      if (node.importClause?.name) {
        remember(sourceFile, node.importClause.name.text, {
          importedFrom: module,
          importedName: 'default',
          importTypeOnly: node.importClause.isTypeOnly,
          kind: 'other-import',
          node: node.importClause.name,
        })
      }
      if (named && ts.isNamespaceImport(named)) {
        remember(sourceFile, named.name.text, {
          importedFrom: module,
          importedName: '*',
          importTypeOnly: node.importClause?.isTypeOnly,
          kind: 'other-import',
          node: named.name,
        })
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const imported = (element.propertyName ?? element.name).text
          remember(sourceFile, element.name.text, {
            importedFrom: module,
            importedName: imported,
            importTypeOnly: node.importClause?.isTypeOnly === true || element.isTypeOnly,
            kind:
              module === 'drizzle-orm' && imported === 'sql'
                ? 'drizzle-sql-import'
                : 'other-import',
            node: element,
          })
        }
      }
    }
    if (ts.isParameter(node)) {
      const scope = ts.isFunctionLike(node.parent) ? node.parent : nearestScope(node)
      for (const name of bindingNames(node.name)) {
        remember(scope, name.text, {
          destructured: !ts.isIdentifier(node.name),
          kind: 'parameter',
          node,
        })
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const declarationList = ts.isVariableDeclarationList(node.parent)
        ? node.parent
        : undefined
      const isConst = !!declarationList && !!(declarationList.flags & ts.NodeFlags.Const)
      const functionScoped =
        !!declarationList && (declarationList.flags & ts.NodeFlags.BlockScoped) === 0
      const names = bindingNames(node.name)
      for (const name of names) {
        remember(nearestScope(node, functionScoped), name.text, {
          destructured: !ts.isIdentifier(node.name),
          initializer:
            names.length === 1 && ts.isIdentifier(node.name)
              ? node.initializer
              : undefined,
          kind: isConst ? 'const' : 'mutable',
          node,
        })
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      remember(nearestScope(node), node.name.text, { kind: 'function', node })
    }
    if (ts.isClassDeclaration(node) && node.name) {
      remember(nearestScope(node), node.name.text, { kind: 'mutable', node })
    }
    if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind)) {
      for (const target of assignmentTargets(node.left)) {
        assignments.push({
          sinkCapability: target.sinkCapability,
          target: target.identifier,
          value: node.right,
        })
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      assignments.push({ sinkCapability: false, target: node.operand })
    }
    ts.forEachChild(node, collect)
  }
  collect(sourceFile)

  const binding = (identifier: ts.Identifier): Binding | undefined => {
    for (
      let current: ts.Node | undefined = identifier.parent;
      current;
      current = current.parent
    ) {
      if (!isScope(current)) continue
      const values = byScope.get(current)?.get(identifier.text)
      if (!values || values.length === 0) continue
      return values.length === 1
        ? values[0]
        : { kind: 'mutable', node: values[values.length - 1]?.node ?? current }
    }
    return undefined
  }

  return {
    assignmentIsSink: (identifier) => {
      const expected = binding(identifier)?.node
      return (
        !!expected &&
        assignments.some(
          (assignment) =>
            assignment.sinkCapability && binding(assignment.target)?.node === expected,
        )
      )
    },
    assignmentValues: (identifier) => {
      const expected = binding(identifier)?.node
      return expected
        ? assignments.flatMap((assignment) =>
            binding(assignment.target)?.node === expected && assignment.value
              ? [assignment.value]
              : [],
          )
        : []
    },
    binding,
    hasAssignment: (identifier) => {
      const expected = binding(identifier)?.node
      return (
        !!expected &&
        assignments.some((assignment) => binding(assignment.target)?.node === expected)
      )
    },
  }
}

const assignmentOperators = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

function unwrap(expression: ts.Expression): ts.Expression {
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
  return value
}

const maximumStaticAlternatives = 32

function combineStaticTexts(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  if (left.length * right.length > maximumStaticAlternatives) {
    throw new SqlScanError(
      'ownership.sql.provider-unresolved',
      'Static SQL provider alternatives exceed the accepted grammar.',
    )
  }
  return left.flatMap((prefix) => right.map((suffix) => prefix + suffix))
}

/**
 * Resolve only JavaScript strings whose possible values are statically closed.
 * Unknown template substitutions remain placeholders: ordinary query values are
 * not SQL syntax, while immutable string substitutions and concatenations are.
 */
function staticTexts(
  expression: ts.Expression,
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): readonly string[] | undefined {
  const value = unwrap(expression)
  if (seen.has(value)) return undefined
  const branchSeen = new Set(seen).add(value)
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return [value.text]
  }
  if (ts.isTemplateExpression(value)) {
    let texts: readonly string[] = [value.head.text]
    for (const span of value.templateSpans) {
      const substitutions = staticTexts(span.expression, bindings, branchSeen) ?? [' ']
      const combined = combineStaticTexts(texts, substitutions)
      texts = combined.map((text) => text + span.literal.text)
    }
    return texts
  }
  if (ts.isIdentifier(value)) {
    const binding = bindings.binding(value)
    if (
      binding?.kind === 'const' &&
      binding.initializer &&
      !bindings.hasAssignment(value)
    ) {
      return staticTexts(binding.initializer, bindings, branchSeen)
    }
    return undefined
  }
  if (ts.isConditionalExpression(value)) {
    const whenTrue = staticTexts(value.whenTrue, bindings, branchSeen)
    const whenFalse = staticTexts(value.whenFalse, bindings, branchSeen)
    if (!whenTrue || !whenFalse) return undefined
    const alternatives = [...new Set([...whenTrue, ...whenFalse])]
    if (alternatives.length > maximumStaticAlternatives) {
      throw new SqlScanError(
        'ownership.sql.provider-unresolved',
        'Static SQL provider alternatives exceed the accepted grammar.',
      )
    }
    return alternatives
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const left = staticTexts(value.left, bindings, branchSeen)
    const right = staticTexts(value.right, bindings, branchSeen)
    if (!left || !right) return undefined
    const alternatives = [...new Set([...left, ...right])]
    if (alternatives.length > maximumStaticAlternatives) {
      throw new SqlScanError(
        'ownership.sql.provider-unresolved',
        'Static SQL provider alternatives exceed the accepted grammar.',
      )
    }
    return alternatives
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticTexts(value.left, bindings, branchSeen)
    const right = staticTexts(value.right, bindings, branchSeen)
    return left && right ? combineStaticTexts(left, right) : undefined
  }
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
    const binding = bindings.binding(value.expression)
    if (
      binding?.kind !== 'function' ||
      !ts.isFunctionDeclaration(binding.node) ||
      bindings.hasAssignment(value.expression)
    ) {
      return undefined
    }
    const callable = binding.node
    if (!callable.body || branchSeen.has(callable)) return undefined
    const callableSeen = new Set(branchSeen).add(callable)
    const alternatives: string[] = []
    let unsupportedReturn = false
    const visit = (node: ts.Node): void => {
      if (node !== callable && ts.isFunctionLike(node)) return
      if (ts.isReturnStatement(node)) {
        const texts = node.expression
          ? staticTexts(node.expression, bindings, callableSeen)
          : undefined
        if (!texts) unsupportedReturn = true
        else alternatives.push(...texts)
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(callable)
    const unique = [...new Set(alternatives)]
    if (unsupportedReturn || unique.length === 0) return undefined
    if (unique.length > maximumStaticAlternatives) {
      throw new SqlScanError(
        'ownership.sql.provider-unresolved',
        'Static SQL provider alternatives exceed the accepted grammar.',
      )
    }
    return unique
  }
  return undefined
}

function isSqlIdentifier(identifier: ts.Identifier, bindings: BindingIndex): boolean {
  const binding = bindings.binding(identifier)
  return (
    binding?.kind === 'drizzle-sql-import' ||
    (identifier.text === 'sql' && binding === undefined)
  )
}

function isSqlTag(tag: ts.Expression, bindings: BindingIndex): boolean {
  const value = unwrap(tag)
  if (ts.isIdentifier(value)) return isSqlIdentifier(value, bindings)
  if (
    ts.isPropertyAccessExpression(value) &&
    value.name.text === 'raw' &&
    ts.isIdentifier(unwrap(value.expression))
  ) {
    return isSqlIdentifier(unwrap(value.expression) as ts.Identifier, bindings)
  }
  return false
}

type Evidence = Readonly<{ node: ts.Node; text: string }>
type ClassifiedEvidence = Evidence & Readonly<{ evidence: RawObservedWrite['evidence'] }>

type SchemaBindingToSql = ReadonlyMap<string, string>

function alternatives(expression: ts.Expression): readonly ts.Expression[] {
  const value = unwrap(expression)
  if (ts.isConditionalExpression(value)) {
    return [...alternatives(value.whenTrue), ...alternatives(value.whenFalse)]
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return [...alternatives(value.left), ...alternatives(value.right)]
  }
  return [value]
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined
}

function expressionMemberName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  bindings: BindingIndex,
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  const names = expression.argumentExpression
    ? staticTexts(expression.argumentExpression, bindings)
    : undefined
  return names?.length === 1 ? names[0] : undefined
}

function isSqlRawCall(
  expression: ts.Expression,
  bindings: BindingIndex,
): expression is ts.CallExpression {
  const value = unwrap(expression)
  return (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'raw' &&
    ts.isIdentifier(unwrap(value.expression.expression)) &&
    isSqlIdentifier(unwrap(value.expression.expression) as ts.Identifier, bindings)
  )
}

function expressionIsRawProviderCapability(
  expression: ts.Expression,
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): boolean {
  const value = unwrap(expression)
  if (seen.has(value)) return false
  const branchSeen = new Set(seen).add(value)
  if (
    (ts.isPropertyAccessExpression(value) && value.name.text === 'raw') ||
    (ts.isElementAccessExpression(value) &&
      value.argumentExpression &&
      staticTexts(value.argumentExpression, bindings)?.some((method) => method === 'raw'))
  ) {
    return true
  }
  if (ts.isIdentifier(value)) {
    const binding = bindings.binding(value)
    return binding?.kind === 'const' &&
      binding.initializer &&
      !bindings.hasAssignment(value)
      ? expressionIsRawProviderCapability(binding.initializer, bindings, branchSeen)
      : false
  }
  if (ts.isConditionalExpression(value)) {
    return (
      expressionIsRawProviderCapability(value.whenTrue, bindings, branchSeen) ||
      expressionIsRawProviderCapability(value.whenFalse, bindings, branchSeen)
    )
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      expressionIsRawProviderCapability(value.left, bindings, branchSeen) ||
      expressionIsRawProviderCapability(value.right, bindings, branchSeen)
    )
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return expressionIsRawProviderCapability(value.right, bindings, branchSeen)
  }
  return (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'bind' &&
    expressionIsRawProviderCapability(value.expression.expression, bindings, branchSeen)
  )
}

function appliedRawProvider(
  expression: ts.Expression | undefined,
): readonly ts.Expression[] {
  if (!expression) return []
  const value = unwrap(expression)
  if (!ts.isArrayLiteralExpression(value)) return [expression]
  const first = value.elements[0]
  return first && !ts.isOmittedExpression(first) && !ts.isSpreadElement(first)
    ? [first]
    : []
}

function rawProviderExpressionsForCall(
  call: ts.CallExpression,
  bindings: BindingIndex,
): readonly ts.Expression[] | undefined {
  const callee = unwrap(call.expression)
  if (expressionIsRawProviderCapability(callee, bindings)) {
    return call.arguments.slice(0, 1)
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === 'call' || callee.name.text === 'apply') &&
    expressionIsRawProviderCapability(callee.expression, bindings)
  ) {
    return callee.name.text === 'call'
      ? call.arguments.slice(1, 2)
      : appliedRawProvider(call.arguments[1])
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Reflect' &&
    callee.name.text === 'apply' &&
    call.arguments[0] &&
    expressionIsRawProviderCapability(call.arguments[0], bindings)
  ) {
    return appliedRawProvider(call.arguments[2])
  }
  return undefined
}

function cataloguedTableName(
  expression: ts.Expression,
  bindings: BindingIndex,
  schemaBindingToSql: SchemaBindingToSql | undefined,
): string | undefined {
  if (!schemaBindingToSql) return undefined
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) {
    const binding = bindings.binding(value)
    return binding?.kind === 'other-import' &&
      binding.importTypeOnly !== true &&
      binding.importedFrom === '@/platform/db/schema' &&
      binding.importedName &&
      binding.importedName !== '*'
      ? schemaBindingToSql.get(binding.importedName)
      : undefined
  }
  if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
    const binding = bindings.binding(value.expression)
    return binding?.kind === 'other-import' &&
      binding.importTypeOnly !== true &&
      binding.importedFrom === '@/platform/db/schema' &&
      binding.importedName === '*'
      ? schemaBindingToSql.get(value.name.text)
      : undefined
  }
  return undefined
}

function drizzleTemplateTexts(
  template: ts.TemplateLiteral,
  bindings: BindingIndex,
  schemaBindingToSql: SchemaBindingToSql | undefined,
  seen: Set<ts.Node>,
): readonly string[] | undefined {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return [template.text]
  let texts: readonly string[] = [template.head.text]
  for (const span of template.templateSpans) {
    const expression = unwrap(span.expression)
    let substitutions: readonly string[] = [' ']
    const table = cataloguedTableName(expression, bindings, schemaBindingToSql)
    if (table) {
      substitutions = [table]
    } else if (isSqlRawCall(expression, bindings) && expression.arguments[0]) {
      const nested = evidenceFromProvider(
        expression.arguments[0],
        bindings,
        schemaBindingToSql,
        seen,
      )
      if (!nested) return undefined
      substitutions = nested.map(({ text }) => text)
    } else if (
      ts.isTaggedTemplateExpression(expression) &&
      isSqlTag(expression.tag, bindings)
    ) {
      const nested = drizzleTemplateTexts(
        expression.template,
        bindings,
        schemaBindingToSql,
        seen,
      )
      if (!nested) return undefined
      substitutions = nested
    }
    texts = combineStaticTexts(texts, substitutions).map(
      (text) => text + span.literal.text,
    )
  }
  return texts
}

function evidenceFromProvider(
  expression: ts.Expression,
  bindings: BindingIndex,
  schemaBindingToSql?: SchemaBindingToSql,
  seen = new Set<ts.Node>(),
): readonly Evidence[] | undefined {
  const evidence: Evidence[] = []
  for (const candidate of alternatives(expression)) {
    const value = unwrap(candidate)
    if (seen.has(value)) return undefined
    const branchSeen = new Set(seen).add(value)
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      evidence.push({ node: value, text: value.text })
      continue
    }
    if (ts.isTemplateExpression(value)) {
      for (const text of staticTexts(value, bindings) ?? [templateText(value)]) {
        evidence.push({ node: value, text })
      }
      continue
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const texts = staticTexts(value, bindings)
      if (!texts) return undefined
      for (const text of texts) {
        evidence.push({ node: value, text })
      }
      continue
    }
    if (ts.isTaggedTemplateExpression(value) && isSqlTag(value.tag, bindings)) {
      const texts = drizzleTemplateTexts(
        value.template,
        bindings,
        schemaBindingToSql,
        branchSeen,
      )
      if (!texts) return undefined
      for (const text of texts) evidence.push({ node: value.template, text })
      continue
    }
    if (ts.isIdentifier(value)) {
      const binding = bindings.binding(value)
      if (
        binding?.kind === 'const' &&
        binding.initializer &&
        !bindings.hasAssignment(value)
      ) {
        const nested = evidenceFromProvider(
          binding.initializer,
          bindings,
          schemaBindingToSql,
          branchSeen,
        )
        if (!nested) return undefined
        evidence.push(...nested)
      } else {
        return undefined
      }
      continue
    }
    if (ts.isObjectLiteralExpression(value)) {
      if (value.properties.length !== 1) return undefined
      const only = value.properties[0]
      if (only && ts.isPropertyAssignment(only) && propertyName(only.name) === 'text') {
        const nested = evidenceFromProvider(
          only.initializer,
          bindings,
          schemaBindingToSql,
          branchSeen,
        )
        if (!nested) return undefined
        evidence.push(...nested)
      } else if (only && ts.isShorthandPropertyAssignment(only)) {
        if (only.name.text === 'text') {
          const nested = evidenceFromProvider(
            only.name,
            bindings,
            schemaBindingToSql,
            branchSeen,
          )
          if (!nested) return undefined
          evidence.push(...nested)
        } else return undefined
      } else {
        return undefined
      }
      continue
    }
    if (ts.isCallExpression(value)) {
      const providers = rawProviderExpressionsForCall(value, bindings)
      if (providers) {
        for (const provider of providers) {
          const nested = evidenceFromProvider(
            provider,
            bindings,
            schemaBindingToSql,
            branchSeen,
          )
          if (!nested) return undefined
          evidence.push(...nested)
        }
        continue
      }
    }
    if (ts.isCallExpression(value)) {
      const texts = staticTexts(value, bindings, seen)
      if (!texts) return undefined
      for (const text of texts) {
        evidence.push({ node: value, text })
      }
      continue
    }
    return undefined
  }
  return evidence
}

const SIMPLE_IDENTIFIER = '(?:"[A-Za-z_][A-Za-z0-9_$]*"|[A-Za-z_][A-Za-z0-9_$]*)'
const QUALIFIED_TARGET = `${SIMPLE_IDENTIFIER}(?:\\s*\\.\\s*${SIMPLE_IDENTIFIER})?`

function tableName(target: string): string {
  const last = target.split(/\s*\.\s*/).at(-1) ?? target
  return last.startsWith('"') && last.endsWith('"')
    ? last.slice(1, -1)
    : last.toLowerCase()
}

function targetPatterns(): readonly {
  readonly op: RawWriteOp
  readonly re: RegExp
}[] {
  return [
    {
      op: 'insert',
      re: new RegExp(
        `\\bINSERT\\s+INTO\\s+(?:ONLY\\s+)?(${QUALIFIED_TARGET})(?:\\s+\\*)?`,
        'gi',
      ),
    },
    {
      op: 'delete',
      re: new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?(${QUALIFIED_TARGET})`, 'gi'),
    },
    {
      op: 'update',
      re: new RegExp(
        `\\bUPDATE\\s+(?:ONLY\\s+)?(${QUALIFIED_TARGET})(?:\\s+\\*)?(?:\\s+(?:AS\\s+)?${SIMPLE_IDENTIFIER})?\\s+SET\\b`,
        'gi',
      ),
    },
  ]
}

function parenthesisDepths(statement: string): readonly number[] {
  const depths: number[] = []
  let depth = 0
  for (let index = 0; index < statement.length; index += 1) {
    depths[index] = depth
    if (statement[index] === '(') depth += 1
    else if (statement[index] === ')') depth = Math.max(0, depth - 1)
  }
  return depths
}

function insertCommandEnd(
  statement: string,
  insertStart: number,
  insertDepth: number,
  depths: readonly number[],
  laterInsertStarts: readonly number[],
): number {
  const nextPeer = laterInsertStarts.find(
    (start) => start > insertStart && depths[start] === insertDepth,
  )
  for (let index = insertStart + 1; index < (nextPeer ?? statement.length); index += 1) {
    if (statement[index] === ')' && depths[index] === insertDepth) return index
  }
  return nextPeer ?? statement.length
}

function insertHasConflictUpdate(
  statement: string,
  insertStart: number,
  insertEnd: number,
  insertDepth: number,
  depths: readonly number[],
): boolean {
  const conflictPattern = /\bON\s+CONFLICT\b/gi
  conflictPattern.lastIndex = insertStart
  for (
    let conflict = conflictPattern.exec(statement);
    conflict && (conflict.index ?? statement.length) < insertEnd;
    conflict = conflictPattern.exec(statement)
  ) {
    const conflictStart = conflict.index ?? 0
    if (depths[conflictStart] !== insertDepth) continue
    const updatePattern = /\bDO\s+UPDATE\b/gi
    updatePattern.lastIndex = conflictStart + conflict[0].length
    const update = updatePattern.exec(statement)
    if (
      update &&
      (update.index ?? statement.length) < insertEnd &&
      depths[update.index ?? 0] === insertDepth
    ) {
      return true
    }
  }
  return false
}

function skipSpace(text: string, start: number): number {
  let index = start
  while (/\s/.test(text[index] ?? '')) index += 1
  return index
}

function consumeWord(text: string, start: number, word: string): number | undefined {
  const index = skipSpace(text, start)
  const match = new RegExp(`^${word}\\b`, 'i').exec(text.slice(index))
  return match ? index + match[0].length : undefined
}

function readIdentifier(
  text: string,
  start: number,
): Readonly<{ end: number; value: string }> | undefined {
  const index = skipSpace(text, start)
  const quoted = /^"([A-Za-z_][A-Za-z0-9_$]*)"/.exec(text.slice(index))
  if (quoted?.[1]) return { end: index + quoted[0].length, value: quoted[1] }
  const plain = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(index))
  return plain
    ? { end: index + plain[0].length, value: plain[0].toLowerCase() }
    : undefined
}

function readTarget(
  text: string,
  start: number,
): Readonly<{ end: number; table: string }> | undefined {
  const first = readIdentifier(text, start)
  if (!first) return undefined
  const end = skipSpace(text, first.end)
  if (text[end] !== '.') return { end: first.end, table: first.value }
  const second = readIdentifier(text, end + 1)
  return second ? { end: second.end, table: second.value } : undefined
}

function unsupportedMutation(
  statement: string,
  sqlNames: ReadonlySet<string>,
): string | undefined {
  for (const merge of statement.matchAll(/\bMERGE\s+INTO\b/gi)) {
    let cursor = (merge.index ?? 0) + merge[0].length
    cursor = consumeWord(statement, cursor, 'ONLY') ?? cursor
    const target = readTarget(statement, cursor)
    if (target && sqlNames.has(target.table)) return `merge:${target.table}`
  }

  for (const truncate of statement.matchAll(/\bTRUNCATE\b/gi)) {
    let cursor = (truncate.index ?? 0) + truncate[0].length
    cursor = consumeWord(statement, cursor, 'TABLE') ?? cursor
    while (true) {
      cursor = consumeWord(statement, cursor, 'ONLY') ?? cursor
      const target = readTarget(statement, cursor)
      if (!target) break
      if (sqlNames.has(target.table)) return `truncate:${target.table}`
      cursor = skipSpace(statement, target.end)
      if (statement[cursor] === '*') cursor = skipSpace(statement, cursor + 1)
      if (statement[cursor] !== ',') break
      cursor += 1
    }
  }

  for (const copy of statement.matchAll(/\bCOPY\b/gi)) {
    let cursor = (copy.index ?? 0) + copy[0].length
    cursor = consumeWord(statement, cursor, 'ONLY') ?? cursor
    const target = readTarget(statement, cursor)
    if (!target) continue
    cursor = skipSpace(statement, target.end)
    if (statement[cursor] === '(') {
      let depth = 1
      cursor += 1
      while (cursor < statement.length && depth > 0) {
        if (statement[cursor] === '(') depth += 1
        else if (statement[cursor] === ')') depth -= 1
        cursor += 1
      }
    }
    if (consumeWord(statement, cursor, 'FROM') && sqlNames.has(target.table)) {
      return `copy:${target.table}`
    }
  }
  return undefined
}

function writesInText(
  text: string,
  sqlNames: ReadonlySet<string>,
): readonly Readonly<{ op: RawWriteOp; table: string }>[] {
  const executable = executableSqlText(text)
  const writes: { op: RawWriteOp; table: string }[] = []
  for (const statement of executable.split(';')) {
    const unsupported = unsupportedMutation(statement, sqlNames)
    if (unsupported) {
      const [op, table] = unsupported.split(':')
      throw new SqlScanError(
        'ownership.sql.mutation-unsupported',
        `Unsupported raw ${op ?? 'mutation'} targets schema table ${table ?? 'unknown'}.`,
      )
    }
    const patterns = targetPatterns()
    const insertPattern = patterns.find(({ op }) => op === 'insert')?.re
    const insertMatches = insertPattern ? [...statement.matchAll(insertPattern)] : []
    const depths = parenthesisDepths(statement)
    const insertStarts = insertMatches.map((match) => match.index ?? 0)
    for (const match of insertMatches) {
      const table = match[1] ? tableName(match[1]) : undefined
      if (!table || !sqlNames.has(table)) continue
      writes.push({ op: 'insert', table })
      const start = match.index ?? 0
      const depth = depths[start] ?? 0
      const end = insertCommandEnd(statement, start, depth, depths, insertStarts)
      if (insertHasConflictUpdate(statement, start, end, depth, depths)) {
        writes.push({ op: 'update', table })
      }
    }
    for (const { op, re } of patterns) {
      if (op === 'insert') continue
      for (let match = re.exec(statement); match; match = re.exec(statement)) {
        const table = match[1] ? tableName(match[1]) : undefined
        if (!table || !sqlNames.has(table)) continue
        writes.push({ op, table })
      }
    }
  }
  return writes
}

const sqlReceiverName = /^(?:client|database|db|query|scoped|transaction)$/i

function directMethod(expression: ts.Expression): string | undefined {
  const value = unwrap(expression)
  if (!ts.isPropertyAccessExpression(value)) return undefined
  return SQL_EXECUTION_METHODS.has(value.name.text) ? value.name.text : undefined
}

function callableContainsSink(
  node: ts.Node,
  bindings: BindingIndex,
  seen: Set<ts.Node>,
): boolean {
  const callable = ts.isFunctionLike(node) ? node : undefined
  return callable
    ? callableProviderParameterIndexes(callable, bindings, seen).size > 0
    : false
}

function callableReturnExpressions(
  node: ts.SignatureDeclaration,
): readonly ts.Expression[] {
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return [node.body]
  const expressions: ts.Expression[] = []
  const visit = (candidate: ts.Node): void => {
    if (candidate !== node && ts.isFunctionLike(candidate)) return
    if (ts.isReturnStatement(candidate) && candidate.expression) {
      expressions.push(candidate.expression)
      return
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return expressions
}

function callableReturnsSink(
  node: ts.SignatureDeclaration,
  bindings: BindingIndex,
  seen: Set<ts.Node>,
): boolean {
  if (seen.has(node)) return false
  const branchSeen = new Set(seen).add(node)
  return callableReturnExpressions(node).some(
    (expression) =>
      expressionIsSink(expression, bindings, branchSeen) ||
      storesSinkCapability(expression, bindings, branchSeen),
  )
}

function callableFromBinding(
  binding: Binding | undefined,
  bindings: BindingIndex,
): ts.SignatureDeclaration | undefined {
  if (!binding) return undefined
  if (binding.kind === 'function' && ts.isFunctionDeclaration(binding.node)) {
    return binding.node.name && !bindings.hasAssignment(binding.node.name)
      ? binding.node
      : undefined
  }
  const initializer = binding.initializer && unwrap(binding.initializer)
  const declarationName =
    ts.isVariableDeclaration(binding.node) && ts.isIdentifier(binding.node.name)
      ? binding.node.name
      : undefined
  return initializer &&
    ts.isFunctionLike(initializer) &&
    (!declarationName || !bindings.hasAssignment(declarationName))
    ? initializer
    : undefined
}

function parameterIndexesInExpression(
  candidate: ts.Node,
  callable: ts.SignatureDeclaration,
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): ReadonlySet<number> {
  if (seen.has(candidate)) return new Set()
  seen.add(candidate)
  if (ts.isTaggedTemplateExpression(candidate) && isSqlTag(candidate.tag, bindings)) {
    return new Set()
  }
  if (ts.isExpression(candidate) && staticTexts(candidate, bindings)) {
    return new Set()
  }
  if (ts.isIdentifier(candidate)) {
    const binding = bindings.binding(candidate)
    const parameterIndex =
      binding?.node && ts.isParameter(binding.node)
        ? callable.parameters.indexOf(binding.node)
        : -1
    if (parameterIndex >= 0) return new Set([parameterIndex])
    if (binding?.initializer) {
      return parameterIndexesInExpression(binding.initializer, callable, bindings, seen)
    }
  }
  const indexes = new Set<number>()
  ts.forEachChild(candidate, (child) => {
    for (const index of parameterIndexesInExpression(child, callable, bindings, seen)) {
      indexes.add(index)
    }
  })
  return indexes
}

function providerExpressionsForCall(
  call: ts.CallExpression,
  bindings: BindingIndex,
  seen: Set<ts.Node>,
): readonly ts.Expression[] {
  if (directMethod(call.expression)) return call.arguments.slice(0, 1)
  const callee = unwrap(call.expression)
  if (ts.isElementAccessExpression(callee)) return call.arguments
  if (ts.isIdentifier(callee)) {
    const binding = bindings.binding(callee)
    if (binding?.destructured && destructuredSqlMethod(callee, binding)) {
      return call.arguments.slice(0, 1)
    }
    const initializer = binding?.initializer && unwrap(binding.initializer)
    if (initializer && directMethod(initializer)) {
      return call.arguments.slice(0, 1)
    }
    const callable = callableFromBinding(binding, bindings)
    if (callable) {
      return [...callableProviderParameterIndexes(callable, bindings, seen)].flatMap(
        (index) =>
          call.arguments[index] ? [call.arguments[index] as ts.Expression] : [],
      )
    }
    return []
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Reflect' &&
    callee.name.text === 'apply'
  ) {
    return call.arguments.slice(2, 3)
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === 'call' || callee.name.text === 'apply') &&
    directMethod(callee.expression)
  ) {
    return callee.name.text === 'call'
      ? call.arguments.slice(1, 2)
      : call.arguments.slice(1, 2)
  }
  return []
}

function callableProviderParameterIndexes(
  callable: ts.SignatureDeclaration,
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): ReadonlySet<number> {
  if (seen.has(callable)) return new Set()
  const branchSeen = new Set(seen).add(callable)
  const indexes = new Set<number>()
  const visit = (node: ts.Node): void => {
    if (node !== callable && ts.isFunctionLike(node)) return
    if (ts.isCallExpression(node)) {
      for (const provider of providerExpressionsForCall(node, bindings, branchSeen)) {
        for (const index of parameterIndexesInExpression(provider, callable, bindings)) {
          indexes.add(index)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(callable)
  return indexes
}

function resolvedObjectLiterals(
  expression: ts.Expression,
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): readonly ts.ObjectLiteralExpression[] {
  const value = unwrap(expression)
  if (seen.has(value)) return []
  const branchSeen = new Set(seen).add(value)
  if (ts.isObjectLiteralExpression(value)) return [value]
  if (ts.isIdentifier(value)) {
    const binding = bindings.binding(value)
    return binding?.initializer
      ? resolvedObjectLiterals(binding.initializer, bindings, branchSeen)
      : []
  }
  if (ts.isConditionalExpression(value)) {
    return [
      ...resolvedObjectLiterals(value.whenTrue, bindings, branchSeen),
      ...resolvedObjectLiterals(value.whenFalse, bindings, branchSeen),
    ]
  }
  if (ts.isCallExpression(value)) {
    const callee = unwrap(value.expression)
    const callable = ts.isFunctionLike(callee)
      ? callee
      : ts.isIdentifier(callee)
        ? callableFromBinding(bindings.binding(callee), bindings)
        : undefined
    if (callable) {
      return callableReturnExpressions(callable).flatMap((expression) =>
        resolvedObjectLiterals(expression, bindings, branchSeen),
      )
    }
  }
  if (ts.isPropertyAccessExpression(value)) {
    return storedPropertyValues(
      value.expression,
      value.name.text,
      bindings,
      branchSeen,
    ).flatMap((item) => resolvedObjectLiterals(item, bindings, branchSeen))
  }
  if (ts.isElementAccessExpression(value) && value.argumentExpression) {
    const names = staticTexts(value.argumentExpression, bindings)
    if (!names) return []
    return names.flatMap((name) =>
      storedPropertyValues(value.expression, name, bindings, branchSeen).flatMap((item) =>
        resolvedObjectLiterals(item, bindings, branchSeen),
      ),
    )
  }
  return []
}

function storedPropertyValues(
  expression: ts.Expression,
  name: string,
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): readonly ts.Expression[] {
  const values: ts.Expression[] = []
  for (const object of resolvedObjectLiterals(expression, bindings, seen)) {
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property)) {
        const names = ts.isComputedPropertyName(property.name)
          ? staticTexts(property.name.expression, bindings)
          : propertyName(property.name)
            ? [propertyName(property.name) as string]
            : []
        if (names?.includes(name)) values.push(property.initializer)
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === name
      ) {
        values.push(property.name)
      } else if (ts.isSpreadAssignment(property)) {
        values.push(...storedPropertyValues(property.expression, name, bindings, seen))
      }
    }
  }
  return values
}

function mapStoredValues(
  expression: ts.Expression,
  names: readonly string[],
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): readonly ts.Expression[] {
  const value = unwrap(expression)
  if (seen.has(value)) return []
  const branchSeen = new Set(seen).add(value)
  if (ts.isIdentifier(value)) {
    const binding = bindings.binding(value)
    return binding?.initializer
      ? mapStoredValues(binding.initializer, names, bindings, branchSeen)
      : []
  }
  if (
    !ts.isNewExpression(value) ||
    !ts.isIdentifier(value.expression) ||
    value.expression.text !== 'Map'
  ) {
    return []
  }
  const entries = value.arguments?.[0]
  if (!entries || !ts.isArrayLiteralExpression(unwrap(entries))) return []
  return (unwrap(entries) as ts.ArrayLiteralExpression).elements.flatMap((entry) => {
    const pair = ts.isSpreadElement(entry) ? undefined : unwrap(entry)
    if (!pair || !ts.isArrayLiteralExpression(pair) || pair.elements.length < 2) {
      return []
    }
    const key = pair.elements[0]
    const stored = pair.elements[1]
    if (
      !key ||
      !stored ||
      ts.isOmittedExpression(key) ||
      ts.isSpreadElement(key) ||
      ts.isOmittedExpression(stored) ||
      ts.isSpreadElement(stored)
    ) {
      return []
    }
    return staticTexts(key, bindings)?.some((item) => names.includes(item))
      ? [stored]
      : []
  })
}

function expressionIsSink(
  expression: ts.Expression,
  bindings: BindingIndex,
  seen: Set<ts.Node>,
): boolean {
  const value = unwrap(expression)
  if (seen.has(value)) return false
  seen.add(value)
  if (directMethod(value)) return true
  if (ts.isElementAccessExpression(value)) {
    const methods = value.argumentExpression
      ? staticTexts(value.argumentExpression, bindings)
      : undefined
    if (
      methods?.some((method) =>
        storedPropertyValues(value.expression, method, bindings, seen).some((stored) =>
          expressionIsSink(stored, bindings, seen),
        ),
      )
    ) {
      return true
    }
    const receiver = rootIdentifier(value.expression)
    return (
      (methods?.some((method) => SQL_EXECUTION_METHODS.has(method)) ?? false) ||
      (!!receiver && sqlReceiverName.test(receiver.text) && !methods)
    )
  }
  if (ts.isConditionalExpression(value)) {
    return (
      expressionIsSink(value.whenTrue, bindings, seen) ||
      expressionIsSink(value.whenFalse, bindings, seen)
    )
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      expressionIsSink(value.left, bindings, seen) ||
      expressionIsSink(value.right, bindings, seen)
    )
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return expressionIsSink(value.right, bindings, seen)
  }
  if (
    ts.isPropertyAccessExpression(value) &&
    storedPropertyValues(value.expression, value.name.text, bindings, seen).some(
      (stored) => expressionIsSink(stored, bindings, seen),
    )
  ) {
    return true
  }
  if (ts.isIdentifier(value)) {
    const binding = bindings.binding(value)
    if (!binding || seen.has(binding.node)) return false
    if (binding.destructured) {
      return destructuredSqlMethod(value, binding)
    }
    if (bindings.assignmentIsSink(value)) return true
    if (
      bindings
        .assignmentValues(value)
        .some((assigned) => expressionIsSink(assigned, bindings, seen))
    ) {
      return true
    }
    if (binding.initializer) {
      const initializer = unwrap(binding.initializer)
      if (ts.isFunctionLike(initializer)) {
        return callableContainsSink(initializer, bindings, seen)
      }
      seen.add(binding.node)
      return expressionIsSink(initializer, bindings, seen)
    }
    if (binding.kind === 'function') {
      return callableContainsSink(binding.node, bindings, seen)
    }
    return false
  }
  if (ts.isFunctionLike(value)) {
    return callableContainsSink(value, bindings, seen)
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'bind'
  ) {
    return expressionIsSink(value.expression.expression, bindings, seen)
  }
  if (ts.isCallExpression(value)) {
    const callee = unwrap(value.expression)
    if (ts.isIdentifier(callee)) {
      const callable = callableFromBinding(bindings.binding(callee), bindings)
      if (callable && callableReturnsSink(callable, bindings, seen)) return true
    }
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      expressionMemberName(callee, bindings) === 'get'
    ) {
      const names = value.arguments[0]
        ? staticTexts(value.arguments[0], bindings)
        : undefined
      if (
        names?.some((name) =>
          mapStoredValues(callee.expression, [name], bindings, seen).some((stored) =>
            expressionIsSink(stored, bindings, seen),
          ),
        )
      ) {
        return true
      }
    }
    return value.arguments.some((argument) => forwardedSqlSink(argument, bindings))
  }
  return false
}

function indirectSinkCall(
  call: ts.CallExpression,
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): boolean {
  const callee = unwrap(call.expression)
  if (ts.isElementAccessExpression(callee)) return true
  if (ts.isIdentifier(callee)) return expressionIsSink(callee, bindings, seen)
  if (ts.isPropertyAccessExpression(callee)) {
    if (
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Reflect' &&
      callee.name.text === 'apply' &&
      call.arguments[0]
    ) {
      return expressionIsSink(call.arguments[0], bindings, seen)
    }
    if (callee.name.text === 'call' || callee.name.text === 'apply') {
      return expressionIsSink(callee.expression, bindings, seen)
    }
  }
  if (
    ts.isCallExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === 'bind'
  ) {
    return expressionIsSink(callee.expression.expression, bindings, seen)
  }
  if (ts.isCallExpression(callee)) {
    return expressionIsSink(callee, bindings, seen)
  }
  return expressionIsSink(callee, bindings, seen)
}

function destructuredSqlMethod(identifier: ts.Identifier, binding: Binding): boolean {
  const declaration = binding.node
  if (!ts.isVariableDeclaration(declaration) && !ts.isParameter(declaration)) {
    return false
  }
  const visit = (name: ts.BindingName, property?: ts.PropertyName): boolean => {
    if (ts.isIdentifier(name)) {
      if (name.text !== identifier.text || !property) return false
      const method = ts.isComputedPropertyName(property)
        ? undefined
        : property.getText(identifier.getSourceFile()).replace(/["']/g, '')
      if (method && SQL_EXECUTION_METHODS.has(method)) return true
      return !method
    }
    return name.elements.some((element) => {
      if (ts.isOmittedExpression(element)) return false
      return visit(element.name, element.propertyName)
    })
  }
  return visit(declaration.name)
}

function forwardedSqlSink(
  expression: ts.Expression,
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): boolean {
  const value = unwrap(expression)
  if (seen.has(value)) return false
  seen.add(value)
  if (directMethod(value)) return true
  if (ts.isConditionalExpression(value)) {
    return (
      forwardedSqlSink(value.whenTrue, bindings, seen) ||
      forwardedSqlSink(value.whenFalse, bindings, seen)
    )
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      forwardedSqlSink(value.left, bindings, seen) ||
      forwardedSqlSink(value.right, bindings, seen)
    )
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return forwardedSqlSink(value.right, bindings, seen)
  }
  if (ts.isPropertyAccessExpression(value)) {
    return expressionIsSink(value, bindings, new Set())
  }
  if (ts.isElementAccessExpression(value) && value.argumentExpression) {
    const methods = staticTexts(value.argumentExpression, bindings)
    return methods?.some((method) => SQL_EXECUTION_METHODS.has(method)) ?? false
  }
  if (ts.isIdentifier(value)) {
    const binding = bindings.binding(value)
    if (!binding || seen.has(binding.node)) return false
    seen.add(binding.node)
    if (binding.destructured && destructuredSqlMethod(value, binding)) {
      return true
    }
    return binding.initializer
      ? forwardedSqlSink(binding.initializer, bindings, seen)
      : false
  }
  if (ts.isCallExpression(value)) {
    return expressionIsSink(value, bindings, new Set())
  }
  return false
}

function containsSinkCapability(node: ts.Node, bindings: BindingIndex): boolean {
  if (ts.isExpression(node) && forwardedSqlSink(node, bindings)) return true
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsSinkCapability(child, bindings)) found = true
  })
  return found
}

function storesSinkCapability(
  expression: ts.Expression,
  bindings: BindingIndex,
  seen = new Set<ts.Node>(),
): boolean {
  const value = unwrap(expression)
  if (seen.has(value)) return false
  const branchSeen = new Set(seen).add(value)
  if (expressionIsSink(value, bindings, new Set(seen))) return true
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) =>
        !ts.isOmittedExpression(element) &&
        storesSinkCapability(
          ts.isSpreadElement(element) ? element.expression : element,
          bindings,
          branchSeen,
        ),
    )
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return expressionIsSink(property.name, bindings, new Set(branchSeen))
      }
      if (ts.isPropertyAssignment(property)) {
        return storesSinkCapability(property.initializer, bindings, branchSeen)
      }
      return ts.isSpreadAssignment(property)
        ? storesSinkCapability(property.expression, bindings, branchSeen)
        : false
    })
  }
  return false
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  )
}

function validateSinkCapabilityFlow(
  node: ts.Node,
  bindings: BindingIndex,
  file: string,
  sourceFile: ts.SourceFile,
): void {
  if (
    ts.isTaggedTemplateExpression(node) &&
    !isSqlTag(node.tag, bindings) &&
    ts.isTemplateExpression(node.template) &&
    node.template.templateSpans.some((span) =>
      containsSinkCapability(span.expression, bindings),
    )
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) &&
    (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) &&
    callableReturnsSink(node, bindings, new Set())
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isYieldExpression(node) &&
    node.expression &&
    containsSinkCapability(node.expression, bindings)
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isJsxExpression(node) &&
    node.expression &&
    containsSinkCapability(node.expression, bindings)
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isThrowStatement(node) &&
    node.expression &&
    containsSinkCapability(node.expression, bindings)
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isArrayLiteralExpression(node) &&
    node.elements.some(
      (element) =>
        !ts.isOmittedExpression(element) &&
        storesSinkCapability(
          ts.isSpreadElement(element) ? element.expression : element,
          bindings,
        ),
    )
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isPropertyDeclaration(node) &&
    node.initializer &&
    storesSinkCapability(node.initializer, bindings)
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isBinaryExpression(node) &&
    assignmentOperators.has(node.operatorToken.kind) &&
    expressionIsSink(node.right, bindings, new Set()) &&
    !ts.isIdentifier(unwrap(node.left))
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isPropertyAssignment(node) &&
    ts.isComputedPropertyName(node.name) &&
    !staticTexts(node.name.expression, bindings) &&
    containsSinkCapability(node.initializer, bindings)
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isNewExpression(node) &&
    node.arguments?.some((argument) => storesSinkCapability(argument, bindings))
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression)
    if (
      isObjectMutationCallee(callee, bindings) &&
      node.arguments.slice(1).some((argument) => storesSinkCapability(argument, bindings))
    ) {
      unresolvedProvider(file, node, sourceFile)
    }
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      ['add', 'push', 'set', 'unshift'].includes(
        expressionMemberName(callee, bindings) ?? '',
      ) &&
      node.arguments.some((argument) => containsSinkCapability(argument, bindings))
    ) {
      unresolvedProvider(file, node, sourceFile)
    }
  }
  if (ts.isVariableStatement(node) && hasExportModifier(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (
        declaration.initializer &&
        (expressionIsSink(declaration.initializer, bindings, new Set()) ||
          (ts.isFunctionLike(declaration.initializer) &&
            callableReturnsSink(declaration.initializer, bindings, new Set())))
      ) {
        unresolvedProvider(file, declaration, sourceFile)
      }
    }
  }
  if (
    ts.isFunctionDeclaration(node) &&
    hasExportModifier(node) &&
    callableReturnsSink(node, bindings, new Set())
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isExportAssignment(node) &&
    expressionIsSink(node.expression, bindings, new Set())
  ) {
    unresolvedProvider(file, node, sourceFile)
  }
  if (
    ts.isExportDeclaration(node) &&
    !node.moduleSpecifier &&
    node.exportClause &&
    ts.isNamedExports(node.exportClause)
  ) {
    for (const element of node.exportClause.elements) {
      const local = element.propertyName ?? element.name
      if (expressionIsSink(local, bindings, new Set())) {
        unresolvedProvider(file, element, sourceFile)
      }
    }
  }
}

function unresolvedProvider(
  file: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): never {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  throw new SqlScanError(
    'ownership.sql.provider-unresolved',
    `${file}:${line + 1} SQL provider is outside the accepted static grammar.`,
  )
}

type OpaqueBindingContract = Readonly<{
  kind: 'const' | 'mutable' | 'parameter'
  owner: string
  initializer?: 'assigned-query-args' | 'descriptor-text' | 'dialect-query' | 'new-client'
}>

type OpaqueDirectContract = Readonly<{
  file: string
  functionStack: readonly string[]
  provider: string
  providerBinding: OpaqueBindingContract
  receiverBinding: OpaqueBindingContract
  shapes: readonly string[]
}>

const opaqueDirectContracts: readonly OpaqueDirectContract[] = [
  {
    file: 'src/platform/application-coordination/postgres-unit-of-work.ts',
    functionStack: ['function:queryWithGuard'],
    provider: 'text',
    providerBinding: { kind: 'parameter', owner: 'function:queryWithGuard' },
    receiverBinding: { kind: 'parameter', owner: 'function:queryWithGuard' },
    shapes: ['client.query(text,[...values])', 'client.query(text)'],
  },
  {
    file: 'src/platform/application-coordination/prelocked-session.ts',
    functionStack: ['function:guardedPrelockQuery'],
    provider: 'text',
    providerBinding: { kind: 'parameter', owner: 'function:guardedPrelockQuery' },
    receiverBinding: { kind: 'parameter', owner: 'function:guardedPrelockQuery' },
    shapes: ['client.query(text,[...values])', 'client.query(text)'],
  },
  {
    file: 'src/platform/application-coordination/scoped-drizzle.ts',
    functionStack: ['function:dispatchDrizzleQuery'],
    provider: 'text',
    providerBinding: {
      kind: 'const',
      owner: 'function:dispatchDrizzleQuery',
      initializer: 'descriptor-text',
    },
    receiverBinding: {
      kind: 'parameter',
      owner: 'function:dispatchDrizzleQuery',
    },
    shapes: ['scoped.query(text,parameters)', 'scoped.queryArray(text,parameters)'],
  },
  {
    file: 'src/platform/db/disposable-integration-database.ts',
    functionStack: ['property-arrow:query', 'function:defaultClientFactory'],
    provider: 'text',
    providerBinding: { kind: 'parameter', owner: 'property-arrow:query' },
    receiverBinding: {
      kind: 'const',
      owner: 'function:defaultClientFactory',
      initializer: 'new-client',
    },
    shapes: ['client.query(text,values?[...values]:undefined)'],
  },
  {
    file: 'src/platform/db/external-host-one-shot.ts',
    functionStack: ['method:query', 'function:runExternalHostClientOwner'],
    provider: 'text',
    providerBinding: { kind: 'parameter', owner: 'method:query' },
    receiverBinding: {
      kind: 'const',
      owner: 'function:runExternalHostClientOwner',
      initializer: 'new-client',
    },
    shapes: ['client.query(text,[...values])', 'client.query(text)'],
  },
  {
    file: 'src/platform/db/preflight.ts',
    functionStack: ['function:execute'],
    provider: 'compiled.sql',
    providerBinding: {
      kind: 'const',
      owner: 'function:execute',
      initializer: 'dialect-query',
    },
    receiverBinding: { kind: 'parameter', owner: 'function:execute' },
    shapes: ['query.query(compiled.sql,compiled.params)'],
  },
]

function compactText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, '')
}

/**
 * Canonicalize syntax trivia without canonicalizing token contents.
 *
 * `compactText` is appropriate for small, grammar-checked call shapes, but it
 * cannot attest executable declarations: removing whitespace from the raw
 * source also removes behavior-significant whitespace inside string, template,
 * and regular-expression literals. Token kind, length, and exact token text
 * make the stream unambiguous while still allowing formatting-only changes.
 */
export function declarationTokenStream(node: ts.Node, sourceFile: ts.SourceFile): string {
  const tokens: string[] = []
  const visit = (candidate: ts.Node): void => {
    const children = candidate.getChildren(sourceFile)
    if (children.length === 0) {
      const token = candidate.getText(sourceFile)
      tokens.push(`${candidate.kind}:${token.length}:${token}`)
      return
    }
    for (const child of children) visit(child)
  }
  visit(node)
  return tokens.join('|')
}

const trustedHelperDeclarationHashes = Object.freeze({
  exactDataDescriptor: '77eae4d3e5231b2019445b52246f5fdfd160aeff98707d3c170843337385bf40',
  materializedQueryConfig:
    'e808871390391eec752f171325fafda2252c743ec3e41bf6a22d54956d2a829e',
  materializeQueryArgs:
    'd58c0c19c8a79ecd3ea8b5d5434d9a65e459a1336f0ab9574c5d8565e4104a96',
})

function topLevelFunction(
  name: string,
  sourceFile: ts.SourceFile,
): ts.FunctionDeclaration | undefined {
  return sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )
}

function trustedHelperDeclaration(
  name: keyof typeof trustedHelperDeclarationHashes,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
): boolean {
  const helper = topLevelFunction(name, sourceFile)
  if (!helper?.body || !helper.name) return false
  const helperBinding = bindings.binding(helper.name)
  if (
    helperBinding?.kind !== 'function' ||
    helperBinding.node !== helper ||
    bindingMutations(helperBinding, bindings, sourceFile).length > 0
  ) {
    return false
  }
  const digest = createHash('sha256')
    .update(declarationTokenStream(helper, sourceFile))
    .digest('hex')
  return digest === trustedHelperDeclarationHashes[name]
}

function functionIdentity(node: ts.SignatureDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return `function:${node.name.text}`
  }
  if (ts.isMethodDeclaration(node) && node.name) {
    return `method:${node.name.getText(node.getSourceFile())}`
  }
  if (
    ts.isArrowFunction(node) &&
    ts.isPropertyAssignment(node.parent) &&
    node.parent.initializer === node
  ) {
    return `property-arrow:${node.parent.name.getText(node.getSourceFile())}`
  }
  return undefined
}

function functionStack(node: ts.Node): readonly string[] {
  const stack: string[] = []
  for (
    let current: ts.Node | undefined = node.parent;
    current;
    current = current.parent
  ) {
    if (!ts.isFunctionLike(current)) continue
    const identity = functionIdentity(current)
    stack.push(identity ?? 'function:unsupported')
  }
  return stack
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) return value
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    return rootIdentifier(value.expression)
  }
  return undefined
}

function bindingOwner(binding: Binding): string | undefined {
  if (ts.isParameter(binding.node) && ts.isFunctionLike(binding.node.parent)) {
    return functionIdentity(binding.node.parent)
  }
  for (
    let current: ts.Node | undefined = binding.node.parent;
    current;
    current = current.parent
  ) {
    if (ts.isFunctionLike(current)) return functionIdentity(current)
  }
  return undefined
}

type BindingMutation = Readonly<{
  node: ts.Node
  rootAssignment: boolean
  value?: ts.Expression
}>

function targetTouchesBinding(
  target: ts.Node,
  binding: Binding,
  bindings: BindingIndex,
): boolean {
  if (ts.isIdentifier(target)) return bindings.binding(target)?.node === binding.node
  if (
    ts.isParenthesizedExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isTypeAssertionExpression(target) ||
    ts.isNonNullExpression(target)
  ) {
    return targetTouchesBinding(target.expression, binding, bindings)
  }
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    return targetTouchesBinding(target.expression, binding, bindings)
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return targetTouchesBinding(property.name, binding, bindings)
      }
      if (ts.isPropertyAssignment(property)) {
        return targetTouchesBinding(property.initializer, binding, bindings)
      }
      return ts.isSpreadAssignment(property)
        ? targetTouchesBinding(property.expression, binding, bindings)
        : false
    })
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some((element) =>
      ts.isOmittedExpression(element)
        ? false
        : ts.isSpreadElement(element)
          ? targetTouchesBinding(element.expression, binding, bindings)
          : targetTouchesBinding(element, binding, bindings),
    )
  }
  return false
}

const objectMutationMethods = new Set([
  'assign',
  'defineProperties',
  'defineProperty',
  'deleteProperty',
  'set',
])
const collectionMutationMethods = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
])

function isObjectMutationCallee(
  expression: ts.Expression,
  bindings: BindingIndex,
  seen = new Set<Binding>(),
): boolean {
  const value = unwrap(expression)
  if (
    (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
    ts.isIdentifier(value.expression) &&
    (value.expression.text === 'Object' || value.expression.text === 'Reflect') &&
    !bindings.binding(value.expression) &&
    objectMutationMethods.has(expressionMemberName(value, bindings) ?? '')
  ) {
    return true
  }
  if (ts.isIdentifier(value)) {
    const binding = bindings.binding(value)
    if (!binding?.initializer || seen.has(binding)) return false
    return isObjectMutationCallee(
      binding.initializer,
      bindings,
      new Set(seen).add(binding),
    )
  }
  return false
}

function expressionCarriesBinding(
  expression: ts.Expression,
  binding: Binding,
  bindings: BindingIndex,
): boolean {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) return bindings.binding(value)?.node === binding.node
  if (ts.isConditionalExpression(value)) {
    return (
      expressionCarriesBinding(value.whenTrue, binding, bindings) ||
      expressionCarriesBinding(value.whenFalse, binding, bindings)
    )
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      expressionCarriesBinding(value.left, binding, bindings) ||
      expressionCarriesBinding(value.right, binding, bindings)
    )
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) =>
        !ts.isOmittedExpression(element) &&
        expressionCarriesBinding(
          ts.isSpreadElement(element) ? element.expression : element,
          binding,
          bindings,
        ),
    )
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return bindings.binding(property.name)?.node === binding.node
      }
      if (ts.isPropertyAssignment(property)) {
        return expressionCarriesBinding(property.initializer, binding, bindings)
      }
      return ts.isSpreadAssignment(property)
        ? expressionCarriesBinding(property.expression, binding, bindings)
        : false
    })
  }
  return false
}

/**
 * Track values that expose all or part of an opaque binding. Unlike
 * `expressionCarriesBinding`, this includes property-derived capabilities, but
 * deliberately does not infer that an arbitrary call returns its receiver or
 * arguments.
 */
function expressionDerivesFromBinding(
  expression: ts.Expression,
  binding: Binding,
  bindings: BindingIndex,
): boolean {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) return bindings.binding(value)?.node === binding.node
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    return expressionDerivesFromBinding(value.expression, binding, bindings)
  }
  if (
    ts.isCallExpression(value) &&
    (ts.isPropertyAccessExpression(value.expression) ||
      ts.isElementAccessExpression(value.expression)) &&
    expressionMemberName(value.expression, bindings) === 'bind'
  ) {
    return expressionDerivesFromBinding(value.expression.expression, binding, bindings)
  }
  if (ts.isConditionalExpression(value)) {
    return (
      expressionDerivesFromBinding(value.whenTrue, binding, bindings) ||
      expressionDerivesFromBinding(value.whenFalse, binding, bindings)
    )
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      expressionDerivesFromBinding(value.left, binding, bindings) ||
      expressionDerivesFromBinding(value.right, binding, bindings)
    )
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) =>
        !ts.isOmittedExpression(element) &&
        expressionDerivesFromBinding(
          ts.isSpreadElement(element) ? element.expression : element,
          binding,
          bindings,
        ),
    )
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return bindings.binding(property.name)?.node === binding.node
      }
      if (ts.isPropertyAssignment(property)) {
        return expressionDerivesFromBinding(property.initializer, binding, bindings)
      }
      return ts.isSpreadAssignment(property)
        ? expressionDerivesFromBinding(property.expression, binding, bindings)
        : false
    })
  }
  return false
}

function immutableBindingAliases(
  root: Binding,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
): readonly Binding[] {
  const aliases = new Map<ts.Node, Binding>([[root.node, root]])
  let changed = true
  while (changed) {
    changed = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const alias = bindings.binding(node.name)
        if (
          alias?.kind === 'const' &&
          !bindings.hasAssignment(node.name) &&
          [...aliases.values()].some((source) =>
            expressionDerivesFromBinding(
              node.initializer as ts.Expression,
              source,
              bindings,
            ),
          ) &&
          !aliases.has(alias.node)
        ) {
          aliases.set(alias.node, alias)
          changed = true
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return [...aliases.values()]
}

function parameterEscapes(binding: Binding, bindings: BindingIndex): boolean {
  if (!ts.isParameter(binding.node) || !ts.isFunctionLike(binding.node.parent)) {
    return true
  }
  const callable = binding.node.parent
  let escapes = false
  const visit = (node: ts.Node): void => {
    if (escapes || (node !== callable && ts.isFunctionLike(node))) return
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      expressionDerivesFromBinding(node.expression, binding, bindings)
    ) {
      escapes = true
      return
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      expressionDerivesFromBinding(node.initializer, binding, bindings)
    ) {
      escapes = true
      return
    }
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      expressionDerivesFromBinding(node.right, binding, bindings) &&
      !targetTouchesBinding(node.left, binding, bindings)
    ) {
      escapes = true
      return
    }
    if (
      ts.isPropertyAssignment(node) &&
      expressionDerivesFromBinding(node.initializer, binding, bindings)
    ) {
      escapes = true
      return
    }
    if (
      ts.isShorthandPropertyAssignment(node) &&
      bindings.binding(node.name)?.node === binding.node
    ) {
      escapes = true
      return
    }
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.some(
        (element) =>
          !ts.isOmittedExpression(element) &&
          expressionDerivesFromBinding(
            ts.isSpreadElement(element) ? element.expression : element,
            binding,
            bindings,
          ),
      )
    ) {
      escapes = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(callable)
  return escapes
}

function safeOpaqueBindingArgument(
  call: ts.CallExpression,
  argumentIndex: number,
  binding: Binding,
  rootBinding: Binding,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
  seen: ReadonlySet<ts.Node>,
): boolean {
  if (directMethod(call.expression) && argumentIndex === 0) return true
  const callee = unwrap(call.expression)
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    ts.isIdentifier(callee.expression) &&
    !bindings.binding(callee.expression)
  ) {
    const owner = callee.expression.text
    const method = expressionMemberName(callee, bindings)
    if (
      argumentIndex === 0 &&
      ((owner === 'Object' &&
        [
          'entries',
          'getOwnPropertyDescriptor',
          'getOwnPropertyDescriptors',
          'getPrototypeOf',
          'is',
          'isExtensible',
          'isFrozen',
          'isSealed',
          'keys',
          'values',
        ].includes(method ?? '')) ||
        (owner === 'Reflect' &&
          ['get', 'getOwnPropertyDescriptor', 'has', 'ownKeys'].includes(method ?? '')) ||
        (owner === 'Array' && method === 'isArray'))
    ) {
      return true
    }
    if (
      owner === 'Object' &&
      method === 'freeze' &&
      argumentIndex === 0 &&
      binding.node === rootBinding.node
    ) {
      return true
    }
    if (
      owner === 'Reflect' &&
      method === 'apply' &&
      argumentIndex === 2 &&
      binding.node === rootBinding.node &&
      binding.kind === 'mutable' &&
      bindingOwner(binding) === 'method:#executeQuery' &&
      sameStrings(functionStack(call), ['method:#executeQuery']) &&
      call.arguments.map((argument) => compactText(argument, sourceFile)).join(',') ===
        'this.#client.query,this.#client,queryArgs'
    ) {
      return true
    }
  }
  if (
    argumentIndex === 0 &&
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'sqlToQuery' &&
    ts.isIdentifier(callee.expression)
  ) {
    const dialect = bindings.binding(callee.expression)
    const initializer = dialect?.initializer && unwrap(dialect.initializer)
    if (
      dialect?.kind === 'const' &&
      initializer &&
      ts.isNewExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      isRuntimeImport(
        initializer.expression,
        'drizzle-orm/pg-core',
        'PgDialect',
        bindings,
      )
    ) {
      return true
    }
  }
  if (!ts.isIdentifier(callee)) return false
  const callable = callableFromBinding(bindings.binding(callee), bindings)
  if (!callable) return false
  const parameter =
    callable.parameters[argumentIndex] ??
    (callable.parameters.at(-1)?.dotDotDotToken ? callable.parameters.at(-1) : undefined)
  if (!parameter || !ts.isIdentifier(parameter.name)) return false
  const parameterBinding = bindings.binding(parameter.name)
  if (parameterBinding?.kind !== 'parameter' || seen.has(parameterBinding.node)) {
    return false
  }
  const branchSeen = new Set(seen).add(parameterBinding.node)
  return (
    bindingMutations(parameterBinding, bindings, sourceFile, branchSeen).length === 0 &&
    !parameterEscapes(parameterBinding, bindings)
  )
}

function bindingMutations(
  binding: Binding,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
  seen: ReadonlySet<ts.Node> = new Set(),
): readonly BindingMutation[] {
  const mutations: BindingMutation[] = []
  const trackedBindings = immutableBindingAliases(binding, bindings, sourceFile)
  const touchesTrackedBinding = (node: ts.Node): boolean =>
    trackedBindings.some((tracked) => targetTouchesBinding(node, tracked, bindings))
  const carriedBinding = (expression: ts.Expression): Binding | undefined =>
    trackedBindings.find((tracked) =>
      expressionCarriesBinding(expression, tracked, bindings),
    )
  const derivedBinding = (expression: ts.Expression): Binding | undefined =>
    trackedBindings.find((tracked) =>
      expressionDerivesFromBinding(expression, tracked, bindings),
    )
  const visit = (node: ts.Node): void => {
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      derivedBinding(node.expression)
    ) {
      mutations.push({ node, rootAssignment: false })
    } else if (
      ts.isArrowFunction(node) &&
      !ts.isBlock(node.body) &&
      derivedBinding(node.body)
    ) {
      mutations.push({ node, rootAssignment: false })
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      derivedBinding(node.initializer) &&
      (!ts.isIdentifier(node.name) ||
        !trackedBindings.some((tracked) => {
          const declared = bindings.binding(node.name as ts.Identifier)
          return declared?.kind === 'const' && declared.node === tracked.node
        }))
    ) {
      mutations.push({ node, rootAssignment: false })
    } else if (ts.isExportAssignment(node) && derivedBinding(node.expression)) {
      mutations.push({ node, rootAssignment: false })
    } else if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      touchesTrackedBinding(node.left)
    ) {
      mutations.push({
        node,
        rootAssignment:
          ts.isIdentifier(unwrap(node.left)) &&
          bindings.binding(unwrap(node.left) as ts.Identifier)?.node === binding.node,
        value: node.right,
      })
    } else if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      derivedBinding(node.right)
    ) {
      mutations.push({ node, rootAssignment: false })
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      touchesTrackedBinding(node.operand)
    ) {
      mutations.push({ node, rootAssignment: ts.isIdentifier(unwrap(node.operand)) })
    } else if (ts.isDeleteExpression(node) && touchesTrackedBinding(node.expression)) {
      mutations.push({ node, rootAssignment: false })
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (
        isObjectMutationCallee(callee, bindings) &&
        node.arguments[0] &&
        touchesTrackedBinding(node.arguments[0])
      ) {
        mutations.push({ node, rootAssignment: false })
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        collectionMutationMethods.has(callee.name.text) &&
        touchesTrackedBinding(callee.expression)
      ) {
        mutations.push({ node, rootAssignment: false })
      } else if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        trackedBindings.some(
          (tracked) =>
            tracked.node !== binding.node &&
            targetTouchesBinding(callee.expression, tracked, bindings),
        )
      ) {
        mutations.push({ node, rootAssignment: false })
      } else if (
        node.arguments.some((argument, index) => {
          const carried = carriedBinding(argument)
          return (
            !!carried &&
            !safeOpaqueBindingArgument(
              node,
              index,
              carried,
              binding,
              bindings,
              sourceFile,
              seen,
            )
          )
        })
      ) {
        mutations.push({ node, rootAssignment: false })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return mutations
}

function isRuntimeImport(
  identifier: ts.Identifier,
  importedFrom: string,
  importedName: string,
  bindings: BindingIndex,
): boolean {
  const binding = bindings.binding(identifier)
  return (
    binding?.kind === 'other-import' &&
    binding.importTypeOnly !== true &&
    binding.importedFrom === importedFrom &&
    binding.importedName === importedName
  )
}

function matchesDialectQueryInitializer(
  initializer: ts.Expression,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
): boolean {
  const value = unwrap(initializer)
  if (
    !ts.isCallExpression(value) ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== 'sqlToQuery' ||
    !ts.isIdentifier(value.expression.expression) ||
    value.arguments.length !== 1 ||
    !ts.isIdentifier(value.arguments[0])
  ) {
    return false
  }
  const dialectIdentifier = value.expression.expression
  const dialect = bindings.binding(dialectIdentifier)
  const dialectInitializer = dialect?.initializer && unwrap(dialect.initializer)
  if (
    dialect?.kind !== 'const' ||
    bindingOwner(dialect) !== undefined ||
    !dialectInitializer ||
    !ts.isNewExpression(dialectInitializer) ||
    dialectInitializer.arguments?.length !== 0 ||
    !ts.isIdentifier(dialectInitializer.expression) ||
    !isRuntimeImport(
      dialectInitializer.expression,
      'drizzle-orm/pg-core',
      'PgDialect',
      bindings,
    ) ||
    bindingMutations(dialect, bindings, sourceFile).length > 0
  ) {
    return false
  }
  const statement = bindings.binding(value.arguments[0])
  return (
    statement?.kind === 'parameter' &&
    bindingOwner(statement) === 'function:execute' &&
    (!ts.isParameter(statement.node) || !statement.node.initializer) &&
    bindingMutations(statement, bindings, sourceFile).length === 0
  )
}

function matchesDescriptorTextInitializer(
  initializer: ts.Expression,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
): boolean {
  const value = unwrap(initializer)
  if (
    !ts.isPropertyAccessExpression(value) ||
    value.name.text !== 'value' ||
    !ts.isCallExpression(value.expression) ||
    !ts.isIdentifier(value.expression.expression) ||
    value.expression.expression.text !== 'exactDataDescriptor' ||
    value.expression.arguments.length !== 2 ||
    !ts.isIdentifier(value.expression.arguments[0]) ||
    !ts.isStringLiteralLike(value.expression.arguments[1]) ||
    value.expression.arguments[1].text !== 'text' ||
    !trustedHelperDeclaration('exactDataDescriptor', bindings, sourceFile)
  ) {
    return false
  }
  const descriptors = bindings.binding(value.expression.arguments[0])
  return (
    descriptors?.kind === 'const' &&
    bindingOwner(descriptors) === 'function:dispatchDrizzleQuery' &&
    !!descriptors.initializer &&
    compactText(descriptors.initializer, sourceFile) ===
      'Object.getOwnPropertyDescriptors(config)' &&
    bindingMutations(descriptors, bindings, sourceFile).length === 0
  )
}

function matchesBindingContract(
  identifier: ts.Identifier | undefined,
  contract: OpaqueBindingContract,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
): boolean {
  if (!identifier) return false
  const binding = bindings.binding(identifier)
  if (
    !binding ||
    binding.kind !== contract.kind ||
    bindingOwner(binding) !== contract.owner
  ) {
    return false
  }
  if (ts.isParameter(binding.node) && binding.node.initializer) return false
  const mutations = bindingMutations(binding, bindings, sourceFile)
  if (!contract.initializer) return mutations.length === 0
  if (contract.initializer === 'assigned-query-args') {
    if (binding.initializer) return false
    const assignment = mutations[0]
    if (
      mutations.length !== 1 ||
      !assignment?.rootAssignment ||
      !assignment.value ||
      compactText(assignment.value, sourceFile) !== 'materializeQueryArgs(query,rowMode)'
    ) {
      return false
    }
    const value = unwrap(assignment.value)
    if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) return false
    const helper = bindings.binding(value.expression)
    return (
      helper?.kind === 'function' &&
      ts.isFunctionDeclaration(helper.node) &&
      helper.node.parent === sourceFile &&
      bindingMutations(helper, bindings, sourceFile).length === 0 &&
      trustedHelperDeclaration('materializeQueryArgs', bindings, sourceFile) &&
      trustedHelperDeclaration('materializedQueryConfig', bindings, sourceFile)
    )
  }
  if (mutations.length > 0) return false
  if (!binding.initializer) return false
  const initializer = unwrap(binding.initializer)
  if (contract.initializer === 'new-client') {
    return (
      ts.isNewExpression(initializer) &&
      initializer.arguments !== undefined &&
      ts.isIdentifier(initializer.expression) &&
      isRuntimeImport(initializer.expression, 'pg', 'Client', bindings)
    )
  }
  if (contract.initializer === 'descriptor-text') {
    return matchesDescriptorTextInitializer(initializer, bindings, sourceFile)
  }
  return matchesDialectQueryInitializer(initializer, bindings, sourceFile)
}

function directCallShape(call: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const expression = unwrap(call.expression)
  if (!ts.isPropertyAccessExpression(expression)) return 'unsupported'
  return `${compactText(expression.expression, sourceFile)}.${expression.name.text}(${call.arguments
    .map((argument) => compactText(argument, sourceFile))
    .join(',')})`
}

function callsForContract(
  sourceFile: ts.SourceFile,
  contract: OpaqueDirectContract,
): readonly ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      directMethod(node.expression) &&
      node.arguments[0] &&
      compactText(node.arguments[0], sourceFile) === contract.provider &&
      sameStrings(functionStack(node), contract.functionStack)
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

function declarationIdentifier(binding: Binding, identifier: ts.Identifier): boolean {
  if (ts.isParameter(binding.node) || ts.isVariableDeclaration(binding.node)) {
    return bindingNames(binding.node.name).includes(identifier)
  }
  if (ts.isFunctionDeclaration(binding.node) || ts.isClassDeclaration(binding.node)) {
    return binding.node.name === identifier
  }
  if (ts.isImportSpecifier(binding.node)) return binding.node.name === identifier
  if (ts.isNamespaceImport(binding.node)) return binding.node.name === identifier
  if (ts.isImportClause(binding.node)) return binding.node.name === identifier
  return binding.node === identifier
}

function identifiersForBinding(
  node: ts.Node,
  binding: Binding,
  bindings: BindingIndex,
): ReadonlySet<ts.Identifier> {
  const identifiers = new Set<ts.Identifier>()
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isIdentifier(candidate) &&
      !(
        ts.isPropertyAccessExpression(candidate.parent) &&
        candidate.parent.name === candidate
      ) &&
      bindings.binding(candidate)?.node === binding.node &&
      !declarationIdentifier(binding, candidate)
    ) {
      identifiers.add(candidate)
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return identifiers
}

function parameterReferencesStayInCalls(
  binding: Binding,
  calls: readonly ts.CallExpression[],
  position: 'provider' | 'receiver',
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
): boolean {
  if (binding.kind !== 'parameter') return true
  const allowed = new Set<ts.Identifier>()
  for (const call of calls) {
    const roots =
      position === 'provider'
        ? call.arguments
        : ts.isPropertyAccessExpression(unwrap(call.expression))
          ? [(unwrap(call.expression) as ts.PropertyAccessExpression).expression]
          : []
    for (const root of roots) {
      for (const identifier of identifiersForBinding(root, binding, bindings)) {
        allowed.add(identifier)
      }
    }
  }
  const references = identifiersForBinding(sourceFile, binding, bindings)
  return [...references].every((identifier) => allowed.has(identifier))
}

/**
 * Runtime SQL is accepted only at six exact pass-through seams whose callers
 * are scanned separately. The complete call multiset, lexical function stack,
 * receiver/provider bindings, and binding origins are all pinned; names alone
 * cannot create a new exception.
 */
function approvedOpaqueDirectCall(
  file: string,
  call: ts.CallExpression,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
): boolean {
  const contract = opaqueDirectContracts.find(
    (candidate) =>
      candidate.file === file &&
      candidate.provider ===
        compactText(call.arguments[0] as ts.Expression, sourceFile) &&
      sameStrings(functionStack(call), candidate.functionStack),
  )
  if (!contract) return false
  const expression = unwrap(call.expression)
  if (!ts.isPropertyAccessExpression(expression)) return false
  const calls = callsForContract(sourceFile, contract)
  const actualShapes = calls.map((item) => directCallShape(item, sourceFile)).sort()
  const expectedShapes = [...contract.shapes].sort()
  if (!sameStrings(actualShapes, expectedShapes)) return false
  const providerIdentifier = rootIdentifier(call.arguments[0] as ts.Expression)
  const receiverIdentifier = rootIdentifier(expression.expression)
  if (
    !matchesBindingContract(
      providerIdentifier,
      contract.providerBinding,
      bindings,
      sourceFile,
    ) ||
    !matchesBindingContract(
      receiverIdentifier,
      contract.receiverBinding,
      bindings,
      sourceFile,
    )
  ) {
    return false
  }
  const providerBinding = providerIdentifier
    ? bindings.binding(providerIdentifier)
    : undefined
  const receiverBinding = receiverIdentifier
    ? bindings.binding(receiverIdentifier)
    : undefined
  return (
    !!providerBinding &&
    !!receiverBinding &&
    parameterReferencesStayInCalls(
      providerBinding,
      calls,
      'provider',
      bindings,
      sourceFile,
    ) &&
    parameterReferencesStayInCalls(
      receiverBinding,
      calls,
      'receiver',
      bindings,
      sourceFile,
    )
  )
}

function approvedTrackedReflectQuery(
  file: string,
  call: ts.CallExpression,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
): boolean {
  if (
    file !== 'src/platform/application-coordination/postgres-unit-of-work.ts' ||
    compactText(call.expression, sourceFile) !== 'Reflect.apply' ||
    !sameStrings(functionStack(call), ['method:#executeQuery']) ||
    call.arguments.map((argument) => compactText(argument, sourceFile)).join(',') !==
      'this.#client.query,this.#client,queryArgs'
  ) {
    return false
  }
  const method = functionStack(call)[0]
  let ownerClass: ts.ClassLikeDeclaration | undefined
  let ownerMethod: ts.MethodDeclaration | undefined
  for (
    let current: ts.Node | undefined = call.parent;
    current;
    current = current.parent
  ) {
    if (!ownerMethod && ts.isMethodDeclaration(current)) ownerMethod = current
    if (ts.isClassLike(current)) {
      ownerClass = current
      break
    }
  }
  const queryArgs = call.arguments[2]
  const queryArgsIdentifier = queryArgs && rootIdentifier(queryArgs)
  if (
    method !== 'method:#executeQuery' ||
    !ownerMethod ||
    !ownerClass?.name ||
    ownerClass.name.text !== 'TransactionQueryTracker' ||
    !matchesBindingContract(
      queryArgsIdentifier,
      {
        kind: 'mutable',
        owner: 'method:#executeQuery',
        initializer: 'assigned-query-args',
      },
      bindings,
      sourceFile,
    )
  ) {
    return false
  }
  let count = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      compactText(node.expression, sourceFile) === 'Reflect.apply' &&
      sameStrings(functionStack(node), ['method:#executeQuery']) &&
      node.arguments.map((argument) => compactText(argument, sourceFile)).join(',') ===
        'this.#client.query,this.#client,queryArgs'
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  let trackedClientReferences = 0
  const visitMethod = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      compactText(node, sourceFile) === 'this.#client'
    ) {
      trackedClientReferences += 1
    }
    ts.forEachChild(node, visitMethod)
  }
  visitMethod(ownerMethod)
  return count === 1 && trackedClientReferences === 2
}

function validateOpaqueContractsForFile(
  file: string,
  bindings: BindingIndex,
  sourceFile: ts.SourceFile,
): ReadonlySet<ts.CallExpression> {
  const approvedCalls = new Set<ts.CallExpression>()
  for (const contract of opaqueDirectContracts.filter(
    (candidate) => candidate.file === file,
  )) {
    const calls = callsForContract(sourceFile, contract)
    if (
      calls.length === 0 ||
      calls.some((call) => !approvedOpaqueDirectCall(file, call, bindings, sourceFile))
    ) {
      unresolvedProvider(file, calls[0] ?? sourceFile, sourceFile)
    }
    for (const call of calls) approvedCalls.add(call)
  }

  if (file !== 'src/platform/application-coordination/postgres-unit-of-work.ts') {
    return approvedCalls
  }
  const trackedCalls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      compactText(node.expression, sourceFile) === 'Reflect.apply' &&
      sameStrings(functionStack(node), ['method:#executeQuery']) &&
      node.arguments.map((argument) => compactText(argument, sourceFile)).join(',') ===
        'this.#client.query,this.#client,queryArgs'
    ) {
      trackedCalls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const trackedCall = trackedCalls[0]
  if (
    trackedCalls.length !== 1 ||
    !trackedCall ||
    !approvedTrackedReflectQuery(file, trackedCall, bindings, sourceFile)
  ) {
    unresolvedProvider(file, trackedCall ?? sourceFile, sourceFile)
  }
  approvedCalls.add(trackedCall)
  return approvedCalls
}

/** Detect closed-grammar raw writes in one already-parsed source file. */
export function detectRawSqlWrites(
  sourceFile: ts.SourceFile,
  file: string,
  principal: string,
  sqlNames: ReadonlySet<string>,
  schemaBindingToSql?: SchemaBindingToSql,
): RawObservedWrite[] {
  const bindings = createBindingIndex(sourceFile)
  const approvedOpaqueCalls = validateOpaqueContractsForFile(file, bindings, sourceFile)
  const evidence = new Map<string, ClassifiedEvidence>()
  const remember = (
    item: Evidence,
    classification: RawObservedWrite['evidence'],
  ): void => {
    const key = `${item.node.pos}:${item.node.end}:${item.text}`
    const existing = evidence.get(key)
    if (existing?.evidence === 'executable') return
    evidence.set(key, { ...item, evidence: classification })
  }

  const visit = (node: ts.Node): void => {
    validateSinkCapabilityFlow(node, bindings, file, sourceFile)
    if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag, bindings)) {
      const found = evidenceFromProvider(node, bindings, schemaBindingToSql)
      if (found && found.length > 0) {
        for (const item of found) remember(item, 'potential')
      } else {
        unresolvedProvider(file, node, sourceFile)
      }
    }
    if (ts.isCallExpression(node)) {
      const rawProviders = rawProviderExpressionsForCall(node, bindings)
      if (rawProviders && rawProviders.length > 0) {
        const found = rawProviders.flatMap(
          (provider) =>
            evidenceFromProvider(provider, bindings, schemaBindingToSql) ?? [],
        )
        if (found.length > 0) {
          for (const item of found) remember(item, 'potential')
        } else {
          unresolvedProvider(file, node, sourceFile)
        }
      }
      const method = directMethod(node.expression)
      const forwardedSink = node.arguments.some((argument) =>
        forwardedSqlSink(argument, bindings),
      )
      if (method) {
        const provider = node.arguments[0]
        if (provider) {
          const found = evidenceFromProvider(provider, bindings, schemaBindingToSql)
          if (found && found.length > 0) {
            for (const item of found) remember(item, 'executable')
          } else if (!approvedOpaqueCalls.has(node)) {
            unresolvedProvider(file, provider, sourceFile)
          }
        }
      } else if (indirectSinkCall(node, bindings)) {
        const found = node.arguments.flatMap(
          (argument) =>
            evidenceFromProvider(argument, bindings, schemaBindingToSql) ?? [],
        )
        if (found.length > 0) {
          for (const item of found) remember(item, 'executable')
        } else if (!approvedOpaqueCalls.has(node)) {
          unresolvedProvider(file, node, sourceFile)
        }
      } else if (forwardedSink) {
        const found = node.arguments.flatMap(
          (argument) =>
            evidenceFromProvider(argument, bindings, schemaBindingToSql) ?? [],
        )
        if (found.length > 0) {
          for (const item of found) remember(item, 'potential')
        } else if (!approvedOpaqueCalls.has(node)) {
          unresolvedProvider(file, node, sourceFile)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const writes: RawObservedWrite[] = []
  for (const item of evidence.values()) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      item.node.getStart(sourceFile),
    )
    for (const write of writesInText(item.text, sqlNames)) {
      writes.push({
        evidence: item.evidence,
        principal,
        table: write.table,
        op: write.op,
        kind: 'raw',
        file,
        line: line + 1,
      })
    }
  }
  return writes
}
