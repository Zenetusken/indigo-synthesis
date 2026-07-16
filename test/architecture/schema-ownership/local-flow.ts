import { posix } from 'node:path'
import ts from 'typescript'
import type { ObservedWrite, WriteOp } from '../schema-ownership-scan'
import { executableSqlText } from './sql'

const writeMethods = new Set<WriteOp>(['insert', 'update', 'delete'])
const readRelationMethods = new Set([
  'from',
  'fullJoin',
  'innerJoin',
  'leftJoin',
  'rightJoin',
])
const compactAlternativeTokens = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
])

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

export type LocalFlowDiagnosticCode =
  | 'destructured-table-storage'
  | 'exported-schema-table'
  | 'helper-table-argument'
  | 'helper-table-return'
  | 'method-capability-escape'
  | 'mutable-table-storage'
  | 'object-or-array-table-storage'
  | 'raw-table-interpolation'
  | 'unresolved-schema-load'
  | 'unresolved-computed-method'
  | 'unresolved-namespace-member'
  | 'unresolved-table-member'

export class SchemaLocalFlowError extends Error {
  constructor(
    readonly code: LocalFlowDiagnosticCode,
    readonly file: string,
    readonly line: number,
    detail: string,
  ) {
    super(`${file}:${line} ${code}: ${detail}`)
    this.name = 'SchemaLocalFlowError'
  }
}

type BindingKind =
  | 'class'
  | 'const'
  | 'function'
  | 'import'
  | 'let'
  | 'namespace-import'
  | 'parameter'
  | 'var'

type BindingSource = Readonly<{
  defaultOnly?: boolean
  expression: ts.Expression
  path: readonly string[]
}>

type Binding = Readonly<{
  declaration: ts.Node
  importedFrom?: string
  importedName?: string
  initializer?: ts.Expression
  kind: BindingKind
  name: string
  namespace?: boolean
  schemaTable?: string
  sources?: readonly BindingSource[]
}>

type Scope = {
  readonly bindings: Map<string, Binding[]>
  readonly node: ts.Node
  readonly parent?: Scope
}

type FlowContext = Readonly<{
  bindingToSql: ReadonlyMap<string, string>
  cryptoFactories: ReadonlySet<Binding>
  file: string
  getTableColumns: ReadonlySet<Binding>
  mutatedBindings: ReadonlySet<Binding>
  mutatedGlobalCollections: ReadonlySet<string>
  namespaceBindings: ReadonlySet<Binding>
  scopeForNode: ReadonlyMap<ts.Node, Scope>
  sourceFile: ts.SourceFile
}>

function resolvedModuleSpecifier(value: string, file: string): string {
  const normalized = value.replace(/^@\//, 'src/').replaceAll('\\', '/')
  if (!normalized.startsWith('.')) return normalized
  return posix.normalize(
    posix.join(posix.dirname(file.replaceAll('\\', '/')), normalized),
  )
}

function isSchemaSpecifier(value: string, file: string): boolean {
  return /(^|\/)platform\/db\/schema(?:\/|$)/.test(resolvedModuleSpecifier(value, file))
}

function isSchemaFile(file: string): boolean {
  return /(^|\/)platform\/db\/schema(?:\/|$)/.test(file.replaceAll('\\', '/'))
}

function isTypeOnlyPosition(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true
    if (ts.isStatement(current) || ts.isExpression(current)) return false
  }
  return false
}

function isApprovedRuntimeSchemaRegistration(
  identifier: ts.Identifier,
  binding: Binding,
  context: FlowContext,
): boolean {
  if (
    context.file !== 'src/platform/db/database-runtime.ts' ||
    binding.importedName !== '*' ||
    !binding.importedFrom ||
    !isSchemaSpecifier(binding.importedFrom, context.file) ||
    !ts.isShorthandPropertyAssignment(identifier.parent) ||
    identifier.parent.name !== identifier ||
    !ts.isObjectLiteralExpression(identifier.parent.parent) ||
    identifier.parent.parent.properties.length !== 1
  ) {
    return false
  }
  const object = identifier.parent.parent
  const call = object.parent
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length !== 2 ||
    call.arguments[1] !== object ||
    !ts.isIdentifier(call.expression) ||
    call.arguments[0]?.getText(context.sourceFile) !== 'this.#ordinaryPool'
  ) {
    return false
  }
  const drizzleBinding = bindingFor(call.expression, context)
  return (
    drizzleBinding?.kind === 'import' &&
    drizzleBinding.importedFrom === 'drizzle-orm/node-postgres' &&
    drizzleBinding.importedName === 'drizzle'
  )
}

function modifiersInclude(
  node: ts.Node,
  kind: ts.SyntaxKind.ExportKeyword | ts.SyntaxKind.DefaultKeyword,
): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
    : false
}

function declarationKind(node: ts.VariableDeclaration): BindingKind {
  const list = node.parent
  if (!ts.isVariableDeclarationList(list)) return 'var'
  if ((list.flags & ts.NodeFlags.Const) !== 0) return 'const'
  if ((list.flags & ts.NodeFlags.Let) !== 0) return 'let'
  return 'var'
}

