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

const recoveryIdentifierPrefix = 'indigo:owner-recovery:'
const recoveryValueVersion = 'owner-recovery-v1'
const minimumTtlMinutes = 5
const maximumTtlMinutes = 60

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

function codeMatchesStoredValue(code: string, storedValue: string): boolean {
  const expectedPrefix = `${recoveryValueVersion}:`
  if (!storedValue.startsWith(expectedPrefix)) return false

  const expectedHex = storedValue.slice(expectedPrefix.length)
  const actualHex = recoveryDigest(code)
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false

  return timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHex, 'hex'))
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

export async function issueOwnerRecovery(input: {
  readonly ownerEmail: string
  readonly ttlMinutes: number
  readonly now?: Date
}): Promise<IssuedOwnerRecovery> {
  const ownerEmail = normalizeOwnerEmail(input.ownerEmail)
  validateTtlMinutes(input.ttlMinutes)

  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000)
  const code = `indigo_r1_${randomBytes(32).toString('base64url')}`

  return getDb().transaction(
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
          expiresAt: expiresAt.toISOString(),
        },
        createdAt: now,
      })

      return { recoveryId, code, expiresAt }
    },
    { isolationLevel: 'serializable' },
  )
}

export async function redeemOwnerRecovery(input: {
  readonly ownerEmail: string
  readonly code: string
  readonly newPassword: string
  readonly now?: Date
}): Promise<RedeemedOwnerRecovery> {
  const ownerEmail = normalizeOwnerEmail(input.ownerEmail)
  validateNewPassword(input.newPassword)
  const now = input.now ?? new Date()
  const passwordHash = await hashPassword(input.newPassword)

  const outcome = await getDb().transaction(
    async (transaction) => {
      const owner = await lockAndResolveOwner(transaction, ownerEmail)
      const identifier = recoveryIdentifier(owner.id)
      const [pending] = await transaction
        .select()
        .from(verification)
        .where(eq(verification.identifier, identifier))
        .for('update')
        .limit(1)

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
        .where(and(eq(account.userId, owner.id), eq(account.providerId, 'credential')))
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
}
