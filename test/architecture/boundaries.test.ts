import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve(process.cwd(), 'src')
const sourceExtensions = /\.(?:ts|tsx)$/
const importPattern = /(?:from\s+|import\s*)['"]([^'"]+)['"]/g

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

function importsIn(path: string): string[] {
  return [...readFileSync(path, 'utf8').matchAll(importPattern)].map(
    (match) => match[1] ?? '',
  )
}

describe('architecture boundaries', () => {
  const files = filesMatching(sourceRoot, sourceExtensions)

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
    const violations = files
      .filter((path) => projectPath(path).includes('/domain/'))
      .flatMap((path) =>
        importsIn(path)
          .filter((specifier) =>
            forbiddenDependencies.some(
              (dependency) =>
                specifier === dependency || specifier.startsWith(`${dependency}/`),
            ),
          )
          .map((specifier) => `${projectPath(path)} -> ${specifier}`),
      )

    expect(violations).toEqual([])
  })

  it('prevents lower layers from depending on the Next.js application shell', () => {
    const violations = files
      .filter((path) => !projectPath(path).startsWith('src/app/'))
      .flatMap((path) =>
        importsIn(path)
          .filter(
            (specifier) =>
              specifier === '@/app' ||
              specifier.startsWith('@/app/') ||
              specifier === '@/components' ||
              specifier.startsWith('@/components/'),
          )
          .map((specifier) => `${projectPath(path)} -> ${specifier}`),
      )

    expect(violations).toEqual([])
  })

  it('keeps platform infrastructure independent of product modules', () => {
    const violations = files
      .filter((path) => projectPath(path).startsWith('src/platform/'))
      .flatMap((path) =>
        importsIn(path)
          .filter(
            (specifier) =>
              specifier === '@/modules' || specifier.startsWith('@/modules/'),
          )
          .map((specifier) => `${projectPath(path)} -> ${specifier}`),
      )

    expect(violations).toEqual([])
  })

  it('does not introduce an application-initiated outbound HTTP dependency', () => {
    const outboundClientPattern =
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|(?:from\s+|import\s*\(\s*)['"](?:axios|undici|node:(?:https?|http2))['"]/
    const remoteAssetPattern = /\b(?:src|poster)\s*=\s*(?:["']|\{\s*["'])\s*https?:\/\//
    const remoteStylesheetAssetPattern =
      /(?:url\(\s*["']?\s*|@import\s+(?:url\(\s*)?["']?)https?:\/\//
    const remoteStylesheetLinkPattern =
      /<link\b(?=[^>]*\brel\s*=\s*["']stylesheet["'])[^>]*\bhref\s*=\s*(?:["']|\{\s*["'])\s*https?:\/\//
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

  it('keeps the module dependency graph acyclic', () => {
    const graph = new Map<string, Set<string>>()

    for (const path of files.filter((candidate) =>
      projectPath(candidate).startsWith('src/modules/'),
    )) {
      const [, owner] = projectPath(path).match(/^src\/modules\/([^/]+)\//) ?? []
      if (!owner) continue
      const dependencies = graph.get(owner) ?? new Set<string>()

      for (const specifier of importsIn(path)) {
        const [, dependency] = specifier.match(/^@\/modules\/([^/]+)/) ?? []
        if (dependency && dependency !== owner) dependencies.add(dependency)
      }
      graph.set(owner, dependencies)
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const cycles: string[] = []

    function visit(moduleName: string, path: string[]): void {
      if (visiting.has(moduleName)) {
        cycles.push([...path, moduleName].join(' -> '))
        return
      }
      if (visited.has(moduleName)) return

      visiting.add(moduleName)
      for (const dependency of graph.get(moduleName) ?? []) {
        visit(dependency, [...path, moduleName])
      }
      visiting.delete(moduleName)
      visited.add(moduleName)
    }

    for (const moduleName of graph.keys()) visit(moduleName, [])

    expect(cycles).toEqual([])
  })
})
