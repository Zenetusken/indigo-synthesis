import {
  CredentialLifecycleCapacityError,
  CredentialLifecycleUnavailableError,
} from '../infrastructure/credential-lifecycle-lock'

/** Classifies expected fail-closed lifecycle admission errors at the app boundary. */
export function isCredentialLifecycleRejection(error: unknown): boolean {
  return (
    error instanceof CredentialLifecycleCapacityError ||
    error instanceof CredentialLifecycleUnavailableError
  )
}
