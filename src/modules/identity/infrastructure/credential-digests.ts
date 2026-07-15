import { createHmac } from 'node:crypto'
import { getServerConfig } from '@/platform/config/server'
import { normalizeRecoveryEmail } from '../recovery/recovery-policy'

function credentialDigestForSecret(
  authSecret: string,
  domain: 'credential-email-lock-v1' | 'credential-session-token-v1',
  value: string,
): string {
  if (!authSecret || !value || value.includes('\0')) {
    throw new TypeError('Credential digest input is invalid.')
  }
  return createHmac('sha256', authSecret)
    .update(`${domain}\0${value}`, 'utf8')
    .digest('hex')
}

export function credentialEmailLockDigestForSecret(
  authSecret: string,
  email: string,
): string {
  return credentialDigestForSecret(
    authSecret,
    'credential-email-lock-v1',
    normalizeRecoveryEmail(email),
  )
}

export function credentialEmailLockDigest(email: string): string {
  return credentialEmailLockDigestForSecret(getServerConfig().authSecret, email)
}

export function credentialSessionTokenDigestForSecret(
  authSecret: string,
  signedToken: string,
): string {
  return credentialDigestForSecret(authSecret, 'credential-session-token-v1', signedToken)
}

export function credentialSessionTokenDigest(signedToken: string): string {
  return credentialSessionTokenDigestForSecret(getServerConfig().authSecret, signedToken)
}
