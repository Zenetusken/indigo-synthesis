import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { account, auditEvents, session, verification } from '@/platform/db/schema'
import {
  ownerRecoveryCodeIdentity,
  ownerRecoveryIdentifier,
  ownerRecoveryStoredValue,
  ownerRecoveryStoredValueMatches,
  type ParsedRecoveryRedemptionInput,
  type PreparedOwnerRecoveryIssuance,
  type PreparedRecoveryRedemption,
  prepareOwnerRecoveryRedemption,
  recoveryPreparationPolicy,
} from '../recovery/recovery-preparation'
import {
  claimOwnerRecoveryCliRedemptionMutationScope,
  claimOwnerRecoveryIssuanceMutationScope,
  type OwnerRecoveryCliRedemptionCapture,
  type OwnerRecoveryCliRedemptionMutationScope,
  type OwnerRecoveryIssuanceCapture,
  type OwnerRecoveryIssuanceMutationScope,
} from './recovery-mutation'

const maximumPrivateValueBytes = 16 * 1024

export type ScopedOwnerRecoveryIssuanceOutcome =
  | Readonly<{ kind: 'issued' }>
  | Readonly<{ kind: 'rejected'; reason: 'owner-mismatch' }>

export type ScopedOwnerRecoveryCliRedemptionOutcome =
  | Readonly<{
      kind: 'redeemed'
      ownerUserId: string
      revokedSessionCount: number
    }>
  | Readonly<{
      kind: 'rejected'
      reason: 'owner-mismatch' | 'code-invalid' | 'credential-missing'
    }>

export type ScopedOwnerRecoveryCliRedemptionInput = Readonly<{
  parsed: ParsedRecoveryRedemptionInput
  commandEnteredAt: Date
}>

export interface ScopedOwnerRecoveryIssuanceMutationGateway {
  issue(
    prepared: PreparedOwnerRecoveryIssuance,
  ): Promise<ScopedOwnerRecoveryIssuanceOutcome>
}

export interface ScopedOwnerRecoveryCliRedemptionMutationGateway {
  redeem(
    input: ScopedOwnerRecoveryCliRedemptionInput,
  ): Promise<ScopedOwnerRecoveryCliRedemptionOutcome>
}

export class ScopedHostRecoveryInvariantError extends Error {
  constructor() {
    super('The scoped host recovery mutation is no longer coherent.')
    this.name = 'ScopedHostRecoveryInvariantError'
  }
}

function invariant(): never {
  throw new ScopedHostRecoveryInvariantError()
}

function sameInstant(left: unknown, right: Date): boolean {
  return (
    left instanceof Date &&
    Number.isFinite(left.getTime()) &&
    left.getTime() === right.getTime()
  )
}

function boundedPrivateText(value: unknown, maximumBytes = maximumPrivateValueBytes) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  )
}

