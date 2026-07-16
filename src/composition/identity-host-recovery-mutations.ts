import {
  CoordinationError,
  type CredentialLifecycleMutationRequest,
  type HostMaintenanceRequest,
  type PrelockedSessionPort,
} from '@/application/coordination'
import {
  captureOwnerRecoveryCliRedemption,
  captureOwnerRecoveryIssuance,
  type OwnerRecoveryCliRedemptionCapture,
  type OwnerRecoveryIssuanceCapture,
  ownerRecoveryCliRedemptionCaptureView,
  ownerRecoveryIssuanceCaptureView,
  recheckOwnerRecoveryCliRedemption,
  recheckOwnerRecoveryIssuance,
} from '@/modules/identity/infrastructure/recovery-mutation'
import {
  createScopedOwnerRecoveryCliRedemptionMutationGateway,
  createScopedOwnerRecoveryIssuanceMutationGateway,
  type ScopedOwnerRecoveryCliRedemptionOutcome,
  type ScopedOwnerRecoveryIssuanceOutcome,
} from '@/modules/identity/infrastructure/scoped-host-recovery'
import {
  type IssuedOwnerRecovery,
  OwnerRecoveryError,
  type RedeemedOwnerRecovery,
} from '@/modules/identity/recovery/owner-recovery-contract'
import {
  captureRecoveryCommandEntry,
  ownerRecoveryCodeIdentity,
  type ParsedOwnerRecoveryIssuanceInput,
  parseOwnerRecoveryHostRedemptionInput,
  parseOwnerRecoveryIssuanceInput,
  prepareOwnerRecoveryIssuance,
  RecoveryPreparationError,
} from '@/modules/identity/recovery/recovery-preparation'
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

type OwnerRecoveryCliRequest = Extract<
  CredentialLifecycleMutationRequest,
  { readonly authority: { readonly mutation: 'owner-recovery-cli-redemption' } }
>

type OwnerRecoveryIssueRequest = Extract<
  HostMaintenanceRequest,
  { readonly authority: { readonly kind: 'owner-recovery-issue' } }
>

type OwnerRecoveryIssueInput = Readonly<{
  ownerEmail: string
  ttlMinutes: number
  now?: Date
}>

type OwnerRecoveryRedemptionInput = Readonly<{
  ownerEmail: string
  code: string
  newPassword: string
  now?: Date
}>

const authorityIssuer = createPlatformMutationAuthorityIssuer()
const intentFactory = createPlatformPrelockedSessionIntentFactory()
const emptyReadGateways = Object.freeze({})

function ownerRecoveryError(error: unknown): never {
  if (error instanceof RecoveryPreparationError) {
    throw new OwnerRecoveryError(error.code, error.message)
  }
  throw error
}

function instanceOpen(): OwnerRecoveryError {
  return new OwnerRecoveryError(
    'owner-recovery.instance-open',
    'This instance has no installed owner. Use first-owner bootstrap instead.',
  )
}

function rejectionError(
  reason:
    | Extract<ScopedOwnerRecoveryIssuanceOutcome, { kind: 'rejected' }>['reason']
    | Extract<ScopedOwnerRecoveryCliRedemptionOutcome, { kind: 'rejected' }>['reason'],
): OwnerRecoveryError {
  switch (reason) {
    case 'owner-mismatch':
      return new OwnerRecoveryError(
        'owner-recovery.owner-mismatch',
        'The supplied email does not match the installed owner.',
      )
    case 'credential-missing':
      return new OwnerRecoveryError(
        'owner-recovery.credential-missing',
        'The installed owner has no password credential to recover.',
      )
    case 'code-invalid':
      return new OwnerRecoveryError(
        'owner-recovery.code-invalid',
        'The recovery code is invalid or expired.',
      )
  }
}