function buildScopes(
  sourceFile: ts.SourceFile,
  file: string,
  bindingToSql: ReadonlyMap<string, string>,
): Readonly<{
  cryptoFactories: ReadonlySet<Binding>
  getTableColumns: ReadonlySet<Binding>
  mutatedBindings: ReadonlySet<Binding>
  mutatedGlobalCollections: ReadonlySet<string>
  namespaceBindings: ReadonlySet<Binding>
  scopeForNode: ReadonlyMap<ts.Node, Scope>
}> {
  const root: Scope = { bindings: new Map(), node: sourceFile }
  const scopeForNode = new Map<ts.Node, Scope>()
  const namespaceBindings = new Set<Binding>()
  const getTableColumns = new Set<Binding>()
  const cryptoFactories = new Set<Binding>()

  const remember = (scope: Scope, binding: Binding): void => {
    const records = scope.bindings.get(binding.name) ?? []
    records.push(binding)
    scope.bindings.set(binding.name, records)
  }
  const isAmbientDeclaration = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (
        ts.canHaveModifiers(current) &&
        ts
          .getModifiers(current)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      ) {
        return true
      }
      if (ts.isSourceFile(current)) return false
    }
    return false
  }
  const importBindings = (node: ts.ImportDeclaration): void => {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return
    const module = node.moduleSpecifier.text
    const clause = node.importClause
    if (!clause) return
    if (clause.name) {
      remember(root, {
        declaration: clause.name,
        importedFrom: module,
        importedName: 'default',
        kind: 'import',
        name: clause.name.text,
      })
    }
    const named = clause.namedBindings
    if (!named) return
    if (ts.isNamespaceImport(named)) {
      const binding: Binding = {
        declaration: named.name,
        importedFrom: module,
        importedName: '*',
        kind: 'namespace-import',
        name: named.name.text,
        namespace: isSchemaSpecifier(module, sourceFile.fileName),
      }
      remember(root, binding)
      if (binding.namespace) namespaceBindings.add(binding)
      return
    }
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text
      const binding: Binding = {
        declaration: element.name,
        importedFrom: module,
        importedName: imported,
        kind: 'import',
        name: element.name.text,
        schemaTable: isSchemaSpecifier(module, sourceFile.fileName)
          ? bindingToSql.get(imported)
          : undefined,
      }
      remember(root, binding)
      if (module === 'drizzle-orm' && imported === 'getTableColumns') {
        getTableColumns.add(binding)
      }
      if (
        module === 'node:crypto' &&
        (imported === 'createHash' || imported === 'createHmac')
      ) {
        cryptoFactories.add(binding)
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) importBindings(statement)
  }

  const bindingMemberName = (
    element: ts.BindingElement,
    index: number,
  ): string | undefined => {
    if (ts.isArrayBindingPattern(element.parent)) return index.toString()
    const property = element.propertyName
    if (property && (ts.isIdentifier(property) || ts.isStringLiteralLike(property))) {
      return property.text
    }
    return ts.isIdentifier(element.name) ? element.name.text : undefined
  }
  const sourcesForIdentifier = (
    name: ts.BindingName,
    target: ts.Identifier,
    source: BindingSource | undefined,
  ): readonly BindingSource[] => {
    if (ts.isIdentifier(name)) return name === target && source ? [source] : []
    const results: BindingSource[] = []
    name.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return
      const member = bindingMemberName(element, index)
      const projected =
        source && member !== undefined
          ? { ...source, path: [...source.path, member] }
          : undefined
      results.push(...sourcesForIdentifier(element.name, target, projected))
      if (
        element.initializer &&
        bindingIdentifiers(element.name).some((identifier) => identifier === target)
      ) {
        results.push({
          defaultOnly: true,
          expression: element.initializer,
          path: [],
        })
      }
    })
    return results
  }

  const visit = (node: ts.Node, scope: Scope): void => {
    scopeForNode.set(node, scope)
    if (ts.isImportDeclaration(node)) return

    if (ts.isFunctionDeclaration(node) && node.name && !isAmbientDeclaration(node)) {
      remember(scope, {
        declaration: node.name,
        kind: 'function',
        name: node.name.text,
      })
    } else if (ts.isClassDeclaration(node) && node.name && !isAmbientDeclaration(node)) {
      remember(scope, {
        declaration: node.name,
        kind: 'class',
        name: node.name.text,
      })
    }

    let childScope = scope
    if (
      node !== sourceFile &&
      (ts.isFunctionLike(node) ||
        ts.isBlock(node) ||
        ts.isModuleBlock(node) ||
        ts.isCaseBlock(node) ||
        ts.isCatchClause(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node))
    ) {
      childScope = { bindings: new Map(), node, parent: scope }
      scopeForNode.set(node, childScope)
    }

    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) {
          remember(childScope, {
            declaration: parameter.name,
            initializer: parameter.initializer,
            kind: 'parameter',
            name: parameter.name.text,
            sources: parameter.initializer
              ? [
                  {
                    defaultOnly: true,
                    expression: parameter.initializer,
                    path: [],
                  },
                ]
              : [],
          })
        } else {
          for (const identifier of bindingIdentifiers(parameter.name)) {
            remember(childScope, {
              declaration: identifier,
              kind: 'parameter',
              name: identifier.text,
              sources: sourcesForIdentifier(
                parameter.name,
                identifier,
                parameter.initializer
                  ? {
                      defaultOnly: true,
                      expression: parameter.initializer,
                      path: [],
                    }
                  : undefined,
              ),
            })
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && !isAmbientDeclaration(node)) {
      const kind = declarationKind(node)
      let declarationScope = childScope
      if (kind === 'var') {
        while (
          declarationScope.parent &&
          !ts.isFunctionLike(declarationScope.node) &&
          !ts.isModuleBlock(declarationScope.node) &&
          !ts.isSourceFile(declarationScope.node)
        ) {
          declarationScope = declarationScope.parent
        }
      }
      for (const identifier of bindingIdentifiers(node.name)) {
        remember(declarationScope, {
          declaration: identifier,
          initializer: ts.isIdentifier(node.name) ? node.initializer : undefined,
          kind,
          name: identifier.text,
          schemaTable:
            isSchemaFile(file) && ts.isIdentifier(node.name)
              ? bindingToSql.get(identifier.text)
              : undefined,
          sources: sourcesForIdentifier(
            node.name,
            identifier,
            node.initializer ? { expression: node.initializer, path: [] } : undefined,
          ),
        })
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const identifier of bindingIdentifiers(node.variableDeclaration.name)) {
        remember(childScope, {
          declaration: identifier,
          kind: 'let',
          name: identifier.text,
        })
      }
    }
    ts.forEachChild(node, (child) => visit(child, childScope))
  }
  visit(sourceFile, root)
  const mutatedBindings = new Set<Binding>()
  const mutatedGlobalCollections = new Set<string>()
  const recordsFor = (identifier: ts.Identifier): readonly Binding[] | undefined => {
    let scope = scopeForNode.get(identifier)
    while (scope) {
      const bindings = scope.bindings.get(identifier.text)
      if (bindings) return bindings
      scope = scope.parent
    }
    return undefined
  }
  const markMutated = (expression: ts.Expression): void => {
    const value = unwrap(expression)
    if (!ts.isIdentifier(value)) return
    const records = recordsFor(value)
    if (records?.length === 1 && records[0]) mutatedBindings.add(records[0])
  }
  const globalCollectionIn = (expression: ts.Expression): string | undefined => {
    const value = unwrap(expression)
    if (
      ts.isIdentifier(value) &&
      ['Headers', 'Map', 'Set'].includes(value.text) &&
      recordsFor(value) === undefined
    ) {
      return value.text
    }
    if (ts.isPropertyAccessExpression(value)) {
      if (value.name.text === 'prototype' && ts.isIdentifier(value.expression)) {
        return globalCollectionIn(value.expression)
      }
      if (
        ts.isIdentifier(value.expression) &&
        value.expression.text === 'globalThis' &&
        ['Headers', 'Map', 'Set'].includes(value.name.text)
      ) {
        return value.name.text
      }
    }
    return undefined
  }
  const collectMutations = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      (ts.isPropertyAccessExpression(unwrap(node.left)) ||
        ts.isElementAccessExpression(unwrap(node.left)))
    ) {
      const receiver = (
        unwrap(node.left) as ts.PropertyAccessExpression | ts.ElementAccessExpression
      ).expression
      markMutated(receiver)
      const globalCollection = globalCollectionIn(receiver)
      if (globalCollection) mutatedGlobalCollections.add(globalCollection)
    } else if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      ts.isIdentifier(unwrap(node.left))
    ) {
      const globalCollection = globalCollectionIn(unwrap(node.left))
      if (globalCollection) mutatedGlobalCollections.add(globalCollection)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(unwrap(node.expression)) &&
      node.arguments[0]
    ) {
      const callee = unwrap(node.expression) as ts.PropertyAccessExpression
      if (
        ts.isIdentifier(callee.expression) &&
        ((callee.expression.text === 'Object' &&
          ['assign', 'defineProperties', 'defineProperty', 'setPrototypeOf'].includes(
            callee.name.text,
          )) ||
          (callee.expression.text === 'Reflect' && callee.name.text === 'set'))
      ) {
        markMutated(node.arguments[0])
        const globalCollection = globalCollectionIn(node.arguments[0])
        if (globalCollection) mutatedGlobalCollections.add(globalCollection)
      }
    }
    ts.forEachChild(node, collectMutations)
  }
  collectMutations(sourceFile)
  const immutableAliasEdges: readonly [Binding, Binding][] = (() => {
    const edges: [Binding, Binding][] = []
    for (const scope of new Set(scopeForNode.values())) {
      for (const bindings of scope.bindings.values()) {
        for (const binding of bindings) {
          if (binding.kind !== 'const' || !binding.initializer) continue
          const initializer = unwrap(binding.initializer)
          if (!ts.isIdentifier(initializer)) continue
          const targets = recordsFor(initializer)
          if (targets?.length === 1 && targets[0]) edges.push([binding, targets[0]])
        }
      }
    }
    return edges
  })()
  for (let changed = true; changed; ) {
    changed = false
    for (const [left, right] of immutableAliasEdges) {
      if (mutatedBindings.has(left) === mutatedBindings.has(right)) continue
      mutatedBindings.add(left)
      mutatedBindings.add(right)
      changed = true
    }
  }
  return {
    cryptoFactories,
    getTableColumns,
    mutatedBindings,
    mutatedGlobalCollections,
    namespaceBindings,
    scopeForNode,
  }
}

function bindingIdentifiers(name: ts.BindingName): readonly ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name]
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  )
}

function bindingFor(
  identifier: ts.Identifier,
  context: FlowContext,
): Binding | undefined {
  const bindings = bindingRecordsFor(identifier, context)
  return bindings?.length === 1 ? bindings[0] : undefined
}

function bindingRecordsFor(
  identifier: ts.Identifier,
  context: FlowContext,
): readonly Binding[] | undefined {
  let scope = context.scopeForNode.get(identifier)
  while (scope) {
    const bindings = scope.bindings.get(identifier.text)
    if (bindings) return bindings
    scope = scope.parent
  }
  return undefined
}

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

type LoaderKind =
  | 'builtin-module-factory'
  | 'create-require-factory'
  | 'global-object'
  | 'module-object'
  | 'process-object'
  | 'reflect-object'
  | 'require-loader'

function loaderMemberKinds(
  kinds: ReadonlySet<LoaderKind>,
  member: string,
): ReadonlySet<LoaderKind> {
  const result = new Set<LoaderKind>()
  if (kinds.has('global-object')) {
    if (member === 'require') result.add('require-loader')
    if (member === 'module') result.add('module-object')
    if (member === 'process') result.add('process-object')
    if (member === 'Reflect') result.add('reflect-object')
  }
  if (kinds.has('module-object')) {
    if (member === 'require' || member === '_load') result.add('require-loader')
    if (member === 'createRequire') result.add('create-require-factory')
    if (member === 'default' || member === 'Module') result.add('module-object')
  }
  if (kinds.has('require-loader') && member === 'main') {
    result.add('module-object')
  }
  if (kinds.has('process-object')) {
    if (member === 'getBuiltinModule') result.add('builtin-module-factory')
    if (member === 'mainModule') result.add('module-object')
  }
  return result
}

function propertyExpression(
  expression: ts.Expression,
  member: string,
): ts.Expression | undefined {
  const value = unwrap(expression)
  if (ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = property.name
        const staticName =
          ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined
        if (staticName === member) return property.initializer
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === member
      ) {
        return property.name
      }
    }
  }
  if (ts.isArrayLiteralExpression(value) && /^\d+$/.test(member)) {
    const element = value.elements[Number(member)]
    return element && !ts.isOmittedExpression(element)
      ? ts.isSpreadElement(element)
        ? undefined
        : element
      : undefined
  }
  return undefined
}

function projectedExpressions(
  expression: ts.Expression,
  path: readonly string[],
  context: FlowContext,
  seenBindings = new Set<Binding>(),
): readonly ts.Expression[] {
  const value = unwrap(expression)
  if (path.length === 0) return [value]
  const [member, ...rest] = path
  if (member === undefined) return [value]
  const property = propertyExpression(value, member)
  if (property) return projectedExpressions(property, rest, context, seenBindings)
  if (ts.isIdentifier(value)) {
    const results: ts.Expression[] = []
    for (const binding of bindingRecordsFor(value, context) ?? []) {
      if (seenBindings.has(binding) || context.mutatedBindings.has(binding)) continue
      const seen = new Set(seenBindings).add(binding)
      for (const source of binding.sources ?? []) {
        results.push(
          ...projectedExpressions(
            source.expression,
            [...source.path, member, ...rest],
            context,
            seen,
          ),
        )
      }
    }
    return results
  }
  if (ts.isConditionalExpression(value)) {
    return [
      ...projectedExpressions(value.whenTrue, path, context, seenBindings),
      ...projectedExpressions(value.whenFalse, path, context, seenBindings),
    ]
  }
  if (
    ts.isBinaryExpression(value) &&
    compactAlternativeTokens.has(value.operatorToken.kind)
  ) {
    return [
      ...projectedExpressions(value.left, path, context, seenBindings),
      ...projectedExpressions(value.right, path, context, seenBindings),
    ]
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return projectedExpressions(value.right, path, context, seenBindings)
  }
  return []
}

function isRuntimeUndefined(expression: ts.Expression, context: FlowContext): boolean {
  const value = unwrap(expression)
  return (
    ts.isVoidExpression(value) ||
    (ts.isIdentifier(value) &&
      value.text === 'undefined' &&
      bindingRecordsFor(value, context) === undefined)
  )
}

