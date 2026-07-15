import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { readCodeSources } from './import-graph'

function projectPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/')
}

function isTestSource(path: string): boolean {
  return /(?:^|\/)test\//.test(path) || /\.(?:test|spec)\.tsx?$/.test(path)
}

function literalText(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null
}

function isPgModule(specifier: string): boolean {
  return specifier === 'pg' || specifier.startsWith('pg/')
}

function isDatabaseRuntimeModule(specifier: string): boolean {
  return /(?:^|\/)database-runtime(?:\.(?:[cm]?js|ts))?$/.test(specifier)
}

function exportedValueDescriptions(path: string, source: string): readonly string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const descriptions: string[] = []
  const modifiers = (node: ts.Node): readonly ts.Modifier[] =>
    ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []
  const isExported = (node: ts.Node): boolean =>
    modifiers(node).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  const isDefault = (node: ts.Node): boolean =>
    modifiers(node).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  const bindingNames = (name: ts.BindingName): readonly string[] => {
    if (ts.isIdentifier(name)) return [name.text]
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
    )
  }

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      if (!statement.exportClause) {
        descriptions.push(
          `re-export:*${statement.moduleSpecifier ? `:${literalText(statement.moduleSpecifier) ?? 'computed'}` : ''}`,
        )
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) {
            descriptions.push(
              `export:${element.propertyName?.text ?? element.name.text}->${element.name.text}`,
            )
          }
        }
      } else descriptions.push(`export:namespace->${statement.exportClause.name.text}`)
    } else if (ts.isExportAssignment(statement)) {
      descriptions.push(
        `${statement.isExportEquals ? 'export-equals' : 'default-export'}:${statement.expression.getText(file)}`,
      )
    } else if (ts.isClassDeclaration(statement) && isExported(statement)) {
      descriptions.push(
        `${isDefault(statement) ? 'default-' : ''}class:${statement.name?.text ?? '<anonymous>'}`,
      )
    } else if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
      descriptions.push(
        `${isDefault(statement) ? 'default-' : ''}function:${statement.name?.text ?? '<anonymous>'}`,
      )
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name))
          descriptions.push(`variable:${name}`)
      }
    } else if (ts.isEnumDeclaration(statement) && isExported(statement)) {
      descriptions.push(`enum:${statement.name.text}`)
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = statement.expression.left.getText(file)
      if (/^(?:module\.exports|exports(?:\.|\[))/.test(target)) {
        descriptions.push(`commonjs:${target}`)
      }
    }
  }

  return descriptions
}

