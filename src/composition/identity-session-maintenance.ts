import {
  CoordinationError,
  type HostMaintenanceRequest,
  type PrelockedSessionPort,
} from '@/application/coordination'
import {
  ExpiredSessionMaintenanceError,
  type ExpiredSessionMaintenanceInput,
  type ExpiredSessionMaintenanceResult,
  type ParsedExpiredSessionMaintenanceInput,
  parseExpiredSessionMaintenanceInput,
  toExpiredSessionMaintenanceResult,
} from '@/modules/identity/application/expired-session-maintenance'
import {
  captureExpiredSessionMaintenance,
  type ExpiredSessionMaintenanceCapture,
  expiredSessionMaintenanceCaptureView,
  recheckExpiredSessionMaintenance,
} from '@/modules/identity/infrastructure/expired-session-maintenance'
import {
  createScopedExpiredSessionMaintenanceMutationGateway,
  type ScopedExpiredSessionMaintenanceResult,
} from '@/modules/identity/infrastructure/scoped-expired-session-maintenance'
import {
  createInstallationMutationEpoch,
  installationMutationEpochMatches,
} from '@/platform/application-coordination/lifecycle-values'
import {
  type CapturedIdentityAuthority,
  createPlatformMutationAuthorityIssuer,
} from '@/platform/application-coordination/mutation-authority'
import { createPlatformPrelockedSessionIntentFactory } from '@/platform/application-coordination/prelocked-session'
import { createRuntimePostgresUnitOfWork } from '@/platform/application-coordination/runtime-unit-of-work'
import { createScopedDrizzleDatabase } from '@/platform/application-coordination/scoped-drizzle'
import { withExternalHostCommand } from '@/platform/db/external-host-command'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

type ExpiredSessionMaintenanceRequest = Extract<
  HostMaintenanceRequest,
  { readonly authority: { readonly kind: 'expired-session-maintenance' } }
>

const authorityIssuer = createPlatformMutationAuthorityIssuer()
const intentFactory = createPlatformPrelockedSessionIntentFactory()
const emptyReadGateways = Object.freeze({})

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

