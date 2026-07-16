import type { EmailSignInActionBinding } from '../application/action-binding'
import { issueEmailSignInActionBinding } from '../infrastructure/action-binding'
import { getServerSignInInstallationState } from '../infrastructure/installation'

export type SignInPageInstallation =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'closed'
      readonly actionBinding: EmailSignInActionBinding
    }

/** Returns no raw lifecycle value to the page or browser. */
export async function getSignInPageInstallation(): Promise<SignInPageInstallation> {
  const installation = await getServerSignInInstallationState()
  if (installation.kind === 'open') return installation
  return {
    kind: 'closed',
    actionBinding: issueEmailSignInActionBinding({
      expectedEpoch: installation.productMutationEpoch,
    }),
  }
}
