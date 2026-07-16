import { randomBytes } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import { getDb } from '@/platform/db/client'
import {
  account,
  auditEvents,
  installationState,
  memberResetStates,
  session,
  user,
  verification,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  credentialEmailLockDigest,
  withCredentialLifecycleLocks,
  withSubmittedEmailCredentialLifecycleLocks,
} from '../infrastructure/credential-lifecycle-lock'
import { verifyDestructiveReauthentication } from '../infrastructure/destructive-reauthentication'
import {
  admitWebRecoveryAttempt,
  isWebRecoveryAttemptThrottled,
} from '../infrastructure/web-recovery-rate-limit'
import { credentialAuditContext, type WebCredentialContext } from './credential-context'
import {
  memberResetBackoffMilliseconds,
  normalizeRecoveryEmail,
  publicRecoveryFailure,
} from './recovery-policy'
import {
  memberResetIdentifier,
  memberResetStoredValue,
  memberResetStoredValueMatches,
} from './recovery-preparation'

const memberResetCodePrefix = 'indigo_m1_'
const minimumTtlMinutes = 5
const maximumTtlMinutes = 60
const issuanceCooldownMilliseconds = 30_000
const invalidPasswordHashInput = 'indigo-invalid-member-reset-password'
const unresolvedVerificationLookupId = 'indigo:unresolved-member-reset-verification'

type DatabaseTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0]

export class MemberResetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MemberResetError'
  }
}

export type IssuedMemberReset = {
  readonly resetId: string
  readonly code: string
  readonly expiresAt: Date
}

export type RedeemedMemberReset = {
  readonly kind: 'redeemed'
  readonly targetUserId: string
  readonly revokedSessionCount: number
}

export type RedeemMemberResetResult = RedeemedMemberReset | typeof publicRecoveryFailure

function validateTtlMinutes(ttlMinutes: number): void {
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < minimumTtlMinutes ||
    ttlMinutes > maximumTtlMinutes
  ) {
    throw new MemberResetError(
      'member-reset.ttl-invalid',
      `Reset lifetime must be a whole number from ${minimumTtlMinutes} to ${maximumTtlMinutes} minutes.`,
    )
  }
}

function passwordIsValid(password: string): boolean {
  return password.length >= 12 && password.length <= 128 && !password.includes('\0')
}

function unresolvedMemberLookupId(normalizedEmail: string): string {
  return `indigo:unresolved-member:${credentialEmailLockDigest(normalizedEmail)}`
}

async function appendMemberResetAudit(
  transaction: DatabaseTransaction,
  input: {
    readonly eventType:
      | 'member-reset-issued'
      | 'member-reset-redeemed'
      | 'member-reset-rejected'
    readonly actorUserId: string | null
    readonly subjectUserId: string | null
    readonly entityId: string | null
    readonly requestContext: WebCredentialContext
    readonly metadata?: Readonly<Record<string, unknown>>
    readonly now: Date
  },
): Promise<void> {
  await transaction.insert(auditEvents).values({
    id: newUuidV7(),
    actorUserId: input.actorUserId,
    subjectUserId: input.subjectUserId,
    eventType: input.eventType,
    entityType: 'member-reset',
    entityId: input.entityId,
    metadata: {
      ...credentialAuditContext(input.requestContext),
      ...input.metadata,
    },
    createdAt: input.now,
  })
}

async function rejectIssue(input: {
  readonly actorUserId: string | null
  readonly subjectUserId: string | null
  readonly entityId?: string | null
  readonly outcome: string
  readonly requestContext: WebCredentialContext
  readonly now: Date
}): Promise<void> {
  await getDb().transaction((transaction) =>
    appendMemberResetAudit(transaction, {
      eventType: 'member-reset-rejected',
      actorUserId: input.actorUserId,
      subjectUserId: input.subjectUserId,
      entityId: input.entityId ?? null,
      requestContext: input.requestContext,
      metadata: { outcome: input.outcome },
      now: input.now,
    }),
  )
}

