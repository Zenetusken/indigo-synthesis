import { headers } from 'next/headers'
import { getServerConfig } from '@/platform/config/server'
import { verifyIdentitySessionCookie } from '../infrastructure/auth'
import { resolveWebClientAddress } from '../infrastructure/client-address'
import type { WebCredentialContext } from '../recovery/credential-context'

type AuthenticatedCommandState = Readonly<{
  commandEnteredAt: Date
  requestContext: WebCredentialContext
  verifiedSessionToken: string
}>

type LocalUserCreationCommandState = AuthenticatedCommandState &
  Readonly<{
    actionBinding: string
    targetUserId: string
    name: string
    email: string
    initialPassword: string
    currentPassword: string
  }>

type MemberResetIssuanceCommandState = AuthenticatedCommandState &
  Readonly<{
    actionBinding: string
    targetUserId: string
    currentPassword: string
  }>

const localUserCreationCommands = new WeakMap<
  LocalUserCreationMutationCommand,
  LocalUserCreationCommandState
>()
const memberResetIssuanceCommands = new WeakMap<
  MemberResetIssuanceMutationCommand,
  MemberResetIssuanceCommandState
>()

/** Nominal, non-serializable local-user command derived from one server-action request. */
export abstract class LocalUserCreationMutationCommand {
  protected declare readonly localUserCreationMutationCommandNominal: never
}

/** Nominal, non-serializable reset-issuance command derived from one server-action request. */
export abstract class MemberResetIssuanceMutationCommand {
  protected declare readonly memberResetIssuanceMutationCommandNominal: never
}

class ConcreteLocalUserCreationMutationCommand extends LocalUserCreationMutationCommand {}
class ConcreteMemberResetIssuanceMutationCommand extends MemberResetIssuanceMutationCommand {}

export type LocalUserCreationMutationCommandView = LocalUserCreationCommandState
export type MemberResetIssuanceMutationCommandView = MemberResetIssuanceCommandState

export type CredentialAdministrationCommandCapture<Command> =
  | Readonly<{ kind: 'captured'; command: Command }>
  | Readonly<{ kind: 'rejected' }>

function formString(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

function stableCommandEntry(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Credential-administration command-entry clock is invalid.')
  }
  return new Date(value.getTime())
}

function sessionVerificationRequest(requestHeaders: Headers): Request {
  const headers = new Headers(requestHeaders)
  headers.delete('content-length')
  headers.delete('content-type')
  return new Request(
    `${getServerConfig().appOrigin}/api/auth/indigo/verify-session-cookie`,
    { method: 'POST', headers },
  )
}

async function captureAuthenticatedCommandState(
  commandEnteredAt: Date,
): Promise<AuthenticatedCommandState | null> {
  // Copy the one incoming header snapshot. Cookie verification, origin checking, and client-
  // address resolution must never observe different mutable request states.
  const requestHeaders = new Headers(await headers())
  const config = getServerConfig()
  const clientAddress = resolveWebClientAddress(requestHeaders, {
    allowDirectLoopback: !config.secureCookies,
  })
  if (!clientAddress) return null

  const verification = await verifyIdentitySessionCookie(
    sessionVerificationRequest(requestHeaders),
  )
  if (verification.kind !== 'verified') return null

  return Object.freeze({
    commandEnteredAt,
    requestContext: Object.freeze({ channel: 'web', clientAddress }),
    verifiedSessionToken: verification.sessionToken,
  })
}

/**
 * Snapshots every browser-owned local-user field before the first await, then adds only a
 * cryptographically verified server-side session token and the trusted ingress context.
 */
