import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  type CreateLocalUserInput,
  type LocalUser,
  validateLocalUserInput,
} from '@/modules/identity/application/local-users'
import {
  account,
  auditEvents,
  memberResetStates,
  user,
  verification,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  credentialAuditContext,
  type WebCredentialContext,
} from '../recovery/credential-context'
import {
  memberResetStoredValue,
  type PreparedMemberResetIssuance,
  recoveryPreparationPolicy,
} from '../recovery/recovery-preparation'
import {
  type LocalUserCreationMutationCapture,
  localUserCreationMutationScope,
  type MemberResetIssuanceMutationCapture,
  memberResetIssuanceMutationScope,
} from './credential-administration-mutation'

const maximumUuidTimestamp = 0xffffffffffff

export type PreparedLocalUserCreation = Readonly<{
  targetUserId: string
  accountId: string
  auditEventId: string
  name: string
  normalizedEmail: string
  passwordHash: string
  commandEnteredAt: Date
}>

export type ScopedLocalUserCreationOutcome =
  | Readonly<{ kind: 'created'; user: LocalUser }>
  | Readonly<{ kind: 'email-conflict' }>

export type ScopedMemberResetIssuanceOutcome =
  | Readonly<{
      kind: 'issued'
      resetId: string
      code: string
      expiresAt: Date
    }>
  | Readonly<{
      kind: 'cooldown'
      retryAfter: Date
    }>

export interface ScopedLocalUserCreationMutationGateway {
  createLocalUser(
    capture: LocalUserCreationMutationCapture,
    prepared: PreparedLocalUserCreation,
    requestContext: WebCredentialContext,
  ): Promise<ScopedLocalUserCreationOutcome>
}

export interface ScopedMemberResetIssuanceMutationGateway {
  issueMemberReset(
    capture: MemberResetIssuanceMutationCapture,
    prepared: PreparedMemberResetIssuance,
    requestContext: WebCredentialContext,
  ): Promise<ScopedMemberResetIssuanceOutcome>
}

function commandEntryDate(value: Date): Date {
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > maximumUuidTimestamp) {
    throw new TypeError(
      'The credential-administration command-entry clock must be a valid UUIDv7 date.',
    )
  }
  return new Date(timestamp)
}

function sameInstant(left: Date, right: Date): boolean {
  return (
    left instanceof Date &&
    right instanceof Date &&
    Number.isFinite(left.getTime()) &&
    left.getTime() === right.getTime()
  )
}

function invalidPreparedPayload(): never {
  throw new TypeError(
    'Prepared credential-administration data does not match its nominal capture.',
  )
}

/**
 * Performs all validation, identifier allocation, and password hashing before a
 * database lease is acquired. The returned payload never retains the raw password.
 */
export async function prepareLocalUserCreation(input: {
  readonly targetUserId: string
  readonly name: CreateLocalUserInput['name']
  readonly email: CreateLocalUserInput['email']
  readonly initialPassword: CreateLocalUserInput['password']
  readonly commandEnteredAt: Date
}): Promise<PreparedLocalUserCreation> {
  const commandEnteredAt = commandEntryDate(input.commandEnteredAt)
  const validated = validateLocalUserInput({
    name: input.name,
    email: input.email,
    password: input.initialPassword,
  })
  if (
    typeof input.targetUserId !== 'string' ||
    input.targetUserId.length < 1 ||
    input.targetUserId.length > 512 ||
    input.targetUserId.includes('\0')
  ) {
    throw new TypeError('A preallocated local-user target identity is required.')
  }
  const timestamp = commandEnteredAt.getTime()
  const accountId = newUuidV7(timestamp)
  const auditEventId = newUuidV7(timestamp)
  const passwordHash = await hashPassword(validated.password)

  return Object.freeze({
    targetUserId: input.targetUserId,
    accountId,
    auditEventId,
    name: validated.name,
    normalizedEmail: validated.email,
    passwordHash,
    commandEnteredAt,
  })
}

