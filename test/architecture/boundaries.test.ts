import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyzeImportGraph,
  findModuleCycles,
  isApplicationBoundaryViolation,
  readTypeScriptSources,
} from './import-graph'

const sourceRoot = resolve(process.cwd(), 'src')

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
  const sourceFiles = readTypeScriptSources(sourceRoot)
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
    const outboundClientPattern =
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|(?:from\s+|import\s*\(\s*)['"](?:axios|undici|node:(?:https?|http2))['"]/
    const remoteAssetPattern = /\b(?:src|poster)\s*=\s*(?:["']|\{\s*["'])\s*https?:\/\//
    const remoteStylesheetAssetPattern =
      /(?:url\(\s*["']?\s*|@import\s+(?:url\(\s*)?["']?)https?:\/\//
    const remoteStylesheetLinkPattern =
      /<link\b(?=[^>]*\brel\s*=\s*["']stylesheet["'])[^>]*\bhref\s*=\s*(?:["']|\{\s*["'])\s*https?:\/\//
    /** Sole allowed LLM loopback client; must keep assertLoopbackEndpoint guards. */
    const loopbackLlmClientAllowlist = new Set([
      'src/platform/llm/adapters/openai-compatible-loopback.ts',
    ])
    const runtimeFiles = [
      ...filesMatching(sourceRoot, /\.(?:[cm]?[jt]sx?|css)$/),
      ...filesMatching(resolve(process.cwd(), 'scripts'), /\.(?:[cm]?[jt]sx?|css)$/),
      ...filesMatching(resolve(process.cwd(), 'public'), /\.(?:js|css|html|svg)$/),
      ...['next.config.ts', 'playwright.config.ts', 'drizzle.config.ts']
        .map((path) => resolve(process.cwd(), path))
        .filter(existsSync),
    ]
    const violations = runtimeFiles
      .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
      .filter((path) => {
        if (loopbackLlmClientAllowlist.has(projectPath(path))) return false
        const source = readFileSync(path, 'utf8')
        return (
          outboundClientPattern.test(source) ||
          remoteAssetPattern.test(source) ||
          remoteStylesheetAssetPattern.test(source) ||
          remoteStylesheetLinkPattern.test(source)
        )
      })
      .map(projectPath)

    expect(violations).toEqual([])
  })

  it('keeps the loopback LLM client host-restricted', () => {
    const clientPath = resolve(
      sourceRoot,
      'platform/llm/adapters/openai-compatible-loopback.ts',
    )
    const source = readFileSync(clientPath, 'utf8')
    expect(source).toContain('assertLoopbackEndpoint')
    expect(source).toContain('127.0.0.1')
    expect(source).toMatch(/LOOPBACK_HOSTS|loopback/)
  })

  it('keeps the module dependency graph acyclic', () => {
    expect(findModuleCycles(importGraph.edges, sourceRoot)).toEqual([])
  })
})
