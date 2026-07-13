import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { credentialEmailLockDigestForSecret } from './credential-lifecycle-lock'

describe('credential lifecycle lock keys', () => {
  it('normalizes email under the versioned secret-keyed namespace', () => {
    const secret = 'unit-test-credential-lock-secret'
    const expected = createHmac('sha256', secret)
      .update('credential-email-lock-v1\0member@example.test', 'utf8')
      .digest('hex')

    expect(credentialEmailLockDigestForSecret(secret, '  Member@Example.TEST ')).toBe(
      expected,
    )
    expect(
      credentialEmailLockDigestForSecret(`${secret}-rotated`, 'member@example.test'),
    ).not.toBe(expected)
  })
})
