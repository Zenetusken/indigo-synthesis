import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  account,
  auditEvents,
  memberResetStates,
  session,
  verification,
} from '@/platform/db/schema'
import {
  credentialAuditContext,
  type WebCredentialContext,
} from '../recovery/credential-context'
import { memberResetBackoffMilliseconds } from '../recovery/recovery-policy'
import {
  memberResetCodeIdentity,
  memberResetStoredValueMatches,
  ownerRecoveryCodeIdentity,
  ownerRecoveryStoredValueMatches,
  type ParsedRecoveryRedemptionInput,
  type PreparedRecoveryRedemption,
  prepareMemberResetRedemption,
  prepareOwnerRecoveryRedemption,
} from '../recovery/recovery-preparation'
import {
  claimMemberResetRedemptionMutationScope,
  claimOwnerRecoveryWebRedemptionMutationScope,
  type MemberResetRedemptionCapture,
  type MemberResetRedemptionMutationScope,
  type OwnerRecoveryWebRedemptionCapture,
  type OwnerRecoveryWebRedemptionMutationScope,
} from './recovery-mutation'
import { createScopedWebRecoveryRateLimitGateway } from './web-recovery-rate-limit'

const maximumPrivateValueBytes = 16 * 1024
const maximumPostgresInteger = 2_147_483_647

export type ScopedBrowserRecoveryRejection = Readonly<{
  kind: 'rejected'
  persistence: 'unchanged' | 'committed'
}>

export type ScopedMemberResetRedemptionOutcome =
  | Readonly<{
      kind: 'redeemed'
      targetUserId: string
      revokedSessionCount: number
    }>
  | ScopedBrowserRecoveryRejection

export type ScopedOwnerRecoveryWebRedemptionOutcome =
  | Readonly<{
      kind: 'redeemed'
      ownerUserId: string
      revokedSessionCount: number
    }>
  | ScopedBrowserRecoveryRejection

export type ScopedBrowserRecoveryRedemptionInput = Readonly<{
  parsed: ParsedRecoveryRedemptionInput
  commandEnteredAt: Date
  requestContext: WebCredentialContext
}>

export interface ScopedMemberResetRedemptionMutationGateway {
  redeem(
    input: ScopedBrowserRecoveryRedemptionInput,
  ): Promise<ScopedMemberResetRedemptionOutcome>
}

export interface ScopedOwnerRecoveryWebRedemptionMutationGateway {
  redeem(
    input: ScopedBrowserRecoveryRedemptionInput,
  ): Promise<ScopedOwnerRecoveryWebRedemptionOutcome>
}

export class ScopedBrowserRecoveryInvariantError extends Error {
  constructor() {
    super('The scoped browser recovery mutation is no longer coherent.')
    this.name = 'ScopedBrowserRecoveryInvariantError'
  }
}

function invariant(): never {
  throw new ScopedBrowserRecoveryInvariantError()
}

function sameInstant(left: Date, right: Date): boolean {
  return (
    left instanceof Date &&
    right instanceof Date &&
    Number.isFinite(left.getTime()) &&
    left.getTime() === right.getTime()
  )
}

function boundedPrivateText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maximumPrivateValueBytes
  )
}

function assertParsedBinding(
  scope: MemberResetRedemptionMutationScope | OwnerRecoveryWebRedemptionMutationScope,
  input: ScopedBrowserRecoveryRedemptionInput,
): void {
  const parsed = input.parsed
  const derivedCodeIdentity =
    scope.purpose === 'member-reset-redemption'
      ? memberResetCodeIdentity(parsed.submittedCode)
      : ownerRecoveryCodeIdentity(parsed.submittedCode)
  if (
    parsed.normalizedEmail !== scope.normalizedEmail ||
    derivedCodeIdentity !== scope.codeIdentity ||
    !sameInstant(input.commandEnteredAt, scope.commandEnteredAt) ||
    typeof parsed.passwordIsValid !== 'boolean' ||
    !boundedPrivateText(parsed.submittedCode) ||
    !boundedPrivateText(parsed.passwordHashInput) ||
    input.requestContext.channel !== 'web'
  ) {
    invariant()
  }
}

