import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { buildSchemaTableMap, SchemaCatalogError } from './schema-ownership/catalog'
import {
  detectLocalDrizzleWrites,
  SchemaLocalFlowError,
} from './schema-ownership/local-flow'
import {
  detectRawSqlWrites,
  executableSqlText,
  SqlScanError,
} from './schema-ownership/sql'

/**
 * Public facade for the schema write-authority fence (spec §5.3).
 *
 * The implementation is deliberately split by proof boundary:
 * - catalog.ts pins the complete pgTable declaration grammar;
 * - local-flow.ts accepts a small immutable Drizzle table-flow grammar and
 *   rejects storage/capability escapes;
 * - sql.ts tokenizes PostgreSQL text and accepts only direct static providers.
 *
 * Unsupported static shapes fail closed. Truly runtime-built table names,
 * trigger bodies, FK cascades, and database-role enforcement remain the
 * explicit static-scanner residuals in spec §5.3(11).
 */

export type WriteOp = 'insert' | 'update' | 'delete'
export type WriteKind = 'drizzle' | 'raw'
export type WriteEvidence = 'executable' | 'potential'

export type ObservedWrite = Readonly<{
  /** Executable evidence reaches a recognized write sink; potential evidence remains O2-conservative. */
  readonly evidence: WriteEvidence
  readonly principal: string
  readonly table: string
  readonly op: WriteOp
  readonly kind: WriteKind
  readonly file: string
  readonly line: number
}>

export {
  buildSchemaTableMap,
  executableSqlText,
  SchemaCatalogError,
  SchemaLocalFlowError,
  SqlScanError,
}

const projectRoot = process.cwd()
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/

export function projectPath(absolutePath: string): string {
  return relative(projectRoot, absolutePath).split(sep).join('/')
}

function filesMatching(directory: string, pattern: RegExp): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = resolve(directory, entry)
      return statSync(path).isDirectory()
        ? filesMatching(path, pattern)
        : pattern.test(path)
          ? [path]
          : []
    })
    .sort()
}

function createSourceFile(file: string, source: string): ts.SourceFile {
  const extension = file.toLowerCase()
  const scriptKind = extension.endsWith('.jsx')
    ? ts.ScriptKind.JSX
    : /\.(?:cjs|mjs|js)$/.test(extension)
      ? ts.ScriptKind.JS
      : extension.endsWith('x')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
}

/** Absolute paths of non-test JavaScript/TypeScript files under a directory. */
export function listSourceFiles(dir: string): string[] {
  return filesMatching(dir, SOURCE_FILE).filter((file) => !TEST_FILE.test(file))
}