function loaderKinds(
  expression: ts.Expression,
  context: FlowContext,
  seenBindings = new Set<Binding>(),
  seenCallables = new Set<ts.Node>(),
): ReadonlySet<LoaderKind> {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) {
    const records = bindingRecordsFor(value, context)
    if (!records) {
      if (value.text === 'require') return new Set(['require-loader'])
      if (value.text === 'module') return new Set(['module-object'])
      if (value.text === 'global' || value.text === 'globalThis') {
        return new Set(['global-object'])
      }
      if (value.text === 'process') return new Set(['process-object'])
      if (value.text === 'Reflect') return new Set(['reflect-object'])
      return new Set()
    }
    const result = new Set<LoaderKind>()
    for (const binding of records) {
      if (seenBindings.has(binding) || context.mutatedBindings.has(binding)) continue
      const seen = new Set(seenBindings).add(binding)
      if (binding.importedFrom === 'node:module') {
        if (binding.importedName === 'createRequire') {
          result.add('create-require-factory')
        } else if (binding.importedName === '_load') {
          result.add('require-loader')
        } else if (
          binding.importedName === '*' ||
          binding.importedName === 'default' ||
          binding.importedName === 'Module'
        ) {
          result.add('module-object')
        }
      }
      for (const source of binding.sources ?? []) {
        let projected: ts.Expression | undefined = source.expression
        let kinds = loaderKinds(projected, context, seen, seenCallables)
        for (const member of source.path) {
          const next: ts.Expression | undefined =
            projected && propertyExpression(projected, member)
          if (next) {
            projected = next
            kinds = loaderKinds(next, context, seen, seenCallables)
          } else {
            projected = undefined
            kinds = loaderMemberKinds(kinds, member)
          }
        }
        for (const kind of kinds) result.add(kind)
      }
      if (
        (binding.sources?.length ?? 0) === 0 &&
        binding.initializer &&
        (binding.kind === 'const' || binding.kind === 'parameter')
      ) {
        for (const kind of loaderKinds(
          binding.initializer,
          context,
          seen,
          seenCallables,
        )) {
          result.add(kind)
        }
      }
    }
    return result
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const member = staticMemberName(value)
    return member
      ? loaderMemberKinds(
          loaderKinds(value.expression, context, seenBindings, seenCallables),
          member,
        )
      : new Set()
  }
  if (ts.isConditionalExpression(value)) {
    return new Set([
      ...loaderKinds(value.whenTrue, context, seenBindings, seenCallables),
      ...loaderKinds(value.whenFalse, context, seenBindings, seenCallables),
    ])
  }
  if (
    ts.isBinaryExpression(value) &&
    compactAlternativeTokens.has(value.operatorToken.kind)
  ) {
    return new Set([
      ...loaderKinds(value.left, context, seenBindings, seenCallables),
      ...loaderKinds(value.right, context, seenBindings, seenCallables),
    ])
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return loaderKinds(value.right, context, seenBindings, seenCallables)
  }
  if (!ts.isCallExpression(value)) return new Set()

  const result = new Set<LoaderKind>()
  const calleeKinds = loaderKinds(value.expression, context, seenBindings, seenCallables)
  if (calleeKinds.has('create-require-factory')) result.add('require-loader')
  if (calleeKinds.has('builtin-module-factory')) {
    const modules = value.arguments[0]
      ? staticModuleSpecifiers(value.arguments[0], context)
      : undefined
    if (modules?.some((item) => item === 'module' || item === 'node:module')) {
      result.add('module-object')
    }
  }
  const callee = unwrap(value.expression)
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    staticMemberName(callee) === 'bind'
  ) {
    for (const kind of loaderKinds(
      callee.expression,
      context,
      seenBindings,
      seenCallables,
    )) {
      result.add(kind)
    }
  }
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    staticMemberName(callee) === 'get' &&
    loaderKinds(callee.expression, context, seenBindings, seenCallables).has(
      'reflect-object',
    ) &&
    value.arguments[0] &&
    value.arguments[1]
  ) {
    const members = staticModuleSpecifiers(value.arguments[1], context) ?? []
    for (const member of members) {
      for (const kind of loaderMemberKinds(
        loaderKinds(value.arguments[0], context, seenBindings, seenCallables),
        member,
      )) {
        result.add(kind)
      }
    }
  }
  const callable = localCallable(value.expression, context)
  if (callable && !seenCallables.has(callable)) {
    const seen = new Set(seenCallables).add(callable)
    for (const returned of callableReturnExpressions(callable)) {
      for (const kind of loaderKinds(returned, context, seenBindings, seen)) {
        result.add(kind)
      }
    }
  }
  return result
}

function staticModuleSpecifiers(
  expression: ts.Expression,
  context: FlowContext,
  seen = new Set<ts.Node>(),
): readonly string[] | undefined {
  const value = unwrap(expression)
  if (seen.has(value)) return undefined
  const branchSeen = new Set(seen).add(value)
  if (ts.isStringLiteralLike(value)) return [value.text]
  if (ts.isIdentifier(value)) {
    const binding = bindingFor(value, context)
    return binding?.kind === 'const' &&
      binding.initializer &&
      !context.mutatedBindings.has(binding)
      ? staticModuleSpecifiers(binding.initializer, context, branchSeen)
      : undefined
  }
  if (ts.isConditionalExpression(value)) {
    const whenTrue = staticModuleSpecifiers(value.whenTrue, context, branchSeen)
    const whenFalse = staticModuleSpecifiers(value.whenFalse, context, branchSeen)
    const alternatives = [...(whenTrue ?? []), ...(whenFalse ?? [])]
    return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const left = staticModuleSpecifiers(value.left, context, branchSeen)
    const right = staticModuleSpecifiers(value.right, context, branchSeen)
    const alternatives = [...(left ?? []), ...(right ?? [])]
    return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticModuleSpecifiers(value.left, context, branchSeen)
    const right = staticModuleSpecifiers(value.right, context, branchSeen)
    return left && right
      ? left.flatMap((prefix) => right.map((suffix) => prefix + suffix))
      : undefined
  }
  if (ts.isTemplateExpression(value)) {
    let alternatives: readonly string[] = [value.head.text]
    for (const span of value.templateSpans) {
      const substitution = staticModuleSpecifiers(span.expression, context, branchSeen)
      if (!substitution) return undefined
      alternatives = alternatives.flatMap((prefix) =>
        substitution.map((item) => prefix + item + span.literal.text),
      )
    }
    return alternatives
  }
  if (ts.isCallExpression(value)) {
    const callable = localCallable(value.expression, context)
    if (!callable) return undefined
    const alternatives = callableReturnExpressions(callable).flatMap(
      (returned) => staticModuleSpecifiers(returned, context, branchSeen) ?? [],
    )
    return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
  }
  return undefined
}

function isRequireLoader(expression: ts.Expression, context: FlowContext): boolean {
  return loaderKinds(expression, context).has('require-loader')
}

function staticArrayElements(
  expression: ts.Expression | undefined,
  context: FlowContext,
  seen = new Set<Binding>(),
): readonly ts.Expression[] {
  if (!expression) return []
  const value = unwrap(expression)
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.flatMap((element) =>
      ts.isOmittedExpression(element)
        ? []
        : ts.isSpreadElement(element)
          ? staticArrayElements(element.expression, context, seen)
          : [element],
    )
  }
  if (ts.isIdentifier(value)) {
    const binding = bindingFor(value, context)
    return binding?.kind === 'const' &&
      binding.initializer &&
      !context.mutatedBindings.has(binding) &&
      !seen.has(binding)
      ? staticArrayElements(binding.initializer, context, new Set(seen).add(binding))
      : []
  }
  return []
}

function staticCallArguments(
  arguments_: readonly ts.Expression[],
  context: FlowContext,
): readonly ts.Expression[] {
  return arguments_.flatMap((argument) =>
    ts.isSpreadElement(argument)
      ? staticArrayElements(argument.expression, context)
      : [argument],
  )
}

function boundRequireArguments(
  expression: ts.Expression,
  context: FlowContext,
  seen = new Set<Binding>(),
): readonly ts.Expression[] {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) {
    const binding = bindingFor(value, context)
    if (
      binding?.initializer &&
      !context.mutatedBindings.has(binding) &&
      !seen.has(binding)
    ) {
      return boundRequireArguments(
        binding.initializer,
        context,
        new Set(seen).add(binding),
      )
    }
    return []
  }
  if (!ts.isCallExpression(value)) return []
  const callee = unwrap(value.expression)
  if (
    (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) ||
    staticMemberName(callee) !== 'bind' ||
    !isRequireLoader(callee.expression, context)
  ) {
    return []
  }
  return [
    ...boundRequireArguments(callee.expression, context, seen),
    ...staticCallArguments(value.arguments.slice(1), context),
  ]
}

function directSchemaModuleLoadProviders(
  call: ts.CallExpression,
  context: FlowContext,
): readonly ts.Expression[] {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return call.arguments[0] ? [call.arguments[0]] : []
  }
  const callee = unwrap(call.expression)
  if (isRequireLoader(callee, context)) {
    const arguments_ = [
      ...boundRequireArguments(callee, context),
      ...staticCallArguments(call.arguments, context),
    ]
    return arguments_[0] ? [arguments_[0]] : []
  }
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    (staticMemberName(callee) === 'call' || staticMemberName(callee) === 'apply') &&
    isRequireLoader(callee.expression, context)
  ) {
    return staticMemberName(callee) === 'call'
      ? call.arguments[1]
        ? [call.arguments[1]]
        : []
      : staticArrayElements(call.arguments[1], context)
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Reflect' &&
    callee.name.text === 'apply' &&
    call.arguments[0] &&
    isRequireLoader(call.arguments[0], context)
  ) {
    return staticArrayElements(call.arguments[2], context)
  }
  return []
}

