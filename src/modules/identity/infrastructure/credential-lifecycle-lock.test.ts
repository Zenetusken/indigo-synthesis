import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  credentialEmailLockDigestForSecret,
  credentialSessionTokenDigestForSecret,
} from './credential-digests'

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

  it('domain-separates opaque signed-session tokens and rejects ambiguous input', () => {
    const secret = 'unit-test-credential-lock-secret'
    const signedToken = 'opaque.signed-session-token'
    const expected = createHmac('sha256', secret)
      .update(`credential-session-token-v1\0${signedToken}`, 'utf8')
      .digest('hex')

    expect(credentialSessionTokenDigestForSecret(secret, signedToken)).toBe(expected)
    expect(credentialSessionTokenDigestForSecret(secret, signedToken)).not.toBe(
      credentialEmailLockDigestForSecret(secret, signedToken),
    )
    expect(() => credentialSessionTokenDigestForSecret(secret, 'bad\0token')).toThrow(
      'invalid',
    )
  })
})
