import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { and, eq } from 'drizzle-orm'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from '@/platform/db/client'
import {
  account,
  auditEvents,
  installationState,
  session,
  user,
  verification,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  CredentialLifecycleUnavailableError,
  withCredentialLifecycleLock,
  withSubmittedEmailCredentialLifecycleLocks,
} from '../infrastructure/credential-lifecycle-lock'
import {
  admitWebRecoveryAttempt,
  isWebRecoveryAttemptThrottled,
} from '../infrastructure/web-recovery-rate-limit'
import { credentialAuditContext, type WebCredentialContext } from './credential-context'
import { normalizeRecoveryEmail, publicRecoveryFailure } from './recovery-policy'

const recoveryIdentifierPrefix = 'indigo:owner-recovery:'
const recoveryValueVersion = 'owner-recovery-v1'
const minimumTtlMinutes = 5
const maximumTtlMinutes = 60
const invalidPasswordHashInput = 'indigo-invalid-owner-recovery-password'

export class OwnerRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OwnerRecoveryError'
  }
}

export type IssuedOwnerRecovery = {
  readonly recoveryId: string
  readonly code: string
  readonly expiresAt: Date
}

export type RedeemedOwnerRecovery = {
  readonly ownerUserId: string
  readonly revokedSessionCount: number
}

export type RedeemOwnerRecoveryWebResult =
  | ({ readonly kind: 'redeemed' } & RedeemedOwnerRecovery)
  | typeof publicRecoveryFailure

function normalizeOwnerEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  if (!normalized || normalized.length > 320 || !normalized.includes('@')) {
    throw new OwnerRecoveryError(
      'owner-recovery.owner-email-invalid',
      'Provide the installed owner email address.',
    )
  }
  return normalized
}

function validateTtlMinutes(ttlMinutes: number): void {
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < minimumTtlMinutes ||
    ttlMinutes > maximumTtlMinutes
  ) {
    throw new OwnerRecoveryError(
      'owner-recovery.ttl-invalid',
      `Recovery lifetime must be a whole number from ${minimumTtlMinutes} to ${maximumTtlMinutes} minutes.`,
    )
  }
}

function validateNewPassword(password: string): void {
  if (password.length < 12 || password.length > 128 || password.includes('\0')) {
    throw new OwnerRecoveryError(
      'owner-recovery.password-invalid',
      'The new password must contain 12 to 128 characters.',
    )
  }
}

function recoveryIdentifier(ownerUserId: string): string {
  return `${recoveryIdentifierPrefix}${ownerUserId}`
}

function recoveryDigest(code: string): string {
  return createHmac('sha256', getServerConfig().authSecret)
    .update(`${recoveryValueVersion}\0${code}`, 'utf8')
    .digest('hex')
}

function storedRecoveryValue(code: string): string {
  return `${recoveryValueVersion}:${recoveryDigest(code)}`
}

function dummyCredentialDigest(): string {
  return createHmac('sha256', getServerConfig().authSecret)
    .update('credential-dummy-v1\0', 'utf8')
    .digest('hex')
}

function codeMatchesStoredValue(code: string, storedValue: string): boolean {
  const expectedPrefix = `${recoveryValueVersion}:`
  const candidateHex = storedValue.startsWith(expectedPrefix)
    ? storedValue.slice(expectedPrefix.length)
    : ''
  const hasValidExpectedDigest = /^[0-9a-f]{64}$/.test(candidateHex)
  const expectedHex = hasValidExpectedDigest ? candidateHex : dummyCredentialDigest()
  const actualHex = recoveryDigest(code)
  const matches = timingSafeEqual(
    Buffer.from(actualHex, 'hex'),
    Buffer.from(expectedHex, 'hex'),
  )
  return hasValidExpectedDigest && matches
}

