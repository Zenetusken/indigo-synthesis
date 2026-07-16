import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export type ImportEdgeKind =
  | 'import'
  | 're-export'
  | 'dynamic-import'
  | 'require'
  | 'import-equals'
  | 'import-type'

export type ImportEdge = {
  readonly from: string
  readonly specifier: string
  readonly to: string | null
  readonly kind: ImportEdgeKind
  readonly internal: boolean
  readonly runtime: boolean
}

export type ComputedImport = {
  readonly from: string
  readonly kind: 'dynamic-import' | 'require'
}

export type ImportGraph = {
  readonly edges: readonly ImportEdge[]
  readonly computedImports: readonly ComputedImport[]
  readonly unresolvedInternalImports: readonly Omit<ImportEdge, 'to'>[]
}

type AnalyzeImportGraphOptions = {
  readonly sourceRoot: string
}

const sourceExtensions = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const
const assetExtensions = new Set([
  '.css',
  '.gif',
  '.jpeg',
  '.jpg',
  '.json',
  '.png',
  '.svg',
  '.webp',
  '.woff',
  '.woff2',
])

function normalizedPath(path: string): string {
  return resolve(path).split(sep).join('/')
}

function literalModuleSpecifier(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null
}

function staticMemberName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return literalModuleSpecifier(node.argumentExpression)
}

function isModuleRequireReference(
  node: ts.Expression,
  isUnboundGlobal: (identifier: ts.Identifier) => boolean,
): boolean {
  const ambientGlobalObject = (value: ts.Expression): boolean =>
    ts.isIdentifier(value) &&
    (value.text === 'global' || value.text === 'globalThis') &&
    isUnboundGlobal(value)
  const ambientModule = (value: ts.Expression): boolean =>
    (ts.isIdentifier(value) && value.text === 'module' && isUnboundGlobal(value)) ||
    ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
      ambientGlobalObject(value.expression) &&
      staticMemberName(value) === 'module')
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    (ambientModule(node.expression) || ambientGlobalObject(node.expression)) &&
    staticMemberName(node) === 'require'
  )
}

type LexicalScope = {
  readonly bindings: Set<string>
  readonly functionScope: boolean
  readonly parent: LexicalScope | null
}

function bindingNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  )
}

function lexicalScopeIndex(sourceFile: ts.SourceFile): {
  readonly scopeOf: WeakMap<ts.Node, LexicalScope>
  readonly root: LexicalScope
} {
  const root: LexicalScope = {
    bindings: new Set<string>(),
    functionScope: true,
    parent: null,
  }
  const scopeOf = new WeakMap<ts.Node, LexicalScope>()

  const nearestFunctionScope = (scope: LexicalScope): LexicalScope => {
    let current: LexicalScope | null = scope
    while (current && !current.functionScope) current = current.parent
    return current ?? root
  }
  const register = (name: ts.BindingName, scope: LexicalScope): void => {
    for (const binding of bindingNames(name)) scope.bindings.add(binding)
  }
  const childScope = (parent: LexicalScope, functionScope: boolean): LexicalScope => ({
    bindings: new Set<string>(),
    functionScope,
    parent,
  })
  const visit = (node: ts.Node, parentScope: LexicalScope): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      parentScope.bindings.add(node.name.text)
    } else if (ts.isImportClause(node) && node.name && !node.isTypeOnly) {
      parentScope.bindings.add(node.name.text)
    } else if (ts.isImportSpecifier(node) && !node.isTypeOnly) {
      parentScope.bindings.add(node.name.text)
    } else if (ts.isNamespaceImport(node)) {
      parentScope.bindings.add(node.name.text)
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      parentScope.bindings.add(node.name.text)
    }

    let scope = parentScope
    if (ts.isFunctionLike(node)) {
      scope = childScope(parentScope, true)
      if (ts.isFunctionExpression(node) && node.name) {
        scope.bindings.add(node.name.text)
      }
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      scope = childScope(parentScope, false)
      if (node.name) {
        scope.bindings.add(node.name.text)
      }
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
    scopeOf.set(node, scope)

    if (ts.isParameter(node)) {
      register(node.name, scope)
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      register(node.variableDeclaration.name, scope)
    } else if (ts.isVariableDeclaration(node)) {
      const list = ts.isVariableDeclarationList(node.parent) ? node.parent : null
      const target =
        list && (list.flags & ts.NodeFlags.BlockScoped) === 0
          ? nearestFunctionScope(scope)
          : scope
      register(node.name, target)
    } else if (ts.isFunctionExpression(node) && node.name) {
      scope.bindings.add(node.name.text)
    } else if (ts.isClassExpression(node) && node.name) {
      scope.bindings.add(node.name.text)
    }

    ts.forEachChild(node, (child) => visit(child, scope))
  }
  scopeOf.set(sourceFile, root)
  ts.forEachChild(sourceFile, (child) => visit(child, root))
  return { scopeOf, root }
}

function isNonValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
      parent.label === node)
  ) {
    return true
  }
  let current: ts.Node | undefined = parent
  while (current && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return true
    if (ts.isExpression(current) || ts.isStatement(current)) return false
    current = current.parent
  }
  return false
}

function candidatePaths(basePath: string): readonly string[] {
  const extension = extname(basePath)
  const withoutJavaScriptExtension = /\.[cm]?js$/.test(extension)
    ? basePath.slice(0, -extension.length)
    : basePath
  const directCandidates = sourceExtensions.map(
    (sourceExtension) => `${withoutJavaScriptExtension}${sourceExtension}`,
  )

  return [
    basePath,
    ...directCandidates,
    ...sourceExtensions.map((sourceExtension) =>
      join(basePath, `index${sourceExtension}`),
    ),
  ].map(normalizedPath)
}

function resolveInternalImport(
  from: string,
  specifier: string,
  files: ReadonlyMap<string, string>,
  sourceRoot: string,
): { readonly internal: boolean; readonly to: string | null } {
  const assetExtension = extname(specifier)
  if (assetExtensions.has(assetExtension)) return { internal: false, to: null }

  let basePath: string | null = null
  if (specifier === '@') basePath = sourceRoot
  else if (specifier.startsWith('@/')) basePath = join(sourceRoot, specifier.slice(2))
  else if (specifier.startsWith('.')) basePath = resolve(dirname(from), specifier)
  else if (isAbsolute(specifier)) basePath = specifier
  else if (specifier.startsWith('file:')) {
    try {
      basePath = fileURLToPath(specifier)
    } catch {
      return { internal: false, to: null }
    }
  }

  if (!basePath) return { internal: false, to: null }
  const to = candidatePaths(basePath).find((candidate) => files.has(candidate)) ?? null
  return { internal: true, to }
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) {
    return ts.ScriptKind.TS
  }
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.Unknown
}