function boundedCharacterText(value: unknown, maximumCharacters: number) {
  return (
    boundedPrivateText(value) &&
    typeof value === 'string' &&
    value.length <= maximumCharacters
  )
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

function assertIssuanceBinding(
  scope: OwnerRecoveryIssuanceMutationScope,
  prepared: PreparedOwnerRecoveryIssuance,
): void {
  const ttlMilliseconds =
    prepared.expiresAt.getTime() - prepared.commandEnteredAt.getTime()
  const ttlMinutes = ttlMilliseconds / 60_000
  if (
    scope.ownerUserId === null ||
    prepared.ownerUserId !== scope.ownerUserId ||
    prepared.normalizedOwnerEmail !== scope.normalizedEmail ||
    prepared.identifier !== ownerRecoveryIdentifier(scope.ownerUserId) ||
    !sameInstant(prepared.commandEnteredAt, scope.commandEnteredAt) ||
    !(prepared.expiresAt instanceof Date) ||
    !Number.isFinite(prepared.expiresAt.getTime()) ||
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < recoveryPreparationPolicy.ownerRecovery.minimumTtlMinutes ||
    ttlMinutes > recoveryPreparationPolicy.ownerRecovery.maximumTtlMinutes ||
    !boundedPrivateText(prepared.recoveryId) ||
    !boundedPrivateText(prepared.auditEventId) ||
    !boundedCharacterText(
      prepared.code,
      recoveryPreparationPolicy.maximumCodeCharacters,
    ) ||
    prepared.storedValue !== ownerRecoveryStoredValue(prepared.code) ||
    prepared.audit.eventType !== 'owner-recovery-issued' ||
    prepared.audit.entityType !== 'owner-recovery' ||
    prepared.audit.entityId !== prepared.recoveryId ||
    prepared.audit.channel !== 'host-local-cli' ||
    prepared.audit.outcome !== 'issued' ||
    prepared.audit.expiresAt !== prepared.expiresAt.toISOString()
  ) {
    invariant()
  }
}

function assertCliInputBinding(
  scope: OwnerRecoveryCliRedemptionMutationScope,
  input: ScopedOwnerRecoveryCliRedemptionInput,
): void {
  if (
    input.parsed.normalizedEmail !== scope.normalizedEmail ||
    ownerRecoveryCodeIdentity(input.parsed.submittedCode) !== scope.codeIdentity ||
    !sameInstant(input.commandEnteredAt, scope.commandEnteredAt) ||
    input.parsed.passwordIsValid !== true ||
    !boundedCharacterText(
      input.parsed.submittedCode,
      recoveryPreparationPolicy.maximumCodeCharacters,
    ) ||
    !boundedCharacterText(
      input.parsed.passwordHashInput,
      recoveryPreparationPolicy.password.maximumCharacters,
    )
  ) {
    invariant()
  }
}

function assertCliPreparedBinding(
  scope: OwnerRecoveryCliRedemptionMutationScope,
  input: ScopedOwnerRecoveryCliRedemptionInput,
  prepared: PreparedRecoveryRedemption,
): void {
  if (
    prepared.normalizedEmail !== scope.normalizedEmail ||
    prepared.normalizedEmail !== input.parsed.normalizedEmail ||
    prepared.submittedCode !== input.parsed.submittedCode ||
    prepared.codeIdentity !== scope.codeIdentity ||
    prepared.codeIdentity !== ownerRecoveryCodeIdentity(prepared.submittedCode) ||
    !sameInstant(prepared.commandEnteredAt, scope.commandEnteredAt) ||
    prepared.passwordIsValid !== true ||
    !boundedPrivateText(prepared.passwordHash) ||
    !boundedPrivateText(prepared.auditEventId)
  ) {
    invariant()
  }
}

async function insertExactVerification<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  prepared: PreparedOwnerRecoveryIssuance,
): Promise<void> {
  const inserted = await database
    .insert(verification)
    .values({
      id: prepared.recoveryId,
      identifier: prepared.identifier,
      value: prepared.storedValue,
      expiresAt: prepared.expiresAt,
      createdAt: prepared.commandEnteredAt,
      updatedAt: prepared.commandEnteredAt,
    })
    .returning({ id: verification.id })
  if (inserted.length !== 1 || inserted[0]?.id !== prepared.recoveryId) invariant()
}

async function consumeExactVerification<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  pending: Readonly<{ id: string; identifier: string }>,
): Promise<void> {
  const consumed = await database
    .delete(verification)
    .where(
      and(
        eq(verification.id, pending.id),
        eq(verification.identifier, pending.identifier),
      ),
    )
    .returning({ id: verification.id })
  if (consumed.length !== 1 || consumed[0]?.id !== pending.id) invariant()
}

async function appendHostRejection<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  input: {
    readonly auditEventId: string
    readonly subjectUserId: string | null
    readonly entityId: string | null
    readonly createdAt: Date
  },
): Promise<void> {
  await database.insert(auditEvents).values({
    id: input.auditEventId,
    actorUserId: null,
    subjectUserId: input.subjectUserId,
    eventType: 'owner-recovery-rejected',
    entityType: 'owner-recovery',
    entityId: input.entityId,
    metadata: { channel: 'host-local-cli', outcome: 'rejected' },
    createdAt: input.createdAt,
  })
}

async function issueOwnerRecovery<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  scope: OwnerRecoveryIssuanceMutationScope,
  prepared: PreparedOwnerRecoveryIssuance,
): Promise<ScopedOwnerRecoveryIssuanceOutcome> {
  assertIssuanceBinding(scope, prepared)
  if (!scope.ownerEmailMatches) {
    await appendHostRejection(database, {
      auditEventId: prepared.auditEventId,
      subjectUserId: scope.ownerUserId,
      entityId: null,
      createdAt: scope.commandEnteredAt,
    })
    return Object.freeze({ kind: 'rejected', reason: 'owner-mismatch' })
  }

  if (scope.verification) {
    await consumeExactVerification(database, scope.verification)
  }
  await insertExactVerification(database, prepared)
  await database.insert(auditEvents).values({
    id: prepared.auditEventId,
    actorUserId: null,
    subjectUserId: scope.ownerUserId,
    eventType: prepared.audit.eventType,
    entityType: prepared.audit.entityType,
    entityId: prepared.audit.entityId,
    metadata: {
      channel: prepared.audit.channel,
      outcome: prepared.audit.outcome,
      expiresAt: prepared.audit.expiresAt,
    },
    createdAt: prepared.commandEnteredAt,
  })
  return Object.freeze({ kind: 'issued' })
}

