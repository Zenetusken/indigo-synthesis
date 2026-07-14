import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/**
 * Static write-authority scanner for the schema ownership fence (spec §5.3).
 *
 * Finds every DML write against a schema table — Drizzle `.insert/.update/
 * .delete(SYM)` calls and raw-SQL `INSERT INTO` / `UPDATE … SET` / `DELETE
 * FROM` literals (only inside executed SQL: `sql\`…\`` tagged templates and
 * `.execute/.query/.raw(…)` arguments) — and attributes each to a principal
 * (module id or a non-module root). The ownership test authorizes the result
 * against `tableWriteFence` / `crossCuttingOperator`.
 *
 * Deliberate limits (spec §5.3(11)): SQL whose table name is built by runtime
 * concatenation/interpolation, FK CASCADE, and DB triggers are invisible to a
 * static scan. Better Auth adapter writes are invisible too and are authorized
 * by adapter registration (O5), not by a detected call.
 */

export type WriteOp = 'insert' | 'update' | 'delete'
export type WriteKind = 'drizzle' | 'raw'

export type ObservedWrite = {
  /** Module folder id, or a non-module root: platform | app | application | scripts. */
  readonly principal: string
  /** SQL table name. */
  readonly table: string
  readonly op: WriteOp
  readonly kind: WriteKind
  /** Project-relative path, forward-slashed. */
  readonly file: string
  readonly line: number
}

const projectRoot = process.cwd()

export function projectPath(absolutePath: string): string {
  return relative(projectRoot, absolutePath).split(sep).join('/')
}

function filesMatching(directory: string, pattern: RegExp): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry)
    return statSync(path).isDirectory()
      ? filesMatching(path, pattern)
      : pattern.test(path)
        ? [path]
        : []
  })
}

// Include .mts/.cts so an ESM/CJS TS module cannot host a write outside the
// scan perimeter (matches the sibling import-graph scanner).
const TS_SOURCE = /\.(?:mts|cts|tsx?)$/
const TEST_FILE = /\.(?:test|spec)\.(?:mts|cts|tsx?)$/

