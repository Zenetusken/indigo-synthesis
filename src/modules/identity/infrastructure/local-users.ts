import { hashPassword } from 'better-auth/crypto'
import { asc, eq, sql } from 'drizzle-orm'
import {
  type AuthenticatedActor,
  OwnerAuthorizationError,
} from '@/modules/identity/application/actor'
import type {
  CreateLocalUserInput,
  LocalUser,
  LocalUserReader,
} from '@/modules/identity/application/local-users'
import {
  createLocalUser,
  type LocalUserCreator,
  LocalUserCredentialError,
  LocalUserEmailConflictError,
} from '@/modules/identity/application/local-users'
import { getDb } from '@/platform/db/client'
import { account, auditEvents, installationState, user } from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  credentialAuditContext,
  type WebCredentialContext,
} from '../recovery/credential-context'
import { normalizeRecoveryEmail } from '../recovery/recovery-policy'
import { withSubmittedEmailCredentialLifecycleLocks } from './credential-lifecycle-lock'
import { verifyDestructiveReauthentication } from './destructive-reauthentication'

type PostgresError = Error & {
  readonly code?: string
  readonly constraint?: string
}

function isUniqueEmailViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const postgresError = error as PostgresError

  return (
    postgresError.code === '23505' && postgresError.constraint === 'user_email_unique'
  )
}

export const postgresLocalUserCreator: LocalUserCreator = {
  async create(ownerUserId, input): Promise<LocalUser> {
    const passwordHash = await hashPassword(input.password)

    try {
      return await getDb().transaction(async (transaction) => {
        const [installation] = await transaction
          .select({
            ownerUserId: installationState.ownerUserId,
            closedAt: installationState.bootstrapClosedAt,
          })
          .from(installationState)
          .where(eq(installationState.singleton, 1))
          .for('update')
          .limit(1)

        if (
          !installation?.closedAt ||
          !installation.ownerUserId ||
          installation.ownerUserId !== ownerUserId
        ) {
          throw new OwnerAuthorizationError()
        }

        await transaction.execute(
          sql.raw("SET LOCAL indigo.user_creation_mode = 'owner-admin'"),
        )

        const now = new Date()
        const userId = newUuidV7()

        const [createdUser] = await transaction
          .insert(user)
          .values({
            id: userId,
            name: input.name,
            email: input.email,
            emailVerified: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: user.id, name: user.name, email: user.email })

        if (!createdUser) {
          throw new Error('The local user insert returned no row.')
        }

        await transaction.insert(account).values({
          id: newUuidV7(),
          accountId: userId,
          providerId: 'credential',
          userId,
          password: passwordHash,
          createdAt: now,
          updatedAt: now,
        })

        return createdUser
      })
    } catch (error) {
      if (isUniqueEmailViolation(error)) {
        throw new LocalUserEmailConflictError()
      }

      throw error
    }
  },
}

async function appendLocalUserRejection(input: {
  readonly actorUserId: string | null
  readonly targetId: string
  readonly outcome: string
  readonly requestContext: WebCredentialContext
  readonly now: Date
}): Promise<void> {
  await getDb()
    .insert(auditEvents)
    .values({
      id: newUuidV7(),
      actorUserId: input.actorUserId,
      subjectUserId: null,
      eventType: 'local-user-create-rejected',
      entityType: 'local-user',
      entityId: input.targetId,
      metadata: {
        ...credentialAuditContext(input.requestContext),
        outcome: input.outcome,
      },
      createdAt: input.now,
    })
}

