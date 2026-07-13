import type { AuthenticatedActor } from '../application/actor'
import {
  type LocalUser,
  type LocalUserSummary,
  listLocalUsers,
} from '../application/local-users'
import {
  createLocalUserWithOwnerReauthentication,
  postgresLocalUserReader,
} from '../infrastructure/local-users'
import type { WebCredentialContext } from '../recovery/credential-context'

export async function createLocalUserAsOwner(input: {
  readonly actor: AuthenticatedActor
  readonly name: string
  readonly email: string
  readonly initialPassword: string
  readonly currentPassword: string
  readonly requestContext: WebCredentialContext
}): Promise<LocalUser> {
  return createLocalUserWithOwnerReauthentication(input)
}

export async function listLocalUsersAsOwner(
  actor: AuthenticatedActor,
): Promise<readonly LocalUserSummary[]> {
  return listLocalUsers(actor, postgresLocalUserReader)
}
