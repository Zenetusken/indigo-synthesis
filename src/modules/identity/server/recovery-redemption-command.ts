import { headers } from 'next/headers'
import { getServerConfig } from '@/platform/config/server'
import { resolveWebClientAddress } from '../infrastructure/client-address'
import { admitCredentialLoadShedder } from '../infrastructure/credential-load-shedder'
import type { WebRecoveryPurpose } from '../infrastructure/web-recovery-rate-limit'
import type { WebCredentialContext } from '../recovery/credential-context'
import type { publicRecoveryFailure } from '../recovery/recovery-policy'

type RecoveryRedemptionCommandState = Readonly<{
  actionBinding: string
  email: string
  code: string
  newPassword: string
  confirmation: string
  commandEnteredAt: Date
  requestContext: WebCredentialContext
}>

const memberResetRedemptionCommands = new WeakMap<
  MemberResetRedemptionMutationCommand,
  RecoveryRedemptionCommandState
>()
const ownerRecoveryRedemptionCommands = new WeakMap<
  OwnerRecoveryRedemptionMutationCommand,
  RecoveryRedemptionCommandState
>()

/** Nominal, non-serializable public member-reset command from one server-action request. */
export abstract class MemberResetRedemptionMutationCommand {
  protected declare readonly memberResetRedemptionMutationCommandNominal: never
}

/** Nominal, non-serializable public owner-recovery command from one server-action request. */
export abstract class OwnerRecoveryRedemptionMutationCommand {
  protected declare readonly ownerRecoveryRedemptionMutationCommandNominal: never
}

class ConcreteMemberResetRedemptionMutationCommand extends MemberResetRedemptionMutationCommand {}
class ConcreteOwnerRecoveryRedemptionMutationCommand extends OwnerRecoveryRedemptionMutationCommand {}

export type MemberResetRedemptionMutationCommandView = RecoveryRedemptionCommandState
export type OwnerRecoveryRedemptionMutationCommandView = RecoveryRedemptionCommandState

export type RecoveryRedemptionCommandCapture<Command> =
  | Readonly<{ kind: 'captured'; command: Command }>
  | Readonly<{ kind: 'rejected'; reason: 'ingress' | 'load-shed' }>

function formString(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

function stableCommandEntry(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Recovery command-entry clock is invalid.')
  }
  return new Date(value.getTime())
}

function isExpectedOrigin(requestHeaders: Headers, appOrigin: string): boolean {
  const suppliedOrigin = requestHeaders.get('origin')
  if (!suppliedOrigin) return false
  try {
    return new URL(suppliedOrigin).origin === new URL(appOrigin).origin
  } catch {
    return false
  }
}

async function captureTrustedRecoveryContext(input: {
  readonly purpose: WebRecoveryPurpose
  readonly email: string
  readonly commandEnteredAt: Date
}): Promise<
  | Readonly<{ kind: 'captured'; context: WebCredentialContext }>
  | Readonly<{ kind: 'rejected'; reason: 'ingress' | 'load-shed' }>
> {
  // Both origin and address are derived from this one immutable copy of the incoming state.
  const requestHeaders = new Headers(await headers())
  const config = getServerConfig()
  if (!isExpectedOrigin(requestHeaders, config.appOrigin)) {
    return Object.freeze({ kind: 'rejected', reason: 'ingress' })
  }

  const clientAddress = resolveWebClientAddress(requestHeaders, {
    allowDirectLoopback: !config.secureCookies,
  })
  if (!clientAddress) {
    return Object.freeze({ kind: 'rejected', reason: 'ingress' })
  }
  if (
    !admitCredentialLoadShedder({
      purpose: input.purpose,
      email: input.email,
      clientAddress,
      now: input.commandEnteredAt,
    }).admitted
  ) {
    return Object.freeze({ kind: 'rejected', reason: 'load-shed' })
  }
  return Object.freeze({
    kind: 'captured',
    context: Object.freeze({ channel: 'web', clientAddress }),
  })
}