/** True when source statically obtains Better Auth's Drizzle adapter module. */
export function configuresDrizzleAdapter(
  content: string,
  file = 'adapter-probe.ts',
): boolean {
  const sourceFile = createSourceFile(file, content)
  const isDrizzleAdapterModule = (value: string): boolean =>
    /^better-auth\/adapters\/drizzle(?:\/|$)/.test(value)

  type BindingKind =
    | 'class'
    | 'const'
    | 'function'
    | 'import'
    | 'import-equals'
    | 'let'
    | 'parameter'
    | 'var'
  type BindingSource = {
    readonly defaultOnly?: boolean
    readonly expression: ts.Expression
    readonly path: readonly string[]
  }
  type Binding = {
    readonly declaration: ts.Node
    readonly importedFrom?: string
    readonly importedName?: string
    readonly kind: BindingKind
    readonly name: string
    readonly sources: BindingSource[]
    readonly typeOnly: boolean
  }
  type Scope = {
    readonly bindings: Map<string, Binding[]>
    readonly functionScope: boolean
    readonly parent: Scope | null
  }
  type LocalFunction = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression
  type StaticArgument = ts.Expression | undefined
  type CallableCandidate = {
    readonly boundArguments: readonly StaticArgument[]
    readonly functionNode: LocalFunction
  }
  type LocalInvocation = {
    readonly arguments: readonly StaticArgument[]
    readonly functionNode: LocalFunction
  }
  type LoaderKind =
    | 'builtin-module-factory'
    | 'create-require-factory'
    | 'global-object'
    | 'module-object'
    | 'process-object'
    | 'reflect-object'
    | 'require-loader'

  const MAX_FACADE_ALTERNATIVES = 32
  const MAX_HELPER_DEPTH = 8

  const root: Scope = {
    bindings: new Map(),
    functionScope: true,
    parent: null,
  }
  const scopeForNode = new WeakMap<ts.Node, Scope>()
  const remember = (scope: Scope, binding: Binding): void => {
    const bindings = scope.bindings.get(binding.name) ?? []
    bindings.push(binding)
    scope.bindings.set(binding.name, bindings)
  }
  const childScope = (parent: Scope, functionScope: boolean): Scope => ({
    bindings: new Map(),
    functionScope,
    parent,
  })
  const nearestFunctionScope = (scope: Scope): Scope => {
    let current: Scope | null = scope
    while (current && !current.functionScope) current = current.parent
    return current ?? root
  }
  const declarationKind = (node: ts.VariableDeclaration): BindingKind => {
    const list = node.parent
    if (!ts.isVariableDeclarationList(list)) return 'var'
    if ((list.flags & ts.NodeFlags.Const) !== 0) return 'const'
    if ((list.flags & ts.NodeFlags.Let) !== 0) return 'let'
    return 'var'
  }
  const propertyName = (node: ts.PropertyName | undefined): string | undefined => {
    if (!node) return undefined
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text
    if (ts.isNumericLiteral(node)) return node.text
    if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) {
      return node.expression.text
    }
    return undefined
  }
  const isErasedDeclaration = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node
    while (current && current !== sourceFile) {
      if (
        ts.canHaveModifiers(current) &&
        ts
          .getModifiers(current)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      ) {
        return true
      }
      current = current.parent
    }
    return false
  }
  const bindingIdentifiers = (name: ts.BindingName): ts.Identifier[] => {
    if (ts.isIdentifier(name)) return [name]
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
    )
  }
  const registerPattern = (
    name: ts.BindingName,
    scope: Scope,
    kind: BindingKind,
    source: BindingSource | undefined,
    typeOnly = false,
  ): void => {
    if (ts.isIdentifier(name)) {
      remember(scope, {
        declaration: name,
        kind,
        name: name.text,
        sources: source ? [source] : [],
        typeOnly,
      })
      return
    }
    name.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return
      const member = ts.isArrayBindingPattern(name)
        ? index.toString()
        : (propertyName(element.propertyName) ??
          (ts.isIdentifier(element.name) ? element.name.text : undefined))
      const projected =
        source && member !== undefined
          ? {
              defaultOnly: source.defaultOnly,
              expression: source.expression,
              path: [...source.path, member],
            }
          : undefined
      registerPattern(element.name, scope, kind, projected, typeOnly)
      if (element.initializer) {
        const bindings = bindingIdentifiers(element.name)
        for (const identifier of bindings) {
          const records = scope.bindings.get(identifier.text) ?? []
          for (const record of records) {
            if (record.declaration === identifier) {
              record.sources.push({
                defaultOnly: kind === 'parameter',
                expression: element.initializer,
                path: [],
              })
            }
          }
        }
      }
    })
  }
  const registerImport = (node: ts.ImportDeclaration, scope: Scope): void => {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return
    const importedFrom = node.moduleSpecifier.text
    const clause = node.importClause
    if (!clause) return
    if (clause.name) {
      remember(scope, {
        declaration: clause.name,
        importedFrom,
        importedName: 'default',
        kind: 'import',
        name: clause.name.text,
        sources: [],
        typeOnly: clause.isTypeOnly,
      })
    }
    const named = clause.namedBindings
    if (!named) return
    if (ts.isNamespaceImport(named)) {
      remember(scope, {
        declaration: named.name,
        importedFrom,
        importedName: '*',
        kind: 'import',
        name: named.name.text,
        sources: [],
        typeOnly: clause.isTypeOnly,
      })
      return
    }
    for (const element of named.elements) {
      remember(scope, {
        declaration: element.name,
        importedFrom,
        importedName: (element.propertyName ?? element.name).text,
        kind: 'import',
        name: element.name.text,
        sources: [],
        typeOnly: clause.isTypeOnly || element.isTypeOnly,
      })
    }
  }
  const buildScopes = (node: ts.Node, parentScope: Scope): void => {
    if (ts.isFunctionDeclaration(node) && node.name && !isErasedDeclaration(node)) {
      remember(parentScope, {
        declaration: node.name,
        kind: 'function',
        name: node.name.text,
        sources: [],
        typeOnly: false,
      })
    } else if (ts.isClassDeclaration(node) && node.name && !isErasedDeclaration(node)) {
      remember(parentScope, {
        declaration: node.name,
        kind: 'class',
        name: node.name.text,
        sources: [],
        typeOnly: false,
      })
    }

    let scope = parentScope
    if (ts.isFunctionLike(node)) {
      scope = childScope(parentScope, true)
      if (ts.isFunctionExpression(node) && node.name) {
        remember(scope, {
          declaration: node.name,
          kind: 'function',
          name: node.name.text,
          sources: [],
          typeOnly: false,
        })
      }
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      scope = childScope(parentScope, false)
      if (ts.isClassExpression(node) && node.name) {
        remember(scope, {
          declaration: node.name,
          kind: 'class',
          name: node.name.text,
          sources: [],
          typeOnly: false,
        })
      }
    } else if (ts.isModuleBlock(node)) {
      // A namespace/module body is both a lexical boundary and the hoist target
      // for its own `var` declarations. Hoisting those declarations to the file
      // scope invents loader/path provenance outside the namespace.
      scope = childScope(parentScope, true)
    } else if (
      ts.isBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node)
    ) {
      scope = childScope(parentScope, false)
    }
    scopeForNode.set(node, scope)

    if (ts.isImportDeclaration(node)) {
      registerImport(node, scope)
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference
      remember(scope, {
        declaration: node.name,
        importedFrom:
          ts.isExternalModuleReference(reference) &&
          reference.expression &&
          ts.isStringLiteralLike(reference.expression)
            ? reference.expression.text
            : undefined,
        importedName: '*',
        kind: 'import-equals',
        name: node.name.text,
        sources: [],
        typeOnly: node.isTypeOnly,
      })
    } else if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        registerPattern(
          parameter.name,
          scope,
          'parameter',
          parameter.initializer
            ? {
                defaultOnly: true,
                expression: parameter.initializer,
                path: [],
              }
            : undefined,
        )
      }
    } else if (ts.isVariableDeclaration(node) && !isErasedDeclaration(node)) {
      const kind = declarationKind(node)
      const target = kind === 'var' ? nearestFunctionScope(scope) : scope
      registerPattern(
        node.name,
        target,
        kind,
        node.initializer ? { expression: node.initializer, path: [] } : undefined,
      )
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      registerPattern(node.variableDeclaration.name, scope, 'let', undefined)
    }

    ts.forEachChild(node, (child) => buildScopes(child, scope))
  }
  scopeForNode.set(sourceFile, root)
  ts.forEachChild(sourceFile, (child) => buildScopes(child, root))

  const bindingsFor = (identifier: ts.Identifier): readonly Binding[] | undefined => {
    let scope: Scope | null = scopeForNode.get(identifier) ?? root
    while (scope) {
      const bindings = scope.bindings.get(identifier.text)
      if (bindings) return bindings
      scope = scope.parent
    }
    return undefined
  }
  const propertySourcesByBinding = new WeakMap<Binding, Map<string, BindingSource[]>>()
  const addPropertyAssignmentSource = (
    target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    expression: ts.Expression,
    path: readonly string[],
  ): void => {
    const member = propertyName(
      ts.isPropertyAccessExpression(target)
        ? target.name
        : target.argumentExpression &&
            (ts.isStringLiteralLike(target.argumentExpression) ||
              ts.isNumericLiteral(target.argumentExpression))
          ? target.argumentExpression
          : undefined,
    )
    if (!member) return
    let base: ts.Expression = target.expression
    while (
      ts.isParenthesizedExpression(base) ||
      ts.isAsExpression(base) ||
      ts.isTypeAssertionExpression(base) ||
      ts.isNonNullExpression(base) ||
      ts.isSatisfiesExpression(base)
    ) {
      base = base.expression
    }
    if (!ts.isIdentifier(base)) return
    for (const binding of bindingsFor(base) ?? []) {
      let properties = propertySourcesByBinding.get(binding)
      if (!properties) {
        properties = new Map()
        propertySourcesByBinding.set(binding, properties)
      }
      const sources = properties.get(member) ?? []
      if (
        !sources.some(
          (source) =>
            source.expression === expression &&
            source.path.length === path.length &&
            source.path.every((item, index) => item === path[index]),
        )
      ) {
        sources.push({ expression, path })
        properties.set(member, sources)
      }
    }
  }
  const addAssignmentSource = (
    identifier: ts.Identifier,
    expression: ts.Expression,
    path: readonly string[] = [],
  ): boolean => {
    let changed = false
    for (const binding of bindingsFor(identifier) ?? []) {
      if (
        !binding.sources.some(
          (source) =>
            source.expression === expression &&
            source.path.length === path.length &&
            source.path.every((member, index) => member === path[index]),
        )
      ) {
        binding.sources.push({ expression, path })
        changed = true
      }
    }
    return changed
  }
  const addAssignmentPatternSource = (
    target: ts.Expression,
    expression: ts.Expression,
    path: readonly string[] = [],
  ): void => {
    if (ts.isParenthesizedExpression(target)) {
      addAssignmentPatternSource(target.expression, expression, path)
      return
    }
    if (ts.isIdentifier(target)) {
      addAssignmentSource(target, expression, path)
      return
    }
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      addPropertyAssignmentSource(target, expression, path)
      return
    }
    if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      addAssignmentPatternSource(target.left, expression, path)
      addAssignmentPatternSource(target.left, target.right)
      return
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          addAssignmentSource(property.name, expression, [...path, property.name.text])
        } else if (ts.isPropertyAssignment(property)) {
          const member = propertyName(property.name)
          if (member !== undefined) {
            addAssignmentPatternSource(property.initializer, expression, [
              ...path,
              member,
            ])
          }
        }
      }
      return
    }
    if (ts.isArrayLiteralExpression(target)) {
      target.elements.forEach((element, index) => {
        if (!ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) {
          addAssignmentPatternSource(element, expression, [...path, index.toString()])
        }
      })
    }
  }
  const collectAssignments = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      addAssignmentPatternSource(node.left, node.right)
    }
    ts.forEachChild(node, collectAssignments)
  }
  collectAssignments(sourceFile)

  const unwrap = (expression: ts.Expression): ts.Expression => {
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
  const memberName = (
    expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): string | undefined =>
    ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : expression.argumentExpression &&
          (ts.isStringLiteralLike(expression.argumentExpression) ||
            ts.isNumericLiteral(expression.argumentExpression))
        ? expression.argumentExpression.text
        : undefined
  const isModuleBuiltin = (value: string): boolean =>
    value === 'module' || value === 'node:module'
  const isUnbound = (identifier: ts.Identifier): boolean =>
    bindingsFor(identifier) === undefined
  const isAmbientGlobalObject = (expression: ts.Expression): boolean => {
    const value = unwrap(expression)
    return (
      ts.isIdentifier(value) &&
      (value.text === 'global' || value.text === 'globalThis') &&
      isUnbound(value)
    )
  }
  const isAmbientProcess = (expression: ts.Expression): boolean => {
    const value = unwrap(expression)
    if (ts.isIdentifier(value)) {
      return value.text === 'process' && isUnbound(value)
    }
    return (
      (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
      isAmbientGlobalObject(value.expression) &&
      memberName(value) === 'process'
    )
  }
  const isAmbientReflect = (expression: ts.Expression): boolean => {
    const value = unwrap(expression)
    if (ts.isIdentifier(value)) {
      return value.text === 'Reflect' && isUnbound(value)
    }
    return (
      (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
      isAmbientGlobalObject(value.expression) &&
      memberName(value) === 'Reflect'
    )
  }

  const union = <T>(...values: readonly (readonly T[] | undefined)[]): T[] => [
    ...new Set(values.flatMap((value) => value ?? [])),
  ]
  type LocalClass = ts.ClassDeclaration | ts.ClassExpression
  const hasStaticModifier = (node: ts.Node): boolean =>
    !!(
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
    )
  function localClassCandidates(
    expression: ts.Expression,
    seenBindings: ReadonlySet<Binding> = new Set(),
    depth = 0,
  ): readonly LocalClass[] {
    if (depth > MAX_HELPER_DEPTH) return []
    const value = unwrap(expression)
    if (ts.isClassExpression(value)) return [value]
    if (ts.isIdentifier(value)) {
      const bindings = bindingsFor(value)
      if (!bindings) return []
      return bindings
        .flatMap((binding) => {
          if (seenBindings.has(binding)) return []
          const seen = new Set(seenBindings).add(binding)
          const declared = binding.declaration.parent
          const direct = ts.isClassDeclaration(declared) ? [declared] : []
          const sourced = binding.sources.flatMap((source) =>
            source.path.length === 0
              ? localClassCandidates(source.expression, seen, depth + 1)
              : [],
          )
          return [...direct, ...sourced]
        })
        .slice(0, MAX_FACADE_ALTERNATIVES)
    }
    if (ts.isConditionalExpression(value)) {
      return [
        ...localClassCandidates(value.whenTrue, seenBindings, depth + 1),
        ...localClassCandidates(value.whenFalse, seenBindings, depth + 1),
      ].slice(0, MAX_FACADE_ALTERNATIVES)
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return [
        ...localClassCandidates(value.left, seenBindings, depth + 1),
        ...localClassCandidates(value.right, seenBindings, depth + 1),
      ].slice(0, MAX_FACADE_ALTERNATIVES)
    }
    return []
  }
  const classPropertyInitializers = (
    classNode: LocalClass,
    member: string,
    staticMember: boolean,
  ): readonly ts.Expression[] =>
    classNode.members.flatMap((element) =>
      ts.isPropertyDeclaration(element) &&
      element.initializer &&
      propertyName(element.name) === member &&
      hasStaticModifier(element) === staticMember
        ? [element.initializer]
        : [],
    )
  const projectedExpressions = (
    expression: ts.Expression,
    path: readonly string[],
    seenBindings: ReadonlySet<Binding>,
  ): readonly ts.Expression[] => {
    const value = unwrap(expression)
    if (path.length === 0) return [value]
    const [head, ...tail] = path
    if (ts.isIdentifier(value)) {
      const bindings = bindingsFor(value)
      if (!bindings) return []
      return bindings.flatMap((binding) => {
        if (seenBindings.has(binding)) return []
        const seen = new Set(seenBindings).add(binding)
        const assigned = (propertySourcesByBinding.get(binding)?.get(head) ?? []).flatMap(
          (source) =>
            projectedExpressions(source.expression, [...source.path, ...tail], seen),
        )
        const declared = binding.declaration.parent
        const classProperties = ts.isClassDeclaration(declared)
          ? classPropertyInitializers(declared, head, true).flatMap((initializer) =>
              projectedExpressions(initializer, tail, seen),
            )
          : []
        const sourced = binding.sources.flatMap((source) =>
          projectedExpressions(source.expression, [...source.path, ...path], seen),
        )
        return [...assigned, ...classProperties, ...sourced]
      })
    }
    if (ts.isObjectLiteralExpression(value)) {
      return value.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property) && propertyName(property.name) === head) {
          return projectedExpressions(property.initializer, tail, seenBindings)
        }
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === head) {
          return projectedExpressions(property.name, tail, seenBindings)
        }
        return []
      })
    }
    if (ts.isArrayLiteralExpression(value)) {
      const index = Number(head)
      const element = Number.isSafeInteger(index) ? value.elements[index] : undefined
      return element && !ts.isOmittedExpression(element) && !ts.isSpreadElement(element)
        ? projectedExpressions(element, tail, seenBindings)
        : []
    }
    if (ts.isNewExpression(value)) {
      return localClassCandidates(value.expression, seenBindings).flatMap((classNode) =>
        classPropertyInitializers(classNode, head, false).flatMap((initializer) =>
          projectedExpressions(initializer, tail, seenBindings),
        ),
      )
    }
    if (ts.isClassExpression(value)) {
      return classPropertyInitializers(value, head, true).flatMap((initializer) =>
        projectedExpressions(initializer, tail, seenBindings),
      )
    }
    if (ts.isConditionalExpression(value)) {
      return [
        ...projectedExpressions(value.whenTrue, path, seenBindings),
        ...projectedExpressions(value.whenFalse, path, seenBindings),
      ]
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return [
        ...projectedExpressions(value.left, path, seenBindings),
        ...projectedExpressions(value.right, path, seenBindings),
      ]
    }
    return []
  }
  const activeStaticExpressions = new Set<ts.Expression>()
  const staticStrings = (
    expression: ts.Expression,
    seenBindings: ReadonlySet<Binding> = new Set(),
    helperDepth = 0,
  ): readonly string[] | undefined => {
    const value = unwrap(expression)
    if (activeStaticExpressions.has(value)) return undefined
    activeStaticExpressions.add(value)
    try {
      if (ts.isStringLiteralLike(value)) return [value.text]
      if (ts.isIdentifier(value)) {
        const bindings = bindingsFor(value)
        if (!bindings) return undefined
        const alternatives = bindings.flatMap((binding) => {
          if (seenBindings.has(binding)) return []
          const seen = new Set(seenBindings).add(binding)
          return binding.sources.flatMap((source) =>
            projectedExpressions(source.expression, source.path, seen).flatMap(
              (projected) => staticStrings(projected, seen, helperDepth) ?? [],
            ),
          )
        })
        return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
      }
      if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
        const member = memberName(value)
        if (!member) return undefined
        const alternatives = projectedExpressions(
          value.expression,
          [member],
          seenBindings,
        ).flatMap(
          (projected) => staticStrings(projected, seenBindings, helperDepth) ?? [],
        )
        return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
      }
      if (ts.isCallExpression(value) && helperDepth < MAX_HELPER_DEPTH) {
        const alternatives = evaluateCallReturns(
          value,
          helperDepth,
          (returned) => staticStrings(returned, seenBindings, helperDepth + 1) ?? [],
        )
        return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
      }
      if (ts.isConditionalExpression(value)) {
        const whenTrue = staticStrings(value.whenTrue, seenBindings, helperDepth)
        const whenFalse = staticStrings(value.whenFalse, seenBindings, helperDepth)
        const alternatives = [...(whenTrue ?? []), ...(whenFalse ?? [])]
        return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
      }
      if (
        ts.isBinaryExpression(value) &&
        value.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        const left = staticStrings(value.left, seenBindings, helperDepth)
        const right = staticStrings(value.right, seenBindings, helperDepth)
        return left && right
          ? left.flatMap((prefix) => right.map((suffix) => prefix + suffix))
          : undefined
      }
      if (
        ts.isBinaryExpression(value) &&
        (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ) {
        const left = staticStrings(value.left, seenBindings, helperDepth)
        const right = staticStrings(value.right, seenBindings, helperDepth)
        const alternatives = [...(left ?? []), ...(right ?? [])]
        return alternatives.length > 0 ? [...new Set(alternatives)] : undefined
      }
      if (
        ts.isBinaryExpression(value) &&
        value.operatorToken.kind === ts.SyntaxKind.CommaToken
      ) {
        return staticStrings(value.right, seenBindings, helperDepth)
      }
      if (ts.isTemplateExpression(value)) {
        let alternatives: readonly string[] = [value.head.text]
        for (const span of value.templateSpans) {
          const substitution = staticStrings(span.expression, seenBindings, helperDepth)
          if (!substitution) return undefined
          alternatives = alternatives.flatMap((prefix) =>
            substitution.map((item) => prefix + item + span.literal.text),
          )
        }
        return alternatives
      }
      return undefined
    } finally {
      activeStaticExpressions.delete(value)
    }
  }

  const memberKinds = (
    kinds: ReadonlySet<LoaderKind>,
    member: string,
  ): ReadonlySet<LoaderKind> => {
    const result = new Set<LoaderKind>()
    if (kinds.has('global-object')) {
      if (member === 'require') result.add('require-loader')
      if (member === 'module') result.add('module-object')
      if (member === 'process') result.add('process-object')
      if (member === 'Reflect') result.add('reflect-object')
    }
    if (kinds.has('module-object')) {
      if (member === 'createRequire') result.add('create-require-factory')
      if (member === '_load' || member === 'require') result.add('require-loader')
      if (member === 'default' || member === 'Module') result.add('module-object')
    }
    if (kinds.has('process-object') && member === 'getBuiltinModule') {
      result.add('builtin-module-factory')
    }
    return result
  }
  const activeValueExpressions = new Set<ts.Expression>()
  const valueKinds = (
    expression: ts.Expression,
    seenBindings: ReadonlySet<Binding> = new Set(),
    helperDepth = 0,
  ): ReadonlySet<LoaderKind> => {
    const value = unwrap(expression)
    if (activeValueExpressions.has(value)) return new Set()
    activeValueExpressions.add(value)
    try {
      if (ts.isIdentifier(value)) {
        const bindings = bindingsFor(value)
        if (!bindings) {
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
        for (const binding of bindings) {
          if (seenBindings.has(binding)) continue
          const seen = new Set(seenBindings).add(binding)
          if (
            !binding.typeOnly &&
            binding.importedFrom &&
            isModuleBuiltin(binding.importedFrom)
          ) {
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
          for (const source of binding.sources) {
            const projected = projectedExpressions(source.expression, source.path, seen)
            if (projected.length > 0) {
              for (const expression of projected) {
                for (const kind of valueKinds(expression, seen, helperDepth)) {
                  result.add(kind)
                }
              }
              continue
            }
            let kinds = valueKinds(source.expression, seen, helperDepth)
            for (const member of source.path) kinds = memberKinds(kinds, member)
            for (const kind of kinds) result.add(kind)
          }
        }
        return result
      }
      if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
        const member = memberName(value)
        if (!member) return new Set()
        const result = new Set<LoaderKind>()
        for (const projected of projectedExpressions(
          value.expression,
          [member],
          seenBindings,
        )) {
          for (const kind of valueKinds(projected, seenBindings, helperDepth)) {
            result.add(kind)
          }
        }
        for (const kind of memberKinds(
          valueKinds(value.expression, seenBindings, helperDepth),
          member,
        )) {
          result.add(kind)
        }
        return result
      }
      if (ts.isCallExpression(value)) {
        const result = new Set<LoaderKind>()
        if (helperDepth < MAX_HELPER_DEPTH) {
          for (const kind of evaluateCallReturns(value, helperDepth, (returned) => [
            ...valueKinds(returned, seenBindings, helperDepth + 1),
          ])) {
            result.add(kind)
          }
        }
        if (isBuiltinModuleAcquisition(value, seenBindings)) {
          result.add('module-object')
        }
        if (
          valueKinds(value.expression, seenBindings, helperDepth).has(
            'create-require-factory',
          )
        ) {
          result.add('require-loader')
        }
        const callee = value.expression
        if (
          (ts.isPropertyAccessExpression(callee) ||
            ts.isElementAccessExpression(callee)) &&
          memberName(callee) === 'bind' &&
          valueKinds(callee.expression, seenBindings, helperDepth).has('require-loader')
        ) {
          result.add('require-loader')
        }
        if (
          (ts.isPropertyAccessExpression(callee) ||
            ts.isElementAccessExpression(callee)) &&
          memberName(callee) === 'bind' &&
          valueKinds(callee.expression, seenBindings, helperDepth).has(
            'create-require-factory',
          )
        ) {
          result.add('create-require-factory')
        }
        if (
          (ts.isPropertyAccessExpression(callee) ||
            ts.isElementAccessExpression(callee)) &&
          (memberName(callee) === 'call' || memberName(callee) === 'apply') &&
          valueKinds(callee.expression, seenBindings, helperDepth).has(
            'create-require-factory',
          )
        ) {
          result.add('require-loader')
        }
        if (
          (ts.isPropertyAccessExpression(callee) ||
            ts.isElementAccessExpression(callee)) &&
          memberName(callee) === 'apply' &&
          valueKinds(callee.expression, seenBindings).has('reflect-object') &&
          value.arguments[0] &&
          valueKinds(value.arguments[0], seenBindings, helperDepth).has(
            'create-require-factory',
          )
        ) {
          result.add('require-loader')
        }
        return result
      }
      if (ts.isConditionalExpression(value)) {
        return new Set(
          union(
            [...valueKinds(value.whenTrue, seenBindings, helperDepth)],
            [...valueKinds(value.whenFalse, seenBindings, helperDepth)],
          ),
        )
      }
      if (
        ts.isBinaryExpression(value) &&
        (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ) {
        return new Set(
          union(
            [...valueKinds(value.left, seenBindings, helperDepth)],
            [...valueKinds(value.right, seenBindings, helperDepth)],
          ),
        )
      }
      if (
        ts.isBinaryExpression(value) &&
        value.operatorToken.kind === ts.SyntaxKind.CommaToken
      ) {
        return valueKinds(value.right, seenBindings, helperDepth)
      }
      return new Set()
    } finally {
      activeValueExpressions.delete(value)
    }
  }
  const isBuiltinModuleAcquisition = (
    call: ts.CallExpression,
    seenBindings: ReadonlySet<Binding>,
  ): boolean => {
    const specifiers = call.arguments[0] ? (staticStrings(call.arguments[0]) ?? []) : []
    if (!specifiers.some(isModuleBuiltin)) return false
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return true
    if (valueKinds(call.expression, seenBindings).has('require-loader')) return true
    if (valueKinds(call.expression, seenBindings).has('builtin-module-factory')) {
      return true
    }
    const callee = call.expression
    return (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      memberName(callee) === 'getBuiltinModule' &&
      isAmbientProcess(callee.expression)
    )
  }
  const bounded = <T>(values: readonly T[]): readonly T[] =>
    values.slice(0, MAX_FACADE_ALTERNATIVES)

  function expandStaticArguments(
    elements: readonly ts.Expression[],
    seenBindings: ReadonlySet<Binding> = new Set(),
    helperDepth = 0,
  ): readonly (readonly StaticArgument[])[] {
    let alternatives: readonly (readonly StaticArgument[])[] = [[]]
    for (const element of elements) {
      let additions: readonly (readonly StaticArgument[])[]
      if (ts.isOmittedExpression(element)) {
        additions = [[undefined]]
      } else if (ts.isSpreadElement(element)) {
        additions = staticArgumentLists(element.expression, seenBindings, helperDepth)
      } else {
        additions = [[element]]
      }
      if (additions.length === 0) return []
      alternatives = bounded(
        alternatives.flatMap((prefix) =>
          additions.map((addition) => [...prefix, ...addition]),
        ),
      )
    }
    return alternatives
  }

  function staticArgumentLists(
    expression: ts.Expression | undefined,
    seenBindings: ReadonlySet<Binding> = new Set(),
    helperDepth = 0,
  ): readonly (readonly StaticArgument[])[] {
    if (!expression || helperDepth > MAX_HELPER_DEPTH) return []
    const value = unwrap(expression)
    if (ts.isArrayLiteralExpression(value)) {
      return expandStaticArguments(value.elements, seenBindings, helperDepth)
    }
    if (ts.isIdentifier(value)) {
      const bindings = bindingsFor(value)
      if (!bindings) return []
      return bounded(
        bindings.flatMap((binding) => {
          if (seenBindings.has(binding)) return []
          const seen = new Set(seenBindings).add(binding)
          return binding.sources.flatMap((source) =>
            projectedExpressions(source.expression, source.path, seen).flatMap(
              (projected) => staticArgumentLists(projected, seen, helperDepth),
            ),
          )
        }),
      )
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const member = memberName(value)
      if (!member) return []
      return bounded(
        projectedExpressions(value.expression, [member], seenBindings).flatMap(
          (projected) => staticArgumentLists(projected, seenBindings, helperDepth),
        ),
      )
    }
    if (ts.isCallExpression(value)) {
      return bounded(
        evaluateCallReturns(value, helperDepth, (returned) =>
          staticArgumentLists(returned, seenBindings, helperDepth + 1),
        ),
      )
    }
    if (ts.isConditionalExpression(value)) {
      return bounded([
        ...staticArgumentLists(value.whenTrue, seenBindings, helperDepth),
        ...staticArgumentLists(value.whenFalse, seenBindings, helperDepth),
      ])
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return bounded([
        ...staticArgumentLists(value.left, seenBindings, helperDepth),
        ...staticArgumentLists(value.right, seenBindings, helperDepth),
      ])
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return staticArgumentLists(value.right, seenBindings, helperDepth)
    }
    return []
  }

  const localReturnCache = new WeakMap<LocalFunction, readonly ts.Expression[]>()
  function localReturnExpressions(functionNode: LocalFunction): readonly ts.Expression[] {
    const cached = localReturnCache.get(functionNode)
    if (cached) return cached
    if (ts.isArrowFunction(functionNode) && !ts.isBlock(functionNode.body)) {
      const returned = [functionNode.body]
      localReturnCache.set(functionNode, returned)
      return returned
    }
    const body = functionNode.body
    if (!body) return []
    const returned: ts.Expression[] = []
    const visitReturns = (node: ts.Node): void => {
      if (node !== body && ts.isFunctionLike(node)) return
      if (ts.isReturnStatement(node)) {
        if (node.expression) returned.push(node.expression)
        return
      }
      ts.forEachChild(node, visitReturns)
    }
    visitReturns(body)
    const result = bounded(returned)
    localReturnCache.set(functionNode, result)
    return result
  }

  function callableCandidates(
    expression: ts.Expression,
    seenBindings: ReadonlySet<Binding> = new Set(),
    helperDepth = 0,
  ): readonly CallableCandidate[] {
    if (helperDepth > MAX_HELPER_DEPTH) return []
    const value = unwrap(expression)
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      return [{ boundArguments: [], functionNode: value }]
    }
    if (ts.isIdentifier(value)) {
      const bindings = bindingsFor(value)
      if (!bindings) return []
      return bounded(
        bindings.flatMap((binding) => {
          if (seenBindings.has(binding)) return []
          const seen = new Set(seenBindings).add(binding)
          const declared = binding.declaration.parent
          const direct = ts.isFunctionDeclaration(declared)
            ? [{ boundArguments: [], functionNode: declared }]
            : []
          const sourced = binding.sources.flatMap((source) =>
            projectedExpressions(source.expression, source.path, seen).flatMap(
              (projected) => callableCandidates(projected, seen, helperDepth + 1),
            ),
          )
          return [...direct, ...sourced]
        }),
      )
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const member = memberName(value)
      if (!member) return []
      return bounded(
        projectedExpressions(value.expression, [member], seenBindings).flatMap(
          (projected) => callableCandidates(projected, seenBindings, helperDepth + 1),
        ),
      )
    }
    if (ts.isCallExpression(value)) {
      const callee = value.expression
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        memberName(callee) === 'bind'
      ) {
        const boundLists = expandStaticArguments(
          value.arguments.slice(1),
          seenBindings,
          helperDepth,
        )
        return bounded(
          callableCandidates(callee.expression, seenBindings, helperDepth + 1).flatMap(
            (candidate) =>
              boundLists.map((boundArguments) => ({
                boundArguments: [...candidate.boundArguments, ...boundArguments],
                functionNode: candidate.functionNode,
              })),
          ),
        )
      }
      return bounded(
        evaluateCallReturns(value, helperDepth, (returned) =>
          callableCandidates(returned, seenBindings, helperDepth + 1),
        ),
      )
    }
    if (ts.isConditionalExpression(value)) {
      return bounded([
        ...callableCandidates(value.whenTrue, seenBindings, helperDepth + 1),
        ...callableCandidates(value.whenFalse, seenBindings, helperDepth + 1),
      ])
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return bounded([
        ...callableCandidates(value.left, seenBindings, helperDepth + 1),
        ...callableCandidates(value.right, seenBindings, helperDepth + 1),
      ])
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return callableCandidates(value.right, seenBindings, helperDepth + 1)
    }
    return []
  }

  function invocationCandidates(
    call: ts.CallExpression,
    helperDepth = 0,
  ): readonly LocalInvocation[] {
    if (helperDepth > MAX_HELPER_DEPTH) return []
    const callee = call.expression
    let target: ts.Expression = callee
    let argumentLists: readonly (readonly StaticArgument[])[]
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      memberName(callee) === 'apply' &&
      (isAmbientReflect(callee.expression) ||
        valueKinds(callee.expression).has('reflect-object')) &&
      call.arguments[0]
    ) {
      target = call.arguments[0]
      argumentLists = staticArgumentLists(call.arguments[2], new Set(), helperDepth)
    } else if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      memberName(callee) === 'call'
    ) {
      target = callee.expression
      argumentLists = expandStaticArguments(
        call.arguments.slice(1),
        new Set(),
        helperDepth,
      )
    } else if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      memberName(callee) === 'apply'
    ) {
      target = callee.expression
      argumentLists = staticArgumentLists(call.arguments[1], new Set(), helperDepth)
    } else {
      argumentLists = expandStaticArguments(call.arguments, new Set(), helperDepth)
    }
    return bounded(
      callableCandidates(target, new Set(), helperDepth + 1).flatMap((candidate) =>
        argumentLists.map((arguments_) => ({
          arguments: [...candidate.boundArguments, ...arguments_],
          functionNode: candidate.functionNode,
        })),
      ),
    )
  }

  const parameterBindingSources = (
    name: ts.BindingName,
    argument: ts.Expression,
    path: readonly string[] = [],
  ): readonly {
    readonly binding: Binding
    readonly source: BindingSource
  }[] => {
    if (ts.isIdentifier(name)) {
      return (bindingsFor(name) ?? [])
        .filter((binding) => binding.declaration === name)
        .map((binding) => ({
          binding,
          source: { expression: argument, path },
        }))
    }
    return name.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element)) return []
      const member = ts.isArrayBindingPattern(name)
        ? index.toString()
        : (propertyName(element.propertyName) ??
          (ts.isIdentifier(element.name) ? element.name.text : undefined))
      return member === undefined
        ? []
        : parameterBindingSources(element.name, argument, [...path, member])
    })
  }

  function withInvocationSources<T>(
    invocation: LocalInvocation,
    task: () => readonly T[],
  ): readonly T[] {
    const snapshots = new Map<Binding, readonly BindingSource[]>()
    invocation.functionNode.parameters.forEach((parameter, index) => {
      const argument = invocation.arguments[index]
      if (!argument) return
      const value = unwrap(argument)
      if (
        ts.isVoidExpression(value) ||
        (ts.isIdentifier(value) && value.text === 'undefined' && isUnbound(value))
      ) {
        return
      }
      for (const entry of parameterBindingSources(parameter.name, argument)) {
        if (!snapshots.has(entry.binding)) {
          snapshots.set(entry.binding, [...entry.binding.sources])
        }
        if (projectedExpressions(argument, entry.source.path, new Set()).length > 0) {
          const retained = entry.binding.sources.filter((source) => !source.defaultOnly)
          entry.binding.sources.splice(0, entry.binding.sources.length, ...retained)
        }
        entry.binding.sources.push(entry.source)
      }
    })
    try {
      return task()
    } finally {
      for (const [binding, sources] of snapshots) {
        binding.sources.splice(0, binding.sources.length, ...sources)
      }
    }
  }

  function withHelperDefaultsSuppressed(
    functionNode: ts.FunctionLikeDeclaration,
    task: () => void,
  ): void {
    let owner: ts.Node | undefined = functionNode
    while (owner && owner !== sourceFile) {
      if (
        ts.canHaveModifiers(owner) &&
        ts
          .getModifiers(owner)
          ?.some(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.ExportKeyword ||
              modifier.kind === ts.SyntaxKind.DefaultKeyword,
          )
      ) {
        task()
        return
      }
      owner = owner.parent
    }
    const snapshots = new Map<Binding, readonly BindingSource[]>()
    for (const parameter of functionNode.parameters) {
      for (const identifier of bindingIdentifiers(parameter.name)) {
        for (const binding of bindingsFor(identifier) ?? []) {
          if (binding.declaration !== identifier || snapshots.has(binding)) continue
          snapshots.set(binding, [...binding.sources])
          const retained = binding.sources.filter((source) => !source.defaultOnly)
          binding.sources.splice(0, binding.sources.length, ...retained)
        }
      }
    }
    try {
      task()
    } finally {
      for (const [binding, sources] of snapshots) {
        binding.sources.splice(0, binding.sources.length, ...sources)
      }
    }
  }

  function evaluateCallReturns<T>(
    call: ts.CallExpression,
    helperDepth: number,
    evaluate: (returned: ts.Expression) => readonly T[],
  ): readonly T[] {
    if (helperDepth > MAX_HELPER_DEPTH) return []
    return bounded(
      invocationCandidates(call, helperDepth).flatMap((invocation) =>
        withInvocationSources(invocation, () =>
          localReturnExpressions(invocation.functionNode).flatMap(evaluate),
        ),
      ),
    )
  }

  function preboundLoaderArgumentLists(
    expression: ts.Expression,
    seenBindings: ReadonlySet<Binding> = new Set(),
    helperDepth = 0,
  ): readonly (readonly StaticArgument[])[] {
    if (helperDepth > MAX_HELPER_DEPTH) return []
    const value = unwrap(expression)
    if (ts.isIdentifier(value)) {
      const bindings = bindingsFor(value)
      if (!bindings) return []
      return bounded(
        bindings.flatMap((binding) => {
          if (seenBindings.has(binding)) return []
          const seen = new Set(seenBindings).add(binding)
          return binding.sources.flatMap((source) =>
            projectedExpressions(source.expression, source.path, seen).flatMap(
              (projected) =>
                preboundLoaderArgumentLists(projected, seen, helperDepth + 1),
            ),
          )
        }),
      )
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const member = memberName(value)
      if (!member) return []
      return bounded(
        projectedExpressions(value.expression, [member], seenBindings).flatMap(
          (projected) =>
            preboundLoaderArgumentLists(projected, seenBindings, helperDepth + 1),
        ),
      )
    }
    if (ts.isCallExpression(value)) {
      const callee = value.expression
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        memberName(callee) === 'bind' &&
        valueKinds(callee.expression).has('require-loader')
      ) {
        const inherited = preboundLoaderArgumentLists(
          callee.expression,
          seenBindings,
          helperDepth + 1,
        )
        const added = expandStaticArguments(
          value.arguments.slice(1),
          seenBindings,
          helperDepth,
        )
        return inherited.length > 0
          ? bounded(
              inherited.flatMap((prefix) =>
                added.map((arguments_) => [...prefix, ...arguments_]),
              ),
            )
          : added
      }
      return bounded(
        evaluateCallReturns(value, helperDepth, (returned) =>
          preboundLoaderArgumentLists(returned, seenBindings, helperDepth + 1),
        ),
      )
    }
    if (ts.isConditionalExpression(value)) {
      return bounded([
        ...preboundLoaderArgumentLists(value.whenTrue, seenBindings, helperDepth + 1),
        ...preboundLoaderArgumentLists(value.whenFalse, seenBindings, helperDepth + 1),
      ])
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return bounded([
        ...preboundLoaderArgumentLists(value.left, seenBindings, helperDepth + 1),
        ...preboundLoaderArgumentLists(value.right, seenBindings, helperDepth + 1),
      ])
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return preboundLoaderArgumentLists(value.right, seenBindings, helperDepth + 1)
    }
    return []
  }

  function unboundLoaderPossible(
    expression: ts.Expression,
    seenBindings: ReadonlySet<Binding> = new Set(),
    helperDepth = 0,
  ): boolean {
    if (helperDepth > MAX_HELPER_DEPTH) return false
    const value = unwrap(expression)
    if (ts.isIdentifier(value)) {
      const bindings = bindingsFor(value)
      if (!bindings) return value.text === 'require'
      return bindings.some((binding) => {
        if (seenBindings.has(binding)) return false
        const seen = new Set(seenBindings).add(binding)
        if (
          !binding.typeOnly &&
          binding.importedFrom &&
          isModuleBuiltin(binding.importedFrom) &&
          binding.importedName === '_load'
        ) {
          return true
        }
        return binding.sources.some((source) => {
          const projected = projectedExpressions(source.expression, source.path, seen)
          if (projected.length > 0) {
            return projected.some((expression) =>
              unboundLoaderPossible(expression, seen, helperDepth + 1),
            )
          }
          let kinds = valueKinds(source.expression, seen, helperDepth + 1)
          for (const member of source.path) kinds = memberKinds(kinds, member)
          return kinds.has('require-loader')
        })
      })
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const member = memberName(value)
      if (!member) return false
      if (
        projectedExpressions(value.expression, [member], seenBindings).some((projected) =>
          unboundLoaderPossible(projected, seenBindings, helperDepth + 1),
        )
      ) {
        return true
      }
      return memberKinds(valueKinds(value.expression), member).has('require-loader')
    }
    if (ts.isCallExpression(value)) {
      const callee = value.expression
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        memberName(callee) === 'bind' &&
        valueKinds(callee.expression).has('require-loader')
      ) {
        const added = expandStaticArguments(
          value.arguments.slice(1),
          seenBindings,
          helperDepth,
        )
        return (
          added.some((arguments_) => !arguments_[0]) &&
          unboundLoaderPossible(callee.expression, seenBindings, helperDepth + 1)
        )
      }
      if (valueKinds(callee).has('create-require-factory')) return true
      return evaluateCallReturns(value, helperDepth, (returned) => [
        unboundLoaderPossible(returned, seenBindings, helperDepth + 1),
      ]).some(Boolean)
    }
    if (ts.isConditionalExpression(value)) {
      return (
        unboundLoaderPossible(value.whenTrue, seenBindings, helperDepth + 1) ||
        unboundLoaderPossible(value.whenFalse, seenBindings, helperDepth + 1)
      )
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return (
        unboundLoaderPossible(value.left, seenBindings, helperDepth + 1) ||
        unboundLoaderPossible(value.right, seenBindings, helperDepth + 1)
      )
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return unboundLoaderPossible(value.right, seenBindings, helperDepth + 1)
    }
    return false
  }

  const firstStaticArguments = (
    argumentLists: readonly (readonly StaticArgument[])[],
  ): readonly ts.Expression[] =>
    argumentLists.flatMap((arguments_) => {
      const first = arguments_[0]
      return first ? [first] : []
    })

  const moduleLoadProviders = (call: ts.CallExpression): readonly ts.Expression[] => {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return call.arguments[0] ? [call.arguments[0]] : []
    }
    const callee = call.expression
    if (valueKinds(callee).has('require-loader')) {
      const prebound = preboundLoaderArgumentLists(callee)
      const effectivePrebound = prebound.filter((arguments_) => arguments_[0])
      return firstStaticArguments([
        ...effectivePrebound,
        ...(unboundLoaderPossible(callee)
          ? expandStaticArguments(call.arguments, new Set())
          : []),
      ])
    }
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      memberName(callee) === 'call' &&
      valueKinds(callee.expression).has('require-loader')
    ) {
      return firstStaticArguments(
        expandStaticArguments(call.arguments.slice(1), new Set()),
      )
    }
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      memberName(callee) === 'apply' &&
      valueKinds(callee.expression).has('require-loader')
    ) {
      return firstStaticArguments(staticArgumentLists(call.arguments[1]))
    }
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      memberName(callee) === 'apply' &&
      (isAmbientReflect(callee.expression) ||
        valueKinds(callee.expression).has('reflect-object')) &&
      call.arguments[0] &&
      valueKinds(call.arguments[0]).has('require-loader')
    ) {
      return firstStaticArguments(staticArgumentLists(call.arguments[2]))
    }
    return []
  }
  let configured = false
  const visit = (node: ts.Node, helperDepth = 0): void => {
    if (configured) return
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isDrizzleAdapterModule(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause
      if (!clause?.isTypeOnly) {
        const bindings = clause?.namedBindings
        const hasRuntimeBinding =
          !clause ||
          !!clause.name ||
          (!!bindings &&
            (ts.isNamespaceImport(bindings) ||
              bindings.elements.length === 0 ||
              bindings.elements.some((element) => !element.isTypeOnly)))
        if (hasRuntimeBinding) {
          configured = true
          return
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isDrizzleAdapterModule(node.moduleSpecifier.text) &&
      (!node.exportClause ||
        ts.isNamespaceExport(node.exportClause) ||
        node.exportClause.elements.length === 0 ||
        node.exportClause.elements.some((element) => !element.isTypeOnly))
    ) {
      configured = true
      return
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      isDrizzleAdapterModule(node.moduleReference.expression.text)
    ) {
      configured = true
      return
    }
    if (
      ts.isCallExpression(node) &&
      moduleLoadProviders(node).some((provider) =>
        staticStrings(provider)?.some(isDrizzleAdapterModule),
      )
    ) {
      configured = true
      return
    }
    if (ts.isCallExpression(node) && helperDepth < MAX_HELPER_DEPTH) {
      for (const invocation of invocationCandidates(node, helperDepth)) {
        const body = invocation.functionNode.body
        if (!body) continue
        withInvocationSources(invocation, () => {
          visit(body, helperDepth + 1)
          return []
        })
        if (configured) return
      }
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node)) &&
      node.body
    ) {
      const body = node.body
      ts.forEachChild(node, (child) => {
        if (child !== body) visit(child, helperDepth)
      })
      withHelperDefaultsSuppressed(node, () => visit(body, helperDepth))
      return
    }
    ts.forEachChild(node, (child) => visit(child, helperDepth))
  }
  visit(sourceFile)
  return configured
}