function callableReturnExpressions(
  callable: ts.FunctionLikeDeclaration,
): readonly ts.Expression[] {
  if (ts.isArrowFunction(callable) && !ts.isBlock(callable.body)) {
    return [callable.body]
  }
  const returned: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (node !== callable && ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression) {
      returned.push(node.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(callable)
  return returned
}

function localCallable(
  expression: ts.Expression,
  context: FlowContext,
  seen = new Set<ts.Node>(),
): ts.FunctionLikeDeclaration | undefined {
  const value = unwrap(expression)
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value
  if (seen.has(value)) return undefined
  const branchSeen = new Set(seen).add(value)
  if (ts.isCallExpression(value)) {
    const producer = localCallable(value.expression, context, branchSeen)
    if (!producer || branchSeen.has(producer)) return undefined
    const producerSeen = new Set(branchSeen).add(producer)
    for (const returned of callableReturnExpressions(producer)) {
      const callable = localCallable(returned, context, producerSeen)
      if (callable) return callable
    }
    return undefined
  }
  if (!ts.isIdentifier(value)) return undefined
  const bindings = bindingRecordsFor(value, context) ?? []
  const implementations = bindings.flatMap((binding) => {
    if (
      context.mutatedBindings.has(binding) ||
      binding.kind !== 'function' ||
      !ts.isIdentifier(binding.declaration) ||
      !ts.isFunctionDeclaration(binding.declaration.parent) ||
      !binding.declaration.parent.body
    ) {
      return []
    }
    return [binding.declaration.parent]
  })
  if (implementations.length === 1) return implementations[0]
  if (bindings.length !== 1 || !bindings[0]) return undefined
  const binding = bindings[0]
  if (context.mutatedBindings.has(binding)) return undefined
  if (
    binding.kind === 'function' &&
    ts.isIdentifier(binding.declaration) &&
    ts.isFunctionDeclaration(binding.declaration.parent) &&
    binding.declaration.parent.body
  ) {
    return binding.declaration.parent
  }
  const initializer = binding.initializer && unwrap(binding.initializer)
  return initializer ? localCallable(initializer, context, branchSeen) : undefined
}

type ParameterFlow = Readonly<{
  index: number
  path: readonly string[]
  defaults: readonly ts.Expression[]
}>

type ForwardedLoaderParameter = ParameterFlow &
  Readonly<{
    loader?: ParameterFlow
  }>

function parameterBindingDetails(
  name: ts.BindingName,
  target: Binding,
  path: readonly string[] = [],
  defaults: readonly ts.Expression[] = [],
): Readonly<{ path: readonly string[]; defaults: readonly ts.Expression[] }> | undefined {
  if (ts.isIdentifier(name)) {
    return name === target.declaration ? { path, defaults } : undefined
  }
  for (let index = 0; index < name.elements.length; index += 1) {
    const element = name.elements[index]
    if (!element || ts.isOmittedExpression(element)) continue
    const property = element.propertyName
    const member = ts.isArrayBindingPattern(name)
      ? index.toString()
      : property && (ts.isIdentifier(property) || ts.isStringLiteralLike(property))
        ? property.text
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined
    if (member === undefined) continue
    const found = parameterBindingDetails(
      element.name,
      target,
      [...path, member],
      element.initializer ? [...defaults, element.initializer] : defaults,
    )
    if (found) return found
  }
  return undefined
}

function forwardedLoaderParameters(
  callable: ts.FunctionLikeDeclaration,
  context: FlowContext,
): readonly ForwardedLoaderParameter[] {
  const found = new Map<string, ForwardedLoaderParameter>()
  const flowForBinding = (binding: Binding): ParameterFlow | undefined => {
    for (let index = 0; index < callable.parameters.length; index += 1) {
      const parameter = callable.parameters[index]
      if (!parameter) continue
      const details = parameterBindingDetails(parameter.name, binding)
      if (details) return { index, ...details }
    }
    return undefined
  }
  const visit = (node: ts.Node): void => {
    if (node !== callable && ts.isFunctionLike(node)) return
    if (ts.isCallExpression(node)) {
      for (const provider of directSchemaModuleLoadProviders(node, context)) {
        const value = unwrap(provider)
        if (!ts.isIdentifier(value)) continue
        const providerBinding = bindingFor(value, context)
        if (!providerBinding) continue
        const flow = flowForBinding(providerBinding)
        if (!flow) continue
        const callee = unwrap(node.expression)
        const loader = ts.isIdentifier(callee)
          ? (() => {
              const binding = bindingFor(callee, context)
              return binding ? flowForBinding(binding) : undefined
            })()
          : undefined
        const key = `${flow.index}:${flow.path.join('.')}`
        found.set(key, { ...flow, loader })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(callable)
  return [...found.values()]
}

function effectiveParameterExpressions(
  flow: ParameterFlow,
  local: Readonly<{
    arguments: readonly ts.Expression[]
    callable: ts.FunctionLikeDeclaration
  }>,
  context: FlowContext,
): readonly ts.Expression[] {
  const parameter = local.callable.parameters[flow.index]
  const provided = local.arguments[flow.index]
  const supplied =
    provided && !isRuntimeUndefined(provided, context)
      ? projectedExpressions(provided, flow.path, context)
      : []
  const effectiveSupplied = supplied.filter(
    (value) => !isRuntimeUndefined(value, context),
  )
  if (effectiveSupplied.length > 0) return effectiveSupplied
  const parameterFallback = parameter?.initializer
    ? projectedExpressions(parameter.initializer, flow.path, context)
    : []
  const effectiveFallback = parameterFallback.filter(
    (value) => !isRuntimeUndefined(value, context),
  )
  return effectiveFallback.length > 0 ? effectiveFallback : flow.defaults
}

function callableExposesLoaderCapability(
  callable: ts.FunctionLikeDeclaration,
  context: FlowContext,
  seen = new Set<ts.Node>(),
): boolean {
  if (seen.has(callable)) return false
  const branchSeen = new Set(seen).add(callable)
  if (forwardedLoaderParameters(callable, context).length > 0) return true
  return callableReturnExpressions(callable).some((returned) => {
    if (isRequireLoader(returned, context)) return true
    const nested = localCallable(returned, context, branchSeen)
    return nested ? callableExposesLoaderCapability(nested, context, branchSeen) : false
  })
}

function expressionExposesLoaderCapability(
  expression: ts.Expression,
  context: FlowContext,
): boolean {
  if (isRequireLoader(expression, context)) return true
  const callable = localCallable(expression, context)
  return callable ? callableExposesLoaderCapability(callable, context) : false
}

type ResolvedLocalCallable = Readonly<{
  boundArguments: readonly ts.Expression[]
  callable: ts.FunctionLikeDeclaration
}>

function resolvedLocalCallable(
  expression: ts.Expression,
  context: FlowContext,
  seen = new Set<Binding>(),
): ResolvedLocalCallable | undefined {
  const value = unwrap(expression)
  const direct = localCallable(value, context)
  if (direct) return { boundArguments: [], callable: direct }
  if (ts.isIdentifier(value)) {
    const binding = bindingFor(value, context)
    if (
      binding?.initializer &&
      !context.mutatedBindings.has(binding) &&
      !seen.has(binding)
    ) {
      return resolvedLocalCallable(
        binding.initializer,
        context,
        new Set(seen).add(binding),
      )
    }
    return undefined
  }
  if (!ts.isCallExpression(value)) return undefined
  const callee = unwrap(value.expression)
  if (
    (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) ||
    staticMemberName(callee) !== 'bind'
  ) {
    return undefined
  }
  const target = resolvedLocalCallable(callee.expression, context, seen)
  return target
    ? {
        boundArguments: [
          ...target.boundArguments,
          ...staticCallArguments(value.arguments.slice(1), context),
        ],
        callable: target.callable,
      }
    : undefined
}

function localCallArguments(
  call: ts.CallExpression,
  context: FlowContext,
): Readonly<{
  arguments: readonly ts.Expression[]
  callable: ts.FunctionLikeDeclaration
}> | null {
  const direct = resolvedLocalCallable(call.expression, context)
  if (direct) {
    return {
      arguments: [
        ...direct.boundArguments,
        ...staticCallArguments(call.arguments, context),
      ],
      callable: direct.callable,
    }
  }

  const callee = unwrap(call.expression)
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    (staticMemberName(callee) === 'call' || staticMemberName(callee) === 'apply')
  ) {
    const target = resolvedLocalCallable(callee.expression, context)
    if (target) {
      const arguments_ = staticCallArguments(call.arguments, context)
      return {
        arguments: [
          ...target.boundArguments,
          ...(staticMemberName(callee) === 'call'
            ? arguments_.slice(1)
            : staticArrayElements(arguments_[1], context)),
        ],
        callable: target.callable,
      }
    }
  }
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    staticMemberName(callee) === 'apply' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Reflect' &&
    bindingRecordsFor(callee.expression, context) === undefined &&
    call.arguments[0]
  ) {
    const target = resolvedLocalCallable(call.arguments[0], context)
    if (!target) return null
    return {
      arguments: [
        ...target.boundArguments,
        ...staticArrayElements(call.arguments[2], context),
      ],
      callable: target.callable,
    }
  }
  return null
}

function schemaModuleLoadProviders(
  call: ts.CallExpression,
  context: FlowContext,
): readonly ts.Expression[] {
  const direct = directSchemaModuleLoadProviders(call, context)
  const local = localCallArguments(call, context)
  if (!local) return direct
  const forwarded = forwardedLoaderParameters(local.callable, context).flatMap((flow) => {
    if (
      flow.loader &&
      !effectiveParameterExpressions(flow.loader, local, context).some((value) =>
        isRequireLoader(value, context),
      )
    ) {
      return []
    }
    return effectiveParameterExpressions(flow, local, context)
  })
  return [...direct, ...forwarded]
}

function validateSchemaModuleLoad(node: ts.Node, context: FlowContext): void {
  const moduleBuiltin = (value: string): boolean =>
    value === 'module' || value === 'node:module'
  const pgCoreModule = (value: string): boolean =>
    value === 'drizzle-orm/pg-core' || value.startsWith('drizzle-orm/pg-core/')
  const runtimeImport = (declaration: ts.ImportDeclaration): boolean => {
    const clause = declaration.importClause
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
  const runtimeExport = (declaration: ts.ExportDeclaration): boolean =>
    !declaration.isTypeOnly &&
    (!declaration.exportClause ||
      ts.isNamespaceExport(declaration.exportClause) ||
      declaration.exportClause.elements.length === 0 ||
      declaration.exportClause.elements.some((element) => !element.isTypeOnly))
  const approvedPgDialectImport = (declaration: ts.ImportDeclaration): boolean => {
    if (
      context.file !== 'src/platform/db/preflight.ts' ||
      !ts.isStringLiteralLike(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== 'drizzle-orm/pg-core'
    ) {
      return false
    }
    const clause = declaration.importClause
    const bindings = clause?.namedBindings
    return (
      !!clause &&
      !clause.isTypeOnly &&
      !clause.name &&
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length === 1 &&
      !bindings.elements[0]?.isTypeOnly &&
      (bindings.elements[0]?.propertyName ?? bindings.elements[0]?.name)?.text ===
        'PgDialect'
    )
  }
  const storedLoaders = (() => {
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap((property) => {
        if (ts.isShorthandPropertyAssignment(property)) return [property.name]
        if (ts.isPropertyAssignment(property)) return [property.initializer]
        if (ts.isSpreadAssignment(property)) return [property.expression]
        return []
      })
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((element) =>
        ts.isOmittedExpression(element)
          ? []
          : [ts.isSpreadElement(element) ? element.expression : element],
      )
    }
    if (ts.isPropertyDeclaration(node) && node.initializer) {
      return [node.initializer]
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      !ts.isIdentifier(unwrap(node.left))
    ) {
      return [node.right]
    }
    return []
  })()
  if (storedLoaders.some((value) => expressionExposesLoaderCapability(value, context))) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      'module-loader capability storage is outside the accepted schema provenance grammar',
    )
  }
  const exportedLoader = (() => {
    if (
      ts.isFunctionDeclaration(node) &&
      modifiersInclude(node, ts.SyntaxKind.ExportKeyword)
    ) {
      return callableExposesLoaderCapability(node, context)
    }
    if (
      ts.isVariableStatement(node) &&
      modifiersInclude(node, ts.SyntaxKind.ExportKeyword)
    ) {
      return node.declarationList.declarations.some(
        (declaration) =>
          !!declaration.initializer &&
          expressionExposesLoaderCapability(declaration.initializer, context),
      )
    }
    if (ts.isExportAssignment(node)) {
      return expressionExposesLoaderCapability(node.expression, context)
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      return node.exportClause.elements.some((element) => {
        const local = element.propertyName ?? element.name
        return (
          !element.isTypeOnly &&
          ts.isIdentifier(local) &&
          expressionExposesLoaderCapability(local, context)
        )
      })
    }
    return false
  })()
  if (exportedLoader) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      'module-loader wrappers cannot escape the closed local provenance grammar',
    )
  }
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    callableExposesLoaderCapability(node, context)
  ) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      'method and accessor storage of module-loader wrappers is outside the closed grammar',
    )
  }
  const directReflectLoaderArgument = (
    call: ts.CallExpression,
    argument: ts.Expression,
  ): boolean => {
    const callee = unwrap(call.expression)
    return (
      call.arguments[0] === argument &&
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      staticMemberName(callee) === 'apply' &&
      loaderKinds(callee.expression, context).has('reflect-object') &&
      isRequireLoader(argument, context)
    )
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.some(
      (argument) =>
        expressionExposesLoaderCapability(argument, context) &&
        !directReflectLoaderArgument(node, argument),
    )
  ) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      'module-loader capabilities cannot be passed to arbitrary helpers',
    )
  }
  if (
    ts.isNewExpression(node) &&
    node.arguments?.some((argument) =>
      expressionExposesLoaderCapability(argument, context),
    )
  ) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      'module-loader capabilities cannot be passed to constructors',
    )
  }
  const loaderConstructor = ts.isNewExpression(node)
    ? resolvedLocalCallable(node.expression, context)
    : undefined
  if (
    loaderConstructor &&
    callableExposesLoaderCapability(loaderConstructor.callable, context)
  ) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      'loader-forwarding callables cannot be invoked as constructors',
    )
  }
  if (
    ((ts.isYieldExpression(node) && node.expression) ||
      (ts.isThrowStatement(node) && node.expression) ||
      (ts.isJsxExpression(node) && node.expression)) &&
    expressionExposesLoaderCapability(node.expression, context)
  ) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      'module-loader capabilities cannot escape through yield, throw, or JSX',
    )
  }
  if (
    ts.isImportDeclaration(node) &&
    runtimeImport(node) &&
    ts.isStringLiteralLike(node.moduleSpecifier) &&
    (moduleBuiltin(node.moduleSpecifier.text) ||
      (pgCoreModule(node.moduleSpecifier.text) &&
        !isSchemaFile(context.file) &&
        !approvedPgDialectImport(node)))
  ) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      moduleBuiltin(node.moduleSpecifier.text)
        ? 'runtime Node module-loader acquisition is outside the accepted schema provenance grammar'
        : 'runtime pg-core acquisition is allowed only in catalogued table files and the exact preflight PgDialect seam',
    )
  }
  if (
    ts.isExportDeclaration(node) &&
    runtimeExport(node) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier) &&
    (moduleBuiltin(node.moduleSpecifier.text) ||
      (pgCoreModule(node.moduleSpecifier.text) && !isSchemaFile(context.file)))
  ) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      moduleBuiltin(node.moduleSpecifier.text)
        ? 'runtime Node module-loader export is outside the accepted schema provenance grammar'
        : 'pg-core cannot be re-exported outside the closed schema catalog',
    )
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    !node.isTypeOnly &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteralLike(node.moduleReference.expression) &&
    (isSchemaSpecifier(node.moduleReference.expression.text, context.file) ||
      moduleBuiltin(node.moduleReference.expression.text) ||
      pgCoreModule(node.moduleReference.expression.text))
  ) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      moduleBuiltin(node.moduleReference.expression.text)
        ? 'runtime Node module-loader acquisition is outside the accepted schema provenance grammar'
        : pgCoreModule(node.moduleReference.expression.text)
          ? 'runtime pg-core acquisition is outside the closed schema catalog'
          : 'schema modules require a static ESM import in the accepted provenance grammar',
    )
  }
  if (!ts.isCallExpression(node)) return
  const providers = schemaModuleLoadProviders(node, context)
  const builtinProvider = (() => {
    const callee = unwrap(node.expression)
    if (
      (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) ||
      !loaderKinds(callee, context).has('builtin-module-factory')
    ) {
      return []
    }
    return node.arguments[0] ? [node.arguments[0]] : []
  })()
  const modules = [...providers, ...builtinProvider].flatMap(
    (provider) => staticModuleSpecifiers(provider, context) ?? [],
  )
  if (modules.some(moduleBuiltin)) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      'runtime Node module-loader acquisition is outside the accepted schema provenance grammar',
    )
  }
  if (modules.some(pgCoreModule)) {
    fail(
      context,
      node,
      'unresolved-schema-load',
      'runtime pg-core acquisition is outside the closed schema catalog',
    )
  }
  if (!modules.some((module) => isSchemaSpecifier(module, context.file))) return
  fail(
    context,
    node,
    'unresolved-schema-load',
    'CommonJS, dynamic, and forwarded schema module loads are not accepted',
  )
}

