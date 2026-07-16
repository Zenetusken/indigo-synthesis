import {
  type AuthenticatedDestructiveAuthority,
  CoordinationError,
  type DestructiveReauthenticationAttemptRequest,
  type InstanceResetRequest,
  type SubjectDeletionRequest,
} from '@/application/coordination'
import { DeletionError } from '@/modules/data-portability/application/deletion'
import {
  createScopedInstanceResetAttemptGateway,
  createScopedInstanceResetGateway,
  createScopedSubjectDeletionAttemptGateway,
  createScopedSubjectDeletionGateway,
} from '@/modules/data-portability/infrastructure/scoped-destructive-adapter'
import {
  verifyInstanceResetActionBinding,
  verifyTraineeDataDeletionActionBinding,
} from '@/modules/identity/infrastructure/action-binding'
import {
  captureInstanceResetMutation,
  captureTraineeDataDeletionMutation,
  IdentityDestructiveMutationAuthorityUnavailableError,
  IdentityDestructiveMutationCaptureInvariantError,
  IdentityDestructiveMutationCaptureStaleError,
  type InstanceResetMutationCapture,
  instanceResetMutationCaptureView,
  recheckInstanceResetMutation,
  recheckTraineeDataDeletionMutation,
  type TraineeDataDeletionMutationCapture,
  traineeDataDeletionMutationCaptureView,
} from '@/modules/identity/infrastructure/destructive-mutation'
import {
  createScopedInstanceResetReauthenticationGateway,
  createScopedSubjectDeletionReauthenticationGateway,
} from '@/modules/identity/infrastructure/scoped-credential-reauthentication'
import {
  type InstanceResetMutationCommand,
  instanceResetCommandView,
  type TraineeDataDeletionMutationCommand,
  traineeDataDeletionCommandView,
} from '@/modules/identity/server/destructive-command'
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

type KnownNotAppliedResult =
  | Readonly<{ kind: 'confirmation-rejected' }>
  | Readonly<{ kind: 'reauthentication-failed' }>
  | Readonly<{ kind: 'reauthentication-locked' }>
  | Readonly<{ kind: 'plan-invalid' }>
  | Readonly<{ kind: 'plan-changed' }>
  | Readonly<{ kind: 'stale' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'reauthentication-incomplete' }>

type OutcomeUnknownResult = Readonly<{ kind: 'outcome-unknown' }>

type SubjectOutcomeUnknownResult = Readonly<{
  kind: 'outcome-unknown'
  actorRole: 'owner' | 'member'
}>

export type SubjectDeletionMutationResult =
  | KnownNotAppliedResult
  | SubjectOutcomeUnknownResult
  | Readonly<{
      kind: 'deleted'
      actorRole: 'owner' | 'member'
      warning: 'cleanup-failed' | null
    }>

export type InstanceResetMutationResult =
  | KnownNotAppliedResult
  | OutcomeUnknownResult
  | Readonly<{ kind: 'reset'; warning: 'cleanup-failed' | null }>

export interface DataPortabilityDestructiveMutationPort {
  deleteSubject(
    command: TraineeDataDeletionMutationCommand,
  ): Promise<SubjectDeletionMutationResult>
  resetInstance(
    command: InstanceResetMutationCommand,
  ): Promise<InstanceResetMutationResult>
}

type SubjectAttemptRequest = Extract<
  DestructiveReauthenticationAttemptRequest,
  { readonly authority: { readonly purpose: 'trainee-data-deletion' } }
>
type ResetAttemptRequest = Extract<
  DestructiveReauthenticationAttemptRequest,
  { readonly authority: { readonly purpose: 'instance-reset' } }
>
type SubjectProtectedAuthority = Extract<
  AuthenticatedDestructiveAuthority,
  { readonly purpose: 'trainee-data-deletion' }
>
type ResetProtectedAuthority = Extract<
  AuthenticatedDestructiveAuthority,
  { readonly purpose: 'instance-reset' }
>

type DestructivePurpose = 'trainee-data-deletion' | 'instance-reset'
type DestructivePhase = 'before-attempt' | 'attempt' | 'protected'

type ExpectedDestructiveAuthority = Readonly<{
  kind: 'destructive-reauthentication-attempt' | 'authenticated-destructive'
  purpose: DestructivePurpose
  epoch: string
  actorUserId: string
  sessionId: string
  expectedRole: 'owner' | 'member'
}>

const authorityIssuer = createPlatformMutationAuthorityIssuer()
const intentFactory = createPlatformPrelockedSessionIntentFactory()
const prelockedSessions = createPlatformPrelockedSessionPort()
const emptyReadGateways = Object.freeze({})
const maximumPlanIdentityBytes = 512