export async function issueMemberReset(input: {
  readonly actor: AuthenticatedActor
  readonly targetUserId: string
  readonly currentPassword: string
  readonly ttlMinutes?: number
  readonly requestContext: WebCredentialContext
  readonly now?: Date
}): Promise<IssuedMemberReset> {
  const ttlMinutes = input.ttlMinutes ?? 15
  validateTtlMinutes(ttlMinutes)
  const now = input.now ?? new Date()

  return withCredentialLifecycleLocks(
    [input.actor.userId, input.targetUserId],
    async () => {
      const [authority] = await getDb()
        .select({
          ownerUserId: installationState.ownerUserId,
          actorExists: sql<boolean>`EXISTS(
            SELECT 1 FROM ${user} actor_user
            WHERE actor_user.id = ${input.actor.userId}
          )`,
          targetExists: sql<boolean>`EXISTS(
            SELECT 1 FROM ${user} target_user
            WHERE target_user.id = ${input.targetUserId}
          )`,
        })
        .from(installationState)
        .where(eq(installationState.singleton, 1))
        .limit(1)

      const actorUserId = authority?.actorExists ? input.actor.userId : null
      const subjectUserId = authority?.targetExists ? input.targetUserId : null
      if (input.actor.role !== 'owner' || authority?.ownerUserId !== input.actor.userId) {
        await rejectIssue({
          actorUserId,
          subjectUserId,
          outcome: 'not-authorized',
          requestContext: input.requestContext,
          now,
        })
        throw new MemberResetError(
          'member-reset.not-authorized',
          'Only the installed owner may issue a reset code.',
        )
      }
      if (!subjectUserId || subjectUserId === authority.ownerUserId) {
        await rejectIssue({
          actorUserId,
          subjectUserId,
          outcome: 'target-invalid',
          requestContext: input.requestContext,
          now,
        })
        throw new MemberResetError(
          'member-reset.target-invalid',
          'Choose a trainee account to reset.',
        )
      }

      const reauthentication = await verifyDestructiveReauthentication({
        userId: input.actor.userId,
        purpose: 'member-reset-issue',
        password: input.currentPassword,
        audit: {
          actorUserId: input.actor.userId,
          subjectUserId,
          eventType: 'member-reset-rejected',
          entityType: 'member-reset',
          entityId: null,
          metadata: {
            ...credentialAuditContext(input.requestContext),
            outcome: 'reauthentication-denied',
          },
        },
        now,
      })
      if (reauthentication.status !== 'succeeded') {
        throw new MemberResetError(
          `member-reset.reauthentication-${reauthentication.status}`,
          reauthentication.status === 'locked'
            ? 'Too many owner-password attempts. Try again later.'
            : 'The owner password was not accepted.',
        )
      }

      const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000)
      const code = `${memberResetCodePrefix}${randomBytes(32).toString('base64url')}`

      const outcome = await getDb().transaction(
        async (transaction) => {
          const [installation] = await transaction
            .select({ ownerUserId: installationState.ownerUserId })
            .from(installationState)
            .where(eq(installationState.singleton, 1))
            .for('update')
            .limit(1)
          const [targetCredential] = await transaction
            .select({ id: account.id })
            .from(account)
            .where(
              and(
                eq(account.userId, input.targetUserId),
                eq(account.providerId, 'credential'),
              ),
            )
            .for('update')
            .limit(1)
          const [state] = await transaction
            .select()
            .from(memberResetStates)
            .where(eq(memberResetStates.targetUserId, input.targetUserId))
            .for('update')
            .limit(1)

          if (
            installation?.ownerUserId !== input.actor.userId ||
            !targetCredential ||
            input.targetUserId === installation.ownerUserId
          ) {
            await appendMemberResetAudit(transaction, {
              eventType: 'member-reset-rejected',
              actorUserId: input.actor.userId,
              subjectUserId: targetCredential ? input.targetUserId : null,
              entityId: state?.activeVerificationId ?? null,
              requestContext: input.requestContext,
              metadata: { outcome: 'target-invalid' },
              now,
            })
            return { kind: 'rejected' as const }
          }

          if (
            state &&
            state.lastIssuedAt.getTime() + issuanceCooldownMilliseconds > now.getTime()
          ) {
            await appendMemberResetAudit(transaction, {
              eventType: 'member-reset-rejected',
              actorUserId: input.actor.userId,
              subjectUserId: input.targetUserId,
              entityId: state.activeVerificationId,
              requestContext: input.requestContext,
              metadata: {
                outcome: 'cooldown',
                retryAfter: new Date(
                  state.lastIssuedAt.getTime() + issuanceCooldownMilliseconds,
                ).toISOString(),
              },
              now,
            })
            return { kind: 'cooldown' as const }
          }

          const identifier = memberResetIdentifier(input.targetUserId)
          const resetId = newUuidV7()
          await transaction
            .delete(verification)
            .where(eq(verification.identifier, identifier))
          await transaction.insert(verification).values({
            id: resetId,
            identifier,
            value: memberResetStoredValue(code),
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          await transaction
            .insert(memberResetStates)
            .values({
              targetUserId: input.targetUserId,
              activeVerificationId: resetId,
              lastIssuedAt: now,
              failedAttempts: 0,
              retryAfter: null,
              lastAttemptAt: null,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: memberResetStates.targetUserId,
              set: {
                activeVerificationId: resetId,
                lastIssuedAt: now,
                failedAttempts: 0,
                retryAfter: null,
                lastAttemptAt: null,
                updatedAt: now,
              },
            })
          await appendMemberResetAudit(transaction, {
            eventType: 'member-reset-issued',
            actorUserId: input.actor.userId,
            subjectUserId: input.targetUserId,
            entityId: resetId,
            requestContext: input.requestContext,
            metadata: { outcome: 'issued', expiresAt: expiresAt.toISOString() },
            now,
          })
          return { kind: 'issued' as const, resetId }
        },
        { isolationLevel: 'serializable' },
      )

      if (outcome.kind === 'cooldown') {
        throw new MemberResetError(
          'member-reset.cooldown',
          'Wait 30 seconds before issuing another reset code for this account.',
        )
      }
      if (outcome.kind === 'rejected') {
        throw new MemberResetError(
          'member-reset.target-invalid',
          'Choose a trainee account to reset.',
        )
      }
      return { resetId: outcome.resetId, code, expiresAt }
    },
  )
}

export async function redeemMemberReset(input: {
  readonly email: string
  readonly code: string
  readonly newPassword: string
  readonly requestContext: WebCredentialContext
  readonly now?: Date
}): Promise<RedeemMemberResetResult> {
  const now = input.now ?? new Date()
  const normalizedEmail = normalizeRecoveryEmail(input.email)
  let resolvedUserId: string | null = null
  const rateInput = {
    purpose: 'member-reset' as const,
    email: normalizedEmail,
    clientAddress: input.requestContext.clientAddress,
    now,
  }

  if (await isWebRecoveryAttemptThrottled(rateInput)) return publicRecoveryFailure

  return withSubmittedEmailCredentialLifecycleLocks({
    email: normalizedEmail,
    resolveAccountUserIds: async () => {
      const [candidate] = await getDb()
        .select({ id: user.id })
        .from(user)
        .where(eq(sql`lower(${user.email})`, normalizedEmail))
        .limit(1)
      resolvedUserId = candidate?.id ?? null
      return resolvedUserId ? [resolvedUserId] : []
    },
    callback: async () => {
      const unresolvedUserId = unresolvedMemberLookupId(normalizedEmail)
      const preflightUserId = resolvedUserId ?? unresolvedUserId
      const [preflightState] = await getDb()
        .select({ retryAfter: memberResetStates.retryAfter })
        .from(memberResetStates)
        .where(eq(memberResetStates.targetUserId, preflightUserId))
        .limit(1)
      if (preflightState?.retryAfter && preflightState.retryAfter > now) {
        return publicRecoveryFailure
      }

      const admission = await admitWebRecoveryAttempt(rateInput)
      if (!admission.admitted) return publicRecoveryFailure

      const validPassword = passwordIsValid(input.newPassword)
      const passwordHash = await hashPassword(
        validPassword ? input.newPassword : invalidPasswordHashInput,
      )

      return getDb().transaction(
        async (transaction): Promise<RedeemMemberResetResult> => {
          const [installation] = await transaction
            .select({ ownerUserId: installationState.ownerUserId })
            .from(installationState)
            .where(eq(installationState.singleton, 1))
            .limit(1)
          const [target] = await transaction
            .select({ id: user.id })
            .from(user)
            .where(eq(sql`lower(${user.email})`, normalizedEmail))
            .limit(1)
          const targetLookupId = target?.id ?? unresolvedUserId
          const [credential] = await transaction
            .select({ id: account.id })
            .from(account)
            .where(
              and(
                eq(account.userId, targetLookupId),
                eq(account.providerId, 'credential'),
              ),
            )
            .for('update')
            .limit(1)
          const [state] = await transaction
            .select()
            .from(memberResetStates)
            .where(eq(memberResetStates.targetUserId, targetLookupId))
            .for('update')
            .limit(1)
          const pendingLookupId =
            state?.activeVerificationId ?? unresolvedVerificationLookupId
          const [pending] = await transaction
            .select()
            .from(verification)
            .where(eq(verification.id, pendingLookupId))
            .for('update')
            .limit(1)

          if (state?.retryAfter && state.retryAfter > now) {
            await appendMemberResetAudit(transaction, {
              eventType: 'member-reset-rejected',
              actorUserId: null,
              subjectUserId: target?.id ?? null,
              entityId: pending?.id ?? null,
              requestContext: input.requestContext,
              metadata: { outcome: 'rejected' },
              now,
            })
            return publicRecoveryFailure
          }

          const codeMatches = memberResetStoredValueMatches(
            input.code,
            pending?.value ?? null,
          )
          const codeIsLive = pending !== undefined && pending.expiresAt > now
          const mayRedeem =
            target !== undefined &&
            target.id !== installation?.ownerUserId &&
            credential !== undefined &&
            state !== undefined &&
            pending !== undefined &&
            codeIsLive &&
            codeMatches &&
            validPassword

          if (mayRedeem) {
            await transaction
              .update(account)
              .set({ password: passwordHash, updatedAt: now })
              .where(eq(account.id, credential.id))
            await transaction.delete(verification).where(eq(verification.id, pending.id))
            const revokedSessions = await transaction
              .delete(session)
              .where(eq(session.userId, target.id))
              .returning({ id: session.id })
            await transaction
              .update(memberResetStates)
              .set({
                activeVerificationId: null,
                failedAttempts: 0,
                retryAfter: null,
                lastAttemptAt: null,
                updatedAt: now,
              })
              .where(eq(memberResetStates.targetUserId, target.id))
            await appendMemberResetAudit(transaction, {
              eventType: 'member-reset-redeemed',
              actorUserId: null,
              subjectUserId: target.id,
              entityId: pending.id,
              requestContext: input.requestContext,
              metadata: {
                outcome: 'redeemed',
                sessionsRevoked: revokedSessions.length,
              },
              now,
            })
            return {
              kind: 'redeemed',
              targetUserId: target.id,
              revokedSessionCount: revokedSessions.length,
            }
          }

          let retryAfter: Date | null = null
          const wrongLiveCode = state && pending && codeIsLive && !codeMatches
          if (state && wrongLiveCode) {
            const failedAttempts = state.failedAttempts + 1
            retryAfter = new Date(
              now.getTime() + memberResetBackoffMilliseconds(failedAttempts),
            )
            await transaction
              .update(memberResetStates)
              .set({
                failedAttempts,
                retryAfter,
                lastAttemptAt: now,
                updatedAt: now,
              })
              .where(eq(memberResetStates.targetUserId, state.targetUserId))
          } else if (state && pending && !codeIsLive) {
            await transaction.delete(verification).where(eq(verification.id, pending.id))
            await transaction
              .update(memberResetStates)
              .set({
                activeVerificationId: null,
                failedAttempts: 0,
                retryAfter: null,
                lastAttemptAt: null,
                updatedAt: now,
              })
              .where(eq(memberResetStates.targetUserId, state.targetUserId))
          }

          await appendMemberResetAudit(transaction, {
            eventType: 'member-reset-rejected',
            actorUserId: null,
            subjectUserId: target?.id ?? null,
            entityId: pending?.id ?? null,
            requestContext: input.requestContext,
            metadata: {
              outcome: 'rejected',
              ...(retryAfter ? { retryAfter: retryAfter.toISOString() } : {}),
            },
            now,
          })
          return publicRecoveryFailure
        },
        { isolationLevel: 'serializable' },
      )
    },
  })
}
