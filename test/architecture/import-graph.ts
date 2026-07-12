import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts'] as const
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

  if (!basePath) return { internal: false, to: null }
  const to = candidatePaths(basePath).find((candidate) => files.has(candidate)) ?? null
  return { internal: true, to }
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) {
    return ts.ScriptKind.TS
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

  const addEdge = (from: string, specifier: string, kind: ImportEdgeKind) => {
    const resolvedImport = resolveInternalImport(from, specifier, files, sourceRoot)
    edges.push({ from, specifier, kind, ...resolvedImport })
  }

  for (const [from, source] of files) {
    const sourceFile = ts.createSourceFile(
      from,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(from),
    )

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const specifier = literalModuleSpecifier(node.moduleSpecifier)
        if (specifier) addEdge(from, specifier, 'import')
      } else if (ts.isExportDeclaration(node)) {
        const specifier = literalModuleSpecifier(node.moduleSpecifier)
        if (specifier) addEdge(from, specifier, 're-export')
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const specifier = literalModuleSpecifier(node.moduleReference.expression)
        if (specifier) addEdge(from, specifier, 'import-equals')
      } else if (ts.isImportTypeNode(node)) {
        const argument = ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : undefined
        const specifier = literalModuleSpecifier(argument)
        if (specifier) addEdge(from, specifier, 'import-type')
      } else if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const isRequire =
          ts.isIdentifier(node.expression) && node.expression.text === 'require'
        if (isDynamicImport || isRequire) {
          const kind = isDynamicImport ? 'dynamic-import' : 'require'
          const specifier = literalModuleSpecifier(node.arguments[0])
          if (specifier) addEdge(from, specifier, kind)
          else computedImports.push({ from, kind })
        }
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

export function readTypeScriptSources(sourceRoot: string): ReadonlyMap<string, string> {
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