/** Production command boundary. Test fixtures use postgresLocalUserCreator directly. */
export async function createLocalUserWithOwnerReauthentication(input: {
  readonly actor: AuthenticatedActor
  readonly name: string
  readonly email: string
  readonly initialPassword: string
  readonly currentPassword: string
  readonly requestContext: WebCredentialContext
  readonly now?: Date
}): Promise<LocalUser> {
  const now = input.now ?? new Date()
  const targetId = newUuidV7()
  const normalizedEmail = normalizeRecoveryEmail(input.email)

  return withSubmittedEmailCredentialLifecycleLocks({
    email: normalizedEmail,
    resolveAccountUserIds: async () => [input.actor.userId, targetId],
    callback: async () => {
      const [authority] = await getDb()
        .select({ ownerUserId: installationState.ownerUserId })
        .from(installationState)
        .where(eq(installationState.singleton, 1))
        .limit(1)
      if (input.actor.role !== 'owner' || authority?.ownerUserId !== input.actor.userId) {
        const [actorExists] = await getDb()
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, input.actor.userId))
          .limit(1)
        await appendLocalUserRejection({
          actorUserId: actorExists?.id ?? null,
          targetId,
          outcome: 'not-authorized',
          requestContext: input.requestContext,
          now,
        })
        throw new OwnerAuthorizationError()
      }

      const reauthentication = await verifyDestructiveReauthentication({
        userId: input.actor.userId,
        purpose: 'local-user-create',
        password: input.currentPassword,
        audit: {
          actorUserId: input.actor.userId,
          subjectUserId: null,
          eventType: 'local-user-create-rejected',
          entityType: 'local-user',
          entityId: targetId,
          metadata: {
            ...credentialAuditContext(input.requestContext),
            outcome: 'reauthentication-denied',
          },
        },
        now,
      })
      if (reauthentication.status !== 'succeeded') {
        throw new LocalUserCredentialError(
          `local-user-create.reauthentication-${reauthentication.status}`,
        )
      }

      const secureCreator: LocalUserCreator = {
        async create(ownerUserId, validatedInput) {
          const passwordHash = await hashPassword(validatedInput.password)
          try {
            return await getDb().transaction(async (transaction) => {
              const [installation] = await transaction
                .select({
                  ownerUserId: installationState.ownerUserId,
                  closedAt: installationState.bootstrapClosedAt,
                })
                .from(installationState)
                .where(eq(installationState.singleton, 1))
                .for('update')
                .limit(1)
              if (!installation?.closedAt || installation.ownerUserId !== ownerUserId) {
                throw new OwnerAuthorizationError()
              }

              await transaction.execute(
                sql.raw("SET LOCAL indigo.user_creation_mode = 'owner-admin'"),
              )
              const [createdUser] = await transaction
                .insert(user)
                .values({
                  id: targetId,
                  name: validatedInput.name,
                  email: validatedInput.email,
                  emailVerified: false,
                  createdAt: now,
                  updatedAt: now,
                })
                .returning({ id: user.id, name: user.name, email: user.email })
              if (!createdUser) throw new Error('The local user insert returned no row.')

              await transaction.insert(account).values({
                id: newUuidV7(),
                accountId: targetId,
                providerId: 'credential',
                userId: targetId,
                password: passwordHash,
                createdAt: now,
                updatedAt: now,
              })
              await transaction.insert(auditEvents).values({
                id: newUuidV7(),
                actorUserId: ownerUserId,
                subjectUserId: targetId,
                eventType: 'local-user-created',
                entityType: 'local-user',
                entityId: targetId,
                metadata: {
                  ...credentialAuditContext(input.requestContext),
                  outcome: 'created',
                },
                createdAt: now,
              })
              return createdUser
            })
          } catch (error) {
            if (isUniqueEmailViolation(error)) throw new LocalUserEmailConflictError()
            throw error
          }
        },
      }

      try {
        return await createLocalUser(
          input.actor,
          {
            name: input.name,
            email: input.email,
            password: input.initialPassword,
          },
          secureCreator,
        )
      } catch (error) {
        await appendLocalUserRejection({
          actorUserId: input.actor.userId,
          targetId,
          outcome:
            error instanceof LocalUserEmailConflictError
              ? 'email-conflict'
              : error instanceof OwnerAuthorizationError
                ? 'not-authorized'
                : 'validation-rejected',
          requestContext: input.requestContext,
          now,
        })
        throw error
      }
    },
  })
}

export async function createLocalUserAsOwner(
  actor: AuthenticatedActor,
  input: CreateLocalUserInput,
): Promise<LocalUser> {
  return createLocalUser(actor, input, postgresLocalUserCreator)
}

export const postgresLocalUserReader: LocalUserReader = {
  list() {
    return getDb()
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
      })
      .from(user)
      .orderBy(asc(user.createdAt))
  },
}
