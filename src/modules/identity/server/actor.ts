import type { Route } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { CheckedSignOutActionBinding } from '../application/action-binding'
import { type AuthenticatedActor, deriveIdentityRole } from '../application/actor'
import { expiredWorkoutSignInLocation } from '../application/sign-in-return'
import { issueCheckedSignOutActionBinding } from '../infrastructure/action-binding'
import { readIdentitySession } from '../infrastructure/auth'
import { getServerActorInstallationState } from '../infrastructure/installation'

export type { AuthenticatedActor } from '../application/actor'

export type ServerAuthenticatedActor = AuthenticatedActor & {
  readonly checkedSignOutActionBinding: CheckedSignOutActionBinding
}

async function readActorContext() {
  const authSession = await readIdentitySession(await headers())

  if (!authSession) {
    return null
  }

  const installation = await getServerActorInstallationState()

  return { authSession, installation }
}

export async function getActor(): Promise<AuthenticatedActor | null> {
  const context = await readActorContext()
  if (!context) return null

  return {
    userId: context.authSession.user.id,
    email: context.authSession.user.email,
    name: context.authSession.user.name,
    role: deriveIdentityRole(
      context.authSession.user.id,
      context.installation.ownerUserId,
    ),
  }
}

export async function getUiActor(): Promise<ServerAuthenticatedActor | null> {
  const context = await readActorContext()
  if (!context) return null

  const now = new Date()
  if (context.authSession.session.expiresAt.getTime() <= now.getTime()) return null

  return {
    userId: context.authSession.user.id,
    email: context.authSession.user.email,
    name: context.authSession.user.name,
    role: deriveIdentityRole(
      context.authSession.user.id,
      context.installation.ownerUserId,
    ),
    checkedSignOutActionBinding: issueCheckedSignOutActionBinding(
      {
        expectedEpoch: context.installation.productMutationEpoch,
        sessionId: context.authSession.session.id,
        actorUserId: context.authSession.user.id,
        sessionExpiresAt: context.authSession.session.expiresAt,
      },
      now,
    ),
  }
}

export async function requireActor(): Promise<AuthenticatedActor> {
  const actor = await getActor()

  if (!actor) {
    redirect('/sign-in')
  }

  return actor
}

export async function requireUiActor(): Promise<ServerAuthenticatedActor> {
  const actor = await getUiActor()

  if (!actor) redirect('/sign-in')

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
