export type IdentityRole = 'owner' | 'member'

export type AuthenticatedActor = {
  readonly userId: string
  readonly email: string
  readonly name: string
  readonly role: IdentityRole
}

export function deriveIdentityRole(
  userId: string,
  ownerUserId: string | null,
): IdentityRole {
  return userId === ownerUserId ? 'owner' : 'member'
}

export class OwnerAuthorizationError extends Error {
  constructor() {
    super('Only the instance owner may create local users.')
    this.name = 'OwnerAuthorizationError'
  }
}

export function assertOwner(
  actor: AuthenticatedActor,
): asserts actor is AuthenticatedActor & { readonly role: 'owner' } {
  if (actor.role !== 'owner') {
    throw new OwnerAuthorizationError()
  }
}
