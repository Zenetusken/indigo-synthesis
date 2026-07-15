import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { analyzeImportGraph, readCodeSources } from './import-graph'

const sourceRoot = resolve(process.cwd(), 'src')

function projectPath(path: string): string {
  return path.slice(process.cwd().length + 1).replaceAll('\\', '/')
}

function isProductionSource(path: string): boolean {
  return !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
}

type ImportPolicy = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>

function runtimeDependencyKeys(files: ReadonlyMap<string, string>): ReadonlySet<string> {
  const keys = new Set<string>()
  const add = (path: string, kind: string, specifier: ts.Expression | undefined) => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      keys.add(`${path}\0${kind}\0${specifier.text}`)
    }
  }

  for (const [path, source] of files) {
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        const namedBindings = clause?.namedBindings
        const hasRuntimeBinding =
          !clause ||
          (!clause.isTypeOnly &&
            (Boolean(clause.name) ||
              !namedBindings ||
              ts.isNamespaceImport(namedBindings) ||
              namedBindings.elements.some((element) => !element.isTypeOnly)))
        if (hasRuntimeBinding) add(path, 'import', node.moduleSpecifier)
      } else if (ts.isExportDeclaration(node)) {
        const exports = node.exportClause
        const hasRuntimeBinding =
          !node.isTypeOnly &&
          (!exports ||
            ts.isNamespaceExport(exports) ||
            exports.elements.some((element) => !element.isTypeOnly))
        if (hasRuntimeBinding) add(path, 're-export', node.moduleSpecifier)
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
          add(path, 'import-equals', node.moduleReference.expression)
        }
      } else if (ts.isCallExpression(node)) {
        const kind =
          node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? 'dynamic-import'
            : ts.isIdentifier(node.expression) && node.expression.text === 'require'
              ? 'require'
              : null
        if (kind) add(path, kind, node.arguments[0])
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return keys
}

function exactRuntimeImportViolations(
  files: ReadonlyMap<string, string>,
  policies: ImportPolicy,
): readonly string[] {
  const graph = analyzeImportGraph(files, { sourceRoot })
  const restrictedEdges = new Map<string, Map<string, string>>()
  for (const edge of graph.edges) {
    if (!edge.to) continue
    const target = projectPath(edge.to)
    if (!policies.has(target)) continue
    const bySpecifier = restrictedEdges.get(edge.from) ?? new Map<string, string>()
    bySpecifier.set(edge.specifier, target)
    restrictedEdges.set(edge.from, bySpecifier)
  }
  const violations: string[] = []

  for (const computed of graph.computedImports) {
    const source = projectPath(computed.from)
    if (isProductionSource(source)) {
      violations.push(
        `${source}: computed ${computed.kind} bypasses sealed-import policy`,
      )
    }
  }

  for (const [path, targets] of restrictedEdges) {
    const source = projectPath(path)
    if (!isProductionSource(source)) continue
    const sourceFile = ts.createSourceFile(
      path,
      files.get(path) ?? '',
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const matched = new Set<string>()

    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        targets.has(statement.moduleSpecifier.text)
      ) {
        const specifier = statement.moduleSpecifier.text
        matched.add(specifier)
        const target = targets.get(specifier) as string
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        const allowed = policies.get(target)?.get(source)
        if (!clause || !allowed || clause.name || !clause.namedBindings) {
          violations.push(`${source}: unauthorized broad import -> ${target}`)
          continue
        }
        if (ts.isNamespaceImport(clause.namedBindings)) {
          violations.push(`${source}: unauthorized namespace import -> ${target}`)
          continue
        }
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue
          const importedName = element.propertyName?.text ?? element.name.text
          if (!allowed.has(importedName)) {
            violations.push(`${source}: unauthorized ${importedName} -> ${target}`)
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        targets.has(statement.moduleSpecifier.text)
      ) {
        matched.add(statement.moduleSpecifier.text)
        const typeOnly =
          statement.isTypeOnly ||
          (statement.exportClause &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.every((element) => element.isTypeOnly))
        if (!typeOnly) {
          violations.push(
            `${source}: runtime re-export -> ${targets.get(statement.moduleSpecifier.text)}`,
          )
        }
      }
    }

    for (const [specifier, target] of targets) {
      if (!matched.has(specifier)) {
        violations.push(`${source}: non-static import -> ${target}`)
      }
    }
  }
  return [...new Set(violations)].sort()
}

