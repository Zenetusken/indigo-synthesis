import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  analyzeImportGraph,
  findModuleCycles,
  isApplicationBoundaryViolation,
  readCodeSources,
} from './import-graph'

const sourceRoot = resolve(process.cwd(), 'src')
const loopbackNetworkPrimitive = 'src/platform/llm/runtime/loopback-fetch.ts'

const runtimeNetworkCapabilityNames = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
])
const forbiddenRuntimeNetworkModules = [
  'axios',
  'got',
  'node-fetch',
  'undici',
  'ws',
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:tls',
] as const

type RuntimeNetworkCapabilityViolation = {
  readonly kind: 'capability' | 'module'
  readonly name: string
  readonly line: number
}

function isWithinTypeNode(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isTypeNode(current)) return true
    if (ts.isExpression(current) || ts.isStatement(current) || ts.isSourceFile(current)) {
      return false
    }
    current = current.parent
  }
  return false
}

function isNonReferenceDeclarationName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent)) &&
    parent.name === identifier
  ) {
    return true
  }
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxAttribute(parent)) &&
    parent.name === identifier
  )
}

function literalModuleSpecifier(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null
}

function isForbiddenRuntimeNetworkModule(specifier: string): boolean {
  return forbiddenRuntimeNetworkModules.some(
    (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
  )
}

function isAllowedNonTransportNetworkImport(node: ts.Node, specifier: string): boolean {
  if (
    (specifier !== 'node:net' && specifier !== 'net') ||
    !ts.isImportDeclaration(node)
  ) {
    return false
  }
  const bindings = node.importClause?.namedBindings
  return (
    !node.importClause?.name &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) =>
      ['isIP', 'isIPv4', 'isIPv6'].includes((element.propertyName ?? element.name).text),
    )
  )
}

/**
 * Finds ownership of runtime network capabilities by syntax, independent of the shape in
 * which a caller invokes or aliases them. Type-only `typeof fetch` references are erased
 * and therefore intentionally excluded.
 */
function runtimeNetworkCapabilityViolations(
  source: string,
  filename = 'runtime-network-audit.ts',
): readonly RuntimeNetworkCapabilityViolation[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const violations: RuntimeNetworkCapabilityViolation[] = []
  const addViolation = (
    node: ts.Node,
    kind: RuntimeNetworkCapabilityViolation['kind'],
    name: string,
  ): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    violations.push({ kind, name, line: line + 1 })
  }

  const checkModule = (node: ts.Node, specifier: string | null): void => {
    if (
      specifier &&
      isForbiddenRuntimeNetworkModule(specifier) &&
      !isAllowedNonTransportNetworkImport(node, specifier)
    ) {
      addViolation(node, 'module', specifier)
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      runtimeNetworkCapabilityNames.has(node.text) &&
      !isWithinTypeNode(node) &&
      !isNonReferenceDeclarationName(node)
    ) {
      addViolation(node, 'capability', node.text)
    } else if (
      ts.isElementAccessExpression(node) &&
      literalModuleSpecifier(node.argumentExpression) !== null &&
      runtimeNetworkCapabilityNames.has(
        literalModuleSpecifier(node.argumentExpression) as string,
      )
    ) {
      addViolation(
        node,
        'capability',
        literalModuleSpecifier(node.argumentExpression) as string,
      )
    }

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      checkModule(node, literalModuleSpecifier(node.moduleSpecifier))
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      checkModule(node, literalModuleSpecifier(node.moduleReference.expression))
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) {
        checkModule(node, literalModuleSpecifier(node.arguments[0]))
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

function filesMatching(directory: string, extensions: RegExp): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = resolve(directory, entry)
      return statSync(path).isDirectory() ? filesMatching(path, extensions) : [path]
    })
    .filter((path) => extensions.test(path))
}

function projectPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/')
}

