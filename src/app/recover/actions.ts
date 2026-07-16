'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getProductionIdentityRecoveryMutationPort } from '@/composition/identity-recovery-mutations'
import { publicRecoveryFailure } from '@/modules/identity/recovery/recovery-policy'
import { captureOwnerRecoveryRedemptionMutationCommand } from '@/modules/identity/server/recovery-redemption-command'

const authenticationDenied = 'Authentication request denied.'

export type RecoverOwnerActionState = {
  readonly kind: 'idle' | 'rejected'
  readonly email: string
  readonly message: string | null
  readonly stale: boolean
}

function formString(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

function rejectedState(
  email: string,
  stale: boolean,
  message: string = publicRecoveryFailure.message,
): RecoverOwnerActionState {
  if (stale) revalidatePath('/recover')
  return {
    kind: 'rejected',
    email,
    message,
    stale,
  }
}

export async function recoverOwnerAction(
  _previous: RecoverOwnerActionState,
  formData: FormData,
): Promise<RecoverOwnerActionState> {
  const commandEnteredAt = new Date()
  const email = formString(formData, 'email')
  const captured = await captureOwnerRecoveryRedemptionMutationCommand({
    formData,
    commandEnteredAt,
  })
  if (captured.kind === 'rejected') {
    return rejectedState(
      email,
      false,
      captured.reason === 'ingress'
        ? authenticationDenied
        : publicRecoveryFailure.message,
    )
  }

  const result = await getProductionIdentityRecoveryMutationPort().redeemOwnerRecovery(
    captured.command,
  )
  if (result.kind === 'redeemed') return redirect('/sign-in?recovered=1')
  return rejectedState(email, result.kind === 'stale')
}
