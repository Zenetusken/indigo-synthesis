import type { AuthenticatedActor } from '../application/actor'
import {
  type CreateLocalUserInput,
  createLocalUser,
  type LocalUser,
  type LocalUserSummary,
  listLocalUsers,
} from '../application/local-users'
import {
  postgresLocalUserCreator,
  postgresLocalUserReader,
} from '../infrastructure/local-users'

export async function createLocalUserAsOwner(
  actor: AuthenticatedActor,
  input: CreateLocalUserInput,
): Promise<LocalUser> {
  return createLocalUser(actor, input, postgresLocalUserCreator)
}

export async function listLocalUsersAsOwner(
  actor: AuthenticatedActor,
): Promise<readonly LocalUserSummary[]> {
  return listLocalUsers(actor, postgresLocalUserReader)
}