function assertPreparedBinding(
  scope: MemberResetRedemptionMutationScope | OwnerRecoveryWebRedemptionMutationScope,
  prepared: PreparedRecoveryRedemption,
): void {
  const derivedCodeIdentity =
    scope.purpose === 'member-reset-redemption'
      ? memberResetCodeIdentity(prepared.submittedCode)
      : ownerRecoveryCodeIdentity(prepared.submittedCode)
  if (
    prepared.normalizedEmail !== scope.normalizedEmail ||
    prepared.codeIdentity !== scope.codeIdentity ||
    derivedCodeIdentity !== scope.codeIdentity ||
    !sameInstant(prepared.commandEnteredAt, scope.commandEnteredAt) ||
    typeof prepared.passwordIsValid !== 'boolean' ||
    !boundedPrivateText(prepared.passwordHash) ||
    !boundedPrivateText(prepared.auditEventId)
  ) {
    invariant()
  }
}

function unchangedRejection(): ScopedBrowserRecoveryRejection {
  return Object.freeze({ kind: 'rejected', persistence: 'unchanged' })
}

function committedRejection(): ScopedBrowserRecoveryRejection {
  return Object.freeze({ kind: 'rejected', persistence: 'committed' })
}

function oneUse<Arguments extends readonly unknown[], Result>(
  operation: (...input: Arguments) => Promise<Result>,
): (...input: Arguments) => Promise<Result> {
  let claimed = false
  return (...input) => {
    if (claimed) return invariant()
    claimed = true
    return operation(...input)
  }
}

function effectiveMemberStateAt(scope: MemberResetRedemptionMutationScope): Date {
  const state = scope.state
  if (!state) return new Date(scope.commandEnteredAt.getTime())
  return new Date(
    Math.max(
      scope.commandEnteredAt.getTime(),
      state.lastIssuedAt.getTime(),
      state.lastAttemptAt?.getTime() ?? 0,
    ),
  )
}

async function appendMemberRejection<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  scope: MemberResetRedemptionMutationScope,
  prepared: PreparedRecoveryRedemption,
  requestContext: WebCredentialContext,
  retryAfter: Date | null,
): Promise<ScopedBrowserRecoveryRejection> {
  await database.insert(auditEvents).values({
    id: prepared.auditEventId,
    actorUserId: null,
    subjectUserId: scope.targetUserId,
    eventType: 'member-reset-rejected',
    entityType: 'member-reset',
    entityId: scope.verification?.id ?? null,
    metadata: {
      ...credentialAuditContext(requestContext),
      outcome: 'rejected',
      ...(retryAfter ? { retryAfter: retryAfter.toISOString() } : {}),
    },
    createdAt: prepared.commandEnteredAt,
  })
  return committedRejection()
}

async function updateExactCredential<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  input: {
    readonly credentialId: string
    readonly userId: string
    readonly passwordHash: string
    readonly updatedAt: Date
  },
): Promise<void> {
  const updated = await database
    .update(account)
    .set({ password: input.passwordHash, updatedAt: input.updatedAt })
    .where(
      and(
        eq(account.id, input.credentialId),
        eq(account.userId, input.userId),
        eq(account.providerId, 'credential'),
      ),
    )
    .returning({ id: account.id })
  if (updated.length !== 1 || updated[0]?.id !== input.credentialId) invariant()
}

async function consumeExactVerification<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  verificationId: string,
): Promise<void> {
  const consumed = await database
    .delete(verification)
    .where(eq(verification.id, verificationId))
    .returning({ id: verification.id })
  if (consumed.length !== 1 || consumed[0]?.id !== verificationId) invariant()
}

async function clearMemberResetState<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  targetUserId: string,
  activeVerificationId: string,
  updatedAt: Date,
): Promise<void> {
  const cleared = await database
    .update(memberResetStates)
    .set({
      activeVerificationId: null,
      failedAttempts: 0,
      retryAfter: null,
      lastAttemptAt: null,
      updatedAt,
    })
    .where(
      and(
        eq(memberResetStates.targetUserId, targetUserId),
        eq(memberResetStates.activeVerificationId, activeVerificationId),
      ),
    )
    .returning({ targetUserId: memberResetStates.targetUserId })
  if (cleared.length !== 1 || cleared[0]?.targetUserId !== targetUserId) invariant()
}

