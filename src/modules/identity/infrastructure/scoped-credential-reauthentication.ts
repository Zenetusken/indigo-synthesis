import { verifyPassword } from 'better-auth/crypto'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  account,
  auditEvents,
  destructiveReauthenticationStates,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  credentialAuditContext,
  type WebCredentialContext,
} from '../recovery/credential-context'
import {
  type LocalUserCreationMutationCapture,
  localUserCreationMutationCaptureView,
  localUserCreationMutationScope,
  type MemberResetIssuanceMutationCapture,
  memberResetIssuanceMutationCaptureView,
  memberResetIssuanceMutationScope,
} from './credential-administration-mutation'
import {
  type DestructiveReauthenticationPurpose,
  destructiveReauthenticationPolicy,
} from './destructive-reauthentication'

type SupportedPurpose = Extract<
  DestructiveReauthenticationPurpose,
  'local-user-create' | 'member-reset-issue'
>

type ReauthenticationBinding = Readonly<{
  purpose: SupportedPurpose
  actorUserId: string
  targetUserId: string
  commandEnteredAt: Date
  precondition: 'ready' | 'member-target-invalid'
  audit: Readonly<{
    actorUserId: string
    subjectUserId: string | null
    eventType: 'local-user-create-rejected' | 'member-reset-rejected'
    entityType: 'local-user' | 'member-reset'
    entityId: string | null
  }>
}>

type ReauthenticationAttemptInput<ProtectedAuthority> = Readonly<{
  currentPassword: string
  requestContext: WebCredentialContext
  markReauthenticationSucceeded: () => ProtectedAuthority
}>

export type ScopedCredentialReauthenticationOutcome<ProtectedAuthority> =
  | Readonly<{ status: 'succeeded'; authority: ProtectedAuthority }>
  | Readonly<{ status: 'failed' | 'locked' }>
  | ScopedCredentialPreconditionRejection

export type ScopedCredentialPreconditionRejection = Readonly<{
  status: 'precondition-rejected'
  reason: 'validation-rejected' | 'target-invalid'
}>

type PreconditionRejectionInput<
  Reason extends ScopedCredentialPreconditionRejection['reason'],
> = Readonly<{
  reason: Reason
  requestContext: WebCredentialContext
}>

export interface ScopedLocalUserCreationReauthenticationGateway {
  attempt<ProtectedAuthority>(
    input: ReauthenticationAttemptInput<ProtectedAuthority>,
  ): Promise<ScopedCredentialReauthenticationOutcome<ProtectedAuthority>>
  rejectPrecondition(
    input: PreconditionRejectionInput<'validation-rejected'>,
  ): Promise<ScopedCredentialPreconditionRejection>
}

export interface ScopedMemberResetIssuanceReauthenticationGateway {
  attempt<ProtectedAuthority>(
    input: ReauthenticationAttemptInput<ProtectedAuthority>,
  ): Promise<ScopedCredentialReauthenticationOutcome<ProtectedAuthority>>
  rejectPrecondition(
    input: PreconditionRejectionInput<'target-invalid'>,
  ): Promise<ScopedCredentialPreconditionRejection>
}

export class ScopedCredentialReauthenticationInvariantError extends Error {
  constructor() {
    super('The scoped credential reauthentication state is no longer coherent.')
    this.name = 'ScopedCredentialReauthenticationInvariantError'
  }
}

type CredentialRow = Readonly<{
  id: string
  password: string | null
}>

type ReauthenticationStateRow = Readonly<{
  id: string
  accountId: string
  purpose: string
  windowStartedAt: Date
  failedAttempts: number
  lockedUntil: Date | null
  lastAttemptAt: Date
}>

function invariant(): never {
  throw new ScopedCredentialReauthenticationInvariantError()
}

function attemptDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return invariant()
  return new Date(value.getTime())
}

function assertCredential(
  row: CredentialRow | undefined,
): CredentialRow & Readonly<{ password: string }> {
  if (
    !row ||
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    typeof row.password !== 'string' ||
    row.password.length === 0
  ) {
    return invariant()
  }
  return row as CredentialRow & Readonly<{ password: string }>
}

function assertState(
  row: ReauthenticationStateRow | undefined,
  binding: ReauthenticationBinding,
  credentialId: string,
): ReauthenticationStateRow | undefined {
  if (!row) return undefined
  if (
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    row.accountId !== credentialId ||
    row.purpose !== binding.purpose ||
    !(row.windowStartedAt instanceof Date) ||
    !Number.isFinite(row.windowStartedAt.getTime()) ||
    !(row.lastAttemptAt instanceof Date) ||
    !Number.isFinite(row.lastAttemptAt.getTime()) ||
    row.lastAttemptAt.getTime() < row.windowStartedAt.getTime() ||
    !Number.isInteger(row.failedAttempts) ||
    row.failedAttempts < 1 ||
    row.failedAttempts > destructiveReauthenticationPolicy.maximumFailedAttempts ||
    (row.lockedUntil !== null &&
      (!(row.lockedUntil instanceof Date) || !Number.isFinite(row.lockedUntil.getTime())))
  ) {
    return invariant()
  }
  return row
}