export function analyzeImportGraph(
  rawFiles: ReadonlyMap<string, string>,
  options: AnalyzeImportGraphOptions,
): ImportGraph {
  const sourceRoot = normalizedPath(options.sourceRoot)
  const files = new Map(
    [...rawFiles].map(([path, source]) => [normalizedPath(path), source] as const),
  )
  const edges: ImportEdge[] = []
  const computedImports: ComputedImport[] = []
  const computedImportKeys = new Set<string>()

  const addEdge = (
    from: string,
    specifier: string,
    kind: ImportEdgeKind,
    runtime = true,
  ) => {
    const resolvedImport = resolveInternalImport(from, specifier, files, sourceRoot)
    edges.push({ from, specifier, kind, runtime, ...resolvedImport })
  }

  const addComputedImport = (from: string, kind: ComputedImport['kind']): void => {
    const key = `${from}\0${kind}`
    if (computedImportKeys.has(key)) return
    computedImportKeys.add(key)
    computedImports.push({ from, kind })
  }

  for (const [from, source] of files) {
    const sourceFile = ts.createSourceFile(
      from,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(from),
    )
    let lexicalScopes: ReturnType<typeof lexicalScopeIndex> | undefined
    const isUnboundGlobal = (identifier: ts.Identifier): boolean => {
      lexicalScopes ??= lexicalScopeIndex(sourceFile)
      let scope: LexicalScope | null =
        lexicalScopes.scopeOf.get(identifier) ?? lexicalScopes.root
      while (scope) {
        if (scope.bindings.has(identifier.text)) return false
        scope = scope.parent
      }
      return true
    }
    const isModuleBuiltin = (specifier: string | null): boolean =>
      specifier === 'module' || specifier === 'node:module'
    const runtimeImportCanCreateRequire = (node: ts.ImportDeclaration): boolean => {
      if (!isModuleBuiltin(literalModuleSpecifier(node.moduleSpecifier))) return false
      const clause = node.importClause
      if (!clause || clause.isTypeOnly) return !clause?.isTypeOnly
      if (clause.name) return true
      const bindings = clause.namedBindings
      if (!bindings || ts.isNamespaceImport(bindings)) return true
      return bindings.elements.some((element) => !element.isTypeOnly)
    }
    const runtimeImportDeclaration = (node: ts.ImportDeclaration): boolean => {
      const clause = node.importClause
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
    const runtimeExportDeclaration = (node: ts.ExportDeclaration): boolean =>
      !node.isTypeOnly &&
      (!node.exportClause ||
        ts.isNamespaceExport(node.exportClause) ||
        node.exportClause.elements.length === 0 ||
        node.exportClause.elements.some((element) => !element.isTypeOnly))

    const isDirectCallCallee = (node: ts.Expression): boolean =>
      ts.isCallExpression(node.parent) && node.parent.expression === node

    const isRequireResolveReference = (node: ts.Identifier): boolean =>
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node &&
      node.parent.name.text === 'resolve'

    const isPropertyName = (node: ts.Identifier): boolean =>
      ts.isPropertyAccessExpression(node.parent) && node.parent.name === node

    const isBuiltinModuleAcquisition = (node: ts.CallExpression): boolean => {
      const specifier = literalModuleSpecifier(node.arguments[0])
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const ambientRequire =
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        isUnboundGlobal(node.expression)
      const ambientModuleRequire = isModuleRequireReference(
        node.expression,
        isUnboundGlobal,
      )
      if (
        isModuleBuiltin(specifier) &&
        (dynamicImport || ambientRequire || ambientModuleRequire)
      ) {
        return true
      }
      if (
        !isModuleBuiltin(specifier) ||
        (!ts.isPropertyAccessExpression(node.expression) &&
          !ts.isElementAccessExpression(node.expression)) ||
        staticMemberName(node.expression) !== 'getBuiltinModule'
      ) {
        return false
      }
      const receiver = node.expression.expression
      if (ts.isIdentifier(receiver)) {
        return receiver.text === 'process' && isUnboundGlobal(receiver)
      }
      return (
        (ts.isPropertyAccessExpression(receiver) ||
          ts.isElementAccessExpression(receiver)) &&
        ts.isIdentifier(receiver.expression) &&
        (receiver.expression.text === 'global' ||
          receiver.expression.text === 'globalThis') &&
        isUnboundGlobal(receiver.expression) &&
        staticMemberName(receiver) === 'process'
      )
    }

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const specifier = literalModuleSpecifier(node.moduleSpecifier)
        if (specifier) {
          addEdge(from, specifier, 'import', runtimeImportDeclaration(node))
        }
        if (runtimeImportCanCreateRequire(node)) addComputedImport(from, 'require')
      } else if (ts.isExportDeclaration(node)) {
        const specifier = literalModuleSpecifier(node.moduleSpecifier)
        if (specifier) {
          addEdge(from, specifier, 're-export', runtimeExportDeclaration(node))
        }
        if (
          isModuleBuiltin(specifier) &&
          !node.isTypeOnly &&
          (!node.exportClause ||
            ts.isNamespaceExport(node.exportClause) ||
            node.exportClause.elements.some((element) => !element.isTypeOnly))
        ) {
          addComputedImport(from, 'require')
        }
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const specifier = literalModuleSpecifier(node.moduleReference.expression)
        if (specifier) addEdge(from, specifier, 'import-equals', !node.isTypeOnly)
        if (!node.isTypeOnly && isModuleBuiltin(specifier)) {
          addComputedImport(from, 'require')
        }
      } else if (ts.isImportTypeNode(node)) {
        const argument = ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : undefined
        const specifier = literalModuleSpecifier(argument)
        if (specifier) addEdge(from, specifier, 'import-type', false)
      } else if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const isRequire =
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require' &&
            isUnboundGlobal(node.expression)) ||
          isModuleRequireReference(node.expression, isUnboundGlobal)
        if (isDynamicImport || isRequire) {
          const kind = isDynamicImport ? 'dynamic-import' : 'require'
          const specifier = literalModuleSpecifier(node.arguments[0])
          if (specifier) addEdge(from, specifier, kind)
          else addComputedImport(from, kind)
        }
        if (isBuiltinModuleAcquisition(node)) addComputedImport(from, 'require')
      } else if (
        ts.isIdentifier(node) &&
        node.text === 'require' &&
        !isNonValueIdentifier(node) &&
        isUnboundGlobal(node) &&
        !isDirectCallCallee(node) &&
        !isRequireResolveReference(node) &&
        !isPropertyName(node)
      ) {
        // `const load = require`, object storage, and forwarding must not make
        // a sealed import disappear from the graph.
        addComputedImport(from, 'require')
      } else if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        isModuleRequireReference(node, isUnboundGlobal) &&
        !isDirectCallCallee(node) &&
        !(
          (ts.isPropertyAccessExpression(node.parent) ||
            ts.isElementAccessExpression(node.parent)) &&
          node.parent.expression === node &&
          staticMemberName(node.parent) === 'resolve'
        )
      ) {
        addComputedImport(from, 'require')
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return {
    edges,
    computedImports,
    unresolvedInternalImports: edges
      .filter((edge) => edge.internal && edge.to === null)
      .map(({ to: _to, ...edge }) => edge),
  }
}

