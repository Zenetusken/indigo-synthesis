declare const checkedSignOutActionBindingBrand: unique symbol
declare const emailSignInActionBindingBrand: unique symbol

/**
 * Browser-safe proof that a checked sign-out was issued for one server-observed
 * installation/session/actor tuple. The encoded value never contains those raw identifiers.
 */
export type CheckedSignOutActionBinding = string & {
  readonly [checkedSignOutActionBindingBrand]: 'checked-sign-out-action-binding'
}

/**
 * Browser-safe proof that an email sign-in was issued for one server-observed
 * installation generation. The encoded value never contains the raw generation.
 */
export type EmailSignInActionBinding = string & {
  readonly [emailSignInActionBindingBrand]: 'email-sign-in-action-binding'
}

export const checkedSignOutActionBindingPurpose = 'checked-sign-out' as const
export const emailSignInActionBindingPurpose = 'email-sign-in' as const
export const identityActionBindingHeader = 'x-indigo-action-binding' as const
export const checkedSignOutActionBindingHeader = identityActionBindingHeader