function staticMemberName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
    ? expression.argumentExpression.text
    : undefined
}

function tableAlternatives(
  expression: ts.Expression,
  context: FlowContext,
  seen = new Set<Binding>(),
): readonly string[] {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) {
    const binding = bindingFor(value, context)
    if (!binding || seen.has(binding)) return []
    if (binding.schemaTable) return [binding.schemaTable]
    if (
      binding.importedFrom &&
      binding.importedName &&
      binding.importedName !== '*' &&
      !binding.namespace &&
      isSchemaSpecifier(binding.importedFrom, context.file)
    ) {
      fail(
        context,
        value,
        'unresolved-table-member',
        `schema import ${JSON.stringify(binding.importedName)} is absent from the closed table catalog`,
      )
    }
    if (binding.kind !== 'const' || !binding.initializer) return []
    return tableAlternatives(binding.initializer, context, new Set(seen).add(binding))
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const member = staticMemberName(value)
    if (member === 'table') {
      const owners = columnOwnerAlternatives(value.expression, context, new Set(seen))
      if (owners.length > 0) return owners
    }
    if (ts.isIdentifier(value.expression)) {
      const binding = bindingFor(value.expression, context)
      if (binding?.namespace && context.namespaceBindings.has(binding)) {
        if (!member)
          fail(
            context,
            value,
            'unresolved-namespace-member',
            'schema namespace member must be static',
          )
        const table = context.bindingToSql.get(member)
        if (table) return [table]
        fail(
          context,
          value,
          'unresolved-namespace-member',
          `schema namespace member ${JSON.stringify(member)} is absent from the closed table catalog`,
        )
      }
    }
  }
  if (ts.isConditionalExpression(value)) {
    return unique([
      ...tableAlternatives(value.whenTrue, context, seen),
      ...tableAlternatives(value.whenFalse, context, seen),
    ])
  }
  if (
    ts.isBinaryExpression(value) &&
    compactAlternativeTokens.has(value.operatorToken.kind)
  ) {
    return unique([
      ...tableAlternatives(value.left, context, seen),
      ...tableAlternatives(value.right, context, seen),
    ])
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return tableAlternatives(value.right, context, seen)
  }
  return []
}

function columnOwnerAlternatives(
  expression: ts.Expression,
  context: FlowContext,
  seen = new Set<Binding>(),
): readonly string[] {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) {
    const binding = bindingFor(value, context)
    if (
      !binding ||
      seen.has(binding) ||
      binding.kind !== 'const' ||
      !binding.initializer ||
      context.mutatedBindings.has(binding)
    ) {
      return []
    }
    return columnOwnerAlternatives(
      binding.initializer,
      context,
      new Set(seen).add(binding),
    )
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const member = staticMemberName(value)
    if (!member || member === 'table') return []
    return tableAlternatives(value.expression, context, seen)
  }
  if (ts.isConditionalExpression(value)) {
    return unique([
      ...columnOwnerAlternatives(value.whenTrue, context, seen),
      ...columnOwnerAlternatives(value.whenFalse, context, seen),
    ])
  }
  if (
    ts.isBinaryExpression(value) &&
    compactAlternativeTokens.has(value.operatorToken.kind)
  ) {
    return unique([
      ...columnOwnerAlternatives(value.left, context, seen),
      ...columnOwnerAlternatives(value.right, context, seen),
    ])
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return columnOwnerAlternatives(value.right, context, seen)
  }
  return []
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort()
}