function policy(
  entries: ReadonlyArray<
    readonly [target: string, importer: string, symbols: readonly string[]]
  >,
): ImportPolicy {
  const result = new Map<string, Map<string, ReadonlySet<string>>>()
  for (const [target, importer, symbols] of entries) {
    const importers = result.get(target) ?? new Map<string, ReadonlySet<string>>()
    importers.set(importer, new Set(symbols))
    result.set(target, importers)
  }
  return result
}

const identityAuthPolicies = policy([
  [
    'src/modules/identity/infrastructure/scoped-mutation-auth.ts',
    'src/composition/identity-auth-mutations.ts',
    ['createScopedIdentityMutationGateway'],
  ],
  [
    'src/modules/identity/infrastructure/auth-mutation-capture.ts',
    'src/composition/identity-auth-mutations.ts',
    [
      'captureCheckedSignOutMutation',
      'captureEmailSignInMutation',
      'checkedSignOutMutationCaptureView',
      'deleteCapturedCheckedSignOutSession',
      'emailSignInMutationCaptureView',
      'recheckCheckedSignOutMutation',
      'recheckEmailSignInMutation',
    ],
  ],
  [
    'src/modules/identity/infrastructure/web-recovery-rate-limit.ts',
    'src/composition/identity-auth-mutations.ts',
    ['createScopedWebRecoveryRateLimitGateway'],
  ],
  [
    'src/modules/identity/infrastructure/web-recovery-rate-limit.ts',
    'src/modules/identity/recovery/member-reset.ts',
    ['admitWebRecoveryAttempt', 'isWebRecoveryAttemptThrottled'],
  ],
  [
    'src/modules/identity/infrastructure/web-recovery-rate-limit.ts',
    'src/modules/identity/recovery/owner-recovery.ts',
    ['admitWebRecoveryAttempt', 'isWebRecoveryAttemptThrottled'],
  ],
  [
    'src/modules/identity/infrastructure/action-binding.ts',
    'src/composition/identity-auth-mutations.ts',
    ['verifyCheckedSignOutActionBinding', 'verifyEmailSignInActionBinding'],
  ],
  [
    'src/modules/identity/infrastructure/action-binding.ts',
    'src/composition/identity-bootstrap-mutations.ts',
    ['verifyOwnerBootstrapActionBinding'],
  ],
  [
    'src/modules/identity/infrastructure/action-binding.ts',
    'src/modules/identity/server/actor.ts',
    ['issueCheckedSignOutActionBinding'],
  ],
  [
    'src/modules/identity/infrastructure/action-binding.ts',
    'src/modules/identity/server/sign-in-page.ts',
    ['issueEmailSignInActionBinding'],
  ],
  [
    'src/modules/identity/infrastructure/action-binding.ts',
    'src/modules/identity/server/bootstrap.ts',
    ['issueOwnerBootstrapActionBinding'],
  ],
  [
    'src/modules/identity/infrastructure/bootstrap-mutation.ts',
    'src/composition/identity-bootstrap-mutations.ts',
    [
      'captureOwnerBootstrapIssuance',
      'captureOwnerBootstrapRedemption',
      'createScopedIdentityBootstrapMutationGateway',
      'ownerBootstrapIssuanceCaptureView',
      'ownerBootstrapRedemptionCaptureView',
      'recheckOwnerBootstrapIssuance',
      'recheckOwnerBootstrapRedemption',
    ],
  ],
  [
    'src/modules/identity/infrastructure/expired-session-cleanup.ts',
    'src/composition/identity-auth-mutations.ts',
    ['cleanupExpiredAccountSessions'],
  ],
  [
    'src/platform/application-coordination/scoped-drizzle.ts',
    'src/composition/identity-auth-mutations.ts',
    ['createScopedDrizzleDatabase'],
  ],
  [
    'src/platform/application-coordination/scoped-drizzle.ts',
    'src/composition/identity-bootstrap-mutations.ts',
    ['createScopedDrizzleDatabase'],
  ],
  [
    'src/platform/application-coordination/runtime-unit-of-work.ts',
    'src/composition/identity-auth-mutations.ts',
    ['createRuntimePostgresUnitOfWork'],
  ],
  [
    'src/platform/application-coordination/runtime-unit-of-work.ts',
    'src/composition/identity-bootstrap-mutations.ts',
    ['createRuntimePostgresUnitOfWork'],
  ],
  [
    'src/platform/db/external-host-command.ts',
    'src/composition/identity-bootstrap-mutations.ts',
    ['withExternalHostCommand'],
  ],
  [
    'src/modules/identity/server/auth-mutation-port.ts',
    'src/composition/identity-auth-mutations.ts',
    ['emailSignInMutationCommandView'],
  ],
  [
    'src/modules/identity/server/auth-mutation-port.ts',
    'src/modules/identity/server/auth-handler.ts',
    ['createEmailSignInMutationCommand', 'emailSignInMutationCommandView'],
  ],
  [
    'src/modules/identity/infrastructure/auth.ts',
    'src/composition/identity-auth-mutations.ts',
    ['clearProvenAbsentIdentitySession', 'verifyIdentitySessionCookie'],
  ],
  [
    'src/modules/identity/infrastructure/auth.ts',
    'src/modules/identity/server/actor.ts',
    ['readIdentitySession'],
  ],
  [
    'src/modules/identity/infrastructure/auth.ts',
    'src/modules/identity/server/auth-handler.ts',
    ['handleIdentityGetSession'],
  ],
  [
    'src/modules/identity/infrastructure/identity-auth-config.ts',
    'src/modules/identity/infrastructure/auth.ts',
    ['createIdentityAuthOptions', 'identityAuthDatabaseSchema'],
  ],
  [
    'src/modules/identity/infrastructure/identity-auth-config.ts',
    'src/modules/identity/infrastructure/scoped-mutation-auth.ts',
    ['createIdentityAuthOptions', 'identityAuthDatabaseSchema'],
  ],
  [
    'src/modules/identity/infrastructure/credential-load-shedder.ts',
    'src/modules/identity/infrastructure/auth.ts',
    ['resetCredentialLoadShedderForTests'],
  ],
  [
    'src/modules/identity/infrastructure/credential-load-shedder.ts',
    'src/modules/identity/server/auth-handler.ts',
    ['admitCredentialLoadShedder'],
  ],
  [
    'src/modules/identity/infrastructure/credential-load-shedder.ts',
    'src/modules/identity/server/bootstrap.ts',
    ['admitCredentialLoadShedder'],
  ],
  [
    'src/composition/identity-auth-mutations.ts',
    'src/app/api/auth/[...all]/route.ts',
    ['getProductionIdentityAuthMutationPort'],
  ],
  [
    'src/composition/identity-bootstrap-mutations.ts',
    'src/modules/identity/server/bootstrap.ts',
    ['createOwnerFromWebWithBootstrapCode'],
  ],
])

