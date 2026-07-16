import {
  CoordinationError,
  type HostBootstrapMutationRequest,
} from '@/application/coordination'
import {
  type CreatedOwner,
  type IssuedOwnerBootstrap,
  OwnerBootstrapError,
  parseOwnerBootstrapInput,
  prepareOwnerBootstrapIssuance,
  prepareOwnerBootstrapRedemption,
} from '@/modules/identity/bootstrap/owner-bootstrap'
import { verifyOwnerBootstrapActionBinding } from '@/modules/identity/infrastructure/action-binding'
import {
  captureOwnerBootstrapIssuance,
  captureOwnerBootstrapRedemption,
  createScopedIdentityBootstrapMutationGateway,
  type OwnerBootstrapIssuanceCapture,
  ownerBootstrapIssuanceCaptureView,
  ownerBootstrapRedemptionCaptureView,
  recheckOwnerBootstrapIssuance,
  recheckOwnerBootstrapRedemption,
} from '@/modules/identity/infrastructure/bootstrap-mutation'
import { credentialEmailLockDigest } from '@/modules/identity/infrastructure/credential-digests'
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
import { withTrustedCredentialCapture } from '@/platform/db/credential-connections'
import { withExternalHostCommand } from '@/platform/db/external-host-command'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

const authorityIssuer = createPlatformMutationAuthorityIssuer()
const intentFactory = createPlatformPrelockedSessionIntentFactory()
const trustedPrelockedSessions = createPlatformPrelockedSessionPort()
const emptyReadGateways = Object.freeze({})