function containsTableEvidence(node: ts.Node, context: FlowContext): boolean {
  if (ts.isExpression(node) && tableAlternatives(node, context).length > 0) {
    return true
  }
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    tableAlternatives(node.expression, context).length > 0
  ) {
    // A table column is not the table capability itself. Treat the column access
    // as a leaf so ordinary eq(table.id, value) predicates remain in grammar.
    return false
  }
  if (ts.isPropertyAccessExpression(node)) {
    // The property token is not an identifier reference (`scope.verification`
    // must not bind to an imported table named `verification`).
    return containsTableEvidence(node.expression, context)
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      containsTableEvidence(node.expression, context) ||
      (!!node.argumentExpression &&
        containsTableEvidence(node.argumentExpression, context))
    )
  }
  // Calls, SQL templates, and callable/class bodies produce values; a table used
  // inside them is visited and classified at its own AST site, but is not table
  // capability storage by the enclosing argument or object.
  if (
    ts.isCallExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isFunctionLike(node) ||
    ts.isClassLike(node)
  ) {
    return false
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return containsTableEvidence(property.name, context)
      }
      if (ts.isPropertyAssignment(property)) {
        return containsTableEvidence(property.initializer, context)
      }
      if (ts.isSpreadAssignment(property)) {
        return containsTableEvidence(property.expression, context)
      }
      return false
    })
  }
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsTableEvidence(child, context)) found = true
  })
  return found
}

function containsCapabilityEvidence(node: ts.Node, context: FlowContext): boolean {
  if (
    ts.isExpression(node) &&
    (tableAlternatives(node, context).length > 0 ||
      columnOwnerAlternatives(node, context).length > 0)
  ) {
    return true
  }
  if (
    ts.isCallExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isFunctionLike(node) ||
    ts.isClassLike(node)
  ) {
    return false
  }
  if (ts.isPropertyAccessExpression(node)) {
    return containsCapabilityEvidence(node.expression, context)
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      containsCapabilityEvidence(node.expression, context) ||
      (!!node.argumentExpression &&
        containsCapabilityEvidence(node.argumentExpression, context))
    )
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return containsCapabilityEvidence(property.name, context)
      }
      if (ts.isPropertyAssignment(property)) {
        return containsCapabilityEvidence(property.initializer, context)
      }
      if (ts.isSpreadAssignment(property)) {
        return containsCapabilityEvidence(property.expression, context)
      }
      return false
    })
  }
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsCapabilityEvidence(child, context)) found = true
  })
  return found
}

function mutationTargetInterpolation(
  template: ts.TemplateExpression,
  spanIndex: number,
  context: FlowContext,
): boolean {
  let staticPrefix = template.head.text
  for (const span of template.templateSpans.slice(0, spanIndex)) {
    const value = unwrap(span.expression)
    const rawText = (() => {
      if (!ts.isCallExpression(value) || value.arguments.length !== 1) return undefined
      const callee = unwrap(value.expression)
      if (
        (!ts.isPropertyAccessExpression(callee) &&
          !ts.isElementAccessExpression(callee)) ||
        staticMemberName(callee) !== 'raw' ||
        !approvedSqlTag(callee.expression, context)
      ) {
        return undefined
      }
      const alternatives = staticModuleSpecifiers(value.arguments[0], context)
      return alternatives?.length === 1 ? alternatives[0] : undefined
    })()
    staticPrefix += `${rawText ?? ' '} ${span.literal.text}`
  }
  const executablePrefix = executableSqlText(staticPrefix)
  return /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|COPY)\s+(?:ONLY\s+)?(?:(?:"[A-Za-z_][A-Za-z0-9_$]*"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?$/i.test(
    executablePrefix,
  )
}

function fail(
  context: Pick<FlowContext, 'file' | 'sourceFile'>,
  node: ts.Node,
  code: LocalFlowDiagnosticCode,
  detail: string,
): never {
  const { line } = context.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(context.sourceFile),
  )
  throw new SchemaLocalFlowError(code, context.file, line + 1, detail)
}

function directMethod(call: ts.CallExpression):
  | Readonly<{
      method: string
      receiver: ts.Expression
    }>
  | undefined {
  const callee = unwrap(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return undefined
  return { method: callee.name.text, receiver: callee.expression }
}

function compactType(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replaceAll(/\s+/g, '')
}

function importsBindingFrom(
  identifier: ts.Identifier,
  context: FlowContext,
  module: string,
  importedName: string,
): boolean {
  const binding = bindingFor(identifier, context)
  return (
    binding?.kind === 'import' &&
    binding.importedFrom === module &&
    binding.importedName === importedName
  )
}

function approvedSqlTag(tag: ts.Expression, context: FlowContext): boolean {
  const value = unwrap(tag)
  return (
    ts.isIdentifier(value) && importsBindingFrom(value, context, 'drizzle-orm', 'sql')
  )
}

function approvedDatabaseType(
  node: ts.TypeNode,
  context: FlowContext,
  seen = new Set<string>(),
): boolean {
  if (ts.isParenthesizedTypeNode(node)) {
    return approvedDatabaseType(node.type, context, seen)
  }
  if (ts.isUnionTypeNode(node)) {
    return (
      node.types.length > 0 &&
      node.types.every((type) => approvedDatabaseType(type, context, seen))
    )
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text
    if (name === 'NodePgDatabase') {
      return importsBindingFrom(
        node.typeName,
        context,
        'drizzle-orm/node-postgres',
        'NodePgDatabase',
      )
    }
    if (name === 'Database' || name === 'DatabaseTransaction') {
      if (importsBindingFrom(node.typeName, context, '@/platform/db/client', name)) {
        return true
      }
    }
    if (name === 'Pick' && node.typeArguments?.[0]) {
      return approvedDatabaseType(node.typeArguments[0], context, seen)
    }
    if (!seen.has(name)) {
      const aliases = context.sourceFile.statements.filter(
        (statement): statement is ts.TypeAliasDeclaration =>
          ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
      )
      if (aliases.length === 1 && aliases[0]) {
        return approvedDatabaseType(aliases[0].type, context, new Set(seen).add(name))
      }
    }
  }
  const text = compactType(node, context.sourceFile)
  if (text === "Parameters<Parameters<ReturnType<typeofgetDb>['transaction']>[0]>[0]") {
    let verifiedGetDb = false
    const visit = (child: ts.Node): void => {
      if (
        ts.isIdentifier(child) &&
        child.text === 'getDb' &&
        importsBindingFrom(child, context, '@/platform/db/client', 'getDb')
      ) {
        verifiedGetDb = true
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
    return verifiedGetDb
  }
  return false
}

function trustedDatabaseReceiver(
  expression: ts.Expression,
  context: FlowContext,
  seen = new Set<Binding>(),
): boolean {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) {
    const binding = bindingFor(value, context)
    if (!binding || seen.has(binding)) return false
    const nextSeen = new Set(seen).add(binding)
    if (binding.kind === 'const' && binding.initializer) {
      return trustedDatabaseReceiver(binding.initializer, context, nextSeen)
    }
    if (binding.kind !== 'parameter') return false
    const parameter = binding.declaration.parent
    if (!ts.isParameter(parameter)) return false
    if (parameter.type && approvedDatabaseType(parameter.type, context)) {
      return true
    }
    const callback = parameter.parent
    const call = callback.parent
    if (
      ts.isFunctionLike(callback) &&
      ts.isCallExpression(call) &&
      call.arguments.includes(callback as ts.Expression)
    ) {
      const method = directMethod(call)
      return (
        method?.method === 'transaction' &&
        trustedDatabaseReceiver(method.receiver, context, nextSeen)
      )
    }
    return false
  }
  if (ts.isCallExpression(value)) {
    const callee = unwrap(value.expression)
    if (!ts.isIdentifier(callee)) return false
    const binding = bindingFor(callee, context)
    return (
      binding?.kind === 'import' &&
      binding.importedFrom === '@/platform/db/client' &&
      binding.importedName === 'getDb'
    )
  }
  return false
}

function writeRooted(expression: ts.Expression, context: FlowContext): boolean {
  let value = unwrap(expression)
  while (ts.isCallExpression(value)) {
    const method = directMethod(value)
    if (!method) return false
    if (writeMethods.has(method.method as WriteOp)) {
      return trustedDatabaseReceiver(method.receiver, context)
    }
    value = unwrap(method.receiver)
  }
  return false
}

function selectRooted(expression: ts.Expression, context: FlowContext): boolean {
  let value = unwrap(expression)
  while (true) {
    if (ts.isCallExpression(value)) {
      const method = directMethod(value)
      if (method?.method === 'select') {
        return trustedDatabaseReceiver(method.receiver, context)
      }
      if (!method) return false
      value = unwrap(method.receiver)
      continue
    }
    if (ts.isPropertyAccessExpression(value)) {
      value = unwrap(value.expression)
      continue
    }
    return false
  }
}

function constInitializer(
  identifier: ts.Identifier,
  context: FlowContext,
): ts.Expression | undefined {
  const binding = bindingFor(identifier, context)
  return binding?.kind === 'const' ? binding.initializer : undefined
}

function immutableValue(
  expression: ts.Expression,
  context: FlowContext,
  seen = new Set<Binding>(),
): ts.Expression {
  const value = unwrap(expression)
  if (!ts.isIdentifier(value)) return value
  const binding = bindingFor(value, context)
  if (
    !binding ||
    seen.has(binding) ||
    binding.kind !== 'const' ||
    !binding.initializer ||
    context.mutatedBindings.has(binding)
  ) {
    return value
  }
  return immutableValue(binding.initializer, context, new Set(seen).add(binding))
}

function globalCollectionDelete(receiver: ts.Expression, context: FlowContext): boolean {
  const value = immutableValue(receiver, context)
  if (!ts.isNewExpression(value) || !ts.isIdentifier(value.expression)) return false
  return (
    ['Headers', 'Map', 'Set'].includes(value.expression.text) &&
    bindingRecordsFor(value.expression, context) === undefined &&
    !context.mutatedGlobalCollections.has(value.expression.text)
  )
}

function importedCryptoUpdate(receiver: ts.Expression, context: FlowContext): boolean {
  const value = immutableValue(receiver, context)
  if (!ts.isCallExpression(value)) return false
  const callee = unwrap(value.expression)
  if (!ts.isIdentifier(callee)) return false
  const binding = bindingFor(callee, context)
  return !!binding && context.cryptoFactories.has(binding)
}

function importedTableColumns(call: ts.CallExpression, context: FlowContext): boolean {
  const callee = unwrap(call.expression)
  if (!ts.isIdentifier(callee)) return false
  const binding = bindingFor(callee, context)
  return !!binding && context.getTableColumns.has(binding)
}

function insertRoot(expression: ts.Expression): ts.CallExpression | undefined {
  let value = unwrap(expression)
  while (ts.isCallExpression(value)) {
    const method = directMethod(value)
    if (!method) return undefined
    if (method.method === 'insert') return value
    value = unwrap(method.receiver)
  }
  return undefined
}

function methodCapabilityEscape(call: ts.CallExpression, context: FlowContext): boolean {
  const callee = unwrap(call.expression)
  if (ts.isElementAccessExpression(callee)) return true
  if (ts.isIdentifier(callee)) {
    const binding = bindingFor(callee, context)
    const bindingElement = binding?.declaration.parent
    if (bindingElement && ts.isBindingElement(bindingElement)) {
      const property = bindingElement.propertyName ?? bindingElement.name
      if (
        (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) &&
        writeMethods.has(property.text as WriteOp)
      ) {
        return true
      }
    }
    const initializer = constInitializer(callee, context)
    if (!initializer) return false
    const value = unwrap(initializer)
    if (ts.isPropertyAccessExpression(value)) {
      return writeMethods.has(value.name.text as WriteOp)
    }
    if (ts.isCallExpression(value)) {
      const method = directMethod(value)
      return method?.method === 'bind'
    }
    return false
  }
  if (ts.isCallExpression(callee)) {
    const factory = directMethod(callee)
    if (factory && ['apply', 'bind', 'call'].includes(factory.method)) return true
  }
  const method = directMethod(call)
  if (method && ['apply', 'bind', 'call'].includes(method.method)) return true
  return (
    method?.method === 'apply' &&
    ts.isIdentifier(unwrap(method.receiver)) &&
    (unwrap(method.receiver) as ts.Identifier).text === 'Reflect'
  )
}

function write(
  sourceFile: ts.SourceFile,
  file: string,
  principal: string,
  node: ts.Node,
  table: string,
  op: WriteOp,
): ObservedWrite {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    evidence: 'executable',
    file,
    kind: 'drizzle',
    line: line + 1,
    op,
    principal,
    table,
  }
}

function approvedIdentityAuthSchemaObject(
  node: ts.ObjectLiteralExpression,
  context: FlowContext,
): boolean {
  if (
    context.file.replaceAll('\\', '/') !==
    'src/modules/identity/infrastructure/identity-auth-config.ts'
  ) {
    return false
  }
  const call = node.parent
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    call.arguments[0] !== node ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== 'freeze' ||
    !ts.isIdentifier(call.expression.expression) ||
    call.expression.expression.text !== 'Object' ||
    bindingFor(call.expression.expression, context) !== undefined
  ) {
    return false
  }
  const declaration = call.parent
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== 'identityAuthDatabaseSchema' ||
    declaration.initializer !== call ||
    declarationKind(declaration) !== 'const'
  ) {
    return false
  }
  const statement = declaration.parent.parent
  if (
    !ts.isVariableStatement(statement) ||
    statement.declarationList.declarations.length !== 1 ||
    !modifiersInclude(statement, ts.SyntaxKind.ExportKeyword)
  ) {
    return false
  }
  const expected = ['account', 'session', 'user', 'verification']
  const observed = node.properties.flatMap((property) => {
    if (!ts.isShorthandPropertyAssignment(property)) return []
    const tables = tableAlternatives(property.name, context)
    return tables.length === 1 &&
      tables[0] === context.bindingToSql.get(property.name.text)
      ? [property.name.text]
      : []
  })
  return (
    node.properties.length === expected.length &&
    observed.length === expected.length &&
    observed.sort().every((name, index) => name === expected[index])
  )
}