function snapshotRecoveryForm(formData: FormData) {
  return Object.freeze({
    actionBinding: formString(formData, 'actionBinding'),
    email: formString(formData, 'email'),
    code: formString(formData, 'code'),
    newPassword: formString(formData, 'newPassword'),
    confirmation: formString(formData, 'confirmPassword'),
  })
}

function commandView(
  state: RecoveryRedemptionCommandState | undefined,
): RecoveryRedemptionCommandState {
  if (!state) throw new TypeError('Recovery command was not issued by Identity.')
  return Object.freeze({
    ...state,
    commandEnteredAt: new Date(state.commandEnteredAt.getTime()),
    requestContext: Object.freeze({ ...state.requestContext }),
  })
}

/** Snapshots every browser-owned field before the first request-context await. */
export async function captureMemberResetRedemptionMutationCommand(input: {
  readonly formData: FormData
  readonly commandEnteredAt: Date
}): Promise<RecoveryRedemptionCommandCapture<MemberResetRedemptionMutationCommand>> {
  const commandEnteredAt = stableCommandEntry(input.commandEnteredAt)
  const submitted = snapshotRecoveryForm(input.formData)
  const context = await captureTrustedRecoveryContext({
    purpose: 'member-reset',
    email: submitted.email,
    commandEnteredAt,
  })
  if (context.kind === 'rejected') return context

  const command = new ConcreteMemberResetRedemptionMutationCommand()
  memberResetRedemptionCommands.set(
    command,
    Object.freeze({
      ...submitted,
      commandEnteredAt,
      requestContext: context.context,
    }),
  )
  Object.freeze(command)
  return Object.freeze({ kind: 'captured', command })
}

/** Snapshots every browser-owned field before the first request-context await. */
export async function captureOwnerRecoveryRedemptionMutationCommand(input: {
  readonly formData: FormData
  readonly commandEnteredAt: Date
}): Promise<RecoveryRedemptionCommandCapture<OwnerRecoveryRedemptionMutationCommand>> {
  const commandEnteredAt = stableCommandEntry(input.commandEnteredAt)
  const submitted = snapshotRecoveryForm(input.formData)
  const context = await captureTrustedRecoveryContext({
    purpose: 'owner-recovery',
    email: submitted.email,
    commandEnteredAt,
  })
  if (context.kind === 'rejected') return context

  const command = new ConcreteOwnerRecoveryRedemptionMutationCommand()
  ownerRecoveryRedemptionCommands.set(
    command,
    Object.freeze({
      ...submitted,
      commandEnteredAt,
      requestContext: context.context,
    }),
  )
  Object.freeze(command)
  return Object.freeze({ kind: 'captured', command })
}

export function memberResetRedemptionMutationCommandView(
  command: MemberResetRedemptionMutationCommand,
): MemberResetRedemptionMutationCommandView {
  return commandView(memberResetRedemptionCommands.get(command))
}

export function ownerRecoveryRedemptionMutationCommandView(
  command: OwnerRecoveryRedemptionMutationCommand,
): OwnerRecoveryRedemptionMutationCommandView {
  return commandView(ownerRecoveryRedemptionCommands.get(command))
}

export type MemberResetRedemptionMutationResult =
  | Readonly<{
      kind: 'redeemed'
      targetUserId: string
      revokedSessionCount: number
    }>
  | Readonly<{ kind: 'stale' }>
  | typeof publicRecoveryFailure

export type OwnerRecoveryRedemptionMutationResult =
  | Readonly<{
      kind: 'redeemed'
      ownerUserId: string
      revokedSessionCount: number
    }>
  | Readonly<{ kind: 'stale' }>
  | typeof publicRecoveryFailure

/** Coarse server boundary for the two public browser credential-recovery mutations. */
export interface IdentityRecoveryMutationPort {
  redeemMemberReset(
    command: MemberResetRedemptionMutationCommand,
  ): Promise<MemberResetRedemptionMutationResult>
  redeemOwnerRecovery(
    command: OwnerRecoveryRedemptionMutationCommand,
  ): Promise<OwnerRecoveryRedemptionMutationResult>
}