function identityRecheckFailure(
  reason: 'installation-epoch-changed' | string,
): CoordinationError {
  return new CoordinationError(
    reason === 'installation-epoch-changed'
      ? 'product-mutation.epoch-changed'
      : 'identity.authority-stale',
  )
}

function assertDestructiveAuthority(
  captured: CapturedIdentityAuthority,
  expected: ExpectedDestructiveAuthority,
): void {
  if (
    captured.kind !== expected.kind ||
    captured.purpose !== expected.purpose ||
    !installationMutationEpochMatches(captured.expectedEpoch, expected.epoch) ||
    captured.actorUserId !== expected.actorUserId ||
    captured.sessionId !== expected.sessionId ||
    captured.expectedRole !== expected.expectedRole ||
    captured.targetUserId !== null ||
    captured.emailDigest !== null
  ) {
    throw new CoordinationError('identity.authority-stale')
  }
}

function lifecycleFailure(
  error: unknown,
  phase: DestructivePhase,
): KnownNotAppliedResult | OutcomeUnknownResult | null {
  if (
    error instanceof IdentityDestructiveMutationAuthorityUnavailableError ||
    error instanceof IdentityDestructiveMutationCaptureStaleError
  ) {
    return Object.freeze({ kind: 'stale' })
  }
  if (error instanceof CredentialConnectionCapacityError) {
    return Object.freeze({ kind: 'unavailable' })
  }
  if (error instanceof DeletionError) {
    if (error.code === 'deletion.plan-invalid') {
      return Object.freeze({ kind: 'plan-invalid' })
    }
    if (error.code === 'deletion.plan-changed') {
      return Object.freeze({ kind: 'plan-changed' })
    }
    return null
  }
  if (!(error instanceof CoordinationError)) return null
  if (
    error.code === 'identity.authority-stale' ||
    error.code === 'product-mutation.epoch-changed'
  ) {
    return Object.freeze({ kind: 'stale' })
  }
  if (error.code === 'uow.capacity' || error.code === 'uow.lock-timeout') {
    return Object.freeze({ kind: 'unavailable' })
  }
  if (phase === 'protected' && error.code === 'uow.commit-outcome-unknown') {
    return Object.freeze({ kind: 'outcome-unknown' })
  }
  const protectedNotAppliedCodes = new Set([
    'uow.begin-failed',
    'uow.cancelled',
    'uow.connection-lost',
    'uow.transaction-aborted',
  ])
  if (phase === 'protected' && protectedNotAppliedCodes.has(error.code)) {
    return Object.freeze({ kind: 'unavailable' })
  }
  const incompleteAttemptCodes = new Set([
    'uow.begin-failed',
    'uow.cancelled',
    'uow.cleanup-failed',
    'uow.commit-outcome-unknown',
    'uow.connection-lost',
    'uow.transaction-aborted',
  ])
  if (phase === 'attempt' && incompleteAttemptCodes.has(error.code)) {
    return Object.freeze({ kind: 'reauthentication-incomplete' })
  }
  if (phase === 'before-attempt' && incompleteAttemptCodes.has(error.code)) {
    return Object.freeze({ kind: 'unavailable' })
  }
  return null
}

function submittedSubjectCommand(
  command: TraineeDataDeletionMutationCommand,
): ReturnType<typeof traineeDataDeletionCommandView> | null {
  try {
    const input = traineeDataDeletionCommandView(command)
    return input.acknowledged && input.typedConfirmation === 'DELETE' ? input : null
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
}

function submittedResetCommand(
  command: InstanceResetMutationCommand,
): ReturnType<typeof instanceResetCommandView> | null {
  try {
    const input = instanceResetCommandView(command)
    return input.acknowledged && input.typedConfirmation === 'RESET' ? input : null
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
}

function validPlanIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maximumPlanIdentityBytes
  )
}

async function captureSubject(
  command: TraineeDataDeletionMutationCommand,
): Promise<TraineeDataDeletionMutationCapture> {
  return withTrustedCredentialCapture((query) =>
    captureTraineeDataDeletionMutation(query, command),
  )
}

async function captureReset(
  command: InstanceResetMutationCommand,
): Promise<InstanceResetMutationCapture> {
  return withTrustedCredentialCapture((query) =>
    captureInstanceResetMutation(query, command),
  )
}

