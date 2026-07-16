import { headers } from 'next/headers'
import { getServerConfig } from '@/platform/config/server'
import { verifyIdentitySessionCookie } from '../infrastructure/auth'
import { resolveWebClientAddress } from '../infrastructure/client-address'
import {
  type DestructiveMutationCommandView,
  type InstanceResetMutationCommand,
  instanceResetMutationCommandView,
  issueInstanceResetMutationCommand,
  issueTraineeDataDeletionMutationCommand,
  type TraineeDataDeletionMutationCommand,
  traineeDataDeletionMutationCommandView,
} from '../infrastructure/destructive-mutation'
import type { WebCredentialContext } from '../recovery/credential-context'

export type {
  DestructiveMutationCommandView,
  InstanceResetMutationCommand,
  TraineeDataDeletionMutationCommand,
}

export type DestructiveMutationCommandCapture<Command> =
  | Readonly<{ kind: 'captured'; command: Command }>
  | Readonly<{ kind: 'rejected' }>

type SubmittedDestructiveCommand = Readonly<{
  actionBinding: string
  planId: string
  planDigest: string
  currentPassword: string
  typedConfirmation: string
  acknowledged: boolean
}>

function formString(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

function stableCommandEntry(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Destructive command-entry clock is invalid.')
  }
  return new Date(value.getTime())
}

function snapshotForm(formData: FormData): SubmittedDestructiveCommand {
  return Object.freeze({
    actionBinding: formString(formData, 'actionBinding'),
    planId: formString(formData, 'planId'),
    planDigest: formString(formData, 'planDigest'),
    currentPassword: formString(formData, 'password'),
    typedConfirmation: formString(formData, 'typedConfirmation'),
    acknowledged: formData.get('acknowledged') === 'on',
  })
}

function sessionVerificationRequest(requestHeaders: Headers): Request {
  const requestHeadersCopy = new Headers(requestHeaders)
  requestHeadersCopy.delete('content-length')
  requestHeadersCopy.delete('content-type')
  return new Request(
    `${getServerConfig().appOrigin}/api/auth/indigo/verify-session-cookie`,
    { method: 'POST', headers: requestHeadersCopy },
  )
}

async function captureVerifiedRequest(): Promise<Readonly<{
  verifiedSessionToken: string
  requestContext: WebCredentialContext
}> | null> {
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
    verifiedSessionToken: verification.sessionToken,
    requestContext: Object.freeze({ channel: 'web', clientAddress }),
  })
}

/** Snapshots every browser-owned subject-deletion field before the first await. */
export async function captureTraineeDataDeletionMutationCommand(input: {
  readonly formData: FormData
  readonly commandEnteredAt: Date
}): Promise<DestructiveMutationCommandCapture<TraineeDataDeletionMutationCommand>> {
  const commandEnteredAt = stableCommandEntry(input.commandEnteredAt)
  const submitted = snapshotForm(input.formData)
  const verified = await captureVerifiedRequest()
  if (!verified) return Object.freeze({ kind: 'rejected' })
  return Object.freeze({
    kind: 'captured',
    command: issueTraineeDataDeletionMutationCommand({
      ...submitted,
      ...verified,
      commandEnteredAt,
    }),
  })
}

/** Snapshots every browser-owned reset field before the first await. */
export async function captureInstanceResetMutationCommand(input: {
  readonly formData: FormData
  readonly commandEnteredAt: Date
}): Promise<DestructiveMutationCommandCapture<InstanceResetMutationCommand>> {
  const commandEnteredAt = stableCommandEntry(input.commandEnteredAt)
  const submitted = snapshotForm(input.formData)
  const verified = await captureVerifiedRequest()
  if (!verified) return Object.freeze({ kind: 'rejected' })
  return Object.freeze({
    kind: 'captured',
    command: issueInstanceResetMutationCommand({
      ...submitted,
      ...verified,
      commandEnteredAt,
    }),
  })
}

export function traineeDataDeletionCommandView(
  command: TraineeDataDeletionMutationCommand,
): DestructiveMutationCommandView & Readonly<{ purpose: 'trainee-data-deletion' }> {
  return traineeDataDeletionMutationCommandView(command)
}

export function instanceResetCommandView(
  command: InstanceResetMutationCommand,
): DestructiveMutationCommandView & Readonly<{ purpose: 'instance-reset' }> {
  return instanceResetMutationCommandView(command)
}