export function readCodeSources(sourceRoot: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>()

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (sourceExtensions.some((extension) => path.endsWith(extension))) {
        files.set(normalizedPath(path), readFileSync(path, 'utf8'))
      }
    }
  }

  visit(sourceRoot)
  return files
}

function moduleName(path: string, sourceRoot: string): string | null {
  const projectPath = relative(sourceRoot, path).split(sep).join('/')
  return projectPath.match(/^modules\/([^/]+)\//)?.[1] ?? null
}

export function isApplicationBoundaryViolation(
  edge: ImportEdge,
  rawSourceRoot: string,
): boolean {
  if (!edge.to) return false
  const sourceRoot = normalizedPath(rawSourceRoot)
  const from = relative(sourceRoot, edge.from).split(sep).join('/')
  const to = relative(sourceRoot, edge.to).split(sep).join('/')
  const fromApplicationShell = from.startsWith('app/') || from.startsWith('components/')
  const toInfrastructure =
    to.includes('/infrastructure/') || to.startsWith('platform/db/')
  return fromApplicationShell && toInfrastructure
}

export function findModuleCycles(
  edges: readonly ImportEdge[],
  rawSourceRoot: string,
): readonly string[] {
  const sourceRoot = normalizedPath(rawSourceRoot)
  const graph = new Map<string, Set<string>>()

  for (const edge of edges) {
    if (!edge.to || !isAbsolute(edge.to)) continue
    const owner = moduleName(edge.from, sourceRoot)
    const dependency = moduleName(edge.to, sourceRoot)
    if (!owner) continue
    const dependencies = graph.get(owner) ?? new Set<string>()
    if (dependency && dependency !== owner) dependencies.add(dependency)
    graph.set(owner, dependencies)
  }

  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const cycles = new Set<string>()

  const visit = (name: string): void => {
    const currentState = state.get(name)
    if (currentState === 'visited') return
    if (currentState === 'visiting') {
      const start = stack.indexOf(name)
      if (start >= 0) cycles.add([...stack.slice(start), name].join(' -> '))
      return
    }

    state.set(name, 'visiting')
    stack.push(name)
    for (const dependency of [...(graph.get(name) ?? [])].sort()) visit(dependency)
    stack.pop()
    state.set(name, 'visited')
  }

  for (const name of [...graph.keys()].sort()) visit(name)
  return [...cycles].sort()
}