const externalHostBootstrapPolicies = policy([
  [
    'src/platform/db/external-host-command.ts',
    'src/composition/identity-bootstrap-mutations.ts',
    ['withExternalHostCommand'],
  ],
  [
    'src/composition/identity-bootstrap-mutations.ts',
    'src/modules/identity/server/bootstrap.ts',
    ['createOwnerFromWebWithBootstrapCode'],
  ],
  [
    'src/composition/identity-bootstrap-mutations.ts',
    'scripts/identity/bootstrap-owner.ts',
    ['issueOwnerBootstrapFromHostCli'],
  ],
  [
    'src/composition/identity-bootstrap-mutations.ts',
    'scripts/llm/dry-run-session-synthesize.ts',
    ['createOwnerWithBootstrapCode', 'issueOwnerBootstrap'],
  ],
])

describe('Identity authentication cutover boundaries', () => {
  const sourceFiles = readCodeSources(sourceRoot)
  const productionFiles = new Map([
    ...sourceFiles,
    ...readCodeSources(resolve(process.cwd(), 'scripts')),
  ])

  it('keeps every scoped/provider/capture seam on exact audited consumers', () => {
    expect(exactRuntimeImportViolations(sourceFiles, identityAuthPolicies)).toEqual([])
  })

  it('seals the external-host adapter and bootstrap composition across src and scripts', () => {
    expect(
      exactRuntimeImportViolations(productionFiles, externalHostBootstrapPolicies),
    ).toEqual([])

    const rogue = resolve(process.cwd(), 'scripts/identity/rogue-host-capture.ts')
    const synthetic = new Map(productionFiles)
    synthetic.set(
      rogue,
      "import { withExternalHostCommand } from '@/platform/db/external-host-command'\nvoid withExternalHostCommand\n",
    )
    expect(
      exactRuntimeImportViolations(synthetic, externalHostBootstrapPolicies),
    ).toContain(
      'scripts/identity/rogue-host-capture.ts: unauthorized broad import -> src/platform/db/external-host-command.ts',
    )
  })

  it('detects aliases, re-exports, literal and computed loading outside the root', () => {
    const rogue = resolve(sourceRoot, 'modules/programs/infrastructure/rogue-auth.ts')
    for (const [source, expected] of [
      [
        "import { createScopedIdentityMutationGateway as bypass } from '@/modules/identity/infrastructure/scoped-mutation-auth'\nvoid bypass\n",
        'unauthorized broad import',
      ],
      [
        "import '@/modules/identity/infrastructure/scoped-mutation-auth'\n",
        'unauthorized broad import',
      ],
      [
        "export { createScopedIdentityMutationGateway } from '@/modules/identity/infrastructure/scoped-mutation-auth'\n",
        'runtime re-export',
      ],
      [
        "const auth = require('@/modules/identity/infrastructure/scoped-mutation-auth')\nvoid auth\n",
        'non-static import',
      ],
      [
        "const target = '@/modules/identity/infrastructure/scoped-mutation-auth'\nvoid import(target)\n",
        'computed dynamic-import',
      ],
      [
        "const target = '@/modules/identity/infrastructure/scoped-mutation-auth'\nvoid require(target)\n",
        'computed require',
      ],
    ] as const) {
      const mutated = new Map(sourceFiles)
      mutated.set(rogue, source)
      expect(
        exactRuntimeImportViolations(mutated, identityAuthPolicies).join('\n'),
      ).toContain(expected)
    }
  })

  it('keeps client-component dependency closures away from server auth and database code', () => {
    const graph = analyzeImportGraph(sourceFiles, { sourceRoot })
    const runtimeDependencies = runtimeDependencyKeys(sourceFiles)
    const outgoing = new Map<string, string[]>()
    for (const edge of graph.edges) {
      if (
        !edge.to ||
        !runtimeDependencies.has(`${edge.from}\0${edge.kind}\0${edge.specifier}`)
      ) {
        continue
      }
      const targets = outgoing.get(edge.from) ?? []
      targets.push(edge.to)
      outgoing.set(edge.from, targets)
    }
    const violations: string[] = []
    for (const [root, source] of sourceFiles) {
      if (!/^\s*['"]use client['"];?/m.test(source) || !isProductionSource(root)) {
        continue
      }
      const pending = [root]
      const seen = new Set<string>()
      while (pending.length > 0) {
        const current = pending.pop() as string
        if (seen.has(current)) continue
        seen.add(current)
        if (
          current !== root &&
          /^\s*['"]use server['"];?/m.test(sourceFiles.get(current) ?? '')
        ) {
          continue
        }
        const currentPath = projectPath(current)
        if (
          current !== root &&
          (currentPath === 'src/composition' ||
            currentPath.startsWith('src/composition/') ||
            currentPath.includes('/infrastructure/') ||
            currentPath.includes('/server/') ||
            currentPath.startsWith('src/platform/db/') ||
            currentPath === 'src/platform/config/server.ts')
        ) {
          violations.push(`${projectPath(root)} -> ${currentPath}`)
          continue
        }
        pending.push(...(outgoing.get(current) ?? []))
      }
    }
    expect(violations.sort()).toEqual([])
  })
})
