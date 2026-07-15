export type CoordinationErrorCode =
  | 'content-lock-plan.invalid'
  | 'content-lock-plan.stale'
  | 'content-lock-plan.too-large'
  | 'uow.begin-failed'
  | 'uow.cancelled'
  | 'uow.capacity'
  | 'uow.cleanup-failed'
  | 'uow.commit-outcome-unknown'
  | 'uow.connection-lost'
  | 'uow.detached-work'
  | 'uow.lock-timeout'
  | 'uow.nested'
  | 'uow.prelocked-session-invalid'
  | 'uow.scope-revoked'

const coordinationErrorMessages: Readonly<Record<CoordinationErrorCode, string>> = {
  'content-lock-plan.invalid': 'The content lock plan is invalid.',
  'content-lock-plan.stale': 'The content used by this request is no longer current.',
  'content-lock-plan.too-large': 'This change is too broad for self-service.',
  'uow.begin-failed': 'The operation could not start its transaction.',
  'uow.cancelled': 'The operation was cancelled.',
  'uow.capacity': 'The operation is temporarily unavailable at current capacity.',
  'uow.cleanup-failed': 'The operation could not safely release its database session.',
  'uow.commit-outcome-unknown': 'The transaction outcome could not be determined.',
  'uow.connection-lost': 'The database session was lost.',
  'uow.detached-work': 'All coordinated work must settle inside the operation callback.',
  'uow.lock-timeout': 'The operation could not acquire its workflow lock in time.',
  'uow.nested': 'A coordinated operation cannot start inside another operation.',
  'uow.prelocked-session-invalid': 'The credential-locked session is no longer valid.',
  'uow.scope-revoked': 'The coordinated operation scope is no longer active.',
}

/**
 * Stable application-level failure from the coordination boundary. Platform adapters may
 * attach a private cause, but callers branch only on this closed code set.
 */
export class CoordinationError extends Error {
  readonly retryable: boolean
  readonly disposition: 'no-self-service' | null

  constructor(readonly code: CoordinationErrorCode) {
    super(coordinationErrorMessages[code])
    this.name = 'CoordinationError'
    this.retryable = code === 'uow.capacity' || code === 'uow.lock-timeout'
    this.disposition = code === 'content-lock-plan.too-large' ? 'no-self-service' : null
  }
}