async function attemptReauthentication<
  TSchema extends Record<string, unknown>,
  ProtectedAuthority,
>(
  database: NodePgDatabase<TSchema>,
  binding: ReauthenticationBinding,
  input: ReauthenticationAttemptInput<ProtectedAuthority>,
): Promise<ScopedCredentialReauthenticationOutcome<ProtectedAuthority>> {
  if (binding.precondition === 'member-target-invalid') {
    return rejectPrecondition(database, binding, {
      reason: 'target-invalid',
      requestContext: input.requestContext,
    })
  }

  const currentPassword = input.currentPassword
  const markReauthenticationSucceeded = input.markReauthenticationSucceeded
  if (
    typeof currentPassword !== 'string' ||
    typeof markReauthenticationSucceeded !== 'function'
  ) {
    return invariant()
  }
  const now = attemptDate(binding.commandEnteredAt)
  const requestAuditContext = credentialAuditContext(input.requestContext)

  const [selectedCredential] = await database
    .select({ id: account.id, password: account.password })
    .from(account)
    .where(
      and(eq(account.userId, binding.actorUserId), eq(account.providerId, 'credential')),
    )
    .for('update')
    .limit(1)
  const credential = assertCredential(selectedCredential)

  const [selectedState] = await database
    .select({
      id: destructiveReauthenticationStates.id,
      accountId: destructiveReauthenticationStates.accountId,
      purpose: destructiveReauthenticationStates.purpose,
      windowStartedAt: destructiveReauthenticationStates.windowStartedAt,
      failedAttempts: destructiveReauthenticationStates.failedAttempts,
      lockedUntil: destructiveReauthenticationStates.lockedUntil,
      lastAttemptAt: destructiveReauthenticationStates.lastAttemptAt,
    })
    .from(destructiveReauthenticationStates)
    .where(
      and(
        eq(destructiveReauthenticationStates.accountId, credential.id),
        eq(destructiveReauthenticationStates.purpose, binding.purpose),
      ),
    )
    .for('update')
    .limit(1)
  const state = assertState(selectedState, binding, credential.id)

  const effectiveStateAt = state
    ? new Date(Math.max(now.getTime(), state.lastAttemptAt.getTime()))
    : now

  if (state?.lockedUntil && state.lockedUntil > effectiveStateAt) {
    return Object.freeze({ status: 'locked' })
  }

  const accepted = await verifyPassword({
    hash: credential.password,
    password: currentPassword,
  })
  if (accepted) {
    if (state) {
      await database
        .delete(destructiveReauthenticationStates)
        .where(
          and(
            eq(destructiveReauthenticationStates.id, state.id),
            eq(destructiveReauthenticationStates.accountId, credential.id),
            eq(destructiveReauthenticationStates.purpose, binding.purpose),
          ),
        )
    }
    const authority = markReauthenticationSucceeded()
    return Object.freeze({ status: 'succeeded', authority })
  }

  const windowCutoff = new Date(
    effectiveStateAt.getTime() -
      destructiveReauthenticationPolicy.attemptWindowMilliseconds,
  )
  const continuesWindow =
    state !== undefined &&
    state.windowStartedAt > windowCutoff &&
    state.lockedUntil === null
  const attemptsInWindow = continuesWindow ? state.failedAttempts + 1 : 1
  const becomesLocked =
    attemptsInWindow >= destructiveReauthenticationPolicy.maximumFailedAttempts
  const windowStartedAt = continuesWindow ? state.windowStartedAt : effectiveStateAt
  const lockedUntil = becomesLocked
    ? new Date(
        effectiveStateAt.getTime() +
          destructiveReauthenticationPolicy.lockoutMilliseconds,
      )
    : null
  const stateId = state?.id ?? newUuidV7(now.getTime())

  if (state) {
    await database
      .update(destructiveReauthenticationStates)
      .set({
        windowStartedAt,
        failedAttempts: attemptsInWindow,
        lockedUntil,
        lastAttemptAt: effectiveStateAt,
        updatedAt: effectiveStateAt,
      })
      .where(
        and(
          eq(destructiveReauthenticationStates.id, state.id),
          eq(destructiveReauthenticationStates.accountId, credential.id),
          eq(destructiveReauthenticationStates.purpose, binding.purpose),
        ),
      )
  } else {
    await database.insert(destructiveReauthenticationStates).values({
      id: stateId,
      accountId: credential.id,
      purpose: binding.purpose,
      windowStartedAt,
      failedAttempts: attemptsInWindow,
      lockedUntil,
      lastAttemptAt: effectiveStateAt,
      createdAt: now,
      updatedAt: effectiveStateAt,
    })
  }

  const outcome = becomesLocked ? 'locked' : 'failed'
  await database.insert(auditEvents).values({
    id: newUuidV7(now.getTime()),
    actorUserId: binding.audit.actorUserId,
    subjectUserId: binding.audit.subjectUserId,
    eventType: binding.audit.eventType,
    entityType: binding.audit.entityType,
    entityId: binding.audit.entityId,
    metadata: {
      ...requestAuditContext,
      purpose: binding.purpose,
      outcome,
      attemptsInWindow,
      windowStartedAt: windowStartedAt.toISOString(),
      lockedUntil: lockedUntil?.toISOString() ?? null,
    },
    createdAt: now,
  })

  return Object.freeze({ status: outcome })
}

