import type { AuthenticatedActor } from '../application/actor'
import { type LocalUserSummary, listLocalUsers } from '../application/local-users'
import { postgresLocalUserReader } from '../infrastructure/local-users'

export async function listLocalUsersAsOwner(
  actor: AuthenticatedActor,
): Promise<readonly LocalUserSummary[]> {
  return listLocalUsers(actor, postgresLocalUserReader)
}