function approvedSelectLockObject(
  node: ts.ObjectLiteralExpression,
  context: FlowContext,
): boolean {
  const call = node.parent
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length !== 2 ||
    call.arguments[1] !== node
  ) {
    return false
  }
  const method = directMethod(call)
  if (
    method?.method !== 'for' ||
    !selectRooted(method.receiver, context) ||
    !ts.isStringLiteralLike(call.arguments[0]) ||
    !['key share', 'no key update', 'share', 'update'].includes(call.arguments[0].text) ||
    node.properties.length !== 1
  ) {
    return false
  }
  const property = node.properties[0]
  return (
    !!property &&
    ts.isPropertyAssignment(property) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
    property.name.text === 'of' &&
    tableAlternatives(property.initializer, context).length > 0
  )
}

function approvedProjectionObject(
  node: ts.ObjectLiteralExpression,
  context: FlowContext,
): boolean {
  const call = node.parent
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    call.arguments[0] !== node ||
    !['returning', 'select'].includes(directMethod(call)?.method ?? '')
  ) {
    return false
  }
  if (directMethod(call)?.method === 'select' && !selectRooted(call, context)) {
    return false
  }
  if (
    directMethod(call)?.method === 'returning' &&
    !writeRooted((directMethod(call) as { receiver: ts.Expression }).receiver, context)
  ) {
    return false
  }
  let capabilityValues = 0
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const value = unwrap(property.expression)
      if (
        !ts.isCallExpression(value) ||
        !importedTableColumns(value, context) ||
        !value.arguments[0] ||
        tableAlternatives(value.arguments[0], context).length === 0
      ) {
        return false
      }
      capabilityValues += 1
      continue
    }
    const value = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : ts.isPropertyAssignment(property)
        ? property.initializer
        : undefined
    if (!value) return false
    if (
      tableAlternatives(value, context).length > 0 ||
      columnOwnerAlternatives(value, context).length > 0
    ) {
      capabilityValues += 1
    } else if (containsCapabilityEvidence(value, context)) {
      return false
    }
  }
  return capabilityValues > 0
}

function approvedConflictObject(
  node: ts.ObjectLiteralExpression,
  context: FlowContext,
): boolean {
  const call = node.parent
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    call.arguments[0] !== node ||
    !['onConflictDoNothing', 'onConflictDoUpdate'].includes(
      directMethod(call)?.method ?? '',
    )
  ) {
    return false
  }
  const target = node.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
      property.name.text === 'target',
  )
  return (
    !!target &&
    columnOwnerAlternatives(target.initializer, context).length > 0 &&
    tableAlternatives(target.initializer, context).length === 0 &&
    node.properties.every((property) => {
      if (property === target) return true
      return (
        ts.isPropertyAssignment(property) &&
        !containsCapabilityEvidence(property.initializer, context)
      )
    })
  )
}

function validateStorage(node: ts.Node, context: FlowContext): void {
  if (
    ts.isBindingElement(node) &&
    node.initializer &&
    containsCapabilityEvidence(node.initializer, context)
  ) {
    fail(
      context,
      node,
      'destructured-table-storage',
      'schema capabilities cannot flow through binding defaults',
    )
  }
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const tables = tableAlternatives(node.initializer, context)
    const columnOwners = columnOwnerAlternatives(node.initializer, context)
    if (tables.length > 0) {
      if (!ts.isIdentifier(node.name)) {
        fail(
          context,
          node,
          'destructured-table-storage',
          'schema tables cannot be destructured',
        )
      }
      if (declarationKind(node) !== 'const') {
        fail(
          context,
          node,
          'mutable-table-storage',
          'schema table aliases must be immutable const bindings',
        )
      }
    } else if (columnOwners.length > 0) {
      if (!ts.isIdentifier(node.name)) {
        fail(
          context,
          node,
          'destructured-table-storage',
          'schema columns cannot be destructured',
        )
      }
      if (declarationKind(node) !== 'const') {
        fail(
          context,
          node,
          'mutable-table-storage',
          'schema column aliases must be immutable const bindings',
        )
      }
    } else if (containsCapabilityEvidence(node.initializer, context)) {
      const statement = node.parent.parent
      if (
        ts.isVariableStatement(statement) &&
        modifiersInclude(statement, ts.SyntaxKind.ExportKeyword)
      ) {
        return
      }
      fail(
        context,
        node,
        'object-or-array-table-storage',
        'schema tables cannot be stored in containers',
      )
    }
  }
  if (
    ts.isBinaryExpression(node) &&
    isAssignmentOperator(node.operatorToken.kind) &&
    containsCapabilityEvidence(node.right, context)
  ) {
    fail(
      context,
      node,
      ts.isIdentifier(unwrap(node.left))
        ? 'mutable-table-storage'
        : 'object-or-array-table-storage',
      'schema table evidence cannot flow through assignment',
    )
  }
  if (
    ts.isPropertyDeclaration(node) &&
    node.initializer &&
    containsCapabilityEvidence(node.initializer, context)
  ) {
    fail(
      context,
      node,
      'object-or-array-table-storage',
      'schema tables cannot be stored on classes',
    )
  }
  if (
    ts.isParameter(node) &&
    node.initializer &&
    containsCapabilityEvidence(node.initializer, context)
  ) {
    fail(
      context,
      node,
      'helper-table-argument',
      'schema tables cannot flow through parameter defaults',
    )
  }
  if (
    (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) &&
    containsCapabilityEvidence(node, context)
  ) {
    if (
      ts.isObjectLiteralExpression(node) &&
      (approvedIdentityAuthSchemaObject(node, context) ||
        approvedSelectLockObject(node, context) ||
        approvedProjectionObject(node, context) ||
        approvedConflictObject(node, context))
    ) {
      return
    }
    const declaration = node.parent
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== node) {
      fail(
        context,
        node,
        'object-or-array-table-storage',
        'schema tables cannot be stored in containers',
      )
    }
  }
  if (
    ts.isReturnStatement(node) &&
    node.expression &&
    containsCapabilityEvidence(node.expression, context)
  ) {
    fail(context, node, 'helper-table-return', 'helpers cannot return schema tables')
  }
  if (
    ts.isArrowFunction(node) &&
    ts.isExpression(node.body) &&
    containsCapabilityEvidence(node.body, context)
  ) {
    fail(context, node, 'helper-table-return', 'helpers cannot return schema tables')
  }
  if (
    ts.isYieldExpression(node) &&
    node.expression &&
    containsCapabilityEvidence(node.expression, context)
  ) {
    fail(context, node, 'helper-table-return', 'helpers cannot yield schema tables')
  }
  if (
    ts.isThrowStatement(node) &&
    node.expression &&
    containsCapabilityEvidence(node.expression, context)
  ) {
    fail(context, node, 'helper-table-return', 'helpers cannot throw schema tables')
  }
  if (
    ts.isNewExpression(node) &&
    node.arguments?.some((argument) => containsCapabilityEvidence(argument, context))
  ) {
    fail(
      context,
      node,
      'helper-table-argument',
      'schema tables cannot be passed to constructors',
    )
  }
  if (
    ts.isJsxExpression(node) &&
    node.expression &&
    containsCapabilityEvidence(node.expression, context)
  ) {
    fail(
      context,
      node,
      'helper-table-argument',
      'schema capabilities cannot be passed through JSX',
    )
  }
  if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
    const spans = node.template.templateSpans
    const interpolatesMutationTarget = node.template.templateSpans.some((span, index) => {
      const value = unwrap(span.expression)
      const recoveredTable =
        (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
        staticMemberName(value) === 'table'
      const tables = tableAlternatives(span.expression, context)
      if (tables.length === 0 && !recoveredTable) return false
      return mutationTargetInterpolation(
        node.template as ts.TemplateExpression,
        index,
        context,
      )
    })
    if (interpolatesMutationTarget) {
      fail(
        context,
        node,
        'raw-table-interpolation',
        'schema tables cannot be interpolated into raw SQL',
      )
    }
    if (
      !approvedSqlTag(node.tag, context) &&
      spans.some((span) => containsCapabilityEvidence(span.expression, context))
    ) {
      fail(
        context,
        node,
        'helper-table-argument',
        'schema capabilities cannot cross arbitrary tagged-template helper seams',
      )
    }
  }
}

