import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/**
 * Static write-authority scanner for the schema ownership fence (spec §5.3).
 *
 * Finds every DML write against a schema table — Drizzle `.insert/.update/
 * .delete(SYM)` calls and raw-SQL `INSERT INTO` / `UPDATE … SET` / `DELETE
 * FROM` literals — and attributes each to a principal (module id or a
 * non-module root). The ownership test authorizes the result against
 * `tableWriteFence` / `crossCuttingOperator`.
 *
 * Deliberate limits (spec §5.3(11)): fully dynamic table names, FK CASCADE, and
 * DB triggers are invisible to a static scan. Better Auth adapter writes are
 * invisible too and are authorized by adapter registration (O5), not by a
 * detected call.
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

const TS_SOURCE = /\.tsx?$/
const TEST_FILE = /\.(test|spec)\.tsx?$/

function isSchemaSpecifier(specifier: string): boolean {
  return /(^|\/)platform\/db\/schema(\/(auth|installation|product))?$/.test(
    specifier.replace(/^@\//, 'src/'),
  )
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
 * Parse the schema files and map every Drizzle export binding to its SQL table
 * name: `export const auditEvents = pgTable('audit_event', …)` → auditEvents ⇒
 * audit_event.
 */
export function buildSchemaTableMap(sourceRoot: string): {
  readonly bindingToSql: ReadonlyMap<string, string>
  readonly sqlNames: ReadonlySet<string>
} {
  const bindingToSql = new Map<string, string>()
  const schemaDir = resolve(sourceRoot, 'platform/db/schema')
  for (const file of ['auth.ts', 'installation.ts', 'product.ts']) {
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

/** Local identifier → SQL table name, resolving named imports and aliases. */
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

// SET-anchored UPDATE so `FOR UPDATE SKIP LOCKED` / `.for('update')` / `ORDER BY
// updated_at` never register as a phantom write (spec §5.3(5)).
const RAW_PATTERNS: readonly { readonly op: WriteOp; readonly re: RegExp }[] = [
  { op: 'insert', re: /\bINSERT\s+INTO\s+"?([a-z_][a-z0-9_]*)"?/gi },
  { op: 'delete', re: /\bDELETE\s+FROM\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)"?/gi },
  { op: 'update', re: /\bUPDATE\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)"?\s+SET\b/gi },
]

function staticText(node: ts.TemplateLiteral | ts.StringLiteral): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  // TemplateExpression: join head + each span's literal text with a space so a
  // table name split across a ${} boundary cannot silently fuse.
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
    ' ',
  )
}

function detectRawSqlWrites(
  sourceFile: ts.SourceFile,
  file: string,
  principal: string,
  sqlNames: ReadonlySet<string>,
): ObservedWrite[] {
  const writes: ObservedWrite[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const text = staticText(node)
      if (/\b(INSERT|UPDATE|DELETE)\b/i.test(text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        )
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
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return writes
}

/** Absolute paths of non-test `.ts(x)` files under a directory. */
export function listTsFiles(dir: string): string[] {
  return filesMatching(dir, TS_SOURCE).filter((file) => !TEST_FILE.test(file))
}

/** True if the file configures a Better Auth Drizzle adapter (the call, not a mention). */
export function configuresDrizzleAdapter(content: string): boolean {
  return /\bdrizzleAdapter\s*\(/.test(content)
}

/** True if a non-identity file registers a Drizzle adapter (an O5 violation). */
export function adapterConfiguredOutsideIdentity(file: string, content: string): boolean {
  return configuresDrizzleAdapter(content) && !file.startsWith('src/modules/identity/')
}

/** Project paths of files that configure a Drizzle adapter under a source root. */
export function listAdapterConfigurers(sourceRoot: string): string[] {
  return listTsFiles(sourceRoot)
    .filter((file) => configuresDrizzleAdapter(readFileSync(file, 'utf8')))
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