function assertLocalBinding(
  capture: LocalUserCreationMutationCapture,
  prepared: PreparedLocalUserCreation,
) {
  const scope = localUserCreationMutationScope(capture)
  if (
    prepared.targetUserId !== scope.targetUserId ||
    prepared.normalizedEmail !== scope.normalizedEmail ||
    !sameInstant(prepared.commandEnteredAt, scope.commandEnteredAt) ||
    !prepared.accountId ||
    !prepared.auditEventId ||
    !prepared.name ||
    !prepared.passwordHash
  ) {
    return invalidPreparedPayload()
  }
  return scope
}

function assertMemberResetBinding(
  capture: MemberResetIssuanceMutationCapture,
  prepared: PreparedMemberResetIssuance,
) {
  const scope = memberResetIssuanceMutationScope(capture)
  const expiresAt = prepared.expiresAt.getTime()
  const lifetime = expiresAt - prepared.commandEnteredAt.getTime()
  if (
    scope.targetState !== 'member' ||
    scope.targetCredential !== 'present' ||
    prepared.targetUserId !== scope.targetUserId ||
    prepared.identifier !== scope.identifier ||
    !sameInstant(prepared.commandEnteredAt, scope.commandEnteredAt) ||
    !Number.isFinite(expiresAt) ||
    lifetime < recoveryPreparationPolicy.memberReset.minimumTtlMinutes * 60_000 ||
    lifetime > recoveryPreparationPolicy.memberReset.maximumTtlMinutes * 60_000 ||
    prepared.storedValue !== memberResetStoredValue(prepared.code) ||
    prepared.audit.eventType !== 'member-reset-issued' ||
    prepared.audit.entityType !== 'member-reset' ||
    prepared.audit.entityId !== prepared.resetId ||
    prepared.audit.outcome !== 'issued' ||
    prepared.audit.expiresAt !== prepared.expiresAt.toISOString() ||
    !prepared.resetId ||
    !prepared.auditEventId
  ) {
    return invalidPreparedPayload()
  }
  return scope
}

async function appendLocalEmailConflict<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  input: {
    readonly actorUserId: string
    readonly prepared: PreparedLocalUserCreation
    readonly requestContext: WebCredentialContext
  },
): Promise<ScopedLocalUserCreationOutcome> {
  await database.insert(auditEvents).values({
    id: input.prepared.auditEventId,
    actorUserId: input.actorUserId,
    subjectUserId: null,
    eventType: 'local-user-create-rejected',
    entityType: 'local-user',
    entityId: input.prepared.targetUserId,
    metadata: {
      ...credentialAuditContext(input.requestContext),
      outcome: 'email-conflict',
    },
    createdAt: input.prepared.commandEnteredAt,
  })
  return Object.freeze({ kind: 'email-conflict' as const })
}

export function createScopedLocalUserCreationMutationGateway<
  TSchema extends Record<string, unknown>,
>(database: NodePgDatabase<TSchema>): ScopedLocalUserCreationMutationGateway {
  return Object.freeze({
    async createLocalUser(
      capture: LocalUserCreationMutationCapture,
      prepared: PreparedLocalUserCreation,
      requestContext: WebCredentialContext,
    ) {
      const scope = assertLocalBinding(capture, prepared)
      if (scope.submittedEmailUserIds.length > 0) {
        return appendLocalEmailConflict(database, {
          actorUserId: scope.actorUserId,
          prepared,
          requestContext,
        })
      }
      const [created] = await database
        .insert(user)
        .values({
          id: prepared.targetUserId,
          name: prepared.name,
          email: prepared.normalizedEmail,
          emailVerified: false,
          createdAt: prepared.commandEnteredAt,
          updatedAt: prepared.commandEnteredAt,
        })
        .onConflictDoNothing({ target: user.email })
        .returning({ id: user.id, name: user.name, email: user.email })

      if (!created) {
        return appendLocalEmailConflict(database, {
          actorUserId: scope.actorUserId,
          prepared,
          requestContext,
        })
      }

      await database.insert(account).values({
        id: prepared.accountId,
        accountId: prepared.targetUserId,
        providerId: 'credential',
        userId: prepared.targetUserId,
        password: prepared.passwordHash,
        createdAt: prepared.commandEnteredAt,
        updatedAt: prepared.commandEnteredAt,
      })
      await database.insert(auditEvents).values({
        id: prepared.auditEventId,
        actorUserId: scope.actorUserId,
        subjectUserId: prepared.targetUserId,
        eventType: 'local-user-created',
        entityType: 'local-user',
        entityId: prepared.targetUserId,
        metadata: {
          ...credentialAuditContext(requestContext),
          outcome: 'created',
        },
        createdAt: prepared.commandEnteredAt,
      })
      return Object.freeze({
        kind: 'created' as const,
        user: Object.freeze({
          id: created.id,
          name: created.name,
          email: created.email,
        }),
      })
    },
  })
}

