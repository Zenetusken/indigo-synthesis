import type { Route } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import type {
  CheckedSignOutActionBinding,
  InstanceResetActionBinding,
  LocalUserCreateActionBinding,
  MemberResetIssueActionBinding,
  TraineeDataDeletionActionBinding,
} from '../application/action-binding'
import { type AuthenticatedActor, deriveIdentityRole } from '../application/actor'
import { expiredWorkoutSignInLocation } from '../application/sign-in-return'
import {
  issueCheckedSignOutActionBinding,
  issueInstanceResetActionBinding,
  issueLocalUserCreateActionBinding,
  issueMemberResetIssueActionBinding,
  issueTraineeDataDeletionActionBinding,
} from '../infrastructure/action-binding'
import { readIdentitySession } from '../infrastructure/auth'
import { getServerActorInstallationState } from '../infrastructure/installation'

export type { AuthenticatedActor } from '../application/actor'

export type ServerAuthenticatedActor = AuthenticatedActor & {
  readonly checkedSignOutActionBinding: CheckedSignOutActionBinding
  /** Nominal server-only authority; deliberately non-enumerable and non-serializable. */
  readonly authenticatedActionEnvelope: AuthenticatedActionEnvelope
}

type AuthenticatedActionEnvelopeState = Readonly<{
  expectedEpoch: string
  sessionId: string
  actorUserId: string
  role: AuthenticatedActor['role']
  sessionExpiresAt: Date
}>

const authenticatedActionEnvelopes = new WeakMap<
  AuthenticatedActionEnvelope,
  AuthenticatedActionEnvelopeState
>()

/** Nominal server-only authority derived from one cryptographically verified session. */
export abstract class AuthenticatedActionEnvelope {
  protected declare readonly authenticatedActionEnvelopeNominal: never
}

class ConcreteAuthenticatedActionEnvelope extends AuthenticatedActionEnvelope {}

export type LocalUserCreationFormEnvelope = Readonly<{
  targetUserId: string
  actionBinding: LocalUserCreateActionBinding
}>

export type MemberResetIssuanceFormEnvelope = Readonly<{
  targetUserId: string
  actionBinding: MemberResetIssueActionBinding
}>

export type DestructivePlanFormInput = Readonly<{
  id: string
  digest: string
  expiresAt: Date
}>

export type TraineeDataDeletionFormEnvelope = Readonly<{
  planId: string
  planDigest: string
  actionBinding: TraineeDataDeletionActionBinding
}>

export type InstanceResetFormEnvelope = Readonly<{
  planId: string
  planDigest: string
  actionBinding: InstanceResetActionBinding
}>

function authenticatedFormSessionIsCurrent(
  state: AuthenticatedActionEnvelopeState,
  now: Date,
): boolean {
  const nowMilliseconds = now.getTime()
  if (!Number.isFinite(nowMilliseconds)) {
    throw new TypeError('Authenticated form issuance clock is invalid.')
  }
  return (
    Math.floor(state.sessionExpiresAt.getTime() / 1_000) >
    Math.floor(nowMilliseconds / 1_000)
  )
}

function createAuthenticatedActionEnvelope(
  state: AuthenticatedActionEnvelopeState,
): AuthenticatedActionEnvelope {
  const envelope = new ConcreteAuthenticatedActionEnvelope()
  authenticatedActionEnvelopes.set(
    envelope,
    Object.freeze({
      ...state,
      sessionExpiresAt: new Date(state.sessionExpiresAt.getTime()),
    }),
  )
  Object.freeze(envelope)
  return envelope
}

function ownerActionEnvelopeState(
  envelope: AuthenticatedActionEnvelope,
): AuthenticatedActionEnvelopeState {
  const state = authenticatedActionEnvelopes.get(envelope)
  if (!state) {
    throw new TypeError('Authenticated action envelope was not issued by Identity.')
  }
  if (state.role !== 'owner') {
    throw new TypeError(
      'Owner role is required to issue credential-administration forms.',
    )
  }
  return state
}

/** Preallocates and binds the only target ID accepted from this rendered creation form. */
export function issueLocalUserCreationFormEnvelope(
  envelope: AuthenticatedActionEnvelope,
  now = new Date(),
): LocalUserCreationFormEnvelope | null {
  const state = ownerActionEnvelopeState(envelope)
  if (!authenticatedFormSessionIsCurrent(state, now)) return null
  const targetUserId = newUuidV7(now.getTime())
  return Object.freeze({
    targetUserId,
    actionBinding: issueLocalUserCreateActionBinding(
      {
        expectedEpoch: state.expectedEpoch,
        sessionId: state.sessionId,
        actorUserId: state.actorUserId,
        targetUserId,
        sessionExpiresAt: state.sessionExpiresAt,
      },
      now,
    ),
  })
}