async function rejectPrecondition<
  TSchema extends Record<string, unknown>,
  Reason extends ScopedCredentialPreconditionRejection['reason'],
>(
  database: NodePgDatabase<TSchema>,
  binding: ReauthenticationBinding,
  input: PreconditionRejectionInput<Reason>,
): Promise<ScopedCredentialPreconditionRejection> {
  if (
    (binding.purpose === 'local-user-create' && input.reason !== 'validation-rejected') ||
    (binding.purpose === 'member-reset-issue' &&
      (input.reason !== 'target-invalid' ||
        binding.precondition !== 'member-target-invalid'))
  ) {
    return invariant()
  }
  const now = attemptDate(binding.commandEnteredAt)
  await database.insert(auditEvents).values({
    id: newUuidV7(now.getTime()),
    actorUserId: binding.audit.actorUserId,
    subjectUserId: binding.audit.subjectUserId,
    eventType: binding.audit.eventType,
    entityType: binding.audit.entityType,
    entityId: binding.audit.entityId,
    metadata: {
      ...credentialAuditContext(input.requestContext),
      outcome: input.reason,
    },
    createdAt: now,
  })
  return Object.freeze({ status: 'precondition-rejected', reason: input.reason })
}

function localUserCreationBinding(
  capture: LocalUserCreationMutationCapture,
): ReauthenticationBinding {
  const view = localUserCreationMutationCaptureView(capture)
  const scope = localUserCreationMutationScope(capture)
  if (
    view.actorCredential !== 'present' ||
    scope.actorUserId !== view.actorUserId ||
    scope.targetUserId !== view.preallocatedTargetUserId
  ) {
    return invariant()
  }
  return Object.freeze({
    purpose: view.purpose,
    actorUserId: view.actorUserId,
    targetUserId: view.preallocatedTargetUserId,
    commandEnteredAt: new Date(scope.commandEnteredAt.getTime()),
    precondition: 'ready',
    audit: Object.freeze({
      actorUserId: view.actorUserId,
      subjectUserId: null,
      eventType: 'local-user-create-rejected',
      entityType: 'local-user',
      entityId: view.preallocatedTargetUserId,
    }),
  })
}

function memberResetIssuanceBinding(
  capture: MemberResetIssuanceMutationCapture,
): ReauthenticationBinding {
  const view = memberResetIssuanceMutationCaptureView(capture)
  const scope = memberResetIssuanceMutationScope(capture)
  if (
    view.actorCredential !== 'present' ||
    scope.actorUserId !== view.actorUserId ||
    scope.targetUserId !== view.targetUserId ||
    scope.targetState !== view.targetState ||
    scope.targetCredential !== view.targetCredential
  ) {
    return invariant()
  }
  const targetIsInvalid =
    view.targetState !== 'member' || view.targetCredential !== 'present'
  return Object.freeze({
    purpose: view.purpose,
    actorUserId: view.actorUserId,
    targetUserId: view.targetUserId,
    commandEnteredAt: new Date(scope.commandEnteredAt.getTime()),
    precondition: targetIsInvalid ? 'member-target-invalid' : 'ready',
    audit: Object.freeze({
      actorUserId: view.actorUserId,
      subjectUserId: view.targetState === 'missing' ? null : view.targetUserId,
      eventType: 'member-reset-rejected',
      entityType: 'member-reset',
      entityId: null,
    }),
  })
}

/**
 * Purpose-narrow attempt gateway. Its only DML surface is the local-user-create
 * password-attempt state and the command's single denial event.
 */
export function createScopedLocalUserCreationReauthenticationGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  capture: LocalUserCreationMutationCapture,
): ScopedLocalUserCreationReauthenticationGateway {
  const binding = localUserCreationBinding(capture)
  return Object.freeze({
    attempt<ProtectedAuthority>(input: ReauthenticationAttemptInput<ProtectedAuthority>) {
      return attemptReauthentication(database, binding, input)
    },
    rejectPrecondition(input: PreconditionRejectionInput<'validation-rejected'>) {
      return rejectPrecondition(database, binding, input)
    },
  })
}

/**
 * Purpose-narrow attempt gateway. It cannot issue or redeem reset material and exposes
 * no protected-identity DML method to the reauthentication callback.
 */
export function createScopedMemberResetIssuanceReauthenticationGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  capture: MemberResetIssuanceMutationCapture,
): ScopedMemberResetIssuanceReauthenticationGateway {
  const binding = memberResetIssuanceBinding(capture)
  return Object.freeze({
    attempt<ProtectedAuthority>(input: ReauthenticationAttemptInput<ProtectedAuthority>) {
      return attemptReauthentication(database, binding, input)
    },
    rejectPrecondition(input: PreconditionRejectionInput<'target-invalid'>) {
      return rejectPrecondition(database, binding, input)
    },
  })
}