function pgValueImportDescriptions(path: string, source: string): readonly string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const descriptions: string[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      isPgModule(literalText(node.moduleSpecifier) ?? '')
    ) {
      const clause = node.importClause
      if (clause && !clause.isTypeOnly) {
        if (clause.name) descriptions.push(`default:${clause.name.text}`)
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          descriptions.push(`namespace:${bindings.name.text}`)
        } else if (bindings) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) {
              descriptions.push(
                `named:${element.propertyName?.text ?? element.name.text}->${element.name.text}`,
              )
            }
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      isPgModule(literalText(node.moduleSpecifier) ?? '')
    ) {
      if (!node.exportClause) descriptions.push('re-export:*')
      else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          if (!element.isTypeOnly) {
            descriptions.push(
              `re-export:${element.propertyName?.text ?? element.name.text}->${element.name.text}`,
            )
          }
        }
      } else descriptions.push('re-export:namespace')
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isPgModule(literalText(node.moduleReference.expression) ?? '')
    ) {
      descriptions.push(`import-equals:${node.name.text}`)
    } else if (ts.isCallExpression(node)) {
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const argument = node.arguments[0]
      if (isRequire || isDynamicImport) {
        const kind = isRequire ? 'require' : 'dynamic-import'
        const specifier = literalText(argument)
        if (specifier === null) descriptions.push(`${kind}:computed`)
        else if (isPgModule(specifier)) descriptions.push(`${kind}:${specifier}`)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(file)
  return descriptions
}

function databaseRuntimeConstructionDescriptions(
  path: string,
  source: string,
): readonly string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const directBindings = new Set<string>()
  const namespaceBindings = new Set<string>()
  const descriptions: string[] = []

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!isDatabaseRuntimeModule(literalText(statement.moduleSpecifier) ?? '')) {
        continue
      }
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) continue
      if (clause.name) {
        directBindings.add(clause.name.text)
        descriptions.push(`default-import:${clause.name.text}`)
      }
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) {
        namespaceBindings.add(bindings.name.text)
        descriptions.push(`namespace-import:${bindings.name.text}`)
      } else if (bindings) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue
          const imported = element.propertyName?.text ?? element.name.text
          directBindings.add(element.name.text)
          descriptions.push(`value-import:${imported}->${element.name.text}`)
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      isDatabaseRuntimeModule(literalText(statement.moduleSpecifier) ?? '')
    ) {
      if (!statement.exportClause) descriptions.push('re-export:*')
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) {
            descriptions.push(
              `re-export:${element.propertyName?.text ?? element.name.text}->${element.name.text}`,
            )
          }
        }
      } else descriptions.push('re-export:namespace')
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      isDatabaseRuntimeModule(literalText(statement.moduleReference.expression) ?? '')
    ) {
      namespaceBindings.add(statement.name.text)
      descriptions.push(`import-equals:${statement.name.text}`)
    } else if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      isDatabaseRuntimeModule(path)
    ) {
      descriptions.push(`default-export:${statement.expression.getText(file)}`)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      if (isRequire || isDynamicImport) {
        const specifier = literalText(node.arguments[0])
        if (specifier !== null && isDatabaseRuntimeModule(specifier)) {
          descriptions.push(`${isRequire ? 'require' : 'dynamic-import'}:${specifier}`)
        }
      }
    }
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && directBindings.has(node.expression.text)) {
        descriptions.push(`new:${node.expression.text}`)
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        namespaceBindings.has(node.expression.expression.text) &&
        node.expression.name.text === 'DatabaseRuntime'
      ) {
        descriptions.push(`new:${node.expression.getText(file)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return descriptions
}

describe('PostgreSQL constructor census', () => {
  it.each([
    ["import { Client as C } from 'pg'; new C()", 'named alias'],
    ["import * as postgres from 'pg'; new postgres.Client()", 'namespace'],
    ["import postgres from 'pg'; new postgres.Client()", 'default'],
    ["import postgres = require('pg'); new postgres.Client()", 'import equals'],
    ["const postgres = require('pg')", 'require'],
    ["void import('pg')", 'dynamic import'],
    ["export { Client as Unsafe } from 'pg'", 're-export'],
    ['const postgres = require(`pg`)', 'template literal'],
    ["void import('pg/lib/client')", 'subpath'],
    ['const moduleName = getName(); void import(moduleName)', 'computed loader'],
  ])('rejects the %s mutation fixture', (source) => {
    expect(pgValueImportDescriptions('/virtual/mutation.ts', source)).not.toEqual([])
  })

  it('keeps production pg value imports on an exact temporary allowlist', () => {
    const files = new Map([
      ...readCodeSources(resolve(process.cwd(), 'src')),
      ...readCodeSources(resolve(process.cwd(), 'scripts')),
    ])
    const allowed = new Map<string, readonly string[]>([
      ['src/platform/db/bounded-pool.ts', ['named:Pool->Pool']],
      ['src/platform/db/disposable-integration-database.ts', ['named:Client->Client']],
      ['scripts/db/backup-restore-drill.ts', ['named:Client->Client']],
      ['scripts/db/reset-e2e.ts', ['named:Client->Client']],
    ])
    const observed = new Map<string, readonly string[]>()

    for (const [path, source] of files) {
      const project = projectPath(path)
      if (isTestSource(project)) continue
      const imports = pgValueImportDescriptions(path, source)
      if (imports.length > 0) observed.set(project, imports)
    }

    expect(Object.fromEntries(observed)).toEqual(Object.fromEntries(allowed))
  })

  it('pins the public value surface of every raw-pg allowlisted module', () => {
    const files = new Map([
      ...readCodeSources(resolve(process.cwd(), 'src')),
      ...readCodeSources(resolve(process.cwd(), 'scripts')),
    ])
    const expected = new Map<string, readonly string[]>([
      ['src/platform/db/bounded-pool.ts', ['class:BoundedPool']],
      [
        'src/platform/db/disposable-integration-database.ts',
        [
          'function:validateIntegrationDatabaseTarget',
          'function:createDisposableIntegrationDatabase',
        ],
      ],
      ['scripts/db/backup-restore-drill.ts', []],
      ['scripts/db/reset-e2e.ts', []],
    ])

    for (const [project, exports] of expected) {
      const source = [...files].find(([path]) => projectPath(path) === project)?.[1]
      expect(source, `missing ${project}`).toBeTypeOf('string')
      expect(exportedValueDescriptions(project, source ?? '')).toEqual(exports)
    }
  })

  it('detects local export laundering from a raw-pg adapter', () => {
    expect(
      exportedValueDescriptions(
        '/virtual/bounded-pool.ts',
        'export class BoundedPool {}; export { Pool as RawPool }',
      ),
    ).toEqual(['class:BoundedPool', 'export:Pool->RawPool'])
  })

  it('detects CommonJS export laundering from a raw-pg adapter', () => {
    expect(
      exportedValueDescriptions(
        '/virtual/bounded-pool.ts',
        'export class BoundedPool {}; module.exports.RawPool = Pool',
      ),
    ).toEqual(['class:BoundedPool', 'commonjs:module.exports.RawPool'])
  })

  it('constructs the process runtime exactly once in the registry', () => {
    const files = readCodeSources(resolve(process.cwd(), 'src'))
    const observed = new Map<string, readonly string[]>()

    for (const [path, source] of files) {
      const project = projectPath(path)
      if (isTestSource(project)) continue
      const constructions = databaseRuntimeConstructionDescriptions(path, source)
      if (constructions.length > 0) observed.set(project, constructions)
    }

    expect(Object.fromEntries(observed)).toEqual({
      'src/platform/db/runtime-registry.ts': [
        'value-import:DatabaseRuntime->DatabaseRuntime',
        'new:DatabaseRuntime',
      ],
    })
  })

  it.each([
    [
      "import { DatabaseRuntime as Runtime } from './database-runtime'; new Runtime({})",
      ['value-import:DatabaseRuntime->Runtime', 'new:Runtime'],
    ],
    [
      "import * as runtime from './database-runtime'; new runtime.DatabaseRuntime({})",
      ['namespace-import:runtime', 'new:runtime.DatabaseRuntime'],
    ],
    [
      "export { DatabaseRuntime } from './database-runtime'",
      ['re-export:DatabaseRuntime->DatabaseRuntime'],
    ],
    [
      "import { DatabaseRuntime } from './database-runtime.js'; new DatabaseRuntime({})",
      ['value-import:DatabaseRuntime->DatabaseRuntime', 'new:DatabaseRuntime'],
    ],
    [
      "import Runtime from './database-runtime'; new Runtime({})",
      ['default-import:Runtime', 'new:Runtime'],
    ],
    [
      "import { Runtime } from './database-runtime'; new Runtime({})",
      ['value-import:Runtime->Runtime', 'new:Runtime'],
    ],
    ["void import('./database-runtime.mjs')", ['dynamic-import:./database-runtime.mjs']],
    [
      "const runtime = require('./database-runtime.cjs')",
      ['require:./database-runtime.cjs'],
    ],
  ])('detects aliased runtime construction', (source, expected) => {
    expect(
      databaseRuntimeConstructionDescriptions('/virtual/mutation.ts', source),
    ).toEqual(expected)
  })

  it('detects a default export added to the runtime module', () => {
    expect(
      databaseRuntimeConstructionDescriptions(
        '/virtual/database-runtime.ts',
        'export default DatabaseRuntime',
      ),
    ).toEqual(['default-export:DatabaseRuntime'])
  })

  it('discovers JavaScript-family operator sources before applying the pg census', () => {
    const directory = mkdtempSync(join(tmpdir(), 'indigo-db-census-'))
    const path = join(directory, 'unsafe.mjs')
    try {
      writeFileSync(path, "import { Client } from 'pg'; new Client()", 'utf8')
      const sources = readCodeSources(directory)
      expect([...sources.keys()]).toEqual([resolve(path).split(sep).join('/')])
      expect(pgValueImportDescriptions(path, sources.get(resolve(path)) ?? '')).toEqual([
        'named:Client->Client',
      ])
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