async function redeemMemberReset<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  scope: MemberResetRedemptionMutationScope,
  input: ScopedBrowserRecoveryRedemptionInput,
): Promise<ScopedMemberResetRedemptionOutcome> {
  assertParsedBinding(scope, input)
  if (
    scope.state?.retryAfter &&
    scope.state.retryAfter.getTime() > scope.commandEnteredAt.getTime()
  ) {
    return unchangedRejection()
  }

  const admission = await createScopedWebRecoveryRateLimitGateway(database).admit({
    purpose: 'member-reset',
    email: scope.normalizedEmail,
    clientAddress: input.requestContext.clientAddress,
    now: scope.commandEnteredAt,
  })
  if (!admission.admitted) return unchangedRejection()

  const prepared = await prepareMemberResetRedemption(
    input.parsed,
    scope.commandEnteredAt,
  )
  assertPreparedBinding(scope, prepared)

  const pending = scope.verification
  const state = scope.state
  const codeMatches = memberResetStoredValueMatches(
    prepared.submittedCode,
    pending?.storedValue ?? null,
  )
  const codeIsLive =
    pending !== null && pending.expiresAt.getTime() > scope.commandEnteredAt.getTime()
  const mayRedeem =
    scope.targetState === 'member' &&
    scope.targetUserId !== null &&
    scope.credentialId !== null &&
    state !== null &&
    pending !== null &&
    state.activeVerificationId === pending.id &&
    codeIsLive &&
    codeMatches &&
    prepared.passwordIsValid

  if (mayRedeem) {
    await updateExactCredential(database, {
      credentialId: scope.credentialId as string,
      userId: scope.targetUserId as string,
      passwordHash: prepared.passwordHash,
      updatedAt: scope.commandEnteredAt,
    })
    await clearMemberResetState(
      database,
      scope.targetUserId as string,
      (pending as NonNullable<typeof pending>).id,
      effectiveMemberStateAt(scope),
    )
    await consumeExactVerification(database, (pending as NonNullable<typeof pending>).id)
    const revokedSessions = await database
      .delete(session)
      .where(eq(session.userId, scope.targetUserId as string))
      .returning({ id: session.id })
    await database.insert(auditEvents).values({
      id: prepared.auditEventId,
      actorUserId: null,
      subjectUserId: scope.targetUserId,
      eventType: 'member-reset-redeemed',
      entityType: 'member-reset',
      entityId: pending.id,
      metadata: {
        ...credentialAuditContext(input.requestContext),
        outcome: 'redeemed',
        sessionsRevoked: revokedSessions.length,
      },
      createdAt: prepared.commandEnteredAt,
    })
    return Object.freeze({
      kind: 'redeemed',
      targetUserId: scope.targetUserId,
      revokedSessionCount: revokedSessions.length,
    })
  }

  const stateAt = effectiveMemberStateAt(scope)
  let retryAfter: Date | null = null
  if (state && pending && codeIsLive && !codeMatches) {
    const failedAttempts = Math.min(state.failedAttempts + 1, maximumPostgresInteger)
    retryAfter = new Date(
      stateAt.getTime() + memberResetBackoffMilliseconds(failedAttempts),
    )
    const updated = await database
      .update(memberResetStates)
      .set({
        failedAttempts,
        retryAfter,
        lastAttemptAt: stateAt,
        updatedAt: stateAt,
      })
      .where(
        and(
          eq(memberResetStates.targetUserId, scope.targetUserId as string),
          eq(memberResetStates.activeVerificationId, pending.id),
        ),
      )
      .returning({ targetUserId: memberResetStates.targetUserId })
    if (updated.length !== 1 || updated[0]?.targetUserId !== scope.targetUserId) {
      invariant()
    }
  } else if (state && pending && !codeIsLive) {
    await clearMemberResetState(
      database,
      scope.targetUserId as string,
      pending.id,
      stateAt,
    )
    await consumeExactVerification(database, pending.id)
  }

  return appendMemberRejection(
    database,
    scope,
    prepared,
    input.requestContext,
    retryAfter,
  )
}

async function appendOwnerRejection<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  scope: OwnerRecoveryWebRedemptionMutationScope,
  prepared: PreparedRecoveryRedemption,
  requestContext: WebCredentialContext,
): Promise<ScopedBrowserRecoveryRejection> {
  await database.insert(auditEvents).values({
    id: prepared.auditEventId,
    actorUserId: null,
    subjectUserId: scope.ownerEmailMatches ? scope.ownerUserId : null,
    eventType: 'owner-recovery-rejected',
    entityType: 'owner-recovery',
    entityId: scope.ownerEmailMatches ? (scope.verification?.id ?? null) : null,
    metadata: {
      ...credentialAuditContext(requestContext),
      outcome: 'rejected',
    },
    createdAt: prepared.commandEnteredAt,
  })
  return committedRejection()
}