export async function captureLocalUserCreationMutationCommand(input: {
  readonly formData: FormData
  readonly commandEnteredAt: Date
}): Promise<CredentialAdministrationCommandCapture<LocalUserCreationMutationCommand>> {
  const commandEnteredAt = stableCommandEntry(input.commandEnteredAt)
  const submitted = Object.freeze({
    actionBinding: formString(input.formData, 'actionBinding'),
    targetUserId: formString(input.formData, 'targetUserId'),
    name: formString(input.formData, 'name'),
    email: formString(input.formData, 'email'),
    initialPassword: formString(input.formData, 'initialPassword'),
    currentPassword: formString(input.formData, 'currentPassword'),
  })
  const authenticated = await captureAuthenticatedCommandState(commandEnteredAt)
  if (!authenticated) return Object.freeze({ kind: 'rejected' })

  const command = new ConcreteLocalUserCreationMutationCommand()
  localUserCreationCommands.set(
    command,
    Object.freeze({ ...authenticated, ...submitted }),
  )
  Object.freeze(command)
  return Object.freeze({ kind: 'captured', command })
}

/** Snapshots one exact target-bound reset command before authenticating the server request. */
export async function captureMemberResetIssuanceMutationCommand(input: {
  readonly formData: FormData
  readonly commandEnteredAt: Date
}): Promise<CredentialAdministrationCommandCapture<MemberResetIssuanceMutationCommand>> {
  const commandEnteredAt = stableCommandEntry(input.commandEnteredAt)
  const submitted = Object.freeze({
    actionBinding: formString(input.formData, 'actionBinding'),
    targetUserId: formString(input.formData, 'targetUserId'),
    currentPassword: formString(input.formData, 'currentPassword'),
  })
  const authenticated = await captureAuthenticatedCommandState(commandEnteredAt)
  if (!authenticated) return Object.freeze({ kind: 'rejected' })

  const command = new ConcreteMemberResetIssuanceMutationCommand()
  memberResetIssuanceCommands.set(
    command,
    Object.freeze({ ...authenticated, ...submitted }),
  )
  Object.freeze(command)
  return Object.freeze({ kind: 'captured', command })
}

export function localUserCreationMutationCommandView(
  command: LocalUserCreationMutationCommand,
): LocalUserCreationMutationCommandView {
  const state = localUserCreationCommands.get(command)
  if (!state) throw new TypeError('Local-user command was not issued by Identity.')
  return Object.freeze({
    ...state,
    commandEnteredAt: new Date(state.commandEnteredAt.getTime()),
    requestContext: Object.freeze({ ...state.requestContext }),
  })
}

export function memberResetIssuanceMutationCommandView(
  command: MemberResetIssuanceMutationCommand,
): MemberResetIssuanceMutationCommandView {
  const state = memberResetIssuanceCommands.get(command)
  if (!state) throw new TypeError('Member-reset command was not issued by Identity.')
  return Object.freeze({
    ...state,
    commandEnteredAt: new Date(state.commandEnteredAt.getTime()),
    requestContext: Object.freeze({ ...state.requestContext }),
  })
}

export type LocalUserCreationMutationResult =
  | Readonly<{ kind: 'created'; email: string }>
  | Readonly<{ kind: 'input-rejected'; issues: readonly string[] }>
  | Readonly<{ kind: 'email-conflict' }>
  | Readonly<{ kind: 'reauthentication-failed' | 'reauthentication-locked' }>
  | Readonly<{ kind: 'stale' | 'rejected' | 'unavailable' }>

export type MemberResetIssuanceMutationResult =
  | Readonly<{
      kind: 'issued'
      targetUserId: string
      code: string
      expiresAt: Date
    }>
  | Readonly<{
      kind:
        | 'cooldown'
        | 'target-invalid'
        | 'reauthentication-failed'
        | 'reauthentication-locked'
        | 'stale'
        | 'rejected'
        | 'unavailable'
    }>

/** Coarse server boundary for the two owner-administered credential mutations. */
export interface IdentityCredentialAdministrationMutationPort {
  createLocalUser(
    command: LocalUserCreationMutationCommand,
  ): Promise<LocalUserCreationMutationResult>
  issueMemberReset(
    command: MemberResetIssuanceMutationCommand,
  ): Promise<MemberResetIssuanceMutationResult>
}
