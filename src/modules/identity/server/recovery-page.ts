import type {
  MemberResetRedemptionActionBinding,
  OwnerRecoveryRedemptionActionBinding,
} from '../application/action-binding'
import {
  issueMemberResetRedemptionActionBinding,
  issueOwnerRecoveryRedemptionActionBinding,
} from '../infrastructure/action-binding'
import { getServerRecoveryPageInstallationState } from '../infrastructure/installation'

export type MemberResetPageInstallation =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'closed'
      readonly actionBinding: MemberResetRedemptionActionBinding
    }

export type OwnerRecoveryPageInstallation =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'closed'
      readonly actionBinding: OwnerRecoveryRedemptionActionBinding
    }

/** Returns no raw installation lifecycle value to the public member-reset page. */
export async function getMemberResetPageInstallation(): Promise<MemberResetPageInstallation> {
  const installation = await getServerRecoveryPageInstallationState()
  if (installation.kind === 'open') return installation
  return {
    kind: 'closed',
    actionBinding: issueMemberResetRedemptionActionBinding({
      expectedEpoch: installation.productMutationEpoch,
    }),
  }
}

/** Returns no raw installation lifecycle value to the public owner-recovery page. */
export async function getOwnerRecoveryPageInstallation(): Promise<OwnerRecoveryPageInstallation> {
  const installation = await getServerRecoveryPageInstallationState()
  if (installation.kind === 'open') return installation
  return {
    kind: 'closed',
    actionBinding: issueOwnerRecoveryRedemptionActionBinding({
      expectedEpoch: installation.productMutationEpoch,
    }),
  }
}