/** Binds reset issuance to the exact member selected by an owner-rendered settings page. */
export function issueMemberResetIssuanceFormEnvelope(
  envelope: AuthenticatedActionEnvelope,
  targetUserId: string,
  now = new Date(),
): MemberResetIssuanceFormEnvelope | null {
  const state = ownerActionEnvelopeState(envelope)
  if (!authenticatedFormSessionIsCurrent(state, now)) return null
  if (targetUserId === state.actorUserId) {
    throw new TypeError('Member reset issuance cannot target the instance owner.')
  }
  return Object.freeze({
    targetUserId,
    actionBinding: issueMemberResetIssueActionBinding(
      {
        expectedEpoch: state.expectedEpoch,
        sessionId: state.sessionId,
        actorUserId: state.actorUserId,
        targetUserId,
        sessionExpiresAt: state.sessionExpiresAt,
      },
      now,
    ),
  })
}

function destructivePlanInput(plan: DestructivePlanFormInput): DestructivePlanFormInput {
  if (
    typeof plan.id !== 'string' ||
    plan.id.length === 0 ||
    plan.id.length > 512 ||
    plan.id.includes('\0') ||
    typeof plan.digest !== 'string' ||
    plan.digest.length === 0 ||
    plan.digest.length > 512 ||
    plan.digest.includes('\0') ||
    !(plan.expiresAt instanceof Date) ||
    !Number.isFinite(plan.expiresAt.getTime())
  ) {
    throw new TypeError('A valid destructive-action preview is required.')
  }
  return Object.freeze({
    id: plan.id,
    digest: plan.digest,
    expiresAt: new Date(plan.expiresAt.getTime()),
  })
}

/** Binds a subject-deletion form to the exact authenticated actor and preview. */
export function issueTraineeDataDeletionFormEnvelope(
  envelope: AuthenticatedActionEnvelope,
  plan: DestructivePlanFormInput,
  now = new Date(),
): TraineeDataDeletionFormEnvelope | null {
  const state = authenticatedActionEnvelopes.get(envelope)
  if (!state) {
    throw new TypeError('Authenticated action envelope was not issued by Identity.')
  }
  const preview = destructivePlanInput(plan)
  if (
    !authenticatedFormSessionIsCurrent(state, now) ||
    Math.floor(preview.expiresAt.getTime() / 1_000) <= Math.floor(now.getTime() / 1_000)
  ) {
    return null
  }
  return Object.freeze({
    planId: preview.id,
    planDigest: preview.digest,
    actionBinding: issueTraineeDataDeletionActionBinding(
      {
        expectedEpoch: state.expectedEpoch,
        sessionId: state.sessionId,
        actorUserId: state.actorUserId,
        planId: preview.id,
        planDigest: preview.digest,
        sessionExpiresAt: state.sessionExpiresAt,
        planExpiresAt: preview.expiresAt,
      },
      now,
    ),
  })
}

/** Binds an owner-only instance-reset form to the exact preview. */
export function issueInstanceResetFormEnvelope(
  envelope: AuthenticatedActionEnvelope,
  plan: DestructivePlanFormInput,
  now = new Date(),
): InstanceResetFormEnvelope | null {
  const state = ownerActionEnvelopeState(envelope)
  const preview = destructivePlanInput(plan)
  if (
    !authenticatedFormSessionIsCurrent(state, now) ||
    Math.floor(preview.expiresAt.getTime() / 1_000) <= Math.floor(now.getTime() / 1_000)
  ) {
    return null
  }
  return Object.freeze({
    planId: preview.id,
    planDigest: preview.digest,
    actionBinding: issueInstanceResetActionBinding(
      {
        expectedEpoch: state.expectedEpoch,
        sessionId: state.sessionId,
        actorUserId: state.actorUserId,
        planId: preview.id,
        planDigest: preview.digest,
        sessionExpiresAt: state.sessionExpiresAt,
        planExpiresAt: preview.expiresAt,
      },
      now,
    ),
  })
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

  const role = deriveIdentityRole(
    context.authSession.user.id,
    context.installation.ownerUserId,
  )
  const actor = {
    userId: context.authSession.user.id,
    email: context.authSession.user.email,
    name: context.authSession.user.name,
    role,
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
  Object.defineProperty(actor, 'authenticatedActionEnvelope', {
    configurable: false,
    enumerable: false,
    value: createAuthenticatedActionEnvelope({
      expectedEpoch: context.installation.productMutationEpoch,
      sessionId: context.authSession.session.id,
      actorUserId: context.authSession.user.id,
      role,
      sessionExpiresAt: context.authSession.session.expiresAt,
    }),
    writable: false,
  })
  return actor as ServerAuthenticatedActor
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