function validateLocalExport(node: ts.Node, context: FlowContext): void {
  if (isSchemaFile(context.file)) return
  if (
    ts.isVariableStatement(node) &&
    modifiersInclude(node, ts.SyntaxKind.ExportKeyword)
  ) {
    for (const declaration of node.declarationList.declarations) {
      if (
        declaration.initializer &&
        containsCapabilityEvidence(declaration.initializer, context)
      ) {
        fail(
          context,
          declaration,
          'exported-schema-table',
          'schema tables cannot be exported outside the schema owner',
        )
      }
    }
  }
  if (
    ts.isExportAssignment(node) &&
    containsCapabilityEvidence(node.expression, context)
  ) {
    fail(
      context,
      node,
      'exported-schema-table',
      'schema tables cannot be exported outside the schema owner',
    )
  }
  if (ts.isExportDeclaration(node)) {
    if (
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isSchemaSpecifier(node.moduleSpecifier.text, context.file) &&
      !node.isTypeOnly
    ) {
      const clause = node.exportClause
      const leaksTable =
        !clause ||
        ts.isNamespaceExport(clause) ||
        clause.elements.some(
          (element) =>
            !element.isTypeOnly &&
            context.bindingToSql.has((element.propertyName ?? element.name).text),
        )
      if (leaksTable) {
        fail(
          context,
          node,
          'exported-schema-table',
          'schema table re-exports are not allowed outside the schema owner',
        )
      }
    }
    if (
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        const local = element.propertyName ?? element.name
        if (
          ts.isIdentifier(local) &&
          (tableAlternatives(local, context).length > 0 ||
            columnOwnerAlternatives(local, context).length > 0)
        ) {
          fail(
            context,
            element,
            'exported-schema-table',
            'schema table aliases cannot be exported',
          )
        }
        const binding = ts.isIdentifier(local) ? bindingFor(local, context) : undefined
        if (binding?.namespace) {
          fail(
            context,
            element,
            'exported-schema-table',
            'schema namespaces cannot be exported',
          )
        }
      }
    }
  }
}

/**
 * Compact, deliberately closed local-flow grammar for Drizzle table values.
 * Unsupported storage/capability flows throw instead of being interpreted.
 */
export function detectLocalDrizzleWrites(
  sourceFile: ts.SourceFile,
  file: string,
  principal: string,
  bindingToSql: ReadonlyMap<string, string>,
): readonly ObservedWrite[] {
  const scopes = buildScopes(sourceFile, file, bindingToSql)
  const context: FlowContext = { bindingToSql, file, sourceFile, ...scopes }
  const writes: ObservedWrite[] = []

  const visit = (node: ts.Node): void => {
    if (!isSchemaFile(file)) validateStorage(node, context)
    validateLocalExport(node, context)
    validateSchemaModuleLoad(node, context)

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isSchemaSpecifier(node.moduleSpecifier.text, context.file) &&
      node.importClause?.name
    ) {
      fail(
        context,
        node.importClause.name,
        'unresolved-namespace-member',
        'default schema imports are outside the accepted provenance grammar',
      )
    }

    if (ts.isIdentifier(node)) {
      const binding = bindingFor(node, context)
      if (binding?.namespace && context.namespaceBindings.has(binding)) {
        const parent = node.parent
        const importName = ts.isNamespaceImport(parent) && parent.name === node
        const staticNamespaceObject =
          (ts.isPropertyAccessExpression(parent) ||
            ts.isElementAccessExpression(parent)) &&
          parent.expression === node &&
          staticMemberName(parent) !== undefined
        const localExport =
          ts.isExportSpecifier(parent) &&
          (parent.propertyName === node || parent.name === node)
        const runtimeSchemaRegistration = isApprovedRuntimeSchemaRegistration(
          node,
          binding,
          context,
        )
        if (
          !importName &&
          !staticNamespaceObject &&
          !localExport &&
          !isTypeOnlyPosition(node) &&
          !runtimeSchemaRegistration
        ) {
          fail(
            context,
            node,
            'unresolved-namespace-member',
            'schema namespaces may only be used through static members',
          )
        }
      }
    }

    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = bindingFor(node.expression, context)
      if (
        binding?.namespace &&
        context.namespaceBindings.has(binding) &&
        !staticMemberName(node)
      ) {
        fail(
          context,
          node,
          'unresolved-namespace-member',
          'schema namespace member must be static',
        )
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      !staticMemberName(node) &&
      (tableAlternatives(node.expression, context).length > 0 ||
        columnOwnerAlternatives(node.expression, context).length > 0)
    ) {
      fail(
        context,
        node,
        'unresolved-table-member',
        'table and column capabilities require static member access',
      )
    }

    if (ts.isCallExpression(node)) {
      const method = directMethod(node)
      const argumentTables = node.arguments.map((argument) =>
        tableAlternatives(argument, context),
      )
      const nestedTableArgument = node.arguments.some((argument) =>
        containsTableEvidence(argument, context),
      )
      const targetTables = argumentTables[0] ?? []
      const target = node.arguments[0] ? unwrap(node.arguments[0]) : undefined
      const unresolvedRecoveredTable =
        !!target &&
        (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
        staticMemberName(target) === 'table' &&
        targetTables.length === 0
      const knownCollectionDelete =
        method?.method === 'delete' && globalCollectionDelete(method.receiver, context)
      const knownCryptoUpdate =
        method?.method === 'update' && importedCryptoUpdate(method.receiver, context)
      const approvedAuthSchema = node.arguments.some(
        (argument) =>
          ts.isObjectLiteralExpression(unwrap(argument)) &&
          approvedIdentityAuthSchemaObject(
            unwrap(argument) as ts.ObjectLiteralExpression,
            context,
          ),
      )
      const approvedSelectLock = node.arguments.some(
        (argument) =>
          ts.isObjectLiteralExpression(unwrap(argument)) &&
          approvedSelectLockObject(
            unwrap(argument) as ts.ObjectLiteralExpression,
            context,
          ),
      )
      const approvedProjection = node.arguments.some(
        (argument) =>
          ts.isObjectLiteralExpression(unwrap(argument)) &&
          approvedProjectionObject(
            unwrap(argument) as ts.ObjectLiteralExpression,
            context,
          ),
      )

      if (
        method &&
        writeMethods.has(method.method as WriteOp) &&
        unresolvedRecoveredTable &&
        target
      ) {
        fail(
          context,
          target,
          'unresolved-table-member',
          'a recovered table capability could not be attributed',
        )
      }

      if (
        method &&
        writeMethods.has(method.method as WriteOp) &&
        targetTables.length > 0 &&
        !knownCollectionDelete &&
        !knownCryptoUpdate
      ) {
        for (const table of targetTables) {
          writes.push(
            write(sourceFile, file, principal, node, table, method.method as WriteOp),
          )
        }
      } else if (method?.method === 'onConflictDoUpdate') {
        const root = insertRoot(method.receiver)
        const insertTarget = root?.arguments[0]
        const tables = insertTarget ? tableAlternatives(insertTarget, context) : []
        if (tables.length === 0 && nestedTableArgument) {
          fail(
            context,
            node,
            'helper-table-argument',
            'cannot recover the insert target for conflict update',
          )
        }
        for (const table of tables) {
          writes.push(write(sourceFile, file, principal, node, table, 'update'))
        }
      } else {
        const approvedRead =
          !!method &&
          readRelationMethods.has(method.method) &&
          selectRooted(method.receiver, context)
        const approvedColumns = importedTableColumns(node, context)
        if (
          nestedTableArgument &&
          !approvedRead &&
          !approvedColumns &&
          !knownCollectionDelete &&
          !knownCryptoUpdate &&
          !approvedAuthSchema &&
          !approvedSelectLock &&
          !approvedProjection
        ) {
          if (methodCapabilityEscape(node, context)) {
            const callee = unwrap(node.expression)
            fail(
              context,
              node,
              ts.isElementAccessExpression(callee)
                ? 'unresolved-computed-method'
                : 'method-capability-escape',
              'schema table passed through a non-direct method capability',
            )
          }
          const storedContainer = node.arguments.find((argument) => {
            const value = unwrap(argument)
            return (
              (ts.isArrayLiteralExpression(value) ||
                ts.isObjectLiteralExpression(value)) &&
              containsTableEvidence(value, context)
            )
          })
          if (storedContainer) {
            fail(
              context,
              storedContainer,
              'object-or-array-table-storage',
              'schema tables cannot be stored in containers',
            )
          }
          fail(
            context,
            node,
            'helper-table-argument',
            'schema tables cannot be passed to helpers',
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return writes
}
