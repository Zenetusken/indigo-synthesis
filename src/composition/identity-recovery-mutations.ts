import {
  CoordinationError,
  type CredentialLifecycleMutationRequest,
} from '@/application/coordination'
import {
  verifyMemberResetRedemptionActionBinding,
  verifyOwnerRecoveryRedemptionActionBinding,
} from '@/modules/identity/infrastructure/action-binding'
import { credentialEmailLockDigest } from '@/modules/identity/infrastructure/credential-digests'
import {
  captureMemberResetRedemption,
  captureOwnerRecoveryWebRedemption,
  type MemberResetRedemptionCapture,
  memberResetRedemptionCaptureView,
  type OwnerRecoveryWebRedemptionCapture,
  ownerRecoveryWebRedemptionCaptureView,
  recheckMemberResetRedemption,
  recheckOwnerRecoveryWebRedemption,
} from '@/modules/identity/infrastructure/recovery-mutation'
import {
  createScopedMemberResetRedemptionMutationGateway,
  createScopedOwnerRecoveryWebRedemptionMutationGateway,
} from '@/modules/identity/infrastructure/scoped-browser-recovery'
import { publicRecoveryFailure } from '@/modules/identity/recovery/recovery-policy'
import {
  memberResetCodeIdentity,
  ownerRecoveryCodeIdentity,
  type ParsedRecoveryRedemptionInput,
  parseMemberResetRedemptionInput,
  parseOwnerRecoveryWebRedemptionInput,
} from '@/modules/identity/recovery/recovery-preparation'
import {
  type IdentityRecoveryMutationPort,
  type MemberResetRedemptionMutationCommand,
  type MemberResetRedemptionMutationResult,
  memberResetRedemptionMutationCommandView,
  type OwnerRecoveryRedemptionMutationCommand,
  type OwnerRecoveryRedemptionMutationResult,
  ownerRecoveryRedemptionMutationCommandView,
} from '@/modules/identity/server/recovery-redemption-command'
import {
  createInstallationMutationEpoch,
  installationMutationEpochMatches,
} from '@/platform/application-coordination/lifecycle-values'
import {
  type CapturedIdentityAuthority,
  createPlatformMutationAuthorityIssuer,
} from '@/platform/application-coordination/mutation-authority'
import {
  createPlatformPrelockedSessionIntentFactory,
  createPlatformPrelockedSessionPort,
} from '@/platform/application-coordination/prelocked-session'
import { createRuntimePostgresUnitOfWork } from '@/platform/application-coordination/runtime-unit-of-work'
import { createScopedDrizzleDatabase } from '@/platform/application-coordination/scoped-drizzle'
import {
  CredentialConnectionCapacityError,
  withSubmittedEmailCredentialCapture,
} from '@/platform/db/credential-connections'

type MemberResetRequest = Extract<
  CredentialLifecycleMutationRequest,
  { readonly authority: { readonly mutation: 'member-reset-redemption' } }
>

type OwnerRecoveryWebRequest = Extract<
  CredentialLifecycleMutationRequest,
  { readonly authority: { readonly mutation: 'owner-recovery-web-redemption' } }
>

const authorityIssuer = createPlatformMutationAuthorityIssuer()
const intentFactory = createPlatformPrelockedSessionIntentFactory()
const prelockedSessions = createPlatformPrelockedSessionPort()
const emptyReadGateways = Object.freeze({})
const staleRecoveryPage = Object.freeze({ kind: 'stale' as const })

function identityRecheckFailure(reason: string): CoordinationError {
  return new CoordinationError(
    reason === 'installation-epoch-changed'
      ? 'product-mutation.epoch-changed'
      : 'identity.authority-stale',
  )
}

function prelockAdmissionFailure(error: unknown): boolean {
  return (
    error instanceof CredentialConnectionCapacityError ||
    (error instanceof CoordinationError &&
      (error.code === 'uow.capacity' || error.code === 'uow.lock-timeout'))
  )
}

