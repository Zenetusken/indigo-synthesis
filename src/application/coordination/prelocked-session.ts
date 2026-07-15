export type SubmittedEmailPrelockedOperation =
  | 'email-sign-in'
  | 'member-reset-redemption'
  | 'owner-recovery-web-redemption'

export type TrustedPrelockedOperation =
  | 'bootstrap-issuance'
  | 'bootstrap-redemption'
  | 'checked-sign-out'
  | 'expired-session-maintenance'
  | 'instance-reset'
  | 'local-user-create'
  | 'member-reset-issue'
  | 'owner-recovery-cli-redemption'
  | 'owner-recovery-issue'
  | 'subject-deletion'

export type PrelockedSessionOperation =
  | SubmittedEmailPrelockedOperation
  | TrustedPrelockedOperation

/**
 * Platform-sealed capture result. Its private concrete state fixes operation, queue lane, exact
 * instance/email/account locks, account-exclusive mode, lifecycle bindings, and cancellation.
 * Workflows cannot select a trusted tag or construct lock identities.
 */
export abstract class PrelockedSessionIntent<
  Operation extends PrelockedSessionOperation,
> {
  protected declare readonly prelockedSessionIntentNominal: Operation

  protected constructor() {}
}

/**
 * One lexical, already credential-locked session. The operation parameter prevents a lease from
 * one credential path from satisfying another path's UoW request.
 */
export abstract class PrelockedSessionLease<Operation extends PrelockedSessionOperation> {
  protected declare readonly prelockedSessionLeaseNominal: Operation

  protected constructor() {}
}

export type PrelockedSessionOptions = {
  readonly signal?: AbortSignal
}

export interface PrelockedSessionPort {
  withPrelockedSessionLease<Operation extends PrelockedSessionOperation, Result>(
    intent: PrelockedSessionIntent<Operation>,
    callback: (lease: PrelockedSessionLease<Operation>) => Promise<Result>,
    options?: PrelockedSessionOptions,
  ): Promise<Result>

  activeLeaseScopeCount(): number
}
