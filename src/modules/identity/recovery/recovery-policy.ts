export const recoveryAbusePolicy = {
  windowMilliseconds: 60_000,
  maximumCleanupRows: 64,
  maximumAttempts: {
    email: 5,
    address: 30,
  },
} as const

export const publicRecoveryFailure = {
  kind: 'rejected',
  message: 'The email, code, or password was not accepted.',
} as const

export function normalizeRecoveryEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  return normalized.length >= 1 && normalized.length <= 320 ? normalized : 'invalid-email'
}

export function memberResetBackoffMilliseconds(failedAttempts: number): number {
  if (!Number.isFinite(failedAttempts) || failedAttempts <= 0) return 0
  const exponent = Math.min(Math.floor(failedAttempts) - 1, 5)
  return Math.min(2 ** exponent * 1_000, 30_000)
}
