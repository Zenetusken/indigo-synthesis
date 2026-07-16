import { CoordinationError, type SubjectExportRequest } from '@/application/coordination'
import {
  DataExportError,
  type FinalizedDataExport,
  finalizeDataExport,
} from '@/modules/data-portability/application/export'
import {
  createScopedSubjectExportGateway,
  type SubjectExportFiles,
  SubjectExportGraphInvariantError,
} from '@/modules/data-portability/infrastructure/scoped-subject-export'
import {
  captureSubjectExportAuthority,
  IdentitySubjectExportAuthorityUnavailableError,
  IdentitySubjectExportCommandError,
  IdentitySubjectExportInvariantError,
  recheckSubjectExportAuthority,
  subjectExportAuthorityView,
} from '@/modules/identity/infrastructure/subject-export-authority'
import type { SubjectExportCommand } from '@/modules/identity/server/subject-export-command'
import {
  createInstallationMutationEpoch,
  installationMutationEpochMatches,
} from '@/platform/application-coordination/lifecycle-values'
import {
  type CapturedIdentityAuthority,
  createPlatformMutationAuthorityIssuer,
} from '@/platform/application-coordination/mutation-authority'
import { createRuntimePostgresUnitOfWork } from '@/platform/application-coordination/runtime-unit-of-work'
import { createScopedDrizzleDatabase } from '@/platform/application-coordination/scoped-drizzle'
import {
  CredentialConnectionCapacityError,
  withTrustedCredentialCapture,
} from '@/platform/db/credential-connections'

const authorityIssuer = createPlatformMutationAuthorityIssuer()

export type SubjectExportResult =
  | Readonly<{
      kind: 'exported'
      archive: FinalizedDataExport<SubjectExportFiles>
    }>
  | Readonly<{ kind: 'stale' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'invalid' }>

export type DataPortabilitySubjectExportPort = Readonly<{
  create(
    command: SubjectExportCommand,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<SubjectExportResult>
}>

function identityRecheckFailure(
  reason: 'installation-epoch-changed' | string,
): CoordinationError {
  return new CoordinationError(
    reason === 'installation-epoch-changed'
      ? 'product-mutation.epoch-changed'
      : 'identity.authority-stale',
  )
}

function assertSubjectExportAuthority(
  captured: CapturedIdentityAuthority,
  expected: Readonly<{
    epoch: string
    actorUserId: string
    sessionId: string
    expectedRole: 'owner' | 'member'
  }>,
): void {
  if (
    captured.kind !== 'authenticated-session' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.actorUserId !== expected.actorUserId ||
    captured.sessionId !== expected.sessionId ||
    captured.expectedRole !== expected.expectedRole
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function mappedFailure(
  error: unknown,
): Exclude<SubjectExportResult, { kind: 'exported' }> | null {
  if (
    error instanceof IdentitySubjectExportAuthorityUnavailableError ||
    error instanceof IdentitySubjectExportCommandError
  ) {
    return Object.freeze({ kind: 'stale' })
  }
  if (
    error instanceof IdentitySubjectExportInvariantError ||
    error instanceof SubjectExportGraphInvariantError
  ) {
    return Object.freeze({ kind: 'invalid' })
  }
  if (error instanceof CredentialConnectionCapacityError) {
    return Object.freeze({ kind: 'unavailable' })
  }
  if (error instanceof DataExportError) {
    return error.code === 'export.subject-missing'
      ? Object.freeze({ kind: 'stale' })
      : Object.freeze({ kind: 'invalid' })
  }
  if (!(error instanceof CoordinationError)) return null
  if (
    error.code === 'identity.authority-stale' ||
    error.code === 'product-mutation.epoch-changed'
  ) {
    return Object.freeze({ kind: 'stale' })
  }
  if (error.code.startsWith('uow.')) {
    return Object.freeze({ kind: 'unavailable' })
  }
  return null
}

async function createSubjectExport(
  command: SubjectExportCommand,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<SubjectExportResult> {
  try {
    const capture = await withTrustedCredentialCapture(
      (query) => captureSubjectExportAuthority(query, command),
      { signal: options.signal },
    )
    const view = subjectExportAuthorityView(capture)
    const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
    const issued = authorityIssuer.authenticatedSession({
      expectedEpoch,
      actorUserId: view.actorUserId,
      sessionId: view.sessionId,
      expectedRole: view.expectedRole,
    })
    const unitOfWork = createRuntimePostgresUnitOfWork(
      ({ client, request, capturedAuthority }) => {
        const gateway = createScopedSubjectExportGateway(
          createScopedDrizzleDatabase(client),
          { subjectUserId: view.actorUserId },
        )
        const readGateways = Object.freeze({ subjectExport: gateway })
        return {
          async recheckIdentity(): Promise<void> {
            assertSubjectExportAuthority(capturedAuthority, {
              epoch: view.expectedEpoch,
              actorUserId: view.actorUserId,
              sessionId: view.sessionId,
              expectedRole: view.expectedRole,
            })
            if (
              request.operation !== 'subject-export' ||
              request.subjectLock.subjectUserId !== view.actorUserId
            ) {
              throw new CoordinationError('identity.authority-stale')
            }
            const recheck = await recheckSubjectExportAuthority(client, capture)
            if (recheck.status === 'stale') {
              throw identityRecheckFailure(recheck.reason)
            }
          },
          readGateways,
          writeGateways: readGateways,
        }
      },
    )
    const request: SubjectExportRequest = {
      operation: 'subject-export',
      authority: issued.authority,
      session: { kind: 'ordinary' },
      expectedEpoch,
      productFence: 'shared',
      subjectLock: { subjectUserId: view.actorUserId, mode: 'shared' },
      content: { kind: 'none' },
      mode: { isolation: 'repeatable-read', access: 'read-only' },
      ...(options.signal ? { signal: options.signal } : {}),
    }
    const files = await unitOfWork.run(request, ({ gateways }) =>
      gateways.subjectExport.readFiles(),
    )
    return Object.freeze({
      kind: 'exported',
      archive: finalizeDataExport(view.actorUserId, files),
    })
  } catch (error) {
    if (options.signal?.aborted) return Object.freeze({ kind: 'unavailable' })
    const mapped = mappedFailure(error)
    if (mapped) return mapped
    throw error
  }
}

const productionDataPortabilitySubjectExportPort: DataPortabilitySubjectExportPort =
  Object.freeze({ create: createSubjectExport })

export function getProductionDataPortabilitySubjectExportPort(): DataPortabilitySubjectExportPort {
  return productionDataPortabilitySubjectExportPort
}