describe('architecture boundaries', () => {
  const sourceFiles = readCodeSources(sourceRoot)
  const importGraph = analyzeImportGraph(sourceFiles, { sourceRoot })

  it('binds supported runtime commands to loopback and preflights production', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
    const development = manifest.scripts?.dev ?? ''
    const production = manifest.scripts?.start ?? ''

    expect(development).toContain('next dev --hostname 127.0.0.1')
    expect(production).toContain('next start --hostname 127.0.0.1')
    expect(production).toContain('NODE_ENV=production')
    expect(production).toContain('scripts/db/preflight.ts')
    expect(production.indexOf('scripts/db/preflight.ts')).toBeLessThan(
      production.indexOf('next start --hostname 127.0.0.1'),
    )
  })

  it('keeps credential recovery session, route, and ingress boundaries fail-closed', () => {
    const sessionReaders = filesMatching(sourceRoot, /\.tsx?$/)
      .filter((path) => !/\.test\.tsx?$/.test(path))
      .filter((path) => readFileSync(path, 'utf8').includes('.api.getSession('))
      .map(projectPath)
    expect(sessionReaders).toEqual(['src/modules/identity/infrastructure/auth.ts'])

    const actor = readFileSync(
      resolve(sourceRoot, 'modules/identity/server/actor.ts'),
      'utf8',
    )
    expect(actor).toContain(
      "import { readIdentitySession } from '../infrastructure/auth'",
    )
    expect(actor).toContain('readIdentitySession(await headers())')
    expect(actor).not.toContain('.api.getSession(')

    const auth = readFileSync(
      resolve(sourceRoot, 'modules/identity/infrastructure/auth.ts'),
      'utf8',
    )
    const authPolicy = readFileSync(
      resolve(sourceRoot, 'modules/identity/infrastructure/identity-auth-config.ts'),
      'utf8',
    )
    const scopedAuth = readFileSync(
      resolve(sourceRoot, 'modules/identity/infrastructure/scoped-mutation-auth.ts'),
      'utf8',
    )
    expect(authPolicy).toContain('disableSignUp: true')
    expect(authPolicy).toContain('deferSessionRefresh: true')
    expect(authPolicy).toContain('disableSessionRefresh: true')
    expect(authPolicy).toMatch(/cookieCache:\s*\{\s*enabled:\s*false\s*\}/)
    expect(authPolicy).toContain("enabled: config.nodeEnv === 'production'")
    expect(authPolicy).toMatch(/customRules:\s*\{\s*'\/sign-in\/email':\s*false\s*\}/)
    expect(`${auth}\n${authPolicy}\n${scopedAuth}`).not.toMatch(
      /\b(?:bearer|refreshToken|jwt)\b/i,
    )
    expect(auth).toContain('nextCookies()')
    expect(auth).toContain('disableCookieCache: true')
    expect(auth).toContain('disableRefresh: true')
    expect(scopedAuth).toContain('transaction: false')
    expect(scopedAuth).not.toContain('nextCookies')

    const publicCredentialRoutes = filesMatching(resolve(sourceRoot, 'app'), /route\.ts$/)
      .map(projectPath)
      .filter((path) => /sign.?up|role/i.test(path))
    expect(publicCredentialRoutes).toEqual([])

    const authHandler = readFileSync(
      resolve(sourceRoot, 'modules/identity/server/auth-handler.ts'),
      'utf8',
    )
    const serverConfig = readFileSync(
      resolve(sourceRoot, 'platform/config/server.ts'),
      'utf8',
    )
    expect(authHandler).toContain('allowDirectLoopback: !config.secureCookies')
    for (const request of [
      'GET /api/auth/get-session',
      'POST /api/auth/sign-in/email',
      'POST /api/auth/sign-out',
    ]) {
      expect(authHandler).toContain(`'${request}'`)
    }
    expect(authHandler).toContain('redactBrowserSessionToken')
    expect(authHandler).toContain('function browserSafeUser')
    expect(authHandler).toContain('function browserSafeSession')
    expect(authHandler).toMatch(
      /for \(const field of \[\s*'id',\s*'name',\s*'email',\s*'emailVerified',\s*'image',\s*'createdAt',\s*'updatedAt',?\s*\]/,
    )
    expect(authHandler).toMatch(
      /for \(const field of \['expiresAt', 'createdAt', 'updatedAt'\]/,
    )
    expect(authHandler).not.toMatch(/\.\.\.(?:body|session|user)\b/)
    for (const path of [
      '/change-email',
      '/change-password',
      '/delete-user',
      '/get-access-token',
      '/list-sessions',
      '/request-password-reset',
      '/reset-password',
      '/revoke-other-sessions',
      '/revoke-session',
      '/revoke-sessions',
      '/set-password',
      '/sign-up/email',
      '/update-user',
    ]) {
      expect(authPolicy).toContain(`'${path}'`)
    }
    expect(serverConfig).toContain(
      'Plain HTTP is supported only for a loopback application origin.',
    )
  })

  it('keeps domain policies independent of frameworks and infrastructure', () => {
    const forbiddenDependencies = [
      'next',
      'react',
      'drizzle-orm',
      'pg',
      'better-auth',
      '@/platform/db',
      'node:fs',
      'node:http',
      'node:https',
    ]
    const violations = importGraph.edges
      .filter(
        ({ from }) =>
          projectPath(from).includes('/domain/') && !/\.test\.tsx?$/.test(from),
      )
      .filter(({ specifier, to }) => {
        if (
          forbiddenDependencies.some(
            (dependency) =>
              specifier === dependency || specifier.startsWith(`${dependency}/`),
          )
        ) {
          return true
        }
        if (!to) return false
        const target = projectPath(to)
        return (
          target.startsWith('src/app/') ||
          target.startsWith('src/components/') ||
          target.startsWith('src/platform/') ||
          target.includes('/application/') ||
          target.includes('/infrastructure/') ||
          target.includes('/server/')
        )
      })
      .map(
        ({ from, specifier, to }) =>
          `${projectPath(from)} -> ${to ? projectPath(to) : specifier}`,
      )

    expect(violations).toEqual([])
  })

  it('prevents lower layers from depending on the Next.js application shell', () => {
    const violations = importGraph.edges
      .filter(({ from }) => {
        const source = projectPath(from)
        return !source.startsWith('src/app/') && !source.startsWith('src/components/')
      })
      .filter(({ to }) => {
        if (!to) return false
        const target = projectPath(to)
        return target.startsWith('src/app/') || target.startsWith('src/components/')
      })
      .map(({ from, to }) => `${projectPath(from)} -> ${projectPath(to as string)}`)

    expect(violations).toEqual([])
  })

  it('keeps platform infrastructure independent of product modules', () => {
    const violations = importGraph.edges
      .filter(({ from }) => projectPath(from).startsWith('src/platform/'))
      .filter(({ to }) => to && projectPath(to).startsWith('src/modules/'))
      .map(({ from, to }) => `${projectPath(from)} -> ${projectPath(to as string)}`)

    expect(violations).toEqual([])
  })

  it('keeps the application shell behind public module boundaries', () => {
    const violations = importGraph.edges
      .filter((edge) => isApplicationBoundaryViolation(edge, sourceRoot))
      .map(({ from, to }) => `${projectPath(from)} -> ${projectPath(to as string)}`)

    expect(violations).toEqual([])
  })

  it('resolves every source import and rejects computed module loading', () => {
    expect(
      importGraph.unresolvedInternalImports.map(
        ({ from, specifier }) => `${projectPath(from)} -> ${specifier}`,
      ),
    ).toEqual([])
    expect(
      importGraph.computedImports.map(
        ({ from, kind }) => `${projectPath(from)} -> ${kind}`,
      ),
    ).toEqual([])
  })

  it('does not introduce an application-initiated outbound HTTP dependency', () => {
    const remoteAssetPattern = /\b(?:src|poster)\s*=\s*(?:["']|\{\s*["'])\s*https?:\/\//
    const remoteStylesheetAssetPattern =
      /(?:url\(\s*["']?\s*|@import\s+(?:url\(\s*)?["']?)https?:\/\//
    const remoteStylesheetLinkPattern =
      /<link\b(?=[^>]*\brel\s*=\s*["']stylesheet["'])[^>]*\bhref\s*=\s*(?:["']|\{\s*["'])\s*https?:\/\//
    const runtimeFiles = [
      ...filesMatching(sourceRoot, /\.(?:[cm]?[jt]sx?|css)$/),
      ...filesMatching(resolve(process.cwd(), 'scripts'), /\.(?:[cm]?[jt]sx?|css)$/),
      ...filesMatching(resolve(process.cwd(), 'public'), /\.(?:js|css|html|svg)$/),
      ...[
        'next.config.ts',
        'playwright.config.ts',
        'playwright.llm.config.ts',
        'drizzle.config.ts',
      ]
        .map((path) => resolve(process.cwd(), path))
        .filter(existsSync),
    ]
    const assetViolations = runtimeFiles
      .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
        return (
          remoteAssetPattern.test(source) ||
          remoteStylesheetAssetPattern.test(source) ||
          remoteStylesheetLinkPattern.test(source)
        )
      })
      .map(projectPath)

    const capabilityViolations = runtimeFiles
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
      .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
      .filter((path) => projectPath(path) !== loopbackNetworkPrimitive)
      .flatMap((path) =>
        runtimeNetworkCapabilityViolations(readFileSync(path, 'utf8'), path).map(
          (violation) =>
            `${projectPath(path)}:${violation.line} ${violation.kind}:${violation.name}`,
        ),
      )

    expect([...assetViolations, ...capabilityViolations]).toEqual([])
  })

  it.each([
    [
      'coalesced fetch alias',
      "const request = options.fetchImpl ?? fetch; request('https://example.test')",
    ],
    [
      'destructured global fetch',
      "const { fetch: request } = globalThis; request('https://example.test')",
    ],
    [
      'computed global fetch',
      "const request = globalThis['fetch']; request('https://example.test')",
    ],
    [
      'promise-carried fetch',
      "Promise.resolve(fetch).then((request) => request('https://example.test'))",
    ],
    [
      'required HTTP client',
      "const https = require('node:https'); https.get('https://example.test')",
    ],
    [
      'bare built-in HTTP client',
      "import * as https from 'https'; https.get('https://example.test')",
    ],
    [
      'raw socket transport',
      "import { connect } from 'node:net'; connect(80, 'example.test')",
    ],
  ])('rejects the outbound-network mutation %s', (_label, source) => {
    expect(runtimeNetworkCapabilityViolations(source)).not.toEqual([])
  })

  it('allows type-only fetch references and handoff to the loopback primitive', () => {
    expect(
      runtimeNetworkCapabilityViolations(`
        declare function fetchLoopback(
          endpoint: string,
          init: RequestInit,
          fetchImpl?: typeof fetch,
        ): Promise<Response>
        export function probe(options: { fetchImpl?: typeof fetch }) {
          return fetchLoopback('http://127.0.0.1:8080/v1', {}, options.fetchImpl)
        }
      `),
    ).toEqual([])
  })

  it('keeps every LLM HTTP caller behind the loopback-only network primitive', () => {
    const clientPath = resolve(sourceRoot, 'platform/llm/runtime/loopback-fetch.ts')
    const source = readFileSync(clientPath, 'utf8')
    expect(source).toContain('assertLoopbackEndpoint')
    expect(source).toContain('127.0.0.1')
    expect(source).toMatch(/LOOPBACK_HOSTS|loopback/)
    expect(source).toContain("redirect: 'error'")
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(
      runtimeNetworkCapabilityViolations(source, loopbackNetworkPrimitive).map(
        ({ kind, name }) => ({ kind, name }),
      ),
    ).toEqual([{ kind: 'capability', name: 'fetch' }])
    expect(source.match(/\bfetchImpl\s*\(/g)).toHaveLength(1)

    for (const relativePath of [
      'platform/llm/adapters/openai-compatible-loopback.ts',
      'platform/llm/runtime/preflight.ts',
    ]) {
      const caller = readFileSync(resolve(sourceRoot, relativePath), 'utf8')
      expect(caller).toContain('fetchLoopback')
      expect(caller).not.toMatch(/\bfetch\s*\(/)
    }
  })

  it('keeps the module dependency graph acyclic', () => {
    expect(findModuleCycles(importGraph.edges, sourceRoot)).toEqual([])
  })
})
