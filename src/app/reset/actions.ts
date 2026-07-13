'use server'

import { redirect } from 'next/navigation'
import { redeemMemberReset } from '@/modules/identity/recovery/member-reset'
import { isCredentialLifecycleRejection } from '@/modules/identity/server/credential-lifecycle'
import { getWebCredentialContext } from '@/modules/identity/server/web-credential-context'

export type ResetCredentialActionState = {
  readonly kind: 'idle' | 'rejected'
  readonly email: string
  readonly message: string | null
}

export async function resetMemberCredentialAction(
  _previous: ResetCredentialActionState,
  formData: FormData,
): Promise<ResetCredentialActionState> {
  const email = String(formData.get('email') ?? '')
  const code = String(formData.get('code') ?? '')
  const newPassword = String(formData.get('newPassword') ?? '')
  const confirmation = String(formData.get('confirmPassword') ?? '')
  const requestContext = await getWebCredentialContext()
  if (!requestContext) {
    return { kind: 'rejected', email, message: 'Authentication request denied.' }
  }

  let result: Awaited<ReturnType<typeof redeemMemberReset>>
  try {
    result = await redeemMemberReset({
      email,
      code,
      newPassword: newPassword === confirmation ? newPassword : '',
      requestContext,
    })
  } catch (error) {
    if (isCredentialLifecycleRejection(error)) {
      return {
        kind: 'rejected',
        email,
        message: 'The email, code, or password was not accepted.',
      }
    }
    throw error
  }
  if (result.kind === 'redeemed') redirect('/sign-in?reset=1')
  return { kind: 'rejected', email, message: result.message }
}