async function lockAndResolveOwner(
  transaction: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  ownerEmail: string,
) {
  const [installation] = await transaction
    .select({ ownerUserId: installationState.ownerUserId })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
    .for('update')
    .limit(1)

  if (!installation?.ownerUserId) {
    throw new OwnerRecoveryError(
      'owner-recovery.instance-open',
      'This instance has no installed owner. Use first-owner bootstrap instead.',
    )
  }

  const [owner] = await transaction
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.id, installation.ownerUserId))
    .limit(1)

  if (!owner || owner.email.toLowerCase() !== ownerEmail) {
    throw new OwnerRecoveryError(
      'owner-recovery.owner-mismatch',
      'The supplied email does not match the installed owner.',
    )
  }

  return owner
}

async function installedOwnerUserId(): Promise<string | null> {
  const [installation] = await getDb()
    .select({ ownerUserId: installationState.ownerUserId })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
    .limit(1)
  return installation?.ownerUserId ?? null
}

async function appendHostRecoveryRejection(input: {
  readonly subjectUserId: string | null
  readonly entityId?: string | null
  readonly now: Date
}): Promise<void> {
  const installedOwner = await installedOwnerUserId()
  if (!input.subjectUserId || installedOwner !== input.subjectUserId) return
  await getDb()
    .insert(auditEvents)
    .values({
      id: newUuidV7(),
      actorUserId: null,
      subjectUserId: input.subjectUserId,
      eventType: 'owner-recovery-rejected',
      entityType: 'owner-recovery',
      entityId: input.entityId ?? null,
      metadata: { channel: 'host-local-cli', outcome: 'rejected' },
      createdAt: input.now,
    })
}

