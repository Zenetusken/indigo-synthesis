import { hashPassword } from 'better-auth/crypto'
import { asc, eq, sql } from 'drizzle-orm'
import {
  type AuthenticatedActor,
  OwnerAuthorizationError,
} from '@/modules/identity/application/actor'
import type {
  CreateLocalUserInput,
  LocalUser,
} from '@/modules/identity/application/local-users'
import {
  createLocalUser,
  type LocalUserCreator,
  LocalUserEmailConflictError,
} from '@/modules/identity/application/local-users'
import { getDb } from '@/platform/db/client'
import { account, installationState, user } from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

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

export async function createLocalUserAsOwner(
  actor: AuthenticatedActor,
  input: CreateLocalUserInput,
): Promise<LocalUser> {
  return createLocalUser(actor, input, postgresLocalUserCreator)
}

export async function listLocalUsersAsOwner(actor: AuthenticatedActor) {
  if (actor.role !== 'owner') throw new OwnerAuthorizationError()

  return getDb()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(asc(user.createdAt))
}