export function adapterConfiguredOutsideIdentity(file: string, content: string): boolean {
  return (
    configuresDrizzleAdapter(content, file) && !file.startsWith('src/modules/identity/')
  )
}

export function listAdapterConfigurers(sourceRoot: string): string[] {
  return listSourceFiles(sourceRoot)
    .filter((file) => configuresDrizzleAdapter(readFileSync(file, 'utf8'), file))
    .map(projectPath)
    .sort()
}

export function principalOf(path: string): string {
  const moduleMatch = path.match(/^src\/modules\/([^/]+)\//)
  if (moduleMatch) return moduleMatch[1] as string
  if (path.startsWith('src/app/')) return 'app'
  if (path.startsWith('src/application/')) return 'application'
  if (path.startsWith('src/platform/')) return 'platform'
  if (path.startsWith('scripts/')) return 'scripts'
  return 'other'
}

export type ScanRoots = Readonly<{
  readonly sourceRoot: string
  readonly extraDirs?: readonly string[]
}>

/** Scan the complete production perimeter through both closed grammars. */
export function scanWrites({ sourceRoot, extraDirs = [] }: ScanRoots): ObservedWrite[] {
  const { bindingToSql, sqlNames } = buildSchemaTableMap(sourceRoot)
  const files = [
    ...listSourceFiles(sourceRoot),
    ...extraDirs.flatMap((directory) => listSourceFiles(directory)),
  ]
  const writes: ObservedWrite[] = []
  for (const absolute of [...new Set(files)].sort()) {
    const file = projectPath(absolute)
    const sourceFile = createSourceFile(absolute, readFileSync(absolute, 'utf8'))
    const principal = principalOf(file)
    writes.push(
      ...detectLocalDrizzleWrites(sourceFile, file, principal, bindingToSql),
      ...detectRawSqlWrites(sourceFile, file, principal, sqlNames, bindingToSql),
    )
  }
  return writes
}

/** Scan one in-memory fixture through the exact production detectors. */
export function scanSource(
  source: string,
  options: Readonly<{
    readonly file: string
    readonly bindingToSql: ReadonlyMap<string, string>
    readonly sqlNames: ReadonlySet<string>
  }>,
): ObservedWrite[] {
  const sourceFile = createSourceFile(options.file, source)
  const principal = principalOf(options.file)
  return [
    ...detectLocalDrizzleWrites(
      sourceFile,
      options.file,
      principal,
      options.bindingToSql,
    ),
    ...detectRawSqlWrites(
      sourceFile,
      options.file,
      principal,
      options.sqlNames,
      options.bindingToSql,
    ),
  ]
}