function assertIssuanceAuthority(
  captured: CapturedIdentityAuthority,
  expected: {
    readonly epoch: string
    readonly capabilityId: string
    readonly hostInvocationId: string
  },
): void {
  if (
    captured.kind !== 'host-bootstrap' ||
    captured.mutation !== 'issuance' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.capabilityIdentity !== expected.capabilityId ||
    captured.hostInvocationId !== expected.hostInvocationId
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function assertRedemptionAuthority(
  captured: CapturedIdentityAuthority,
  expected: {
    readonly epoch: string
    readonly capabilityId: string
    readonly codeIdentity: string
    readonly ownerUserId: string
    readonly emailDigest: string
  },
): void {
  if (
    captured.kind !== 'host-bootstrap' ||
    captured.mutation !== 'redemption' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.capabilityIdentity !== expected.capabilityId ||
    captured.codeIdentity !== expected.codeIdentity ||
    captured.preallocatedOwnerUserId !== expected.ownerUserId ||
    captured.emailDigest !== expected.emailDigest
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

async function issueOwnerBootstrapWithLockPolicy(
  input: { readonly ttlMinutes: number; readonly now?: Date },
  allowTestWithoutInheritedLock: boolean,
): Promise<IssuedOwnerBootstrap> {
  const prepared = prepareOwnerBootstrapIssuance(input)
  const hostInvocationId = newUuidV7()

  return withExternalHostCommand(
    {
      hostInvocationId,
      allowTestWithoutInheritedLock,
    },
    captureOwnerBootstrapIssuance,
    async (capture: OwnerBootstrapIssuanceCapture, prelockedSessions) => {
      const view = ownerBootstrapIssuanceCaptureView(capture)
      const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
      const issued = authorityIssuer.bootstrapIssuance({
        expectedEpoch,
        capabilityIdentity: prepared.capabilityId,
        hostInvocationId,
      })
      const intent = intentFactory.bootstrapIssuance(issued)

      await prelockedSessions.withPrelockedSessionLease(intent, (lease) => {
        const unitOfWork = createRuntimePostgresUnitOfWork(
          ({ client, request, capturedAuthority }) => {
            const gateway = createScopedIdentityBootstrapMutationGateway(
              createScopedDrizzleDatabase(client),
            )
            return {
              async recheckIdentity(): Promise<void> {
                assertIssuanceAuthority(capturedAuthority, {
                  epoch: view.expectedEpoch,
                  capabilityId: prepared.capabilityId,
                  hostInvocationId,
                })
                if (
                  request.operation !== 'host-bootstrap-mutation' ||
                  request.authority.mutation !== 'issuance'
                ) {
                  throw new CoordinationError('identity.authority-stale')
                }
                await recheckOwnerBootstrapIssuance(client, capture)
              },
              readGateways: emptyReadGateways,
              writeGateways: Object.freeze({ bootstrap: gateway }),
            }
          },
        )
        const request: HostBootstrapMutationRequest = {
          operation: 'host-bootstrap-mutation',
          authority: issued.authority,
          session: { kind: 'prelocked', lease },
          expectedEpoch,
          productFence: 'shared',
          subjectLock: null,
          content: { kind: 'none' },
          mode: { isolation: 'serializable', access: 'read-write' },
        }
        return unitOfWork.run(request, ({ gateways }) =>
          gateways.bootstrap.issue(prepared),
        )
      })

      return Object.freeze({
        capabilityId: prepared.capabilityId,
        code: prepared.code,
        expiresAt: prepared.expiresAt,
      })
    },
  )
}

/** Disposable-database/test helper. Real host issuance must use the guarded CLI export below. */
export function issueOwnerBootstrap(input: {
  readonly ttlMinutes: number
  readonly now?: Date
}): Promise<IssuedOwnerBootstrap> {
  if (process.env.NODE_ENV !== 'test') {
    throw new TypeError('Owner bootstrap issuance must use the guarded host CLI.')
  }
  return issueOwnerBootstrapWithLockPolicy(input, true)
}

export function issueOwnerBootstrapFromHostCli(input: {
  readonly ttlMinutes: number
  readonly now?: Date
}): Promise<IssuedOwnerBootstrap> {
  return issueOwnerBootstrapWithLockPolicy(input, false)
}

async function redeemOwnerBootstrap(
  rawInput: {
    readonly name: string
    readonly email: string
    readonly password: string
    readonly code: string
    readonly now?: Date
  },
  actionBinding: unknown | null,
): Promise<CreatedOwner> {
  const parsed = parseOwnerBootstrapInput(rawInput)
  const now = rawInput.now ?? new Date()
  const capture = await withTrustedCredentialCapture((query) =>
    captureOwnerBootstrapRedemption(query, { code: parsed.code, now }),
  )
  const view = ownerBootstrapRedemptionCaptureView(capture)
  if (
    actionBinding !== null &&
    !verifyOwnerBootstrapActionBinding(
      actionBinding,
      { expectedEpoch: view.expectedEpoch },
      now,
    )
  ) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.action-binding-invalid',
      'The bootstrap page is stale or invalid.',
    )
  }

  const prepared = await prepareOwnerBootstrapRedemption(parsed, now)
  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const emailDigest = credentialEmailLockDigest(parsed.email)
  const issued = authorityIssuer.bootstrapRedemption({
    expectedEpoch,
    capabilityIdentity: view.capabilityId,
    codeIdentity: prepared.codeIdentity,
    preallocatedOwnerUserId: prepared.ownerUserId,
    emailDigest,
  })
  const intent = intentFactory.bootstrapRedemption(issued)

  return trustedPrelockedSessions.withPrelockedSessionLease(intent, (lease) => {
    const unitOfWork = createRuntimePostgresUnitOfWork(
      ({ client, request, capturedAuthority }) => {
        const gateway = createScopedIdentityBootstrapMutationGateway(
          createScopedDrizzleDatabase(client),
        )
        return {
          async recheckIdentity(): Promise<void> {
            assertRedemptionAuthority(capturedAuthority, {
              epoch: view.expectedEpoch,
              capabilityId: view.capabilityId,
              codeIdentity: prepared.codeIdentity,
              ownerUserId: prepared.ownerUserId,
              emailDigest,
            })
            if (
              request.operation !== 'host-bootstrap-mutation' ||
              request.authority.mutation !== 'redemption'
            ) {
              throw new CoordinationError('identity.authority-stale')
            }
            await recheckOwnerBootstrapRedemption(client, capture)
          },
          readGateways: emptyReadGateways,
          writeGateways: Object.freeze({ bootstrap: gateway }),
        }
      },
    )
    const request: HostBootstrapMutationRequest = {
      operation: 'host-bootstrap-mutation',
      authority: issued.authority,
      session: { kind: 'prelocked', lease },
      expectedEpoch,
      productFence: 'shared',
      subjectLock: null,
      content: { kind: 'none' },
      mode: { isolation: 'serializable', access: 'read-write' },
    }
    return unitOfWork.run(request, ({ gateways }) =>
      gateways.bootstrap.redeem(capture, prepared),
    )
  })
}

/** Trusted host/test composition helper; the live browser entry uses the bound variant below. */
export function createOwnerWithBootstrapCode(input: {
  readonly name: string
  readonly email: string
  readonly password: string
  readonly code: string
  readonly now?: Date
}): Promise<CreatedOwner> {
  return redeemOwnerBootstrap(input, null)
}

export function createOwnerFromWebWithBootstrapCode(input: {
  readonly name: string
  readonly email: string
  readonly password: string
  readonly code: string
  readonly actionBinding: unknown
}): Promise<CreatedOwner> {
  return redeemOwnerBootstrap(
    {
      name: input.name,
      email: input.email,
      password: input.password,
      code: input.code,
    },
    input.actionBinding,
  )
}