function assertMemberResetAuthority(
  captured: CapturedIdentityAuthority,
  expected: {
    readonly epoch: string
    readonly codeIdentity: string
    readonly emailDigest: string
    readonly targetUserId: string | null
  },
): void {
  if (
    captured.kind !== 'credential-lifecycle' ||
    captured.mutation !== 'member-reset-redemption' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.codeIdentity !== expected.codeIdentity ||
    captured.emailDigest !== expected.emailDigest ||
    captured.targetUserId !== expected.targetUserId ||
    captured.hostInvocationId !== null ||
    captured.channel !== 'member'
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function assertOwnerRecoveryWebAuthority(
  captured: CapturedIdentityAuthority,
  expected: {
    readonly epoch: string
    readonly codeIdentity: string
    readonly emailDigest: string
    readonly ownerUserId: string
  },
): void {
  if (
    captured.kind !== 'credential-lifecycle' ||
    captured.mutation !== 'owner-recovery-web-redemption' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.codeIdentity !== expected.codeIdentity ||
    captured.emailDigest !== expected.emailDigest ||
    captured.targetUserId !== expected.ownerUserId ||
    captured.hostInvocationId !== null ||
    captured.channel !== 'owner-web'
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

async function runMemberResetRedemption(input: {
  readonly capture: MemberResetRedemptionCapture
  readonly parsed: ParsedRecoveryRedemptionInput
  readonly commandEnteredAt: Date
  readonly requestContext: ReturnType<
    typeof memberResetRedemptionMutationCommandView
  >['requestContext']
  readonly expectedEpochValue: string
  readonly codeIdentity: string
  readonly emailDigest: string
  readonly targetUserId: string | null
}): Promise<MemberResetRedemptionMutationResult> {
  const expectedEpoch = createInstallationMutationEpoch(input.expectedEpochValue)
  const issued = authorityIssuer.memberResetRedemption({
    expectedEpoch,
    codeIdentity: input.codeIdentity,
    emailDigest: input.emailDigest,
    targetUserId: input.targetUserId,
  })
  const intent = intentFactory.memberResetRedemption(issued)
  let leaseEntered = false

  try {
    return await prelockedSessions.withPrelockedSessionLease(intent, (lease) => {
      leaseEntered = true
      const unitOfWork = createRuntimePostgresUnitOfWork(
        ({ client, request, capturedAuthority }) => {
          const database = createScopedDrizzleDatabase(client)
          const writeGateways = Object.freeze({
            identityRecovery: Object.freeze({
              async redeem(): Promise<MemberResetRedemptionMutationResult> {
                // Claiming the capture is deliberately lazy: createGatewayContext runs
                // before recheckIdentity, while this callback runs only after it succeeds.
                const gateway = createScopedMemberResetRedemptionMutationGateway(
                  database,
                  input.capture,
                )
                const outcome = await gateway.redeem({
                  parsed: input.parsed,
                  commandEnteredAt: input.commandEnteredAt,
                  requestContext: input.requestContext,
                })
                return outcome.kind === 'redeemed' ? outcome : publicRecoveryFailure
              },
            }),
          })
          return {
            async recheckIdentity(): Promise<void> {
              assertMemberResetAuthority(capturedAuthority, {
                epoch: input.expectedEpochValue,
                codeIdentity: input.codeIdentity,
                emailDigest: input.emailDigest,
                targetUserId: input.targetUserId,
              })
              if (
                request.operation !== 'credential-lifecycle-mutation' ||
                request.authority.mutation !== 'member-reset-redemption'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckMemberResetRedemption(client, input.capture)
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways,
          }
        },
      )
      const request: MemberResetRequest = {
        operation: 'credential-lifecycle-mutation',
        authority: issued.authority,
        session: { kind: 'prelocked', lease },
        expectedEpoch,
        productFence: 'shared',
        subjectLock: null,
        content: { kind: 'none' },
        mode: { isolation: 'serializable', access: 'read-write' },
      }
      return unitOfWork.run(request, ({ gateways }) => gateways.identityRecovery.redeem())
    })
  } catch (error) {
    // Once the lease callback begins, authority/recheck/transaction/commit failures are
    // genuine races or infrastructure faults and must never be flattened or retried.
    if (!leaseEntered && prelockAdmissionFailure(error)) return publicRecoveryFailure
    throw error
  }
}

async function runOwnerRecoveryWebRedemption(input: {
  readonly capture: OwnerRecoveryWebRedemptionCapture
  readonly parsed: ParsedRecoveryRedemptionInput
  readonly commandEnteredAt: Date
  readonly requestContext: ReturnType<
    typeof ownerRecoveryRedemptionMutationCommandView
  >['requestContext']
  readonly expectedEpochValue: string
  readonly codeIdentity: string
  readonly emailDigest: string
  readonly ownerUserId: string
}): Promise<OwnerRecoveryRedemptionMutationResult> {
  const expectedEpoch = createInstallationMutationEpoch(input.expectedEpochValue)
  const issued = authorityIssuer.ownerRecoveryWebRedemption({
    expectedEpoch,
    codeIdentity: input.codeIdentity,
    emailDigest: input.emailDigest,
    expectedOwnerUserId: input.ownerUserId,
  })
  const intent = intentFactory.ownerRecoveryWebRedemption(issued)
  let leaseEntered = false

  try {
    return await prelockedSessions.withPrelockedSessionLease(intent, (lease) => {
      leaseEntered = true
      const unitOfWork = createRuntimePostgresUnitOfWork(
        ({ client, request, capturedAuthority }) => {
          const database = createScopedDrizzleDatabase(client)
          const writeGateways = Object.freeze({
            identityRecovery: Object.freeze({
              async redeem(): Promise<OwnerRecoveryRedemptionMutationResult> {
                const gateway = createScopedOwnerRecoveryWebRedemptionMutationGateway(
                  database,
                  input.capture,
                )
                const outcome = await gateway.redeem({
                  parsed: input.parsed,
                  commandEnteredAt: input.commandEnteredAt,
                  requestContext: input.requestContext,
                })
                return outcome.kind === 'redeemed' ? outcome : publicRecoveryFailure
              },
            }),
          })
          return {
            async recheckIdentity(): Promise<void> {
              assertOwnerRecoveryWebAuthority(capturedAuthority, {
                epoch: input.expectedEpochValue,
                codeIdentity: input.codeIdentity,
                emailDigest: input.emailDigest,
                ownerUserId: input.ownerUserId,
              })
              if (
                request.operation !== 'credential-lifecycle-mutation' ||
                request.authority.mutation !== 'owner-recovery-web-redemption'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckOwnerRecoveryWebRedemption(
                client,
                input.capture,
              )
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways,
          }
        },
      )
      const request: OwnerRecoveryWebRequest = {
        operation: 'credential-lifecycle-mutation',
        authority: issued.authority,
        session: { kind: 'prelocked', lease },
        expectedEpoch,
        productFence: 'shared',
        subjectLock: null,
        content: { kind: 'none' },
        mode: { isolation: 'serializable', access: 'read-write' },
      }
      return unitOfWork.run(request, ({ gateways }) => gateways.identityRecovery.redeem())
    })
  } catch (error) {
    if (!leaseEntered && prelockAdmissionFailure(error)) return publicRecoveryFailure
    throw error
  }
}

async function redeemMemberReset(
  command: MemberResetRedemptionMutationCommand,
): Promise<MemberResetRedemptionMutationResult> {
  const input = memberResetRedemptionMutationCommandView(command)
  const parsed = parseMemberResetRedemptionInput({
    email: input.email,
    code: input.code,
    newPassword: input.newPassword === input.confirmation ? input.newPassword : '',
  })
  const codeIdentity = memberResetCodeIdentity(parsed.submittedCode)
  let capture: MemberResetRedemptionCapture
  try {
    capture = await withSubmittedEmailCredentialCapture((query) =>
      captureMemberResetRedemption(query, {
        normalizedEmail: parsed.normalizedEmail,
        codeIdentity,
        commandEnteredAt: input.commandEnteredAt,
      }),
    )
  } catch (error) {
    if (error instanceof CredentialConnectionCapacityError) {
      return publicRecoveryFailure
    }
    throw error
  }

  const view = memberResetRedemptionCaptureView(capture)
  if (view.installationState !== 'claimed') return staleRecoveryPage
  if (
    !verifyMemberResetRedemptionActionBinding(
      input.actionBinding,
      { expectedEpoch: view.expectedEpoch },
      input.commandEnteredAt,
    )
  ) {
    return staleRecoveryPage
  }
  const emailDigest = credentialEmailLockDigest(parsed.normalizedEmail)
  return runMemberResetRedemption({
    capture,
    parsed,
    commandEnteredAt: input.commandEnteredAt,
    requestContext: input.requestContext,
    expectedEpochValue: view.expectedEpoch,
    codeIdentity: view.codeIdentity,
    emailDigest,
    targetUserId: view.targetUserId,
  })
}

async function redeemOwnerRecovery(
  command: OwnerRecoveryRedemptionMutationCommand,
): Promise<OwnerRecoveryRedemptionMutationResult> {
  const input = ownerRecoveryRedemptionMutationCommandView(command)
  const parsed = parseOwnerRecoveryWebRedemptionInput({
    ownerEmail: input.email,
    code: input.code,
    newPassword: input.newPassword === input.confirmation ? input.newPassword : '',
  })
  const codeIdentity = ownerRecoveryCodeIdentity(parsed.submittedCode)
  let capture: OwnerRecoveryWebRedemptionCapture
  try {
    capture = await withSubmittedEmailCredentialCapture((query) =>
      captureOwnerRecoveryWebRedemption(query, {
        normalizedEmail: parsed.normalizedEmail,
        codeIdentity,
        commandEnteredAt: input.commandEnteredAt,
      }),
    )
  } catch (error) {
    if (error instanceof CredentialConnectionCapacityError) {
      return publicRecoveryFailure
    }
    throw error
  }

  const view = ownerRecoveryWebRedemptionCaptureView(capture)
  if (view.installationState !== 'claimed') return staleRecoveryPage
  if (
    !verifyOwnerRecoveryRedemptionActionBinding(
      input.actionBinding,
      { expectedEpoch: view.expectedEpoch },
      input.commandEnteredAt,
    )
  ) {
    return staleRecoveryPage
  }
  if (view.ownerUserId === null) {
    throw new CoordinationError('identity.authority-stale')
  }
  const emailDigest = credentialEmailLockDigest(parsed.normalizedEmail)
  return runOwnerRecoveryWebRedemption({
    capture,
    parsed,
    commandEnteredAt: input.commandEnteredAt,
    requestContext: input.requestContext,
    expectedEpochValue: view.expectedEpoch,
    codeIdentity: view.codeIdentity,
    emailDigest,
    ownerUserId: view.ownerUserId,
  })
}

const productionIdentityRecoveryMutationPort: IdentityRecoveryMutationPort =
  Object.freeze({ redeemMemberReset, redeemOwnerRecovery })

export function getProductionIdentityRecoveryMutationPort(): IdentityRecoveryMutationPort {
  return productionIdentityRecoveryMutationPort
}
