import {
  CoordinationError,
  type CredentialLifecycleMutationRequest,
} from '@/application/coordination'
import { checkedSignOutActionBindingHeader } from '@/modules/identity/application/action-binding'
import {
  verifyCheckedSignOutActionBinding,
  verifyEmailSignInActionBinding,
} from '@/modules/identity/infrastructure/action-binding'
import {
  clearProvenAbsentIdentitySession,
  verifyIdentitySessionCookie,
} from '@/modules/identity/infrastructure/auth'
import {
  type CheckedSignOutMutationCapture,
  captureCheckedSignOutMutation,
  captureEmailSignInMutation,
  checkedSignOutMutationCaptureView,
  deleteCapturedCheckedSignOutSession,
  type EmailSignInMutationCapture,
  emailSignInMutationCaptureView,
  recheckCheckedSignOutMutation,
  recheckEmailSignInMutation,
} from '@/modules/identity/infrastructure/auth-mutation-capture'
import {
  credentialEmailLockDigest,
  credentialSessionTokenDigest,
} from '@/modules/identity/infrastructure/credential-digests'
import { cleanupExpiredAccountSessions } from '@/modules/identity/infrastructure/expired-session-cleanup'
import { createScopedIdentityMutationGateway } from '@/modules/identity/infrastructure/scoped-mutation-auth'
import { createScopedWebRecoveryRateLimitGateway } from '@/modules/identity/infrastructure/web-recovery-rate-limit'
import {
  type EmailSignInMutationCommand,
  emailSignInMutationCommandView,
  type IdentityAuthMutationPort,
} from '@/modules/identity/server/auth-mutation-port'
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
  withTrustedCredentialCapture,
} from '@/platform/db/credential-connections'

const authorityIssuer = createPlatformMutationAuthorityIssuer()
const intentFactory = createPlatformPrelockedSessionIntentFactory()
const prelockedSessions = createPlatformPrelockedSessionPort()

const emptyReadGateways = Object.freeze({})

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

function signInRejectedResponse(): Response {
  return Response.json({ rejected: true }, { status: 401 })
}

function signOutRejectedResponse(status = 503): Response {
  return Response.json(
    { code: 'SIGN_OUT_NOT_COMMITTED', message: 'Sign-out did not complete.' },
    { status },
  )
}

function expectedCredentialFailure(error: unknown): boolean {
  return (
    error instanceof CredentialConnectionCapacityError ||
    error instanceof CoordinationError
  )
}

function identityRecheckFailure(
  reason: 'installation-epoch-changed' | string,
): CoordinationError {
  return new CoordinationError(
    reason === 'installation-epoch-changed'
      ? 'product-mutation.epoch-changed'
      : 'identity.authority-stale',
  )
}