async function deleteSubject(
  command: TraineeDataDeletionMutationCommand,
): Promise<SubjectDeletionMutationResult> {
  const input = submittedSubjectCommand(command)
  if (!input) return Object.freeze({ kind: 'confirmation-rejected' })
  if (!validPlanIdentity(input.planId) || !validPlanIdentity(input.planDigest)) {
    return Object.freeze({ kind: 'confirmation-rejected' })
  }

  let capture: TraineeDataDeletionMutationCapture
  try {
    capture = await captureSubject(command)
  } catch (error) {
    const mapped = lifecycleFailure(error, 'before-attempt')
    if (mapped && mapped.kind !== 'outcome-unknown') return mapped
    throw error
  }
  const view = traineeDataDeletionMutationCaptureView(capture)
  if (
    !verifyTraineeDataDeletionActionBinding(
      input.actionBinding,
      {
        expectedEpoch: view.expectedEpoch,
        sessionId: view.sessionId,
        actorUserId: view.actorUserId,
        planId: view.planId,
        planDigest: view.planDigest,
      },
      input.commandEnteredAt,
    )
  ) {
    return Object.freeze({ kind: 'confirmation-rejected' })
  }

  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const authenticated = authorityIssuer.authenticatedSession({
    expectedEpoch,
    actorUserId: view.actorUserId,
    sessionId: view.sessionId,
    expectedRole: view.expectedRole,
  })
  const attempt = authorityIssuer.traineeDataDeletionAttempt({ authenticated })
  const intent = intentFactory.subjectDeletion(attempt)
  let phase: DestructivePhase = 'before-attempt'
  const resolution: { value: SubjectDeletionMutationResult | null } = { value: null }

  try {
    return await prelockedSessions.withPrelockedSessionLease(intent, async (lease) => {
      phase = 'attempt'
      const attemptUnitOfWork = createRuntimePostgresUnitOfWork(
        ({
          client,
          request,
          capturedAuthority,
          markReauthenticationSucceeded,
          requireWriteAuthorized,
        }) => {
          const database = createScopedDrizzleDatabase(client)
          const reauthentication = createScopedSubjectDeletionReauthenticationGateway(
            database,
            capture,
          )
          const deletionAttempt = createScopedSubjectDeletionAttemptGateway(
            database,
            { actorUserId: view.actorUserId },
            requireWriteAuthorized,
          )
          return {
            async recheckIdentity(): Promise<void> {
              assertDestructiveAuthority(capturedAuthority, {
                kind: 'destructive-reauthentication-attempt',
                purpose: 'trainee-data-deletion',
                epoch: view.expectedEpoch,
                actorUserId: view.actorUserId,
                sessionId: view.sessionId,
                expectedRole: view.expectedRole,
              })
              if (
                request.operation !== 'destructive-reauthentication-attempt' ||
                request.authority.purpose !== 'trainee-data-deletion'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckTraineeDataDeletionMutation(client, capture)
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways: Object.freeze({
              destructiveAttempt: Object.freeze({
                async execute() {
                  const outcome = await reauthentication.attempt({
                    currentPassword: input.currentPassword,
                    requestContext: input.requestContext,
                    markReauthenticationSucceeded,
                  })
                  if (outcome.status === 'failed' || outcome.status === 'locked') {
                    await deletionAttempt.invalidatePreviewAfterDenial()
                  }
                  return outcome
                },
              }),
            }),
          }
        },
      )
      const attemptRequest: SubjectAttemptRequest = {
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
        gateways.destructiveAttempt.execute(),
      )
      if (attemptOutcome.status === 'failed') {
        resolution.value = Object.freeze({ kind: 'reauthentication-failed' })
        return resolution.value
      }
      if (attemptOutcome.status === 'locked') {
        resolution.value = Object.freeze({ kind: 'reauthentication-locked' })
        return resolution.value
      }
      if (
        attemptOutcome.status !== 'succeeded' ||
        attemptOutcome.authority.purpose !== 'trainee-data-deletion'
      ) {
        throw new TypeError(
          'Subject-deletion reauthentication returned an invalid outcome.',
        )
      }
      const protectedAuthority: SubjectProtectedAuthority = attemptOutcome.authority
      phase = 'protected'
      const protectedUnitOfWork = createRuntimePostgresUnitOfWork(
        ({ client, request, capturedAuthority, requireWriteAuthorized }) => {
          const gateway = createScopedSubjectDeletionGateway(
            createScopedDrizzleDatabase(client),
            {
              actorUserId: view.actorUserId,
              actorEmail: view.actorEmail,
              actorRole: view.expectedRole,
              planId: view.planId,
              planDigest: view.planDigest,
            },
            requireWriteAuthorized,
          )
          return {
            async recheckIdentity(): Promise<void> {
              assertDestructiveAuthority(capturedAuthority, {
                kind: 'authenticated-destructive',
                purpose: 'trainee-data-deletion',
                epoch: view.expectedEpoch,
                actorUserId: view.actorUserId,
                sessionId: view.sessionId,
                expectedRole: view.expectedRole,
              })
              if (
                request.operation !== 'subject-deletion' ||
                request.authority.purpose !== 'trainee-data-deletion'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckTraineeDataDeletionMutation(client, capture)
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways: Object.freeze({ subjectDeletion: gateway }),
          }
        },
      )
      const protectedRequest: SubjectDeletionRequest = {
        operation: 'subject-deletion',
        authority: protectedAuthority,
        session: { kind: 'prelocked', lease },
        expectedEpoch,
        productFence: 'shared',
        subjectLock: { subjectUserId: view.actorUserId, mode: 'exclusive' },
        content: { kind: 'none' },
        mode: { isolation: 'serializable', access: 'read-write' },
      }
      try {
        await protectedUnitOfWork.run(protectedRequest, ({ gateways }) =>
          gateways.subjectDeletion.execute(),
        )
        resolution.value = Object.freeze({
          kind: 'deleted',
          actorRole: view.expectedRole,
          warning: null,
        })
      } catch (error) {
        if (
          !(error instanceof CoordinationError) ||
          error.code !== 'uow.cleanup-failed'
        ) {
          throw error
        }
        resolution.value = Object.freeze({
          kind: 'deleted',
          actorRole: view.expectedRole,
          warning: 'cleanup-failed',
        })
      }
      return resolution.value
    })
  } catch (error) {
    if (resolution.value) {
      return resolution.value.kind === 'deleted'
        ? Object.freeze({ ...resolution.value, warning: 'cleanup-failed' })
        : resolution.value
    }
    const mapped = lifecycleFailure(error, phase)
    if (mapped) {
      return mapped.kind === 'outcome-unknown'
        ? Object.freeze({ kind: mapped.kind, actorRole: view.expectedRole })
        : mapped
    }
    throw error
  }
}

async function resetInstance(
  command: InstanceResetMutationCommand,
): Promise<InstanceResetMutationResult> {
  const input = submittedResetCommand(command)
  if (!input) return Object.freeze({ kind: 'confirmation-rejected' })
  if (!validPlanIdentity(input.planId) || !validPlanIdentity(input.planDigest)) {
    return Object.freeze({ kind: 'confirmation-rejected' })
  }

  let capture: InstanceResetMutationCapture
  try {
    capture = await captureReset(command)
  } catch (error) {
    const mapped = lifecycleFailure(error, 'before-attempt')
    if (mapped) return mapped
    throw error
  }
  const view = instanceResetMutationCaptureView(capture)
  if (view.expectedRole !== 'owner') {
    throw new IdentityDestructiveMutationCaptureInvariantError()
  }
  if (
    !verifyInstanceResetActionBinding(
      input.actionBinding,
      {
        expectedEpoch: view.expectedEpoch,
        sessionId: view.sessionId,
        actorUserId: view.actorUserId,
        planId: view.planId,
        planDigest: view.planDigest,
      },
      input.commandEnteredAt,
    )
  ) {
    return Object.freeze({ kind: 'confirmation-rejected' })
  }

  const expectedEpoch = createInstallationMutationEpoch(view.expectedEpoch)
  const authenticated = authorityIssuer.authenticatedSession({
    expectedEpoch,
    actorUserId: view.actorUserId,
    sessionId: view.sessionId,
    expectedRole: view.expectedRole,
  })
  const attempt = authorityIssuer.instanceResetAttempt({ authenticated })
  const intent = intentFactory.instanceReset(attempt)
  let phase: DestructivePhase = 'before-attempt'
  const resolution: { value: InstanceResetMutationResult | null } = { value: null }

  try {
    return await prelockedSessions.withPrelockedSessionLease(intent, async (lease) => {
      phase = 'attempt'
      const attemptUnitOfWork = createRuntimePostgresUnitOfWork(
        ({
          client,
          request,
          capturedAuthority,
          markReauthenticationSucceeded,
          requireWriteAuthorized,
        }) => {
          const database = createScopedDrizzleDatabase(client)
          const reauthentication = createScopedInstanceResetReauthenticationGateway(
            database,
            capture,
          )
          const resetAttempt = createScopedInstanceResetAttemptGateway(
            database,
            { actorUserId: view.actorUserId },
            requireWriteAuthorized,
          )
          return {
            async recheckIdentity(): Promise<void> {
              assertDestructiveAuthority(capturedAuthority, {
                kind: 'destructive-reauthentication-attempt',
                purpose: 'instance-reset',
                epoch: view.expectedEpoch,
                actorUserId: view.actorUserId,
                sessionId: view.sessionId,
                expectedRole: 'owner',
              })
              if (
                request.operation !== 'destructive-reauthentication-attempt' ||
                request.authority.purpose !== 'instance-reset'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckInstanceResetMutation(client, capture)
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways: Object.freeze({
              destructiveAttempt: Object.freeze({
                async execute() {
                  const outcome = await reauthentication.attempt({
                    currentPassword: input.currentPassword,
                    requestContext: input.requestContext,
                    markReauthenticationSucceeded,
                  })
                  if (outcome.status === 'failed' || outcome.status === 'locked') {
                    await resetAttempt.invalidatePreviewAfterDenial()
                  }
                  return outcome
                },
              }),
            }),
          }
        },
      )
      const attemptRequest: ResetAttemptRequest = {
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
        gateways.destructiveAttempt.execute(),
      )
      if (attemptOutcome.status === 'failed') {
        resolution.value = Object.freeze({ kind: 'reauthentication-failed' })
        return resolution.value
      }
      if (attemptOutcome.status === 'locked') {
        resolution.value = Object.freeze({ kind: 'reauthentication-locked' })
        return resolution.value
      }
      if (
        attemptOutcome.status !== 'succeeded' ||
        attemptOutcome.authority.purpose !== 'instance-reset'
      ) {
        throw new TypeError(
          'Instance-reset reauthentication returned an invalid outcome.',
        )
      }
      const protectedAuthority: ResetProtectedAuthority = attemptOutcome.authority
      phase = 'protected'
      const protectedUnitOfWork = createRuntimePostgresUnitOfWork(
        ({ client, request, capturedAuthority, requireWriteAuthorized }) => {
          const gateway = createScopedInstanceResetGateway(
            createScopedDrizzleDatabase(client),
            {
              actorUserId: view.actorUserId,
              planId: view.planId,
              planDigest: view.planDigest,
            },
            requireWriteAuthorized,
          )
          return {
            async recheckIdentity(): Promise<void> {
              assertDestructiveAuthority(capturedAuthority, {
                kind: 'authenticated-destructive',
                purpose: 'instance-reset',
                epoch: view.expectedEpoch,
                actorUserId: view.actorUserId,
                sessionId: view.sessionId,
                expectedRole: 'owner',
              })
              if (
                request.operation !== 'instance-reset' ||
                request.authority.purpose !== 'instance-reset'
              ) {
                throw new CoordinationError('identity.authority-stale')
              }
              const recheck = await recheckInstanceResetMutation(client, capture)
              if (recheck.status === 'stale') {
                throw identityRecheckFailure(recheck.reason)
              }
            },
            readGateways: emptyReadGateways,
            writeGateways: Object.freeze({ instanceReset: gateway }),
          }
        },
      )
      const protectedRequest: InstanceResetRequest = {
        operation: 'instance-reset',
        authority: protectedAuthority,
        session: { kind: 'prelocked', lease },
        expectedEpoch,
        productFence: 'exclusive',
        subjectLock: null,
        content: { kind: 'none' },
        mode: { isolation: 'serializable', access: 'read-write' },
      }
      try {
        await protectedUnitOfWork.run(protectedRequest, ({ gateways }) =>
          gateways.instanceReset.execute(),
        )
        resolution.value = Object.freeze({ kind: 'reset', warning: null })
      } catch (error) {
        if (
          !(error instanceof CoordinationError) ||
          error.code !== 'uow.cleanup-failed'
        ) {
          throw error
        }
        resolution.value = Object.freeze({
          kind: 'reset',
          warning: 'cleanup-failed',
        })
      }
      return resolution.value
    })
  } catch (error) {
    if (resolution.value) {
      return resolution.value.kind === 'reset'
        ? Object.freeze({ ...resolution.value, warning: 'cleanup-failed' })
        : resolution.value
    }
    const mapped = lifecycleFailure(error, phase)
    if (mapped) return mapped
    throw error
  }
}

const productionDataPortabilityDestructiveMutationPort: DataPortabilityDestructiveMutationPort =
  Object.freeze({ deleteSubject, resetInstance })

export function getProductionDataPortabilityDestructiveMutationPort(): DataPortabilityDestructiveMutationPort {
  return productionDataPortabilityDestructiveMutationPort
}
