/** Database-free operator contract shared by legacy tests and the cut-over host command. */
export class OwnerRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OwnerRecoveryError'
  }
}

export type IssuedOwnerRecovery = Readonly<{
  recoveryId: string
  code: string
  expiresAt: Date
}>

export type RedeemedOwnerRecovery = Readonly<{
  ownerUserId: string
  revokedSessionCount: number
}>
