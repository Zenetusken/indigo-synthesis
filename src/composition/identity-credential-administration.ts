import {
  type AuthenticatedDestructiveAuthority,
  CoordinationError,
  type DestructiveIdentityMutationRequest,
  type DestructiveReauthenticationAttemptRequest,
} from '@/application/coordination'
import { LocalUserInputError } from '@/modules/identity/application/local-users'
import {
  verifyLocalUserCreateActionBinding,
  verifyMemberResetIssueActionBinding,
} from '@/modules/identity/infrastructure/action-binding'
import {
  CredentialAdministrationAuthorityUnavailableError,
  CredentialAdministrationCaptureStaleError,
  captureLocalUserCreationMutation,
  captureMemberResetIssuanceMutation,
  type LocalUserCreationMutationCapture,
  localUserCreationMutationCaptureView,
  type MemberResetIssuanceMutationCapture,
  memberResetIssuanceMutationCaptureView,
  recheckLocalUserCreationMutation,
  recheckMemberResetIssuanceMutation,
} from '@/modules/identity/infrastructure/credential-administration-mutation'
import { credentialEmailLockDigest } from '@/modules/identity/infrastructure/credential-digests'
import {
  createScopedLocalUserCreationMutationGateway,
  createScopedMemberResetIssuanceMutationGateway,
  type PreparedLocalUserCreation,
  prepareLocalUserCreation,
} from '@/modules/identity/infrastructure/scoped-credential-administration'
import {
  createScopedLocalUserCreationReauthenticationGateway,
  createScopedMemberResetIssuanceReauthenticationGateway,
} from '@/modules/identity/infrastructure/scoped-credential-reauthentication'
import { prepareMemberResetIssuance } from '@/modules/identity/recovery/recovery-preparation'
import {
  type IdentityCredentialAdministrationMutationPort,
  type LocalUserCreationMutationCommand,
  type LocalUserCreationMutationResult,
  localUserCreationMutationCommandView,
  type MemberResetIssuanceMutationCommand,
  type MemberResetIssuanceMutationResult,
  memberResetIssuanceMutationCommandView,
} from '@/modules/identity/server/credential-administration-command'
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
  withTrustedCredentialCapture,
} from '@/platform/db/credential-connections'

const authorityIssuer = createPlatformMutationAuthorityIssuer()
const intentFactory = createPlatformPrelockedSessionIntentFactory()
const prelockedSessions = createPlatformPrelockedSessionPort()
const emptyReadGateways = Object.freeze({})

type LocalUserAttemptRequest = Extract<
  DestructiveReauthenticationAttemptRequest,
  { readonly authority: { readonly purpose: 'local-user-create' } }
>
type MemberResetAttemptRequest = Extract<
  DestructiveReauthenticationAttemptRequest,
  { readonly authority: { readonly purpose: 'member-reset-issue' } }
>
type LocalUserProtectedRequest = Extract<
  DestructiveIdentityMutationRequest,
  { readonly authority: { readonly purpose: 'local-user-create' } }
>
type MemberResetProtectedRequest = Extract<
  DestructiveIdentityMutationRequest,
  { readonly authority: { readonly purpose: 'member-reset-issue' } }
>
type LocalUserProtectedAuthority = Extract<
  AuthenticatedDestructiveAuthority,
  { readonly purpose: 'local-user-create' }
>
type MemberResetProtectedAuthority = Extract<
  AuthenticatedDestructiveAuthority,
  { readonly purpose: 'member-reset-issue' }
>

type AdministrationPurpose = 'local-user-create' | 'member-reset-issue'
type AdministrationAuthorityKind =
  | 'destructive-reauthentication-attempt'
  | 'authenticated-destructive'