function assertIssuanceAuthority(
  captured: CapturedIdentityAuthority,
  expected: {
    readonly epoch: string
    readonly ownerUserId: string
    readonly hostInvocationId: string
  },
): void {
  if (
    captured.kind !== 'owner-recovery-issue' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.expectedOwnerUserId !== expected.ownerUserId ||
    captured.hostInvocationId !== expected.hostInvocationId
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function assertCliRedemptionAuthority(
  captured: CapturedIdentityAuthority,
  expected: {
    readonly epoch: string
    readonly ownerUserId: string
    readonly codeIdentity: string
    readonly hostInvocationId: string
  },
): void {
  if (
    captured.kind !== 'credential-lifecycle' ||
    captured.mutation !== 'owner-recovery-cli-redemption' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.targetUserId !== expected.ownerUserId ||
    captured.codeIdentity !== expected.codeIdentity ||
    captured.hostInvocationId !== expected.hostInvocationId ||
    captured.emailDigest !== null ||
    captured.channel !== 'owner-cli'
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function staleRecoveryCapture(reason: string): CoordinationError {
  return new CoordinationError(
    reason === 'installation-epoch-changed'
      ? 'product-mutation.epoch-changed'
      : 'identity.authority-stale',
  )
}

async function runIssuance(
  capture: OwnerRecoveryIssuanceCapture,
  prelockedSessions: PrelockedSessionPort,
  parsed: ParsedOwnerRecoveryIssuanceInput,
  commandEnteredAt: Date,
  hostInvocationId: string,
): Promise<IssuedOwnerRecovery> {
  const view = ownerRecoveryIssuanceCaptureView(capture)
  if (view.installationState !== 'claimed' || view.ownerUserId === null) {
    throw instanceOpen()
  }
  if (view.hostInvocationId !== hostInvocationId) {
    throw new CoordinationError('identity.authority-stale')
  }

  const prepared = prepareOwnerRecoveryIssuance({
    ownerUserId: view.ownerUserId,
    ownerEmail: parsed.normalizedOwnerEmail,
    ttlMinutes: parsed.ttlMinutes,
    commandEnteredAt,
  })
  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const issued = authorityIssuer.ownerRecoveryIssue({
    expectedEpoch,
    expectedOwnerUserId: view.ownerUserId,
    hostInvocationId,
  })
  const intent = intentFactory.ownerRecoveryIssue(issued)

  const outcome = await prelockedSessions.withPrelockedSessionLease(intent, (lease) => {
    const unitOfWork = createRuntimePostgresUnitOfWork(
      ({ client, request, capturedAuthority }) => {
        const database = createScopedDrizzleDatabase(client)
        const writeGateways = Object.freeze({
          hostRecovery: Object.freeze({
            issue(): Promise<ScopedOwnerRecoveryIssuanceOutcome> {
              const gateway = createScopedOwnerRecoveryIssuanceMutationGateway(
                database,
                capture,
              )
              return gateway.issue(prepared)
            },
          }),
        })
        return {
          async recheckIdentity(): Promise<void> {
            assertIssuanceAuthority(capturedAuthority, {
              epoch: view.expectedEpoch,
              ownerUserId: view.ownerUserId as string,
              hostInvocationId,
            })
            if (
              request.operation !== 'host-maintenance' ||
              request.authority.kind !== 'owner-recovery-issue'
            ) {
              throw new CoordinationError('identity.authority-stale')
            }
            const recheck = await recheckOwnerRecoveryIssuance(client, capture)
            if (recheck.status === 'stale') {
              throw staleRecoveryCapture(recheck.reason)
            }
          },
          readGateways: emptyReadGateways,
          writeGateways,
        }
      },
    )
    const request: OwnerRecoveryIssueRequest = {
      operation: 'host-maintenance',
      authority: issued.authority,
      session: { kind: 'prelocked', lease },
      expectedEpoch,
      productFence: 'shared',
      subjectLock: null,
      content: { kind: 'none' },
      mode: { isolation: 'serializable', access: 'read-write' },
    }
    return unitOfWork.run(request, ({ gateways }) => gateways.hostRecovery.issue())
  })

  if (outcome.kind === 'rejected') throw rejectionError(outcome.reason)
  return Object.freeze({
    recoveryId: prepared.recoveryId,
    code: prepared.code,
    expiresAt: new Date(prepared.expiresAt.getTime()),
  })
}

async function issueWithLockPolicy(
  input: OwnerRecoveryIssueInput,
  allowTestWithoutInheritedLock: boolean,
): Promise<IssuedOwnerRecovery> {
  try {
    const commandEnteredAt = captureRecoveryCommandEntry(input.now ?? new Date())
    const parsed = parseOwnerRecoveryIssuanceInput(input)
    const hostInvocationId = newUuidV7(commandEnteredAt.getTime())
    return await withExternalHostCommand(
      { hostInvocationId, allowTestWithoutInheritedLock },
      (query) =>
        captureOwnerRecoveryIssuance(query, {
          normalizedOwnerEmail: parsed.normalizedOwnerEmail,
          hostInvocationId,
          commandEnteredAt,
        }),
      (capture, prelockedSessions) =>
        runIssuance(
          capture,
          prelockedSessions,
          parsed,
          commandEnteredAt,
          hostInvocationId,
        ),
    )
  } catch (error) {
    return ownerRecoveryError(error)
  }
}

async function runCliRedemption(
  capture: OwnerRecoveryCliRedemptionCapture,
  prelockedSessions: PrelockedSessionPort,
  parsed: ReturnType<typeof parseOwnerRecoveryHostRedemptionInput>,
  commandEnteredAt: Date,
  hostInvocationId: string,
): Promise<RedeemedOwnerRecovery> {
  const view = ownerRecoveryCliRedemptionCaptureView(capture)
  if (view.installationState !== 'claimed' || view.ownerUserId === null) {
    throw instanceOpen()
  }
  if (view.hostInvocationId !== hostInvocationId) {
    throw new CoordinationError('identity.authority-stale')
  }
  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const issued = authorityIssuer.ownerRecoveryCliRedemption({
    expectedEpoch,
    codeIdentity: view.codeIdentity,
    expectedOwnerUserId: view.ownerUserId,
    hostInvocationId,
  })
  const intent = intentFactory.ownerRecoveryCliRedemption(issued)

  const outcome = await prelockedSessions.withPrelockedSessionLease(intent, (lease) => {
    const unitOfWork = createRuntimePostgresUnitOfWork(
      ({ client, request, capturedAuthority }) => {
        const database = createScopedDrizzleDatabase(client)
        const writeGateways = Object.freeze({
          hostRecovery: Object.freeze({
            redeem(): Promise<ScopedOwnerRecoveryCliRedemptionOutcome> {
              const gateway = createScopedOwnerRecoveryCliRedemptionMutationGateway(
                database,
                capture,
              )
              return gateway.redeem({ parsed, commandEnteredAt })
            },
          }),
        })
        return {
          async recheckIdentity(): Promise<void> {
            assertCliRedemptionAuthority(capturedAuthority, {
              epoch: view.expectedEpoch,
              ownerUserId: view.ownerUserId as string,
              codeIdentity: view.codeIdentity,
              hostInvocationId,
            })
            if (
              request.operation !== 'credential-lifecycle-mutation' ||
              request.authority.mutation !== 'owner-recovery-cli-redemption'
            ) {
              throw new CoordinationError('identity.authority-stale')
            }
            const recheck = await recheckOwnerRecoveryCliRedemption(client, capture)
            if (recheck.status === 'stale') {
              throw staleRecoveryCapture(recheck.reason)
            }
          },
          readGateways: emptyReadGateways,
          writeGateways,
        }
      },
    )
    const request: OwnerRecoveryCliRequest = {
      operation: 'credential-lifecycle-mutation',
      authority: issued.authority,
      session: { kind: 'prelocked', lease },
      expectedEpoch,
      productFence: 'shared',
      subjectLock: null,
      content: { kind: 'none' },
      mode: { isolation: 'serializable', access: 'read-write' },
    }
    return unitOfWork.run(request, ({ gateways }) => gateways.hostRecovery.redeem())
  })

  if (outcome.kind === 'rejected') throw rejectionError(outcome.reason)
  return Object.freeze({
    ownerUserId: outcome.ownerUserId,
    revokedSessionCount: outcome.revokedSessionCount,
  })
}

async function redeemWithLockPolicy(
  input: OwnerRecoveryRedemptionInput,
  allowTestWithoutInheritedLock: boolean,
): Promise<RedeemedOwnerRecovery> {
  try {
    const commandEnteredAt = captureRecoveryCommandEntry(input.now ?? new Date())
    const parsed = parseOwnerRecoveryHostRedemptionInput(input)
    const codeIdentity = ownerRecoveryCodeIdentity(parsed.submittedCode)
    const hostInvocationId = newUuidV7(commandEnteredAt.getTime())
    return await withExternalHostCommand(
      { hostInvocationId, allowTestWithoutInheritedLock },
      (query) =>
        captureOwnerRecoveryCliRedemption(query, {
          normalizedEmail: parsed.normalizedEmail,
          codeIdentity,
          hostInvocationId,
          commandEnteredAt,
        }),
      (capture, prelockedSessions) =>
        runCliRedemption(
          capture,
          prelockedSessions,
          parsed,
          commandEnteredAt,
          hostInvocationId,
        ),
    )
  } catch (error) {
    return ownerRecoveryError(error)
  }
}

function assertTestHelper(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new TypeError('Owner recovery mutation helpers are restricted to tests.')
  }
}

/** Disposable-database helper. Production host commands must use the guarded export. */
export function issueOwnerRecovery(
  input: OwnerRecoveryIssueInput,
): Promise<IssuedOwnerRecovery> {
  assertTestHelper()
  return issueWithLockPolicy(input, true)
}

export function issueOwnerRecoveryFromHostCli(
  input: OwnerRecoveryIssueInput,
): Promise<IssuedOwnerRecovery> {
  return issueWithLockPolicy(input, false)
}

/** Disposable-database helper. Production host commands must use the guarded export. */
export function redeemOwnerRecovery(
  input: OwnerRecoveryRedemptionInput,
): Promise<RedeemedOwnerRecovery> {
  assertTestHelper()
  return redeemWithLockPolicy(input, true)
}

export function redeemOwnerRecoveryFromHostCli(
  input: OwnerRecoveryRedemptionInput,
): Promise<RedeemedOwnerRecovery> {
  return redeemWithLockPolicy(input, false)
}