async function redeemOwnerRecoveryWeb<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  scope: OwnerRecoveryWebRedemptionMutationScope,
  input: ScopedBrowserRecoveryRedemptionInput,
): Promise<ScopedOwnerRecoveryWebRedemptionOutcome> {
  assertParsedBinding(scope, input)
  const admission = await createScopedWebRecoveryRateLimitGateway(database).admit({
    purpose: 'owner-recovery',
    email: scope.normalizedEmail,
    clientAddress: input.requestContext.clientAddress,
    now: scope.commandEnteredAt,
  })
  if (!admission.admitted) return unchangedRejection()

  const prepared = await prepareOwnerRecoveryRedemption(
    input.parsed,
    scope.commandEnteredAt,
  )
  assertPreparedBinding(scope, prepared)

  const pending = scope.verification
  const codeMatches = ownerRecoveryStoredValueMatches(
    prepared.submittedCode,
    pending?.storedValue ?? null,
  )
  const codeIsLive =
    pending !== null && pending.expiresAt.getTime() > scope.commandEnteredAt.getTime()
  const mayRedeem =
    scope.ownerEmailMatches &&
    scope.ownerUserId !== null &&
    scope.credentialId !== null &&
    pending !== null &&
    codeIsLive &&
    codeMatches &&
    prepared.passwordIsValid

  if (mayRedeem) {
    await updateExactCredential(database, {
      credentialId: scope.credentialId as string,
      userId: scope.ownerUserId as string,
      passwordHash: prepared.passwordHash,
      updatedAt: scope.commandEnteredAt,
    })
    await consumeExactVerification(database, (pending as NonNullable<typeof pending>).id)
    const revokedSessions = await database
      .delete(session)
      .where(eq(session.userId, scope.ownerUserId as string))
      .returning({ id: session.id })
    await database.insert(auditEvents).values({
      id: prepared.auditEventId,
      actorUserId: null,
      subjectUserId: scope.ownerUserId,
      eventType: 'owner-recovery-redeemed',
      entityType: 'owner-recovery',
      entityId: pending.id,
      metadata: {
        ...credentialAuditContext(input.requestContext),
        outcome: 'redeemed',
        sessionsRevoked: revokedSessions.length,
      },
      createdAt: prepared.commandEnteredAt,
    })
    return Object.freeze({
      kind: 'redeemed',
      ownerUserId: scope.ownerUserId,
      revokedSessionCount: revokedSessions.length,
    })
  }

  if (scope.ownerEmailMatches && pending && !codeIsLive) {
    await consumeExactVerification(database, pending.id)
  }
  return appendOwnerRejection(database, scope, prepared, input.requestContext)
}

/**
 * Purpose-narrow, one-use member reset gateway. The capture must have completed
 * its first-query transactional recheck before this factory is called.
 */
export function createScopedMemberResetRedemptionMutationGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  capture: MemberResetRedemptionCapture,
): ScopedMemberResetRedemptionMutationGateway {
  const scope = claimMemberResetRedemptionMutationScope(capture)
  const invoke = oneUse((input: ScopedBrowserRecoveryRedemptionInput) =>
    redeemMemberReset(database, scope, input),
  )
  return Object.freeze({
    redeem(input: ScopedBrowserRecoveryRedemptionInput) {
      return invoke(input)
    },
  })
}

/**
 * Purpose-narrow, one-use browser owner-recovery gateway. Host recovery has a
 * separate unthrottled gateway and cannot call this web-only surface.
 */
export function createScopedOwnerRecoveryWebRedemptionMutationGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  capture: OwnerRecoveryWebRedemptionCapture,
): ScopedOwnerRecoveryWebRedemptionMutationGateway {
  const scope = claimOwnerRecoveryWebRedemptionMutationScope(capture)
  const invoke = oneUse((input: ScopedBrowserRecoveryRedemptionInput) =>
    redeemOwnerRecoveryWeb(database, scope, input),
  )
  return Object.freeze({
    redeem(input: ScopedBrowserRecoveryRedemptionInput) {
      return invoke(input)
    },
  })
}
