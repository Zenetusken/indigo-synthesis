import type { Route } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { type AuthenticatedActor, deriveIdentityRole } from '../application/actor'
import { expiredWorkoutSignInLocation } from '../application/sign-in-return'
import { getAuth } from '../infrastructure/auth'
import { getInstallationOwnerUserId } from '../infrastructure/installation'

export type { AuthenticatedActor } from '../application/actor'

export async function getActor(): Promise<AuthenticatedActor | null> {
  const authSession = await getAuth().api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  })

  if (!authSession) {
    return null
  }

  const ownerUserId = await getInstallationOwnerUserId()

  return {
    userId: authSession.user.id,
    email: authSession.user.email,
    name: authSession.user.name,
    role: deriveIdentityRole(authSession.user.id, ownerUserId),
  }
}

export async function requireActor(): Promise<AuthenticatedActor> {
  const actor = await getActor()

  if (!actor) {
    redirect('/sign-in')
  }

  return actor
}

export async function requireActorForWorkout(
  sessionId: unknown,
): Promise<AuthenticatedActor> {
  const actor = await getActor()

  if (!actor) {
    redirect(expiredWorkoutSignInLocation(sessionId) as Route)
  }

  return actor
}
