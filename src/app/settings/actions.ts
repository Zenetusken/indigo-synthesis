'use server'

import { revalidatePath } from 'next/cache'
import { getProductionIdentityCredentialAdministrationMutationPort } from '@/composition/identity-credential-administration'
import {
  captureLocalUserCreationMutationCommand,
  captureMemberResetIssuanceMutationCommand,
  type LocalUserCreationMutationResult,
  type MemberResetIssuanceMutationResult,
} from '@/modules/identity/server/credential-administration-command'

const authenticationDenied = 'Authentication request denied.'
const staleFormMessage =
  'This settings form is out of date. Current account details were reloaded; review them and submit again.'
const credentialServiceUnavailable =
  'Credential administration is temporarily unavailable. Try again.'

export type LocalUserActionState = {
  readonly errors: readonly string[]
  readonly createdEmail: string | null
  readonly stale: boolean
}

export type MemberResetIssueActionState = {
  readonly errors: readonly string[]
  readonly issued: {
    readonly targetUserId: string
    readonly code: string
    readonly expiresAt: string
  } | null
  readonly stale: boolean
}

function staleLocalUserState(): LocalUserActionState {
  revalidatePath('/settings')
  return { errors: [staleFormMessage], createdEmail: null, stale: true }
}

function staleMemberResetState(): MemberResetIssueActionState {
  revalidatePath('/settings')
  return { errors: [staleFormMessage], issued: null, stale: true }
}

function localUserResultState(
  result: LocalUserCreationMutationResult,
): LocalUserActionState {
  switch (result.kind) {
    case 'created':
      revalidatePath('/settings')
      return { errors: [], createdEmail: result.email, stale: false }
    case 'input-rejected':
      return { errors: result.issues, createdEmail: null, stale: false }
    case 'email-conflict':
      return {
        errors: ['A local user with that email already exists.'],
        createdEmail: null,
        stale: false,
      }
    case 'reauthentication-failed':
      return {
        errors: ['The owner password was not accepted.'],
        createdEmail: null,
        stale: false,
      }
    case 'reauthentication-locked':
      return {
        errors: ['Too many owner-password attempts. Try again later.'],
        createdEmail: null,
        stale: false,
      }
    case 'stale':
    case 'rejected':
      return staleLocalUserState()
    case 'unavailable':
      return {
        errors: [credentialServiceUnavailable],
        createdEmail: null,
        stale: false,
      }
  }
}

function memberResetResultState(
  result: MemberResetIssuanceMutationResult,
): MemberResetIssueActionState {
  switch (result.kind) {
    case 'issued':
      return {
        errors: [],
        issued: {
          targetUserId: result.targetUserId,
          code: result.code,
          expiresAt: result.expiresAt.toISOString(),
        },
        stale: false,
      }
    case 'cooldown':
      return {
        errors: ['Wait 30 seconds before issuing another reset code for this account.'],
        issued: null,
        stale: false,
      }
    case 'reauthentication-failed':
      return {
        errors: ['The owner password was not accepted.'],
        issued: null,
        stale: false,
      }
    case 'reauthentication-locked':
      return {
        errors: ['Too many owner-password attempts. Try again later.'],
        issued: null,
        stale: false,
      }
    case 'target-invalid':
    case 'stale':
    case 'rejected':
      return staleMemberResetState()
    case 'unavailable':
      return {
        errors: [credentialServiceUnavailable],
        issued: null,
        stale: false,
      }
  }
}

export async function createLocalUserAction(
  _previous: LocalUserActionState,
  formData: FormData,
): Promise<LocalUserActionState> {
  const commandEnteredAt = new Date()
  const captured = await captureLocalUserCreationMutationCommand({
    formData,
    commandEnteredAt,
  })
  if (captured.kind === 'rejected') {
    return { errors: [authenticationDenied], createdEmail: null, stale: false }
  }

  const result =
    await getProductionIdentityCredentialAdministrationMutationPort().createLocalUser(
      captured.command,
    )
  return localUserResultState(result)
}

export async function issueMemberResetAction(
  _previous: MemberResetIssueActionState,
  formData: FormData,
): Promise<MemberResetIssueActionState> {
  const commandEnteredAt = new Date()
  const captured = await captureMemberResetIssuanceMutationCommand({
    formData,
    commandEnteredAt,
  })
  if (captured.kind === 'rejected') {
    return { errors: [authenticationDenied], issued: null, stale: false }
  }

  const result =
    await getProductionIdentityCredentialAdministrationMutationPort().issueMemberReset(
      captured.command,
    )
  return memberResetResultState(result)
}