function assertMaintenanceAuthority(
  captured: CapturedIdentityAuthority,
  expected: {
    readonly epoch: string
    readonly ownerUserId: string
    readonly hostInvocationId: string
    readonly cursor: string | null
    readonly batchSize: number
    readonly resolvedAccountUserIds: readonly string[]
  },
): void {
  if (
    captured.kind !== 'expired-session-maintenance' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.expectedOwnerUserId !== expected.ownerUserId ||
    captured.hostInvocationId !== expected.hostInvocationId ||
    captured.cursor !== expected.cursor ||
    captured.batchSize !== expected.batchSize ||
    !sameStrings(
      captured.resolvedAccountUserIds,
      [...expected.resolvedAccountUserIds].sort(),
    )
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function mappedMaintenanceError(error: unknown): never {
  if (error instanceof ExpiredSessionMaintenanceError) throw error
  if (
    error instanceof CoordinationError &&
    (error.code === 'identity.authority-stale' ||
      error.code === 'product-mutation.epoch-changed')
  ) {
    throw new ExpiredSessionMaintenanceError('expired-session-maintenance.stale')
  }
  throw error
}

async function runMaintenance(
  capture: ExpiredSessionMaintenanceCapture,
  prelockedSessions: PrelockedSessionPort,
  parsed: ParsedExpiredSessionMaintenanceInput,
  hostInvocationId: string,
): Promise<ExpiredSessionMaintenanceResult> {
  const view = expiredSessionMaintenanceCaptureView(capture)
  if (view.ownerUserId === null) {
    throw new ExpiredSessionMaintenanceError('expired-session-maintenance.instance-open')
  }
  if (view.hostInvocationId !== hostInvocationId) {
    throw new CoordinationError('identity.authority-stale')
  }

  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const issued = authorityIssuer.expiredSessionMaintenance({
    expectedEpoch,
    expectedOwnerUserId: view.ownerUserId,
    hostInvocationId,
    cursor: view.authorityCursor,
    batchSize: view.batchSize,
    resolvedAccountUserIds: view.resolvedAccountUserIds,
  })
  const intent = intentFactory.expiredSessionMaintenance(issued)

  return prelockedSessions.withPrelockedSessionLease(intent, (lease) => {
    const unitOfWork = createRuntimePostgresUnitOfWork(
      ({ client, request, capturedAuthority }) => {
        const database = createScopedDrizzleDatabase(client)
        const writeGateways = Object.freeze({
          sessionMaintenance: Object.freeze({
            deleteCapturedPage(): Promise<ScopedExpiredSessionMaintenanceResult> {
              const gateway = createScopedExpiredSessionMaintenanceMutationGateway(
                database,
                capture,
              )
              return gateway.deleteCapturedPage()
            },
          }),
        })
        return {
          async recheckIdentity(): Promise<void> {
            assertMaintenanceAuthority(capturedAuthority, {
              epoch: view.expectedEpoch,
              ownerUserId: view.ownerUserId as string,
              hostInvocationId,
              cursor: parsed.cursor,
              batchSize: parsed.batchSize,
              resolvedAccountUserIds: view.resolvedAccountUserIds,
            })
            if (
              request.operation !== 'host-maintenance' ||
              request.authority.kind !== 'expired-session-maintenance'
            ) {
              throw new CoordinationError('identity.authority-stale')
            }
            const recheck = await recheckExpiredSessionMaintenance(client, capture)
            if (recheck.status === 'stale') {
              throw new ExpiredSessionMaintenanceError(
                'expired-session-maintenance.stale',
              )
            }
          },
          readGateways: emptyReadGateways,
          writeGateways,
        }
      },
    )
    const request: ExpiredSessionMaintenanceRequest = {
      operation: 'host-maintenance',
      authority: issued.authority,
      session: { kind: 'prelocked', lease },
      expectedEpoch,
      productFence: 'shared',
      subjectLock: null,
      content: { kind: 'none' },
      mode: { isolation: 'read-committed', access: 'read-write' },
    }
    return unitOfWork.run(request, async ({ gateways }) => {
      const page = await gateways.sessionMaintenance.deleteCapturedPage()
      // Cursor construction remains inside the transaction: an unrepresentable continuation
      // must roll back its deletion rather than commit a page the operator cannot advance past.
      return toExpiredSessionMaintenanceResult({
        sweepCutoff: parsed.sweepCutoff,
        page,
      })
    })
  })
}

async function cleanupWithLockPolicy(
  input: ExpiredSessionMaintenanceInput,
  allowTestWithoutInheritedLock: boolean,
): Promise<ExpiredSessionMaintenanceResult> {
  try {
    const parsed = parseExpiredSessionMaintenanceInput(input)
    const hostInvocationId = newUuidV7()
    return await withExternalHostCommand(
      { hostInvocationId, allowTestWithoutInheritedLock },
      (query) =>
        captureExpiredSessionMaintenance(query, {
          hostInvocationId,
          authorityCursor: parsed.cursor,
          cutoff: parsed.sweepCutoff,
          seek: parsed.seek,
          batchSize: parsed.batchSize,
        }),
      (capture, prelockedSessions) =>
        runMaintenance(capture, prelockedSessions, parsed, hostInvocationId),
    )
  } catch (error) {
    return mappedMaintenanceError(error)
  }
}

function assertTestHelper(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new TypeError('Expired-session maintenance helpers are restricted to tests.')
  }
}

/** Disposable-database helper. Production host commands must use the guarded export. */
export function cleanupExpiredSessions(
  input: ExpiredSessionMaintenanceInput,
): Promise<ExpiredSessionMaintenanceResult> {
  assertTestHelper()
  return cleanupWithLockPolicy(input, true)
}

export function cleanupExpiredSessionsFromHostCli(
  input: ExpiredSessionMaintenanceInput,
): Promise<ExpiredSessionMaintenanceResult> {
  return cleanupWithLockPolicy(input, false)
}
