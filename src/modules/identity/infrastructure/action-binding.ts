import { createHmac, timingSafeEqual } from 'node:crypto'
import { getServerConfig } from '@/platform/config/server'
import {
  type CheckedSignOutActionBinding,
  checkedSignOutActionBindingPurpose,
  type EmailSignInActionBinding,
  emailSignInActionBindingPurpose,
  type OwnerBootstrapActionBinding,
  ownerBootstrapActionBindingPurpose,
} from '../application/action-binding'

const actionBindingVersion = 'iab1'
const actionBindingDomain = 'indigo-identity-action-binding-v1\0'
const base64urlSha256Pattern = /^[A-Za-z0-9_-]{43}$/
const canonicalBase36Pattern = /^[1-9a-z][0-9a-z]*$/
const maximumIdentityFieldBytes = 512
const emailSignInBindingLifetimeMilliseconds = 15 * 60 * 1_000
const ownerBootstrapBindingLifetimeMilliseconds = 15 * 60 * 1_000
const checkedSignOutCleanupGraceMilliseconds = 15 * 60 * 1_000

type IdentityActionBindingPurpose =
  | typeof checkedSignOutActionBindingPurpose
  | typeof emailSignInActionBindingPurpose
  | typeof ownerBootstrapActionBindingPurpose

export type CheckedSignOutActionBindingContext = {
  readonly expectedEpoch: string
  readonly sessionId: string
  readonly actorUserId: string
}

type CheckedSignOutActionBindingIssuance = CheckedSignOutActionBindingContext & {
  /** The binding authorizes only deletion/expiry and has a bounded post-expiry cleanup window. */
  readonly sessionExpiresAt: Date
}

export type EmailSignInActionBindingContext = {
  readonly expectedEpoch: string
}

export type OwnerBootstrapActionBindingContext = {
  readonly expectedEpoch: string
}

function assertIdentityField(label: string, value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumIdentityFieldBytes
  ) {
    throw new TypeError(`${label} is not a valid action-binding identity.`)
  }
}

function expiresAtSeconds(value: Date): number {
  const milliseconds = value.getTime()
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('The action-binding expiry must be a valid date.')
  }

  const seconds = Math.floor(milliseconds / 1_000)
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new TypeError('The action-binding expiry is outside the supported range.')
  }
  return seconds
}

function currentSeconds(now: Date): number {
  const milliseconds = now.getTime()
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('The action-binding clock must be a valid date.')
  }
  return Math.floor(milliseconds / 1_000)
}

function signature(
  purpose: IdentityActionBindingPurpose,
  identityFields: readonly string[],
  encodedExpiry: string,
): Buffer {
  for (const [index, value] of identityFields.entries()) {
    assertIdentityField(`Action-binding identity ${index + 1}`, value)
  }

  const hmac = createHmac('sha256', getServerConfig().authSecret)
    .update(actionBindingDomain, 'utf8')
    .update(actionBindingVersion, 'utf8')
    .update('\0', 'utf8')
    .update(purpose, 'utf8')
    .update('\0', 'utf8')
    .update(encodedExpiry, 'utf8')
  for (const field of identityFields) hmac.update('\0', 'utf8').update(field, 'utf8')
  return hmac.digest()
}

function parseBinding(
  binding: unknown,
  expectedPurpose: IdentityActionBindingPurpose,
): { readonly encodedExpiry: string; readonly suppliedSignature: Buffer } | null {
  if (typeof binding !== 'string' || binding.length > 128) return null

  const [version, purpose, encodedExpiry, encodedSignature, extra] = binding.split('.')
  if (
    extra !== undefined ||
    version !== actionBindingVersion ||
    purpose !== expectedPurpose ||
    !encodedExpiry ||
    !canonicalBase36Pattern.test(encodedExpiry) ||
    !encodedSignature ||
    !base64urlSha256Pattern.test(encodedSignature)
  ) {
    return null
  }

  const expiry = Number.parseInt(encodedExpiry, 36)
  if (!Number.isSafeInteger(expiry) || expiry.toString(36) !== encodedExpiry) return null

  const suppliedSignature = Buffer.from(encodedSignature, 'base64url')
  if (
    suppliedSignature.length !== 32 ||
    suppliedSignature.toString('base64url') !== encodedSignature
  ) {
    return null
  }

  return { encodedExpiry, suppliedSignature }
}

