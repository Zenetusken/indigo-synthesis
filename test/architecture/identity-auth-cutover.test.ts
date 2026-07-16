import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

function policyTargetStubs(policies: ImportPolicy): Map<string, string> {
  return new Map(
    [...policies.keys()].map(
      (target) => [resolve(process.cwd(), target), 'export {}'] as const,
    ),
  )
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

function sealTargets(policies: ImportPolicy, targets: readonly string[]): ImportPolicy {
  const result = new Map(policies)
  for (const target of targets) {
    if (!result.has(target)) result.set(target, new Map())
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
    'src/modules/identity/infrastructure/scoped-browser-recovery.ts',
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
    'src/composition/identity-credential-administration.ts',
    ['verifyLocalUserCreateActionBinding', 'verifyMemberResetIssueActionBinding'],
  ],
  [
    'src/modules/identity/infrastructure/action-binding.ts',
    'src/composition/data-portability-destructive-mutations.ts',
    ['verifyInstanceResetActionBinding', 'verifyTraineeDataDeletionActionBinding'],
  ],
  [
    'src/modules/identity/infrastructure/action-binding.ts',
    'src/composition/identity-recovery-mutations.ts',
    [
      'verifyMemberResetRedemptionActionBinding',
      'verifyOwnerRecoveryRedemptionActionBinding',
    ],
  ],
  [
    'src/modules/identity/infrastructure/action-binding.ts',
    'src/modules/identity/server/actor.ts',
    [
      'issueCheckedSignOutActionBinding',
      'issueInstanceResetActionBinding',
      'issueLocalUserCreateActionBinding',
      'issueMemberResetIssueActionBinding',
      'issueTraineeDataDeletionActionBinding',
    ],
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
    'src/modules/identity/infrastructure/action-binding.ts',
    'src/modules/identity/server/recovery-page.ts',
    [
      'issueMemberResetRedemptionActionBinding',
      'issueOwnerRecoveryRedemptionActionBinding',
    ],
  ],
  [
    'src/modules/identity/infrastructure/installation.ts',
    'src/modules/identity/server/actor.ts',
    ['getServerActorInstallationState'],
  ],
  [
    'src/modules/identity/infrastructure/installation.ts',
    'src/modules/identity/server/bootstrap.ts',
    ['getServerBootstrapInstallationState'],
  ],
  [
    'src/modules/identity/infrastructure/installation.ts',
    'src/modules/identity/server/recovery-page.ts',
    ['getServerRecoveryPageInstallationState'],
  ],
  [
    'src/modules/identity/infrastructure/installation.ts',
    'src/modules/identity/server/sign-in-page.ts',
    ['getServerSignInInstallationState'],
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
    'src/modules/identity/infrastructure/credential-administration-mutation.ts',
    'src/composition/identity-credential-administration.ts',
    [
      'CredentialAdministrationAuthorityUnavailableError',
      'CredentialAdministrationCaptureStaleError',
      'captureLocalUserCreationMutation',
      'captureMemberResetIssuanceMutation',
      'localUserCreationMutationCaptureView',
      'memberResetIssuanceMutationCaptureView',
      'recheckLocalUserCreationMutation',
      'recheckMemberResetIssuanceMutation',
    ],
  ],
  [
    'src/modules/identity/infrastructure/credential-administration-mutation.ts',
    'src/modules/identity/infrastructure/scoped-credential-reauthentication.ts',
    [
      'localUserCreationMutationCaptureView',
      'localUserCreationMutationScope',
      'memberResetIssuanceMutationCaptureView',
      'memberResetIssuanceMutationScope',
    ],
  ],
  [
    'src/modules/identity/infrastructure/credential-administration-mutation.ts',
    'src/modules/identity/infrastructure/scoped-credential-administration.ts',
    ['localUserCreationMutationScope', 'memberResetIssuanceMutationScope'],
  ],
  [
    'src/modules/identity/infrastructure/destructive-mutation.ts',
    'src/composition/data-portability-destructive-mutations.ts',
    [
      'IdentityDestructiveMutationAuthorityUnavailableError',
      'IdentityDestructiveMutationCaptureInvariantError',
      'IdentityDestructiveMutationCaptureStaleError',
      'captureInstanceResetMutation',
      'captureTraineeDataDeletionMutation',
      'instanceResetMutationCaptureView',
      'recheckInstanceResetMutation',
      'recheckTraineeDataDeletionMutation',
      'traineeDataDeletionMutationCaptureView',
    ],
  ],
  [
    'src/modules/identity/infrastructure/destructive-mutation.ts',
    'src/modules/identity/infrastructure/scoped-credential-reauthentication.ts',
    [
      'instanceResetMutationReauthenticationScope',
      'traineeDataDeletionMutationReauthenticationScope',
    ],
  ],
  [
    'src/modules/identity/infrastructure/destructive-mutation.ts',
    'src/modules/identity/server/destructive-command.ts',
    [
      'instanceResetMutationCommandView',
      'issueInstanceResetMutationCommand',
      'issueTraineeDataDeletionMutationCommand',
      'traineeDataDeletionMutationCommandView',
    ],
  ],
  [
    'src/modules/identity/infrastructure/subject-export-authority.ts',
    'src/composition/data-portability-subject-export.ts',
    [
      'IdentitySubjectExportAuthorityUnavailableError',
      'IdentitySubjectExportCommandError',
      'IdentitySubjectExportInvariantError',
      'captureSubjectExportAuthority',
      'recheckSubjectExportAuthority',
      'subjectExportAuthorityView',
    ],
  ],
  [
    'src/modules/identity/infrastructure/subject-export-authority.ts',
    'src/modules/identity/server/subject-export-command.ts',
    ['issueSubjectExportCommand'],
  ],
  [
    'src/modules/identity/server/subject-export-command.ts',
    'src/app/api/export/route.ts',
    ['captureSubjectExportCommand'],
  ],
  [
    'src/composition/data-portability-subject-export.ts',
    'src/app/api/export/route.ts',
    ['getProductionDataPortabilitySubjectExportPort'],
  ],
  [
    'src/modules/data-portability/infrastructure/scoped-subject-export.ts',
    'src/composition/data-portability-subject-export.ts',
    ['SubjectExportGraphInvariantError', 'createScopedSubjectExportGateway'],
  ],
  [
    'src/modules/data-portability/application/export.ts',
    'src/modules/data-portability/infrastructure/scoped-subject-export.ts',
    ['DataExportError'],
  ],
  [
    'src/modules/data-portability/application/export.ts',
    'src/composition/data-portability-subject-export.ts',
    ['DataExportError', 'finalizeDataExport'],
  ],
  [
    'src/modules/data-portability/application/export.ts',
    'src/modules/data-portability/application/deletion.ts',
    ['exportSchemaVersion'],
  ],
  [
    'src/modules/data-portability/application/export.ts',
    'src/modules/data-portability/infrastructure/scoped-destructive-adapter.ts',
    ['exportSchemaVersion'],
  ],
  [
    'src/modules/identity/infrastructure/recovery-mutation.ts',
    'src/composition/identity-recovery-mutations.ts',
    [
      'captureMemberResetRedemption',
      'captureOwnerRecoveryWebRedemption',
      'memberResetRedemptionCaptureView',
      'ownerRecoveryWebRedemptionCaptureView',
      'recheckMemberResetRedemption',
      'recheckOwnerRecoveryWebRedemption',
    ],
  ],
  [
    'src/modules/identity/infrastructure/recovery-mutation.ts',
    'src/composition/identity-host-recovery-mutations.ts',
    [
      'captureOwnerRecoveryCliRedemption',
      'captureOwnerRecoveryIssuance',
      'ownerRecoveryCliRedemptionCaptureView',
      'ownerRecoveryIssuanceCaptureView',
      'recheckOwnerRecoveryCliRedemption',
      'recheckOwnerRecoveryIssuance',
    ],
  ],
  [
    'src/modules/identity/infrastructure/recovery-mutation.ts',
    'src/modules/identity/infrastructure/scoped-browser-recovery.ts',
    [
      'claimMemberResetRedemptionMutationScope',
      'claimOwnerRecoveryWebRedemptionMutationScope',
    ],
  ],
  [
    'src/modules/identity/infrastructure/recovery-mutation.ts',
    'src/modules/identity/infrastructure/scoped-host-recovery.ts',
    [
      'claimOwnerRecoveryCliRedemptionMutationScope',
      'claimOwnerRecoveryIssuanceMutationScope',
    ],
  ],
  [
    'src/modules/identity/application/expired-session-maintenance.ts',
    'src/composition/identity-session-maintenance.ts',
    [
      'ExpiredSessionMaintenanceError',
      'parseExpiredSessionMaintenanceInput',
      'toExpiredSessionMaintenanceResult',
    ],
  ],
  [
    'src/modules/identity/application/expired-session-maintenance.ts',
    'scripts/identity/cleanup-expired-sessions.ts',
    ['ExpiredSessionMaintenanceError'],
  ],
  [
    'src/modules/identity/infrastructure/expired-session-maintenance.ts',
    'src/composition/identity-session-maintenance.ts',
    [
      'captureExpiredSessionMaintenance',
      'expiredSessionMaintenanceCaptureView',
      'recheckExpiredSessionMaintenance',
    ],
  ],
  [
    'src/modules/identity/infrastructure/expired-session-maintenance.ts',
    'src/modules/identity/infrastructure/scoped-expired-session-maintenance.ts',
    ['claimExpiredSessionMaintenanceMutationScope'],
  ],
  [
    'src/modules/identity/infrastructure/scoped-expired-session-maintenance.ts',
    'src/composition/identity-session-maintenance.ts',
    ['createScopedExpiredSessionMaintenanceMutationGateway'],
  ],
  [
    'src/modules/identity/infrastructure/scoped-credential-administration.ts',
    'src/composition/identity-credential-administration.ts',
    [
      'createScopedLocalUserCreationMutationGateway',
      'createScopedMemberResetIssuanceMutationGateway',
      'prepareLocalUserCreation',
    ],
  ],
  [
    'src/modules/identity/infrastructure/scoped-credential-reauthentication.ts',
    'src/composition/identity-credential-administration.ts',
    [
      'createScopedLocalUserCreationReauthenticationGateway',
      'createScopedMemberResetIssuanceReauthenticationGateway',
    ],
  ],
  [
    'src/modules/identity/infrastructure/scoped-credential-reauthentication.ts',
    'src/composition/data-portability-destructive-mutations.ts',
    [
      'createScopedInstanceResetReauthenticationGateway',
      'createScopedSubjectDeletionReauthenticationGateway',
    ],
  ],
  [
    'src/modules/identity/infrastructure/scoped-browser-recovery.ts',
    'src/composition/identity-recovery-mutations.ts',
    [
      'createScopedMemberResetRedemptionMutationGateway',
      'createScopedOwnerRecoveryWebRedemptionMutationGateway',
    ],
  ],
  [
    'src/modules/identity/infrastructure/scoped-host-recovery.ts',
    'src/composition/identity-host-recovery-mutations.ts',
    [
      'createScopedOwnerRecoveryCliRedemptionMutationGateway',
      'createScopedOwnerRecoveryIssuanceMutationGateway',
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
    'src/platform/application-coordination/scoped-drizzle.ts',
    'src/composition/identity-credential-administration.ts',
    ['createScopedDrizzleDatabase'],
  ],
  [
    'src/platform/application-coordination/scoped-drizzle.ts',
    'src/composition/data-portability-destructive-mutations.ts',
    ['createScopedDrizzleDatabase'],
  ],
  [
    'src/platform/application-coordination/scoped-drizzle.ts',
    'src/composition/data-portability-subject-export.ts',
    ['createScopedDrizzleDatabase'],
  ],
  [
    'src/platform/application-coordination/scoped-drizzle.ts',
    'src/composition/identity-recovery-mutations.ts',
    ['createScopedDrizzleDatabase'],
  ],
  [
    'src/platform/application-coordination/scoped-drizzle.ts',
    'src/composition/identity-host-recovery-mutations.ts',
    ['createScopedDrizzleDatabase'],
  ],
  [
    'src/platform/application-coordination/scoped-drizzle.ts',
    'src/composition/identity-session-maintenance.ts',
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
    'src/platform/application-coordination/runtime-unit-of-work.ts',
    'src/composition/identity-credential-administration.ts',
    ['createRuntimePostgresUnitOfWork'],
  ],
  [
    'src/platform/application-coordination/runtime-unit-of-work.ts',
    'src/composition/data-portability-destructive-mutations.ts',
    ['createRuntimePostgresUnitOfWork'],
  ],
  [
    'src/platform/application-coordination/runtime-unit-of-work.ts',
    'src/composition/data-portability-subject-export.ts',
    ['createRuntimePostgresUnitOfWork'],
  ],
  [
    'src/platform/application-coordination/runtime-unit-of-work.ts',
    'src/composition/identity-recovery-mutations.ts',
    ['createRuntimePostgresUnitOfWork'],
  ],
  [
    'src/platform/application-coordination/runtime-unit-of-work.ts',
    'src/composition/identity-host-recovery-mutations.ts',
    ['createRuntimePostgresUnitOfWork'],
  ],
  [
    'src/platform/application-coordination/runtime-unit-of-work.ts',
    'src/composition/identity-session-maintenance.ts',
    ['createRuntimePostgresUnitOfWork'],
  ],
  [
    'src/platform/db/external-host-command.ts',
    'src/composition/identity-bootstrap-mutations.ts',
    ['withExternalHostCommand'],
  ],
  [
    'src/platform/db/external-host-command.ts',
    'src/composition/identity-host-recovery-mutations.ts',
    ['withExternalHostCommand'],
  ],
  [
    'src/platform/db/external-host-command.ts',
    'src/composition/identity-session-maintenance.ts',
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
    'src/modules/identity/server/credential-administration-command.ts',
    'src/app/settings/actions.ts',
    [
      'captureLocalUserCreationMutationCommand',
      'captureMemberResetIssuanceMutationCommand',
    ],
  ],
  [
    'src/modules/identity/server/credential-administration-command.ts',
    'src/composition/identity-credential-administration.ts',
    ['localUserCreationMutationCommandView', 'memberResetIssuanceMutationCommandView'],
  ],
  [
    'src/modules/identity/server/destructive-command.ts',
    'src/app/settings/delete-account/actions.ts',
    ['captureTraineeDataDeletionMutationCommand'],
  ],
  [
    'src/modules/identity/server/destructive-command.ts',
    'src/app/settings/delete/actions.ts',
    ['captureInstanceResetMutationCommand'],
  ],
  [
    'src/modules/identity/server/destructive-command.ts',
    'src/composition/data-portability-destructive-mutations.ts',
    ['instanceResetCommandView', 'traineeDataDeletionCommandView'],
  ],
  [
    'src/modules/identity/server/recovery-page.ts',
    'src/app/reset/page.tsx',
    ['getMemberResetPageInstallation'],
  ],
  [
    'src/modules/identity/server/recovery-page.ts',
    'src/app/recover/page.tsx',
    ['getOwnerRecoveryPageInstallation'],
  ],
  [
    'src/modules/identity/server/recovery-redemption-command.ts',
    'src/app/reset/actions.ts',
    ['captureMemberResetRedemptionMutationCommand'],
  ],
  [
    'src/modules/identity/server/recovery-redemption-command.ts',
    'src/app/recover/actions.ts',
    ['captureOwnerRecoveryRedemptionMutationCommand'],
  ],
  [
    'src/modules/identity/server/recovery-redemption-command.ts',
    'src/composition/identity-recovery-mutations.ts',
    [
      'memberResetRedemptionMutationCommandView',
      'ownerRecoveryRedemptionMutationCommandView',
    ],
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
    'src/modules/identity/server/credential-administration-command.ts',
    ['verifyIdentitySessionCookie'],
  ],
  [
    'src/modules/identity/infrastructure/auth.ts',
    'src/modules/identity/server/destructive-command.ts',
    ['verifyIdentitySessionCookie'],
  ],
  [
    'src/modules/identity/infrastructure/auth.ts',
    'src/modules/identity/server/subject-export-command.ts',
    ['verifyIdentitySessionCookie'],
  ],
  [
    'src/modules/identity/infrastructure/auth.ts',
    'src/modules/identity/server/auth-handler.ts',
    ['handleIdentityGetSession'],
  ],
  [
    'src/modules/identity/infrastructure/auth.ts',
    'scripts/db/reset-e2e.ts',
    ['resetAuthForTests'],
  ],
  [
    'src/modules/identity/infrastructure/auth.ts',
    'scripts/llm/dry-run-session-synthesize.ts',
    ['resetAuthForTests'],
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
    'src/modules/identity/infrastructure/credential-load-shedder.ts',
    'src/modules/identity/server/recovery-redemption-command.ts',
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
  [
    'src/composition/identity-credential-administration.ts',
    'src/app/settings/actions.ts',
    ['getProductionIdentityCredentialAdministrationMutationPort'],
  ],
  [
    'src/composition/identity-recovery-mutations.ts',
    'src/app/reset/actions.ts',
    ['getProductionIdentityRecoveryMutationPort'],
  ],
  [
    'src/composition/identity-recovery-mutations.ts',
    'src/app/recover/actions.ts',
    ['getProductionIdentityRecoveryMutationPort'],
  ],
  [
    'src/composition/identity-host-recovery-mutations.ts',
    'scripts/identity/recover-owner.ts',
    ['issueOwnerRecoveryFromHostCli', 'redeemOwnerRecoveryFromHostCli'],
  ],
  [
    'src/composition/identity-session-maintenance.ts',
    'scripts/identity/cleanup-expired-sessions.ts',
    ['cleanupExpiredSessionsFromHostCli'],
  ],
  [
    'src/modules/data-portability/infrastructure/scoped-destructive-adapter.ts',
    'src/composition/data-portability-destructive-mutations.ts',
    [
      'createScopedInstanceResetAttemptGateway',
      'createScopedInstanceResetGateway',
      'createScopedSubjectDeletionAttemptGateway',
      'createScopedSubjectDeletionGateway',
    ],
  ],
  [
    'src/composition/data-portability-destructive-mutations.ts',
    'src/app/settings/delete-account/actions.ts',
    ['getProductionDataPortabilityDestructiveMutationPort'],
  ],
  [
    'src/composition/data-portability-destructive-mutations.ts',
    'src/app/settings/delete/actions.ts',
    ['getProductionDataPortabilityDestructiveMutationPort'],
  ],
  [
    'src/modules/data-portability/infrastructure/destructive-notice-receipt.ts',
    'src/modules/data-portability/server/destructive-notice.ts',
    [
      'issueInstanceResetNoticeReceipt',
      'issueSubjectDeletionNoticeReceipt',
      'verifyInstanceResetNoticeReceipt',
      'verifyInstanceResetNoticeReceiptForActor',
      'verifySubjectDeletionNoticeReceipt',
      'verifySubjectDeletionNoticeReceiptForActor',
    ],
  ],
  [
    'src/modules/data-portability/server/destructive-notice.ts',
    'src/app/settings/delete-account/actions.ts',
    ['issueSubjectDeletionNoticeReceipt'],
  ],
  [
    'src/modules/data-portability/server/destructive-notice.ts',
    'src/app/settings/delete/actions.ts',
    ['issueInstanceResetNoticeReceipt'],
  ],
  [
    'src/modules/data-portability/server/destructive-notice.ts',
    'src/app/settings/delete-account/page.tsx',
    ['verifySubjectDeletionNoticeReceiptForActor'],
  ],
  [
    'src/modules/data-portability/server/destructive-notice.ts',
    'src/app/settings/delete/page.tsx',
    ['verifyInstanceResetNoticeReceiptForActor'],
  ],
  [
    'src/modules/data-portability/server/destructive-notice.ts',
    'src/app/settings/page.tsx',
    ['verifySubjectDeletionNoticeReceiptForActor'],
  ],
  [
    'src/modules/data-portability/server/destructive-notice.ts',
    'src/app/sign-in/page.tsx',
    [
      'verifyInstanceResetNoticeReceipt',
      'verifyInstanceResetNoticeReceiptForActor',
      'verifySubjectDeletionNoticeReceipt',
      'verifySubjectDeletionNoticeReceiptForActor',
    ],
  ],
  [
    'src/modules/data-portability/server/destructive-notice.ts',
    'src/app/bootstrap/page.tsx',
    ['verifyInstanceResetNoticeReceipt'],
  ],
  [
    'src/modules/identity/recovery/owner-recovery-contract.ts',
    'src/composition/identity-host-recovery-mutations.ts',
    ['OwnerRecoveryError'],
  ],
  [
    'src/modules/identity/recovery/owner-recovery-contract.ts',
    'src/modules/identity/recovery/owner-recovery.ts',
    ['OwnerRecoveryError'],
  ],
  [
    'src/modules/identity/recovery/owner-recovery-contract.ts',
    'scripts/identity/recover-owner.ts',
    ['OwnerRecoveryError'],
  ],
])

const externalHostIdentityPolicies = sealTargets(
  policy([
    [
      'src/platform/db/external-host-command.ts',
      'src/composition/identity-bootstrap-mutations.ts',
      ['withExternalHostCommand'],
    ],
    [
      'src/platform/db/external-host-command.ts',
      'src/composition/identity-host-recovery-mutations.ts',
      ['withExternalHostCommand'],
    ],
    [
      'src/platform/db/external-host-command.ts',
      'src/composition/identity-session-maintenance.ts',
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
    [
      'src/composition/identity-host-recovery-mutations.ts',
      'scripts/identity/recover-owner.ts',
      ['issueOwnerRecoveryFromHostCli', 'redeemOwnerRecoveryFromHostCli'],
    ],
    [
      'src/composition/identity-session-maintenance.ts',
      'scripts/identity/cleanup-expired-sessions.ts',
      ['cleanupExpiredSessionsFromHostCli'],
    ],
    [
      'src/modules/identity/application/expired-session-maintenance.ts',
      'src/composition/identity-session-maintenance.ts',
      [
        'ExpiredSessionMaintenanceError',
        'parseExpiredSessionMaintenanceInput',
        'toExpiredSessionMaintenanceResult',
      ],
    ],
    [
      'src/modules/identity/application/expired-session-maintenance.ts',
      'scripts/identity/cleanup-expired-sessions.ts',
      ['ExpiredSessionMaintenanceError'],
    ],
    [
      'src/modules/identity/infrastructure/expired-session-maintenance.ts',
      'src/composition/identity-session-maintenance.ts',
      [
        'captureExpiredSessionMaintenance',
        'expiredSessionMaintenanceCaptureView',
        'recheckExpiredSessionMaintenance',
      ],
    ],
    [
      'src/modules/identity/infrastructure/expired-session-maintenance.ts',
      'src/modules/identity/infrastructure/scoped-expired-session-maintenance.ts',
      ['claimExpiredSessionMaintenanceMutationScope'],
    ],
    [
      'src/modules/identity/infrastructure/scoped-expired-session-maintenance.ts',
      'src/composition/identity-session-maintenance.ts',
      ['createScopedExpiredSessionMaintenanceMutationGateway'],
    ],
    [
      'src/modules/identity/recovery/owner-recovery-contract.ts',
      'src/composition/identity-host-recovery-mutations.ts',
      ['OwnerRecoveryError'],
    ],
    [
      'src/modules/identity/recovery/owner-recovery-contract.ts',
      'src/modules/identity/recovery/owner-recovery.ts',
      ['OwnerRecoveryError'],
    ],
    [
      'src/modules/identity/recovery/owner-recovery-contract.ts',
      'scripts/identity/recover-owner.ts',
      ['OwnerRecoveryError'],
    ],
  ]),
  [
    'src/modules/identity/recovery/member-reset.ts',
    'src/modules/identity/recovery/owner-recovery.ts',
  ],
)

describe('Identity authentication cutover boundaries', () => {
  const sourceFiles = readCodeSources(sourceRoot)
  const productionFiles = new Map([
    ...sourceFiles,
    ...readCodeSources(resolve(process.cwd(), 'scripts')),
  ])

  it('keeps every scoped/provider/capture seam on exact audited consumers', () => {
    expect(exactRuntimeImportViolations(productionFiles, identityAuthPolicies)).toEqual(
      [],
    )

    const rogue = resolve(process.cwd(), 'scripts/identity/rogue-recovery.ts')
    const synthetic = policyTargetStubs(identityAuthPolicies)
    synthetic.set(
      rogue,
      "import { createScopedMemberResetRedemptionMutationGateway } from '@/modules/identity/infrastructure/scoped-browser-recovery'\nvoid createScopedMemberResetRedemptionMutationGateway\n",
    )
    expect(exactRuntimeImportViolations(synthetic, identityAuthPolicies)).toContain(
      'scripts/identity/rogue-recovery.ts: unauthorized broad import -> src/modules/identity/infrastructure/scoped-browser-recovery.ts',
    )
  })

  it('seals destructive command issuance, ingress, and scoped reauthentication', () => {
    const rogue = resolve(process.cwd(), 'scripts/identity/rogue-destructive.ts')
    for (const [source, expected] of [
      [
        "import { issueTraineeDataDeletionMutationCommand } from '@/modules/identity/infrastructure/destructive-mutation'\nvoid issueTraineeDataDeletionMutationCommand\n",
        'scripts/identity/rogue-destructive.ts: unauthorized broad import -> src/modules/identity/infrastructure/destructive-mutation.ts',
      ],
      [
        "import { captureTraineeDataDeletionMutationCommand } from '@/modules/identity/server/destructive-command'\nvoid captureTraineeDataDeletionMutationCommand\n",
        'scripts/identity/rogue-destructive.ts: unauthorized broad import -> src/modules/identity/server/destructive-command.ts',
      ],
      [
        "import { createScopedSubjectDeletionReauthenticationGateway } from '@/modules/identity/infrastructure/scoped-credential-reauthentication'\nvoid createScopedSubjectDeletionReauthenticationGateway\n",
        'scripts/identity/rogue-destructive.ts: unauthorized broad import -> src/modules/identity/infrastructure/scoped-credential-reauthentication.ts',
      ],
      [
        "import { createScopedSubjectDeletionGateway } from '@/modules/data-portability/infrastructure/scoped-destructive-adapter'\nvoid createScopedSubjectDeletionGateway\n",
        'scripts/identity/rogue-destructive.ts: unauthorized broad import -> src/modules/data-portability/infrastructure/scoped-destructive-adapter.ts',
      ],
      [
        "import { getProductionDataPortabilityDestructiveMutationPort } from '@/composition/data-portability-destructive-mutations'\nvoid getProductionDataPortabilityDestructiveMutationPort\n",
        'scripts/identity/rogue-destructive.ts: unauthorized broad import -> src/composition/data-portability-destructive-mutations.ts',
      ],
      [
        "import { issueSubjectDeletionNoticeReceipt } from '@/modules/data-portability/infrastructure/destructive-notice-receipt'\nvoid issueSubjectDeletionNoticeReceipt\n",
        'scripts/identity/rogue-destructive.ts: unauthorized broad import -> src/modules/data-portability/infrastructure/destructive-notice-receipt.ts',
      ],
      [
        "import { issueSubjectDeletionNoticeReceipt } from '@/modules/data-portability/server/destructive-notice'\nvoid issueSubjectDeletionNoticeReceipt\n",
        'scripts/identity/rogue-destructive.ts: unauthorized broad import -> src/modules/data-portability/server/destructive-notice.ts',
      ],
    ] as const) {
      const synthetic = policyTargetStubs(identityAuthPolicies)
      synthetic.set(rogue, source)
      expect(exactRuntimeImportViolations(synthetic, identityAuthPolicies)).toContain(
        expected,
      )
    }
  })

  it('keeps settings credential administration off every retired live mutation path', () => {
    const actions = resolve(sourceRoot, 'app/settings/actions.ts')
    const forbiddenTargets = new Set(
      [
        'modules/identity/infrastructure/destructive-reauthentication.ts',
        'modules/identity/infrastructure/local-users.ts',
        'modules/identity/recovery/member-reset.ts',
        'modules/identity/server/actor.ts',
        'modules/identity/server/credential-lifecycle.ts',
        'modules/identity/server/local-users.ts',
        'modules/identity/server/web-credential-context.ts',
        'platform/db/client.ts',
      ].map((path) => resolve(sourceRoot, path)),
    )
    const violations = (files: ReadonlyMap<string, string>) =>
      analyzeImportGraph(files, { sourceRoot })
        .edges.filter(
          (edge) => edge.from === actions && edge.to && forbiddenTargets.has(edge.to),
        )
        .map((edge) => `${projectPath(edge.from)} -> ${projectPath(edge.to as string)}`)
        .sort()

    expect(violations(sourceFiles)).toEqual([])

    const synthetic = new Map(sourceFiles)
    synthetic.set(
      actions,
      `${sourceFiles.get(actions) ?? ''}\nimport { issueMemberReset } from '@/modules/identity/recovery/member-reset'\nvoid issueMemberReset\n`,
    )
    expect(violations(synthetic)).toContain(
      'src/app/settings/actions.ts -> src/modules/identity/recovery/member-reset.ts',
    )
  })

  it('keeps browser recovery actions off every retired live mutation and database path', () => {
    const actions = [
      resolve(sourceRoot, 'app/reset/actions.ts'),
      resolve(sourceRoot, 'app/recover/actions.ts'),
    ]
    const forbiddenTargets = new Set(
      [
        'modules/identity/recovery/member-reset.ts',
        'modules/identity/recovery/owner-recovery.ts',
        'modules/identity/server/actor.ts',
        'modules/identity/server/credential-lifecycle.ts',
        'modules/identity/server/web-credential-context.ts',
        'platform/db/client.ts',
      ].map((path) => resolve(sourceRoot, path)),
    )
    const violations = (files: ReadonlyMap<string, string>) =>
      analyzeImportGraph(files, { sourceRoot })
        .edges.filter(
          (edge) =>
            actions.includes(edge.from) && edge.to && forbiddenTargets.has(edge.to),
        )
        .map((edge) => `${projectPath(edge.from)} -> ${projectPath(edge.to as string)}`)
        .sort()

    expect(violations(sourceFiles)).toEqual([])

    for (const [action, injectedImport, expected] of [
      [
        actions[0],
        "import { redeemMemberReset } from '@/modules/identity/recovery/member-reset'\nvoid redeemMemberReset\n",
        'src/app/reset/actions.ts -> src/modules/identity/recovery/member-reset.ts',
      ],
      [
        actions[1],
        "import { getDb } from '@/platform/db/client'\nvoid getDb\n",
        'src/app/recover/actions.ts -> src/platform/db/client.ts',
      ],
    ] as const) {
      const synthetic = new Map(sourceFiles)
      synthetic.set(action, `${sourceFiles.get(action) ?? ''}\n${injectedImport}`)
      expect(violations(synthetic)).toContain(expected)
    }
  })

  it('keeps external-host Identity work on dedicated compositions and off global or web paths', () => {
    const entries = [
      resolve(process.cwd(), 'scripts/identity/recover-owner.ts'),
      resolve(sourceRoot, 'composition/identity-host-recovery-mutations.ts'),
      resolve(process.cwd(), 'scripts/identity/cleanup-expired-sessions.ts'),
      resolve(sourceRoot, 'composition/identity-session-maintenance.ts'),
    ]
    const forbiddenTargets = new Set(
      [
        'modules/identity/infrastructure/scoped-browser-recovery.ts',
        'modules/identity/recovery/owner-recovery.ts',
        'platform/db/client.ts',
        'platform/db/credential-connections.ts',
      ].map((path) => resolve(sourceRoot, path)),
    )
    const violations = (files: ReadonlyMap<string, string>) => {
      const graph = analyzeImportGraph(files, { sourceRoot })
      const outgoing = new Map<string, string[]>()
      for (const edge of graph.edges) {
        if (!edge.to || !edge.runtime) continue
        const targets = outgoing.get(edge.from) ?? []
        targets.push(edge.to)
        outgoing.set(edge.from, targets)
      }

      const found = new Set<string>()
      for (const root of entries) {
        const pending = [root]
        const seen = new Set<string>()
        while (pending.length > 0) {
          const current = pending.pop() as string
          if (seen.has(current)) continue
          seen.add(current)
          for (const target of outgoing.get(current) ?? []) {
            if (forbiddenTargets.has(target)) {
              found.add(`${projectPath(root)} -> ${projectPath(target)}`)
            } else {
              pending.push(target)
            }
          }
        }
      }
      return [...found].sort()
    }

    expect(violations(productionFiles)).toEqual([])

    const synthetic = policyTargetStubs(externalHostIdentityPolicies)
    synthetic.set(
      resolve(sourceRoot, 'platform/db/client.ts'),
      'export const getDb = true',
    )
    synthetic.set(
      entries[0],
      `${productionFiles.get(entries[0]) ?? ''}\nimport { getDb } from '@/platform/db/client'\nvoid getDb\n`,
    )
    expect(violations(synthetic)).toContain(
      'scripts/identity/recover-owner.ts -> src/platform/db/client.ts',
    )

    const alternateLoader = new Map(synthetic)
    alternateLoader.set(
      entries[0],
      "void globalThis.module.require('@/platform/db/client')\n",
    )
    expect(violations(alternateLoader)).toContain(
      'scripts/identity/recover-owner.ts -> src/platform/db/client.ts',
    )

    const helper = resolve(sourceRoot, 'composition/rogue-host-recovery-helper.ts')
    const transitive = new Map<string, string>([
      [resolve(sourceRoot, 'platform/db/client.ts'), 'export const getDb = true'],
      [
        helper,
        "import { getDb } from '@/platform/db/client'\nexport const rogueHostRecoveryHelper = getDb\n",
      ],
    ])
    transitive.set(
      entries[1],
      "import { rogueHostRecoveryHelper } from './rogue-host-recovery-helper'\nvoid rogueHostRecoveryHelper\n",
    )
    expect(violations(transitive)).toContain(
      'src/composition/identity-host-recovery-mutations.ts -> src/platform/db/client.ts',
    )

    transitive.delete(entries[1])
    transitive.set(
      entries[3],
      "import { rogueHostRecoveryHelper } from './rogue-host-recovery-helper'\nvoid rogueHostRecoveryHelper\n",
    )
    expect(violations(transitive)).toContain(
      'src/composition/identity-session-maintenance.ts -> src/platform/db/client.ts',
    )
  })

  it('seals external-host Identity and retired browser recovery across src and scripts', () => {
    expect(
      exactRuntimeImportViolations(productionFiles, externalHostIdentityPolicies),
    ).toEqual([])

    const rogue = resolve(process.cwd(), 'scripts/identity/rogue-host-capture.ts')
    const synthetic = policyTargetStubs(externalHostIdentityPolicies)
    synthetic.set(
      rogue,
      "import { withExternalHostCommand } from '@/platform/db/external-host-command'\nvoid withExternalHostCommand\n",
    )
    expect(
      exactRuntimeImportViolations(synthetic, externalHostIdentityPolicies),
    ).toContain(
      'scripts/identity/rogue-host-capture.ts: unauthorized broad import -> src/platform/db/external-host-command.ts',
    )

    for (const [source, expected] of [
      [
        "import { redeemMemberReset } from '@/modules/identity/recovery/member-reset'\nvoid redeemMemberReset\n",
        'src/app/api/rogue-recovery/route.ts: unauthorized broad import -> src/modules/identity/recovery/member-reset.ts',
      ],
      [
        "import { redeemOwnerRecoveryWeb } from '@/modules/identity/recovery/owner-recovery'\nvoid redeemOwnerRecoveryWeb\n",
        'src/app/api/rogue-recovery/route.ts: unauthorized broad import -> src/modules/identity/recovery/owner-recovery.ts',
      ],
    ] as const) {
      const rogueRoute = resolve(sourceRoot, 'app/api/rogue-recovery/route.ts')
      const bypass = policyTargetStubs(externalHostIdentityPolicies)
      bypass.set(rogueRoute, source)
      expect(
        exactRuntimeImportViolations(bypass, externalHostIdentityPolicies),
      ).toContain(expected)
    }
  })

  it('detects aliases, re-exports, literal and computed loading outside the root', () => {
    const rogue = resolve(sourceRoot, 'modules/programs/infrastructure/rogue-auth.ts')
    const sealedTargetStubs = policyTargetStubs(identityAuthPolicies)
    const absoluteScopedMutationAuth = resolve(
      sourceRoot,
      'modules/identity/infrastructure/scoped-mutation-auth',
    )
    const fileUrlScopedMutationAuth = pathToFileURL(
      `${absoluteScopedMutationAuth}.ts`,
    ).href
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
        `import { createScopedIdentityMutationGateway } from '${absoluteScopedMutationAuth}'\nvoid createScopedIdentityMutationGateway\n`,
        'unauthorized broad import',
      ],
      [
        `import { createScopedIdentityMutationGateway } from '${fileUrlScopedMutationAuth}'\nvoid createScopedIdentityMutationGateway\n`,
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
      [
        "const load = require\nvoid load('@/modules/data-portability/infrastructure/scoped-destructive-adapter')\n",
        'computed require',
      ],
      [
        "void module.require('@/modules/data-portability/infrastructure/scoped-destructive-adapter')\n",
        'non-static import',
      ],
      [
        "import { createRequire as makeRequire } from 'node:module'\nconst load = makeRequire(import.meta.url)\nvoid load('@/modules/data-portability/infrastructure/scoped-destructive-adapter')\n",
        'computed require',
      ],
    ] as const) {
      const mutated = new Map(sealedTargetStubs)
      mutated.set(rogue, source)
      expect(
        exactRuntimeImportViolations(mutated, identityAuthPolicies).join('\n'),
      ).toContain(expected)
    }
  })

  it('keeps client-component dependency closures away from server auth and database code', () => {
    const graph = analyzeImportGraph(sourceFiles, { sourceRoot })
    const outgoing = new Map<string, string[]>()
    for (const edge of graph.edges) {
      if (!edge.to || !edge.runtime) continue
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
