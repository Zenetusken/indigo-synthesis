import { describe, expect, it } from 'vitest'
import {
  memberResetBackoffMilliseconds,
  normalizeRecoveryEmail,
  publicRecoveryFailure,
  recoveryAbusePolicy,
} from './recovery-policy'

describe('recovery policy', () => {
  it('normalizes submitted emails without retaining presentation differences', () => {
    expect(normalizeRecoveryEmail('  Owner@Example.TEST ')).toBe('owner@example.test')
    expect(normalizeRecoveryEmail('')).toBe('invalid-email')
    expect(normalizeRecoveryEmail('x'.repeat(321))).toBe('invalid-email')
  })

  it('uses fixed, bounded, non-permanent web admission budgets', () => {
    expect(recoveryAbusePolicy.windowMilliseconds).toBe(60_000)
    expect(recoveryAbusePolicy.maximumAttempts.email).toBe(5)
    expect(recoveryAbusePolicy.maximumAttempts.address).toBe(30)
    expect(recoveryAbusePolicy.maximumCleanupRows).toBe(64)
  })

  it('gives code guesses a short exponential backoff capped at thirty seconds', () => {
    expect(
      Array.from({ length: 10 }, (_, index) => memberResetBackoffMilliseconds(index + 1)),
    ).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000,
    ])
    expect(memberResetBackoffMilliseconds(1_000_000)).toBe(30_000)
  })

  it('defines one public failure result for every recovery rejection', () => {
    expect(publicRecoveryFailure).toEqual({
      kind: 'rejected',
      message: 'The email, code, or password was not accepted.',
    })
  })
})