export function createScopedMemberResetIssuanceMutationGateway<
  TSchema extends Record<string, unknown>,
>(database: NodePgDatabase<TSchema>): ScopedMemberResetIssuanceMutationGateway {
  return Object.freeze({
    async issueMemberReset(
      capture: MemberResetIssuanceMutationCapture,
      prepared: PreparedMemberResetIssuance,
      requestContext: WebCredentialContext,
    ) {
      const scope = assertMemberResetBinding(capture, prepared)
      const retryAfter = scope.state
        ? new Date(
            scope.state.lastIssuedAt.getTime() +
              recoveryPreparationPolicy.memberReset.issuanceCooldownMilliseconds,
          )
        : null

      if (retryAfter && retryAfter.getTime() > prepared.commandEnteredAt.getTime()) {
        await database.insert(auditEvents).values({
          id: prepared.auditEventId,
          actorUserId: scope.actorUserId,
          subjectUserId: scope.targetUserId,
          eventType: 'member-reset-rejected',
          entityType: 'member-reset',
          entityId: scope.state?.activeVerificationId ?? null,
          metadata: {
            ...credentialAuditContext(requestContext),
            outcome: 'cooldown',
            retryAfter: retryAfter.toISOString(),
          },
          createdAt: prepared.commandEnteredAt,
        })
        return Object.freeze({ kind: 'cooldown' as const, retryAfter })
      }

      await database
        .delete(verification)
        .where(eq(verification.identifier, scope.identifier))
      await database.insert(verification).values({
        id: prepared.resetId,
        identifier: prepared.identifier,
        value: prepared.storedValue,
        expiresAt: prepared.expiresAt,
        createdAt: prepared.commandEnteredAt,
        updatedAt: prepared.commandEnteredAt,
      })
      await database
        .insert(memberResetStates)
        .values({
          targetUserId: scope.targetUserId,
          activeVerificationId: prepared.resetId,
          lastIssuedAt: prepared.commandEnteredAt,
          failedAttempts: 0,
          retryAfter: null,
          lastAttemptAt: null,
          createdAt: prepared.commandEnteredAt,
          updatedAt: prepared.commandEnteredAt,
        })
        .onConflictDoUpdate({
          target: memberResetStates.targetUserId,
          set: {
            activeVerificationId: prepared.resetId,
            lastIssuedAt: prepared.commandEnteredAt,
            failedAttempts: 0,
            retryAfter: null,
            lastAttemptAt: null,
            updatedAt: prepared.commandEnteredAt,
          },
        })
      await database.insert(auditEvents).values({
        id: prepared.auditEventId,
        actorUserId: scope.actorUserId,
        subjectUserId: scope.targetUserId,
        eventType: prepared.audit.eventType,
        entityType: prepared.audit.entityType,
        entityId: prepared.audit.entityId,
        metadata: {
          ...credentialAuditContext(requestContext),
          outcome: prepared.audit.outcome,
          expiresAt: prepared.audit.expiresAt,
        },
        createdAt: prepared.commandEnteredAt,
      })
      return Object.freeze({
        kind: 'issued' as const,
        resetId: prepared.resetId,
        code: prepared.code,
        expiresAt: new Date(prepared.expiresAt.getTime()),
      })
    },
  })
}