async function updateExactCredential<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  input: {
    readonly credentialId: string
    readonly ownerUserId: string
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
        eq(account.userId, input.ownerUserId),
        eq(account.providerId, 'credential'),
      ),
    )
    .returning({ id: account.id })
  if (updated.length !== 1 || updated[0]?.id !== input.credentialId) invariant()
}

async function redeemOwnerRecoveryCli<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  scope: OwnerRecoveryCliRedemptionMutationScope,
  input: ScopedOwnerRecoveryCliRedemptionInput,
): Promise<ScopedOwnerRecoveryCliRedemptionOutcome> {
  assertCliInputBinding(scope, input)
  const prepared = await prepareOwnerRecoveryRedemption(
    input.parsed,
    scope.commandEnteredAt,
  )
  assertCliPreparedBinding(scope, input, prepared)

  const pending = scope.verification
  const codeMatches = ownerRecoveryStoredValueMatches(
    prepared.submittedCode,
    pending?.storedValue ?? null,
  )

  if (!scope.ownerEmailMatches || scope.ownerUserId === null) {
    await appendHostRejection(database, {
      auditEventId: prepared.auditEventId,
      subjectUserId: scope.ownerUserId,
      entityId: null,
      createdAt: prepared.commandEnteredAt,
    })
    return Object.freeze({ kind: 'rejected', reason: 'owner-mismatch' })
  }

  const codeIsLive =
    pending !== null && pending.expiresAt.getTime() > scope.commandEnteredAt.getTime()
  if (pending === null || !codeIsLive || !codeMatches) {
    if (pending !== null && !codeIsLive) {
      await consumeExactVerification(database, pending)
    }
    await appendHostRejection(database, {
      auditEventId: prepared.auditEventId,
      subjectUserId: scope.ownerUserId,
      entityId: pending?.id ?? null,
      createdAt: prepared.commandEnteredAt,
    })
    return Object.freeze({ kind: 'rejected', reason: 'code-invalid' })
  }

  if (scope.credentialId === null || scope.credentialUpdatedAt === null) {
    await appendHostRejection(database, {
      auditEventId: prepared.auditEventId,
      subjectUserId: scope.ownerUserId,
      entityId: pending.id,
      createdAt: prepared.commandEnteredAt,
    })
    return Object.freeze({ kind: 'rejected', reason: 'credential-missing' })
  }

  await updateExactCredential(database, {
    credentialId: scope.credentialId,
    ownerUserId: scope.ownerUserId,
    passwordHash: prepared.passwordHash,
    updatedAt: new Date(
      Math.max(scope.commandEnteredAt.getTime(), scope.credentialUpdatedAt.getTime()),
    ),
  })
  await consumeExactVerification(database, pending)
  const revokedSessions = await database
    .delete(session)
    .where(eq(session.userId, scope.ownerUserId))
    .returning({ id: session.id })
  await database.insert(auditEvents).values({
    id: prepared.auditEventId,
    actorUserId: null,
    subjectUserId: scope.ownerUserId,
    eventType: 'owner-recovery-redeemed',
    entityType: 'owner-recovery',
    entityId: pending.id,
    metadata: {
      channel: 'host-local-cli',
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

/** One-use, unthrottled gateway for owner recovery code issuance on the host. */
export function createScopedOwnerRecoveryIssuanceMutationGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  capture: OwnerRecoveryIssuanceCapture,
): ScopedOwnerRecoveryIssuanceMutationGateway {
  const scope = claimOwnerRecoveryIssuanceMutationScope(capture)
  const invoke = oneUse((prepared: PreparedOwnerRecoveryIssuance) =>
    issueOwnerRecovery(database, scope, prepared),
  )
  return Object.freeze({
    issue(prepared: PreparedOwnerRecoveryIssuance) {
      return invoke(prepared)
    },
  })
}

/** One-use, unthrottled gateway for owner recovery redemption on the host CLI. */
export function createScopedOwnerRecoveryCliRedemptionMutationGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  capture: OwnerRecoveryCliRedemptionCapture,
): ScopedOwnerRecoveryCliRedemptionMutationGateway {
  const scope = claimOwnerRecoveryCliRedemptionMutationScope(capture)
  const invoke = oneUse((input: ScopedOwnerRecoveryCliRedemptionInput) =>
    redeemOwnerRecoveryCli(database, scope, input),
  )
  return Object.freeze({
    redeem(input: ScopedOwnerRecoveryCliRedemptionInput) {
      return invoke(input)
    },
  })
}