export async function issueOwnerRecovery(input: {
  readonly ownerEmail: string
  readonly ttlMinutes: number
  readonly now?: Date
}): Promise<IssuedOwnerRecovery> {
  const now = input.now ?? new Date()
  let subjectUserId: string | null = null
  try {
    subjectUserId = await installedOwnerUserId()
    if (!subjectUserId) {
      throw new OwnerRecoveryError(
        'owner-recovery.instance-open',
        'This instance has no installed owner. Use first-owner bootstrap instead.',
      )
    }
    const ownerEmail = normalizeOwnerEmail(input.ownerEmail)
    validateTtlMinutes(input.ttlMinutes)
    const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000)
    const code = `indigo_r1_${randomBytes(32).toString('base64url')}`

    return await withCredentialLifecycleLock(subjectUserId, () =>
      getDb().transaction(
        async (transaction) => {
          const owner = await lockAndResolveOwner(transaction, ownerEmail)
          const identifier = recoveryIdentifier(owner.id)
          const recoveryId = newUuidV7()

          await transaction
            .delete(verification)
            .where(eq(verification.identifier, identifier))
          await transaction.insert(verification).values({
            id: recoveryId,
            identifier,
            value: storedRecoveryValue(code),
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          await transaction.insert(auditEvents).values({
            id: newUuidV7(),
            actorUserId: null,
            subjectUserId: owner.id,
            eventType: 'owner-recovery-issued',
            entityType: 'owner-recovery',
            entityId: recoveryId,
            metadata: {
              channel: 'host-local-cli',
              outcome: 'issued',
              expiresAt: expiresAt.toISOString(),
            },
            createdAt: now,
          })

          return { recoveryId, code, expiresAt }
        },
        { isolationLevel: 'serializable' },
      ),
    )
  } catch (error) {
    await appendHostRecoveryRejection({ subjectUserId, now }).catch(() => undefined)
    throw error instanceof CredentialLifecycleUnavailableError
      ? new OwnerRecoveryError(
          'owner-recovery.instance-open',
          'This instance has no installed owner. Use first-owner bootstrap instead.',
        )
      : error
  }
}

export async function redeemOwnerRecovery(input: {
  readonly ownerEmail: string
  readonly code: string
  readonly newPassword: string
  readonly now?: Date
}): Promise<RedeemedOwnerRecovery> {
  const now = input.now ?? new Date()
  let subjectUserId: string | null | undefined
  let entityId: string | null | undefined
  try {
    subjectUserId = await installedOwnerUserId()
    if (!subjectUserId) {
      throw new OwnerRecoveryError(
        'owner-recovery.instance-open',
        'This instance has no installed owner. Use first-owner bootstrap instead.',
      )
    }
    const ownerEmail = normalizeOwnerEmail(input.ownerEmail)
    validateNewPassword(input.newPassword)
    const passwordHash = await hashPassword(input.newPassword)

    const outcome = await withCredentialLifecycleLock(subjectUserId, () =>
      getDb().transaction(
        async (transaction) => {
          const owner = await lockAndResolveOwner(transaction, ownerEmail)
          const identifier = recoveryIdentifier(owner.id)
          const [pending] = await transaction
            .select()
            .from(verification)
            .where(eq(verification.identifier, identifier))
            .for('update')
            .limit(1)
          entityId = pending?.id ?? null

          if (!pending) return { status: 'invalid' as const }
          if (pending.expiresAt <= now) {
            await transaction.delete(verification).where(eq(verification.id, pending.id))
            return { status: 'invalid' as const }
          }
          if (!codeMatchesStoredValue(input.code, pending.value)) {
            return { status: 'invalid' as const }
          }

          const [credential] = await transaction
            .update(account)
            .set({ password: passwordHash, updatedAt: now })
            .where(
              and(eq(account.userId, owner.id), eq(account.providerId, 'credential')),
            )
            .returning({ id: account.id })

          if (!credential) {
            throw new OwnerRecoveryError(
              'owner-recovery.credential-missing',
              'The installed owner has no password credential to recover.',
            )
          }

          await transaction.delete(verification).where(eq(verification.id, pending.id))
          const revokedSessions = await transaction
            .delete(session)
            .where(eq(session.userId, owner.id))
            .returning({ id: session.id })
          await transaction.insert(auditEvents).values({
            id: newUuidV7(),
            actorUserId: null,
            subjectUserId: owner.id,
            eventType: 'owner-recovery-redeemed',
            entityType: 'owner-recovery',
            entityId: pending.id,
            metadata: {
              channel: 'host-local-cli',
              outcome: 'redeemed',
              sessionsRevoked: revokedSessions.length,
            },
            createdAt: now,
          })

          return {
            status: 'redeemed' as const,
            ownerUserId: owner.id,
            revokedSessionCount: revokedSessions.length,
          }
        },
        { isolationLevel: 'serializable' },
      ),
    )

    if (outcome.status === 'invalid') {
      throw new OwnerRecoveryError(
        'owner-recovery.code-invalid',
        'The recovery code is invalid or expired.',
      )
    }

    return {
      ownerUserId: outcome.ownerUserId,
      revokedSessionCount: outcome.revokedSessionCount,
    }
  } catch (error) {
    await appendHostRecoveryRejection({
      subjectUserId: subjectUserId ?? null,
      entityId,
      now,
    }).catch(() => undefined)
    throw error instanceof CredentialLifecycleUnavailableError
      ? new OwnerRecoveryError(
          'owner-recovery.instance-open',
          'This instance has no installed owner. Use first-owner bootstrap instead.',
        )
      : error
  }
}

/**
 * Network-facing owner recovery. The CLI remains a separate unthrottled escape path;
 * this wrapper owns uniform failures, web admission, email-first locking, and minimized
 * audit attribution.
 */
export async function redeemOwnerRecoveryWeb(input: {
  readonly ownerEmail: string
  readonly code: string
  readonly newPassword: string
  readonly requestContext: WebCredentialContext
  readonly now?: Date
}): Promise<RedeemOwnerRecoveryWebResult> {
  const now = input.now ?? new Date()
  const normalizedEmail = normalizeRecoveryEmail(input.ownerEmail)
  let resolvedOwnerUserId: string | null = null
  const rateInput = {
    purpose: 'owner-recovery' as const,
    email: normalizedEmail,
    clientAddress: input.requestContext.clientAddress,
    now,
  }

  if (await isWebRecoveryAttemptThrottled(rateInput)) return publicRecoveryFailure

  return withSubmittedEmailCredentialLifecycleLocks({
    email: normalizedEmail,
    resolveAccountUserIds: async () => {
      const [installedOwner] = await getDb()
        .select({ id: user.id, email: user.email })
        .from(installationState)
        .innerJoin(user, eq(user.id, installationState.ownerUserId))
        .where(eq(installationState.singleton, 1))
        .limit(1)
      resolvedOwnerUserId = installedOwner?.id ?? null
      return resolvedOwnerUserId ? [resolvedOwnerUserId] : []
    },
    callback: async () => {
      const admission = await admitWebRecoveryAttempt(rateInput)
      if (!admission.admitted) return publicRecoveryFailure

      const passwordValid =
        input.newPassword.length >= 12 &&
        input.newPassword.length <= 128 &&
        !input.newPassword.includes('\0')
      const passwordHash = await hashPassword(
        passwordValid ? input.newPassword : invalidPasswordHashInput,
      )

      return getDb().transaction(
        async (transaction): Promise<RedeemOwnerRecoveryWebResult> => {
          const [installation] = await transaction
            .select({ ownerUserId: installationState.ownerUserId })
            .from(installationState)
            .where(eq(installationState.singleton, 1))
            .limit(1)
          const ownerUserId = installation?.ownerUserId ?? null
          const [owner] = ownerUserId
            ? await transaction
                .select({ id: user.id, email: user.email })
                .from(user)
                .where(eq(user.id, ownerUserId))
                .limit(1)
            : []
          const ownerMatches =
            owner !== undefined &&
            owner.email.toLowerCase() === normalizedEmail &&
            resolvedOwnerUserId === owner.id
          const [pending] = owner
            ? await transaction
                .select()
                .from(verification)
                .where(eq(verification.identifier, recoveryIdentifier(owner.id)))
                .for('update')
                .limit(1)
            : []
          const [credential] = owner
            ? await transaction
                .select({ id: account.id })
                .from(account)
                .where(
                  and(eq(account.userId, owner.id), eq(account.providerId, 'credential')),
                )
                .for('update')
                .limit(1)
            : []

          const codeMatches = codeMatchesStoredValue(input.code, pending?.value ?? '')
          const codeIsLive = pending !== undefined && pending.expiresAt > now
          if (
            ownerMatches &&
            credential &&
            pending &&
            codeIsLive &&
            codeMatches &&
            passwordValid
          ) {
            await transaction
              .update(account)
              .set({ password: passwordHash, updatedAt: now })
              .where(eq(account.id, credential.id))
            await transaction.delete(verification).where(eq(verification.id, pending.id))
            const revokedSessions = await transaction
              .delete(session)
              .where(eq(session.userId, owner.id))
              .returning({ id: session.id })
            await transaction.insert(auditEvents).values({
              id: newUuidV7(),
              actorUserId: null,
              subjectUserId: owner.id,
              eventType: 'owner-recovery-redeemed',
              entityType: 'owner-recovery',
              entityId: pending.id,
              metadata: {
                ...credentialAuditContext(input.requestContext),
                outcome: 'redeemed',
                sessionsRevoked: revokedSessions.length,
              },
              createdAt: now,
            })
            return {
              kind: 'redeemed',
              ownerUserId: owner.id,
              revokedSessionCount: revokedSessions.length,
            }
          }

          if (ownerMatches && pending && !codeIsLive) {
            await transaction.delete(verification).where(eq(verification.id, pending.id))
          }
          await transaction.insert(auditEvents).values({
            id: newUuidV7(),
            actorUserId: null,
            subjectUserId: ownerMatches ? owner.id : null,
            eventType: 'owner-recovery-rejected',
            entityType: 'owner-recovery',
            entityId: ownerMatches ? (pending?.id ?? null) : null,
            metadata: {
              ...credentialAuditContext(input.requestContext),
              outcome: 'rejected',
            },
            createdAt: now,
          })
          return publicRecoveryFailure
        },
        { isolationLevel: 'serializable' },
      )
    },
  })
}