type ExpectedAdministrationAuthority = Readonly<{
  kind: AdministrationAuthorityKind
  purpose: AdministrationPurpose
  epoch: string
  actorUserId: string
  sessionId: string
  targetUserId: string
  emailDigest: string | null
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

function assertAdministrationAuthority(
  captured: CapturedIdentityAuthority,
  expected: ExpectedAdministrationAuthority,
): void {
  if (
    captured.kind !== expected.kind ||
    captured.purpose !== expected.purpose ||
    captured.expectedRole !== 'owner' ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.actorUserId !== expected.actorUserId ||
    captured.sessionId !== expected.sessionId ||
    captured.targetUserId !== expected.targetUserId ||
    captured.emailDigest !== expected.emailDigest
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function mappedAdministrationFailure(
  error: unknown,
): Readonly<{ kind: 'stale' | 'unavailable' }> | null {
  if (error instanceof CredentialAdministrationAuthorityUnavailableError) {
    return Object.freeze({ kind: 'stale' })
  }
  if (error instanceof CredentialAdministrationCaptureStaleError) {
    return Object.freeze({ kind: 'stale' })
  }
  if (error instanceof CredentialConnectionCapacityError) {
    return Object.freeze({ kind: 'unavailable' })
  }
  if (error instanceof CoordinationError) {
    return Object.freeze({
      kind:
        error.code === 'identity.authority-stale' ||
        error.code === 'product-mutation.epoch-changed'
          ? 'stale'
          : 'unavailable',
    })
  }
  return null
}

function invalidSubmittedCommand(error: unknown): boolean {
  return error instanceof TypeError
}

async function createLocalUser(
  command: LocalUserCreationMutationCommand,
): Promise<LocalUserCreationMutationResult> {
  const input = localUserCreationMutationCommandView(command)
  let capture: LocalUserCreationMutationCapture
  try {
    capture = await withTrustedCredentialCapture((query) =>
      captureLocalUserCreationMutation(query, {
        verifiedSessionToken: input.verifiedSessionToken,
        preallocatedTargetUserId: input.targetUserId,
        submittedEmail: input.email,
        commandEnteredAt: input.commandEnteredAt,
      }),
    )
  } catch (error) {
    const mapped = mappedAdministrationFailure(error)
    if (mapped) return mapped
    if (invalidSubmittedCommand(error)) return Object.freeze({ kind: 'rejected' })
    throw error
  }

  const view = localUserCreationMutationCaptureView(capture)
  if (
    !verifyLocalUserCreateActionBinding(
      input.actionBinding,
      {
        expectedEpoch: view.expectedEpoch,
        sessionId: view.sessionId,
        actorUserId: view.actorUserId,
        targetUserId: view.preallocatedTargetUserId,
      },
      input.commandEnteredAt,
    )
  ) {
    return Object.freeze({ kind: 'rejected' })
  }

  let prepared: PreparedLocalUserCreation | null = null
  let validationIssues: readonly string[] | null = null
  try {
    prepared = await prepareLocalUserCreation({
      targetUserId: view.preallocatedTargetUserId,
      name: input.name,
      email: input.email,
      initialPassword: input.initialPassword,
      commandEnteredAt: input.commandEnteredAt,
    })
  } catch (error) {
    if (!(error instanceof LocalUserInputError)) throw error
    validationIssues = Object.freeze([...error.issues])
  }

  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const emailDigest = credentialEmailLockDigest(view.normalizedEmail)
  const authenticated = authorityIssuer.authenticatedSession({
    expectedEpoch,
    actorUserId: view.actorUserId,
    sessionId: view.sessionId,
    expectedRole: view.expectedRole,
  })
  const attempt = authorityIssuer.localUserCreateAttempt({
    authenticated,
    targetUserId: view.preallocatedTargetUserId,
    emailDigest,
  })
  const intent = intentFactory.localUserCreate(attempt)

  try {
    return await prelockedSessions.withPrelockedSessionLease(intent, async (lease) => {
      const attemptUnitOfWork = createRuntimePostgresUnitOfWork(
        ({ client, request, capturedAuthority, markReauthenticationSucceeded }) => {
          const gateway = createScopedLocalUserCreationReauthenticationGateway(
            createScopedDrizzleDatabase(client),
            capture,
          )
          return {
            async recheckIdentity(): Promise<void> {
              assertAdministrationAuthority(capturedAuthority, {
                kind: 'destructive-reauthentication-attempt',
                purpose: 'local-user-create',
                epoch: view.expectedEpoch,
                actorUserId: view.actorUserId,
                sessionId: view.sessionId,
                targetUserId: view.preallocatedTargetUserId,
                emailDigest,
              })
              if (
                request.operation !== 'destructive-reauthentication-attempt' ||
                request.authority.purpose !== 'local-user-create'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckLocalUserCreationMutation(client, capture)
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways: Object.freeze({
              reauthentication: Object.freeze({
                attempt: () =>
                  gateway.attempt({
                    currentPassword: input.currentPassword,
                    requestContext: input.requestContext,
                    markReauthenticationSucceeded,
                  }),
                rejectValidation: () =>
                  gateway.rejectPrecondition({
                    reason: 'validation-rejected',
                    requestContext: input.requestContext,
                  }),
              }),
            }),
          }
        },
      )
      const attemptRequest: LocalUserAttemptRequest = {
        operation: 'destructive-reauthentication-attempt',
        authority: attempt.authority,
        session: { kind: 'prelocked', lease },
        expectedEpoch,
        productFence: 'shared',
        subjectLock: null,
        content: { kind: 'none' },
        mode: { isolation: 'read-committed', access: 'read-write' },
      }
      const attemptOutcome = await attemptUnitOfWork.run(
        attemptRequest,
        ({ gateways }) =>
          validationIssues
            ? gateways.reauthentication.rejectValidation()
            : gateways.reauthentication.attempt(),
      )

      if (attemptOutcome.status === 'precondition-rejected') {
        if (attemptOutcome.reason !== 'validation-rejected' || !validationIssues) {
          throw new CoordinationError('identity.authority-stale')
        }
        return Object.freeze({ kind: 'input-rejected', issues: validationIssues })
      }
      if (attemptOutcome.status === 'failed') {
        return Object.freeze({ kind: 'reauthentication-failed' })
      }
      if (attemptOutcome.status === 'locked') {
        return Object.freeze({ kind: 'reauthentication-locked' })
      }
      if (
        attemptOutcome.status !== 'succeeded' ||
        !prepared ||
        attemptOutcome.authority.purpose !== 'local-user-create'
      ) {
        throw new CoordinationError('identity.authority-stale')
      }
      const protectedAuthority: LocalUserProtectedAuthority = attemptOutcome.authority

      const protectedUnitOfWork = createRuntimePostgresUnitOfWork(
        ({ client, request, capturedAuthority }) => {
          const gateway = createScopedLocalUserCreationMutationGateway(
            createScopedDrizzleDatabase(client),
          )
          return {
            async recheckIdentity(): Promise<void> {
              assertAdministrationAuthority(capturedAuthority, {
                kind: 'authenticated-destructive',
                purpose: 'local-user-create',
                epoch: view.expectedEpoch,
                actorUserId: view.actorUserId,
                sessionId: view.sessionId,
                targetUserId: view.preallocatedTargetUserId,
                emailDigest,
              })
              if (
                request.operation !== 'destructive-identity-mutation' ||
                request.authority.purpose !== 'local-user-create'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckLocalUserCreationMutation(client, capture)
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways: Object.freeze({ localUserCreation: gateway }),
          }
        },
      )
      const protectedRequest: LocalUserProtectedRequest = {
        operation: 'destructive-identity-mutation',
        authority: protectedAuthority,
        session: { kind: 'prelocked', lease },
        expectedEpoch,
        productFence: 'shared',
        subjectLock: null,
        content: { kind: 'none' },
        mode: { isolation: 'read-committed', access: 'read-write' },
      }
      const outcome = await protectedUnitOfWork.run(protectedRequest, ({ gateways }) =>
        gateways.localUserCreation.createLocalUser(
          capture,
          prepared,
          input.requestContext,
        ),
      )
      return outcome.kind === 'created'
        ? Object.freeze({ kind: 'created', email: outcome.user.email })
        : Object.freeze({ kind: 'email-conflict' })
    })
  } catch (error) {
    const mapped = mappedAdministrationFailure(error)
    if (mapped) return mapped
    throw error
  }
}

async function issueMemberReset(
  command: MemberResetIssuanceMutationCommand,
): Promise<MemberResetIssuanceMutationResult> {
  const input = memberResetIssuanceMutationCommandView(command)
  let capture: MemberResetIssuanceMutationCapture
  try {
    capture = await withTrustedCredentialCapture((query) =>
      captureMemberResetIssuanceMutation(query, {
        verifiedSessionToken: input.verifiedSessionToken,
        targetUserId: input.targetUserId,
        commandEnteredAt: input.commandEnteredAt,
      }),
    )
  } catch (error) {
    const mapped = mappedAdministrationFailure(error)
    if (mapped) return mapped
    if (invalidSubmittedCommand(error)) return Object.freeze({ kind: 'rejected' })
    throw error
  }

  const view = memberResetIssuanceMutationCaptureView(capture)
  if (
    !verifyMemberResetIssueActionBinding(
      input.actionBinding,
      {
        expectedEpoch: view.expectedEpoch,
        sessionId: view.sessionId,
        actorUserId: view.actorUserId,
        targetUserId: view.targetUserId,
      },
      input.commandEnteredAt,
    )
  ) {
    return Object.freeze({ kind: 'rejected' })
  }

  const prepared =
    view.targetState === 'member' && view.targetCredential === 'present'
      ? prepareMemberResetIssuance({
          targetUserId: view.targetUserId,
          commandEnteredAt: input.commandEnteredAt,
        })
      : null
  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const authenticated = authorityIssuer.authenticatedSession({
    expectedEpoch,
    actorUserId: view.actorUserId,
    sessionId: view.sessionId,
    expectedRole: view.expectedRole,
  })
  const attempt = authorityIssuer.memberResetIssueAttempt({
    authenticated,
    targetUserId: view.targetUserId,
  })
  const intent = intentFactory.memberResetIssue(attempt)

  try {
    return await prelockedSessions.withPrelockedSessionLease(intent, async (lease) => {
      const attemptUnitOfWork = createRuntimePostgresUnitOfWork(
        ({ client, request, capturedAuthority, markReauthenticationSucceeded }) => {
          const gateway = createScopedMemberResetIssuanceReauthenticationGateway(
            createScopedDrizzleDatabase(client),
            capture,
          )
          return {
            async recheckIdentity(): Promise<void> {
              assertAdministrationAuthority(capturedAuthority, {
                kind: 'destructive-reauthentication-attempt',
                purpose: 'member-reset-issue',
                epoch: view.expectedEpoch,
                actorUserId: view.actorUserId,
                sessionId: view.sessionId,
                targetUserId: view.targetUserId,
                emailDigest: null,
              })
              if (
                request.operation !== 'destructive-reauthentication-attempt' ||
                request.authority.purpose !== 'member-reset-issue'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckMemberResetIssuanceMutation(client, capture)
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways: Object.freeze({
              reauthentication: Object.freeze({
                attempt: () =>
                  gateway.attempt({
                    currentPassword: input.currentPassword,
                    requestContext: input.requestContext,
                    markReauthenticationSucceeded,
                  }),
              }),
            }),
          }
        },
      )
      const attemptRequest: MemberResetAttemptRequest = {
        operation: 'destructive-reauthentication-attempt',
        authority: attempt.authority,
        session: { kind: 'prelocked', lease },
        expectedEpoch,
        productFence: 'shared',
        subjectLock: null,
        content: { kind: 'none' },
        mode: { isolation: 'read-committed', access: 'read-write' },
      }
      const attemptOutcome = await attemptUnitOfWork.run(attemptRequest, ({ gateways }) =>
        gateways.reauthentication.attempt(),
      )

      if (attemptOutcome.status === 'precondition-rejected') {
        if (attemptOutcome.reason !== 'target-invalid') {
          throw new CoordinationError('identity.authority-stale')
        }
        return Object.freeze({ kind: 'target-invalid' })
      }
      if (attemptOutcome.status === 'failed') {
        return Object.freeze({ kind: 'reauthentication-failed' })
      }
      if (attemptOutcome.status === 'locked') {
        return Object.freeze({ kind: 'reauthentication-locked' })
      }
      if (
        attemptOutcome.status !== 'succeeded' ||
        !prepared ||
        attemptOutcome.authority.purpose !== 'member-reset-issue'
      ) {
        throw new CoordinationError('identity.authority-stale')
      }
      const protectedAuthority: MemberResetProtectedAuthority = attemptOutcome.authority

      const protectedUnitOfWork = createRuntimePostgresUnitOfWork(
        ({ client, request, capturedAuthority }) => {
          const gateway = createScopedMemberResetIssuanceMutationGateway(
            createScopedDrizzleDatabase(client),
          )
          return {
            async recheckIdentity(): Promise<void> {
              assertAdministrationAuthority(capturedAuthority, {
                kind: 'authenticated-destructive',
                purpose: 'member-reset-issue',
                epoch: view.expectedEpoch,
                actorUserId: view.actorUserId,
                sessionId: view.sessionId,
                targetUserId: view.targetUserId,
                emailDigest: null,
              })
              if (
                request.operation !== 'destructive-identity-mutation' ||
                request.authority.purpose !== 'member-reset-issue'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckMemberResetIssuanceMutation(client, capture)
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways: Object.freeze({ memberResetIssuance: gateway }),
          }
        },
      )
      const protectedRequest: MemberResetProtectedRequest = {
        operation: 'destructive-identity-mutation',
        authority: protectedAuthority,
        session: { kind: 'prelocked', lease },
        expectedEpoch,
        productFence: 'shared',
        subjectLock: null,
        content: { kind: 'none' },
        mode: { isolation: 'serializable', access: 'read-write' },
      }
      const outcome = await protectedUnitOfWork.run(protectedRequest, ({ gateways }) =>
        gateways.memberResetIssuance.issueMemberReset(
          capture,
          prepared,
          input.requestContext,
        ),
      )
      return outcome.kind === 'issued'
        ? Object.freeze({
            kind: 'issued',
            targetUserId: view.targetUserId,
            code: outcome.code,
            expiresAt: new Date(outcome.expiresAt.getTime()),
          })
        : Object.freeze({ kind: 'cooldown' })
    })
  } catch (error) {
    const mapped = mappedAdministrationFailure(error)
    if (mapped) return mapped
    throw error
  }
}

const productionIdentityCredentialAdministrationMutationPort: IdentityCredentialAdministrationMutationPort =
  Object.freeze({ createLocalUser, issueMemberReset })

export function getProductionIdentityCredentialAdministrationMutationPort(): IdentityCredentialAdministrationMutationPort {
  return productionIdentityCredentialAdministrationMutationPort
}