// Matches the schema barrel, its `/index`, or any subpath under it, so a binding
// imported via `@/platform/db/schema/index` (or a deep path) still resolves.
function isSchemaSpecifier(specifier: string): boolean {
  return /(^|\/)platform\/db\/schema(\/|$)/.test(specifier.replace(/^@\//, 'src/'))
}

function createSourceFile(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

/**
 * Parse every schema file and map each Drizzle export binding to its SQL table
 * name: `export const auditEvents = pgTable('audit_event', …)` → auditEvents ⇒
 * audit_event. Discovers schema files by globbing the schema directory (not a
 * hardcoded list) so a newly-added schema file's tables are covered — and the
 * O1 bijection check flags them if they are not manifested.
 */
export function buildSchemaTableMap(sourceRoot: string): {
  readonly bindingToSql: ReadonlyMap<string, string>
  readonly sqlNames: ReadonlySet<string>
} {
  const bindingToSql = new Map<string, string>()
  const schemaDir = resolve(sourceRoot, 'platform/db/schema')
  const files = existsSync(schemaDir)
    ? readdirSync(schemaDir).filter(
        // index.ts (barrel) and ownership.ts (the manifest) define no tables.
        (file) => /\.ts$/.test(file) && file !== 'index.ts' && file !== 'ownership.ts',
      )
    : []
  for (const file of files) {
    const path = resolve(schemaDir, file)
    const sourceFile = createSourceFile(path, readFileSync(path, 'utf8'))
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'pgTable'
      ) {
        const first = node.initializer.arguments[0]
        if (first && ts.isStringLiteralLike(first)) {
          bindingToSql.set(node.name.text, first.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return { bindingToSql, sqlNames: new Set(bindingToSql.values()) }
}

/** Local identifier → SQL table name, resolving named imports, aliases, and
 * single-hop local re-bindings (`const t = auditEvents; db.insert(t)`). */
function schemaBindingsInFile(
  sourceFile: ts.SourceFile,
  bindingToSql: ReadonlyMap<string, string>,
): { readonly localToSql: Map<string, string>; readonly namespaces: Set<string> } {
  const localToSql = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isSchemaSpecifier(statement.moduleSpecifier.text)
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text
        const sql = bindingToSql.get(imported)
        if (sql) localToSql.set(element.name.text, sql)
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
    }
  }
  // Resolve `const x = <known table binding>` chains to a fixpoint so a table
  // re-bound to a local const is still attributed.
  for (let changed = true; changed; ) {
    changed = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        !localToSql.has(node.name.text)
      ) {
        const sql = localToSql.get(node.initializer.text)
        if (sql) {
          localToSql.set(node.name.text, sql)
          changed = true
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return { localToSql, namespaces }
}

const WRITE_METHODS = new Set<string>(['insert', 'update', 'delete'])

function detectDrizzleWrites(
  sourceFile: ts.SourceFile,
  file: string,
  principal: string,
  bindingToSql: ReadonlyMap<string, string>,
): ObservedWrite[] {
  const { localToSql, namespaces } = schemaBindingsInFile(sourceFile, bindingToSql)
  if (localToSql.size === 0 && namespaces.size === 0) return []
  const writes: ObservedWrite[] = []

  const tableOfArgument = (arg: ts.Expression | undefined): string | undefined => {
    if (!arg) return undefined
    if (ts.isIdentifier(arg)) return localToSql.get(arg.text)
    // namespace.table form: schema.auditEvents
    if (
      ts.isPropertyAccessExpression(arg) &&
      ts.isIdentifier(arg.expression) &&
      namespaces.has(arg.expression.text)
    ) {
      return bindingToSql.get(arg.name.text)
    }
    return undefined
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITE_METHODS.has(node.expression.name.text)
    ) {
      const table = tableOfArgument(node.arguments[0])
      if (table) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        )
        writes.push({
          principal,
          table,
          op: node.expression.name.text as WriteOp,
          kind: 'drizzle',
          file,
          line: line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return writes
}

// Table capture tolerates an optional `schema.` qualifier; the UPDATE pattern is
// SET-anchored (so `FOR UPDATE SKIP LOCKED` / `ORDER BY updated_at` never match)
// but allows an optional table alias before SET (`UPDATE t a SET`, `UPDATE t AS a
// SET`), matching the alias tolerance DELETE already has (spec §5.3(5)).
const QUALIFIED_TABLE = '(?:"?[a-z_][a-z0-9_]*"?\\.)?"?([a-z_][a-z0-9_]*)"?'
const RAW_PATTERNS: readonly { readonly op: WriteOp; readonly re: RegExp }[] = [
  { op: 'insert', re: new RegExp(`\\bINSERT\\s+INTO\\s+${QUALIFIED_TABLE}`, 'gi') },
  {
    op: 'delete',
    re: new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${QUALIFIED_TABLE}`, 'gi'),
  },
  {
    op: 'update',
    re: new RegExp(
      `\\bUPDATE\\s+(?:ONLY\\s+)?${QUALIFIED_TABLE}(?:\\s+(?:AS\\s+)?[a-z_][a-z0-9_]*)?\\s+SET\\b`,
      'gi',
    ),
  },
]

function staticText(node: ts.TemplateLiteral | ts.StringLiteral): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  // TemplateExpression: join head + each span's literal text with a space so a
  // table name split across a ${} boundary cannot silently fuse.
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
    ' ',
  )
}

const SQL_SINK_METHODS = new Set<string>(['execute', 'query', 'raw'])

function isSqlTag(tag: ts.Expression): boolean {
  if (ts.isIdentifier(tag)) return tag.text === 'sql'
  // sql.raw`…`
  return ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)
    ? tag.expression.text === 'sql'
    : false
}

/**
 * Collect only literals that are executed as SQL: the template of a `sql\`…\``
 * (or `sql.raw\`…\``) tagged template, and string/template arguments to
 * `.execute/.query/.raw(…)`. This excludes SQL keywords that appear in error
 * messages, comments-in-strings, or docs (which are not writes).
 */
function collectSqlLiterals(
  sourceFile: ts.SourceFile,
): Set<ts.TemplateLiteral | ts.StringLiteral> {
  const nodes = new Set<ts.TemplateLiteral | ts.StringLiteral>()
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag)) {
      nodes.add(node.template)
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      SQL_SINK_METHODS.has(node.expression.name.text)
    ) {
      for (const arg of node.arguments) {
        if (
          ts.isStringLiteral(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg) ||
          ts.isTemplateExpression(arg)
        ) {
          nodes.add(arg)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return nodes
}

function detectRawSqlWrites(
  sourceFile: ts.SourceFile,
  file: string,
  principal: string,
  sqlNames: ReadonlySet<string>,
): ObservedWrite[] {
  const writes: ObservedWrite[] = []
  for (const node of collectSqlLiterals(sourceFile)) {
    const text = staticText(node)
    if (!/\b(INSERT|UPDATE|DELETE)\b/i.test(text)) continue
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    for (const { op, re } of RAW_PATTERNS) {
      re.lastIndex = 0
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const table = m[1]?.toLowerCase()
        if (table && sqlNames.has(table)) {
          writes.push({ principal, table, op, kind: 'raw', file, line: line + 1 })
        }
      }
    }
  }
  return writes
}

/** Absolute paths of non-test `.ts(x)/.mts/.cts` files under a directory. */
export function listTsFiles(dir: string): string[] {
  return filesMatching(dir, TS_SOURCE).filter((file) => !TEST_FILE.test(file))
}

/**
 * True if the file imports `drizzleAdapter` from a Better Auth adapter module —
 * by AST, so an aliased import (`import { drizzleAdapter as da }`) is still
 * detected and a mention in a comment/string is not.
 */
export function configuresDrizzleAdapter(
  content: string,
  file = 'adapter-probe.ts',
): boolean {
  if (!content.includes('drizzleAdapter')) return false
  const sourceFile = createSourceFile(file, content)
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/better-auth/.test(statement.moduleSpecifier.text)
    ) {
      return false
    }
    const bindings = statement.importClause?.namedBindings
    return (
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (el) => (el.propertyName ?? el.name).text === 'drizzleAdapter',
      )
    )
  })
}

/** True if a non-identity file registers a Drizzle adapter (an O5 violation). */
export function adapterConfiguredOutsideIdentity(file: string, content: string): boolean {
  return (
    configuresDrizzleAdapter(content, file) && !file.startsWith('src/modules/identity/')
  )
}

/** Project paths of files that configure a Drizzle adapter under a source root. */
export function listAdapterConfigurers(sourceRoot: string): string[] {
  return listTsFiles(sourceRoot)
    .filter((file) => configuresDrizzleAdapter(readFileSync(file, 'utf8'), file))
    .map(projectPath)
    .sort()
}

/** Principal for a project-relative path: module id, or the non-module root. */
export function principalOf(path: string): string {
  const moduleMatch = path.match(/^src\/modules\/([^/]+)\//)
  if (moduleMatch) return moduleMatch[1] as string
  if (path.startsWith('src/app/')) return 'app'
  if (path.startsWith('src/application/')) return 'application'
  if (path.startsWith('src/platform/')) return 'platform'
  if (path.startsWith('scripts/')) return 'scripts'
  return 'other'
}

export type ScanRoots = {
  readonly sourceRoot: string
  /** Extra non-src roots to scan (e.g. scripts/). */
  readonly extraDirs?: readonly string[]
}

/** Scan the perimeter and return every observed schema write. */
export function scanWrites({ sourceRoot, extraDirs = [] }: ScanRoots): ObservedWrite[] {
  const { bindingToSql, sqlNames } = buildSchemaTableMap(sourceRoot)
  const files = [
    ...filesMatching(sourceRoot, TS_SOURCE),
    ...extraDirs.flatMap((dir) => filesMatching(dir, TS_SOURCE)),
  ].filter((file) => !TEST_FILE.test(file))

  const writes: ObservedWrite[] = []
  for (const absolute of files) {
    const file = projectPath(absolute)
    // The schema definitions and the manifest are not write sites.
    if (/^src\/platform\/db\/schema\//.test(file)) continue
    const principal = principalOf(file)
    const sourceFile = createSourceFile(absolute, readFileSync(absolute, 'utf8'))
    writes.push(...detectDrizzleWrites(sourceFile, file, principal, bindingToSql))
    writes.push(...detectRawSqlWrites(sourceFile, file, principal, sqlNames))
  }
  return writes
}

/** Scan a single in-memory snippet through the exact production detectors. */
export function scanSource(
  source: string,
  options: {
    readonly file: string
    readonly bindingToSql: ReadonlyMap<string, string>
    readonly sqlNames: ReadonlySet<string>
  },
): ObservedWrite[] {
  const sourceFile = createSourceFile(options.file, source)
  const principal = principalOf(options.file)
  return [
    ...detectDrizzleWrites(sourceFile, options.file, principal, options.bindingToSql),
    ...detectRawSqlWrites(sourceFile, options.file, principal, options.sqlNames),
  ]
}