function assertEmailSignInAuthority(
  captured: CapturedIdentityAuthority,
  expected: {
    readonly epoch: string
    readonly emailDigest: string
    readonly resolvedAccountUserIds: readonly string[]
  },
): void {
  if (
    captured.kind !== 'credential-lifecycle' ||
    captured.mutation !== 'email-sign-in' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.emailDigest !== expected.emailDigest ||
    !sameStrings(captured.resolvedAccountUserIds, expected.resolvedAccountUserIds)
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function assertCheckedSignOutAuthority(
  captured: CapturedIdentityAuthority,
  expected: {
    readonly epoch: string
    readonly signedTokenDigest: string
    readonly accountUserId: string
  },
): void {
  if (
    captured.kind !== 'credential-lifecycle' ||
    captured.mutation !== 'checked-sign-out' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.signedTokenDigest !== expected.signedTokenDigest ||
    captured.resolvedAccountUserId !== expected.accountUserId
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function providerRequestWithoutActionBinding(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete(checkedSignOutActionBindingHeader)
  return new Request(request, { headers })
}

async function emailSignIn(command: EmailSignInMutationCommand): Promise<Response> {
  const input = emailSignInMutationCommandView(command)
  let capture: EmailSignInMutationCapture
  try {
    capture = await withSubmittedEmailCredentialCapture(
      (query) => captureEmailSignInMutation(query, input.credentialEmail),
      { signal: input.providerRequest.signal },
    )
  } catch (error) {
    if (expectedCredentialFailure(error)) return signInRejectedResponse()
    throw error
  }
  const view = emailSignInMutationCaptureView(capture)
  if (view.installationState !== 'claimed') return signInRejectedResponse()
  if (
    !verifyEmailSignInActionBinding(input.actionBinding, {
      expectedEpoch: view.expectedEpoch,
    })
  ) {
    return signInRejectedResponse()
  }

  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const emailDigest = credentialEmailLockDigest(input.credentialEmail)
  const issued = authorityIssuer.emailSignIn({
    expectedEpoch,
    emailDigest,
    resolvedAccountUserIds: view.resolvedAccountUserIds,
  })
  const intent = intentFactory.emailSignIn(issued)

  try {
    return await prelockedSessions.withPrelockedSessionLease(
      intent,
      (lease) => {
        const unitOfWork = createRuntimePostgresUnitOfWork(
          ({ client, request, capturedAuthority }) => {
            const database = createScopedDrizzleDatabase(client)
            const provider = createScopedIdentityMutationGateway(database)
            const rateLimit = createScopedWebRecoveryRateLimitGateway(database)
            const writeGateways = Object.freeze({
              identityAuth: Object.freeze({
                async execute(): Promise<Response> {
                  const admission = await rateLimit.admit({
                    purpose: 'sign-in',
                    email: input.rateLimitEmail,
                    clientAddress: input.clientAddress,
                  })
                  if (!admission.admitted) return signInRejectedResponse()

                  const response = await provider.signInEmail(input.providerRequest)
                  await cleanupExpiredAccountSessions(client, view.resolvedAccountUserIds)
                  return response
                },
              }),
            })
            return {
              async recheckIdentity(): Promise<void> {
                assertEmailSignInAuthority(capturedAuthority, {
                  epoch: view.expectedEpoch,
                  emailDigest,
                  resolvedAccountUserIds: view.resolvedAccountUserIds,
                })
                if (
                  request.operation !== 'credential-lifecycle-mutation' ||
                  request.authority.mutation !== 'email-sign-in'
                ) {
                  throw new CoordinationError('identity.authority-stale')
                }
                const recheck = await recheckEmailSignInMutation(client, capture)
                if (recheck.status === 'stale') {
                  throw identityRecheckFailure(recheck.reason)
                }
              },
              readGateways: emptyReadGateways,
              writeGateways,
            }
          },
        )
        const request: CredentialLifecycleMutationRequest = {
          operation: 'credential-lifecycle-mutation',
          authority: issued.authority,
          session: { kind: 'prelocked', lease },
          expectedEpoch,
          productFence: 'shared',
          subjectLock: null,
          content: { kind: 'none' },
          mode: { isolation: 'read-committed', access: 'read-write' },
          signal: input.providerRequest.signal,
        }
        return unitOfWork.run(request, ({ gateways }) => gateways.identityAuth.execute())
      },
      { signal: input.providerRequest.signal },
    )
  } catch (error) {
    if (expectedCredentialFailure(error)) return signInRejectedResponse()
    throw error
  }
}

async function checkedSignOut(
  input: Parameters<IdentityAuthMutationPort['checkedSignOut']>[0],
): Promise<Response> {
  // Snapshot the externally owned Request before the first await. Headers on Request are
  // mutable; capture, authority, checked deletion, and provider replay must observe one cookie.
  const stableRequest = new Request(input.request, {
    signal: input.signal ?? input.request.signal,
  })
  const verification = await verifyIdentitySessionCookie(stableRequest)
  if (verification.kind === 'rejected') return verification.response
  if (verification.kind === 'absent') return signOutRejectedResponse(401)
  const verifiedToken = verification.sessionToken

  let capture: CheckedSignOutMutationCapture
  try {
    capture = await withTrustedCredentialCapture(
      (query) => captureCheckedSignOutMutation(query, verifiedToken),
      { signal: input.signal },
    )
  } catch (error) {
    if (expectedCredentialFailure(error)) return signOutRejectedResponse()
    throw error
  }
  const view = checkedSignOutMutationCaptureView(capture)
  if (!view.session) {
    return clearProvenAbsentIdentitySession(stableRequest)
  }
  if (view.installationState !== 'claimed') return signOutRejectedResponse()
  const capturedSession = view.session
  if (
    !verifyCheckedSignOutActionBinding(input.actionBinding, {
      expectedEpoch: view.expectedEpoch,
      sessionId: capturedSession.sessionId,
      actorUserId: capturedSession.accountUserId,
    })
  ) {
    return signOutRejectedResponse(409)
  }

  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const signedTokenDigest = credentialSessionTokenDigest(verifiedToken)
  const issued = authorityIssuer.checkedSignOut({
    expectedEpoch,
    signedTokenDigest,
    resolvedAccountUserId: capturedSession.accountUserId,
  })
  const intent = intentFactory.checkedSignOut(issued)
  const providerRequest = providerRequestWithoutActionBinding(stableRequest)

  try {
    return await prelockedSessions.withPrelockedSessionLease(
      intent,
      (lease) => {
        const unitOfWork = createRuntimePostgresUnitOfWork(
          ({ client, request, capturedAuthority }) => {
            const provider = createScopedIdentityMutationGateway(
              createScopedDrizzleDatabase(client),
            )
            const writeGateways = Object.freeze({
              identityAuth: Object.freeze({
                async execute(): Promise<Response> {
                  await deleteCapturedCheckedSignOutSession(client, capture)
                  await cleanupExpiredAccountSessions(client, [
                    capturedSession.accountUserId,
                  ])
                  return provider.checkedSignOut(providerRequest)
                },
              }),
            })
            return {
              async recheckIdentity(): Promise<void> {
                assertCheckedSignOutAuthority(capturedAuthority, {
                  epoch: view.expectedEpoch,
                  signedTokenDigest,
                  accountUserId: capturedSession.accountUserId,
                })
                if (
                  request.operation !== 'credential-lifecycle-mutation' ||
                  request.authority.mutation !== 'checked-sign-out'
                ) {
                  throw new CoordinationError('identity.authority-stale')
                }
                const recheck = await recheckCheckedSignOutMutation(client, capture)
                if (recheck.status === 'stale') {
                  throw identityRecheckFailure(recheck.reason)
                }
              },
              readGateways: emptyReadGateways,
              writeGateways,
            }
          },
        )
        const request: CredentialLifecycleMutationRequest = {
          operation: 'credential-lifecycle-mutation',
          authority: issued.authority,
          session: { kind: 'prelocked', lease },
          expectedEpoch,
          productFence: 'shared',
          subjectLock: null,
          content: { kind: 'none' },
          mode: { isolation: 'read-committed', access: 'read-write' },
          ...(input.signal ? { signal: input.signal } : {}),
        }
        return unitOfWork.run(request, ({ gateways }) => gateways.identityAuth.execute())
      },
      { signal: input.signal },
    )
  } catch (error) {
    if (expectedCredentialFailure(error)) return signOutRejectedResponse()
    throw error
  }
}

const productionIdentityAuthMutationPort: IdentityAuthMutationPort = Object.freeze({
  emailSignIn,
  checkedSignOut,
})

export function getProductionIdentityAuthMutationPort(): IdentityAuthMutationPort {
  return productionIdentityAuthMutationPort
}