export function issueCheckedSignOutActionBinding(
  input: CheckedSignOutActionBindingIssuance,
  now = new Date(),
): CheckedSignOutActionBinding {
  const expiry = expiresAtSeconds(
    new Date(input.sessionExpiresAt.getTime() + checkedSignOutCleanupGraceMilliseconds),
  )
  const encodedExpiry = expiry.toString(36)
  if (expiry <= currentSeconds(now)) {
    throw new TypeError('Cannot issue an action binding outside the cleanup window.')
  }

  const encodedSignature = signature(
    checkedSignOutActionBindingPurpose,
    [input.expectedEpoch, input.sessionId, input.actorUserId],
    encodedExpiry,
  ).toString('base64url')
  return `${actionBindingVersion}.${checkedSignOutActionBindingPurpose}.${encodedExpiry}.${encodedSignature}` as CheckedSignOutActionBinding
}

export function verifyCheckedSignOutActionBinding(
  binding: unknown,
  context: CheckedSignOutActionBindingContext,
  now = new Date(),
): binding is CheckedSignOutActionBinding {
  const parsed = parseBinding(binding, checkedSignOutActionBindingPurpose)
  if (!parsed) return false

  const expiry = Number.parseInt(parsed.encodedExpiry, 36)
  if (currentSeconds(now) >= expiry) return false

  let expectedSignature: Buffer
  try {
    expectedSignature = signature(
      checkedSignOutActionBindingPurpose,
      [context.expectedEpoch, context.sessionId, context.actorUserId],
      parsed.encodedExpiry,
    )
  } catch {
    return false
  }

  return timingSafeEqual(parsed.suppliedSignature, expectedSignature)
}

/** Issues a short-lived opaque proof for the exact installation generation that rendered sign-in. */
export function issueEmailSignInActionBinding(
  context: EmailSignInActionBindingContext,
  now = new Date(),
): EmailSignInActionBinding {
  const current = currentSeconds(now)
  const expiry = currentSeconds(
    new Date(now.getTime() + emailSignInBindingLifetimeMilliseconds),
  )
  if (!Number.isSafeInteger(expiry) || expiry <= current) {
    throw new TypeError('Cannot issue an email sign-in action binding at this time.')
  }
  const encodedExpiry = expiry.toString(36)
  const encodedSignature = signature(
    emailSignInActionBindingPurpose,
    [context.expectedEpoch],
    encodedExpiry,
  ).toString('base64url')
  return `${actionBindingVersion}.${emailSignInActionBindingPurpose}.${encodedExpiry}.${encodedSignature}` as EmailSignInActionBinding
}

/** Verifies the sign-in page generation without disclosing or trusting it from the browser. */
export function verifyEmailSignInActionBinding(
  binding: unknown,
  context: EmailSignInActionBindingContext,
  now = new Date(),
): binding is EmailSignInActionBinding {
  const parsed = parseBinding(binding, emailSignInActionBindingPurpose)
  if (!parsed) return false

  const expiry = Number.parseInt(parsed.encodedExpiry, 36)
  if (currentSeconds(now) >= expiry) return false

  let expectedSignature: Buffer
  try {
    expectedSignature = signature(
      emailSignInActionBindingPurpose,
      [context.expectedEpoch],
      parsed.encodedExpiry,
    )
  } catch {
    return false
  }
  return timingSafeEqual(parsed.suppliedSignature, expectedSignature)
}

/** Issues a purpose-separated, short-lived proof for the open bootstrap page generation. */
export function issueOwnerBootstrapActionBinding(
  context: OwnerBootstrapActionBindingContext,
  now = new Date(),
): OwnerBootstrapActionBinding {
  const current = currentSeconds(now)
  const expiry = currentSeconds(
    new Date(now.getTime() + ownerBootstrapBindingLifetimeMilliseconds),
  )
  if (!Number.isSafeInteger(expiry) || expiry <= current) {
    throw new TypeError('Cannot issue an owner-bootstrap action binding at this time.')
  }
  const encodedExpiry = expiry.toString(36)
  const encodedSignature = signature(
    ownerBootstrapActionBindingPurpose,
    [context.expectedEpoch],
    encodedExpiry,
  ).toString('base64url')
  return `${actionBindingVersion}.${ownerBootstrapActionBindingPurpose}.${encodedExpiry}.${encodedSignature}` as OwnerBootstrapActionBinding
}

/** Verifies bootstrap purpose and epoch without trusting a browser-supplied lifecycle value. */
export function verifyOwnerBootstrapActionBinding(
  binding: unknown,
  context: OwnerBootstrapActionBindingContext,
  now = new Date(),
): binding is OwnerBootstrapActionBinding {
  const parsed = parseBinding(binding, ownerBootstrapActionBindingPurpose)
  if (!parsed) return false
  const expiry = Number.parseInt(parsed.encodedExpiry, 36)
  if (currentSeconds(now) >= expiry) return false

  let expectedSignature: Buffer
  try {
    expectedSignature = signature(
      ownerBootstrapActionBindingPurpose,
      [context.expectedEpoch],
      parsed.encodedExpiry,
    )
  } catch {
    return false
  }
  return timingSafeEqual(parsed.suppliedSignature, expectedSignature)
}
