import { createHmac, timingSafeEqual } from 'node:crypto'
import { getServerConfig } from '@/platform/config/server'
import {
  type CheckedSignOutActionBinding,
  checkedSignOutActionBindingPurpose,
  type EmailSignInActionBinding,
  emailSignInActionBindingPurpose,
  type InstanceResetActionBinding,
  instanceResetActionBindingPurpose,
  type LocalUserCreateActionBinding,
  localUserCreateActionBindingPurpose,
  type MemberResetIssueActionBinding,
  type MemberResetRedemptionActionBinding,
  memberResetIssueActionBindingPurpose,
  memberResetRedemptionActionBindingPurpose,
  type OwnerBootstrapActionBinding,
  type OwnerRecoveryRedemptionActionBinding,
  ownerBootstrapActionBindingPurpose,
  ownerRecoveryRedemptionActionBindingPurpose,
  type TraineeDataDeletionActionBinding,
  traineeDataDeletionActionBindingPurpose,
} from '../application/action-binding'

const actionBindingVersion = 'iab1'
const actionBindingDomain = 'indigo-identity-action-binding-v1\0'
const base64urlSha256Pattern = /^[A-Za-z0-9_-]{43}$/
const canonicalBase36Pattern = /^[1-9a-z][0-9a-z]*$/
const maximumIdentityFieldBytes = 512
const authenticatedFormBindingLifetimeMilliseconds = 15 * 60 * 1_000
const emailSignInBindingLifetimeMilliseconds = 15 * 60 * 1_000
const ownerBootstrapBindingLifetimeMilliseconds = 15 * 60 * 1_000
const recoveryRedemptionBindingLifetimeMilliseconds = 15 * 60 * 1_000
const checkedSignOutCleanupGraceMilliseconds = 15 * 60 * 1_000

type IdentityActionBindingPurpose =
  | typeof checkedSignOutActionBindingPurpose
  | typeof emailSignInActionBindingPurpose
  | typeof instanceResetActionBindingPurpose
  | typeof localUserCreateActionBindingPurpose
  | typeof memberResetRedemptionActionBindingPurpose
  | typeof memberResetIssueActionBindingPurpose
  | typeof ownerBootstrapActionBindingPurpose
  | typeof ownerRecoveryRedemptionActionBindingPurpose
  | typeof traineeDataDeletionActionBindingPurpose

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

export type DestructivePlanActionBindingContext = {
  readonly expectedEpoch: string
  readonly sessionId: string
  readonly actorUserId: string
  readonly planId: string
  readonly planDigest: string
}

type DestructivePlanActionBindingIssuance = DestructivePlanActionBindingContext & {
  readonly sessionExpiresAt: Date
  readonly planExpiresAt: Date
}

export type InstanceResetActionBindingContext = DestructivePlanActionBindingContext
export type TraineeDataDeletionActionBindingContext = DestructivePlanActionBindingContext

export type LocalUserCreateActionBindingContext = {
  readonly expectedEpoch: string
  readonly sessionId: string
  readonly actorUserId: string
  readonly targetUserId: string
}

type LocalUserCreateActionBindingIssuance = LocalUserCreateActionBindingContext & {
  readonly sessionExpiresAt: Date
}

export type MemberResetIssueActionBindingContext = {
  readonly expectedEpoch: string
  readonly sessionId: string
  readonly actorUserId: string
  readonly targetUserId: string
}

export type MemberResetRedemptionActionBindingContext = {
  readonly expectedEpoch: string
}

type MemberResetIssueActionBindingIssuance = MemberResetIssueActionBindingContext & {
  readonly sessionExpiresAt: Date
}

export type OwnerBootstrapActionBindingContext = {
  readonly expectedEpoch: string
}

export type OwnerRecoveryRedemptionActionBindingContext = {
  readonly expectedEpoch: string
}

type PublicRecoveryRedemptionPurpose =
  | typeof memberResetRedemptionActionBindingPurpose
  | typeof ownerRecoveryRedemptionActionBindingPurpose

type PublicRecoveryRedemptionContext =
  | MemberResetRedemptionActionBindingContext
  | OwnerRecoveryRedemptionActionBindingContext

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

function authenticatedFormExpiry(sessionExpiresAt: Date, now: Date): string {
  const expiry = expiresAtSeconds(
    new Date(
      Math.min(
        sessionExpiresAt.getTime(),
        now.getTime() + authenticatedFormBindingLifetimeMilliseconds,
      ),
    ),
  )
  if (expiry <= currentSeconds(now)) {
    throw new TypeError(
      'Cannot issue an authenticated form binding for an expired session.',
    )
  }
  return expiry.toString(36)
}

function issueAuthenticatedFormBinding(
  purpose:
    | typeof localUserCreateActionBindingPurpose
    | typeof memberResetIssueActionBindingPurpose,
  input: LocalUserCreateActionBindingIssuance | MemberResetIssueActionBindingIssuance,
  now: Date,
): string {
  const encodedExpiry = authenticatedFormExpiry(input.sessionExpiresAt, now)
  const encodedSignature = signature(
    purpose,
    [input.expectedEpoch, input.sessionId, input.actorUserId, input.targetUserId],
    encodedExpiry,
  ).toString('base64url')
  return `${actionBindingVersion}.${purpose}.${encodedExpiry}.${encodedSignature}`
}

function verifyAuthenticatedFormBinding(
  binding: unknown,
  purpose:
    | typeof localUserCreateActionBindingPurpose
    | typeof memberResetIssueActionBindingPurpose,
  context: LocalUserCreateActionBindingContext | MemberResetIssueActionBindingContext,
  now: Date,
): boolean {
  const parsed = parseBinding(binding, purpose)
  if (!parsed) return false

  const expiry = Number.parseInt(parsed.encodedExpiry, 36)
  if (currentSeconds(now) >= expiry) return false

  let expectedSignature: Buffer
  try {
    expectedSignature = signature(
      purpose,
      [
        context.expectedEpoch,
        context.sessionId,
        context.actorUserId,
        context.targetUserId,
      ],
      parsed.encodedExpiry,
    )
  } catch {
    return false
  }
  return timingSafeEqual(parsed.suppliedSignature, expectedSignature)
}

function issueDestructivePlanActionBinding(
  purpose:
    | typeof instanceResetActionBindingPurpose
    | typeof traineeDataDeletionActionBindingPurpose,
  input: DestructivePlanActionBindingIssuance,
  now: Date,
): string {
  const earliestAuthorityExpiry = new Date(
    Math.min(input.sessionExpiresAt.getTime(), input.planExpiresAt.getTime()),
  )
  if (expiresAtSeconds(earliestAuthorityExpiry) <= currentSeconds(now)) {
    throw new TypeError(
      'Cannot issue a destructive plan binding for an expired session or plan.',
    )
  }
  const encodedExpiry = authenticatedFormExpiry(earliestAuthorityExpiry, now)
  const encodedSignature = signature(
    purpose,
    [
      input.expectedEpoch,
      input.sessionId,
      input.actorUserId,
      input.planId,
      input.planDigest,
    ],
    encodedExpiry,
  ).toString('base64url')
  return `${actionBindingVersion}.${purpose}.${encodedExpiry}.${encodedSignature}`
}

function verifyDestructivePlanActionBinding(
  binding: unknown,
  purpose:
    | typeof instanceResetActionBindingPurpose
    | typeof traineeDataDeletionActionBindingPurpose,
  context: DestructivePlanActionBindingContext,
  now: Date,
): boolean {
  const parsed = parseBinding(binding, purpose)
  if (!parsed) return false
  const expiry = Number.parseInt(parsed.encodedExpiry, 36)
  if (currentSeconds(now) >= expiry) return false

  let expectedSignature: Buffer
  try {
    expectedSignature = signature(
      purpose,
      [
        context.expectedEpoch,
        context.sessionId,
        context.actorUserId,
        context.planId,
        context.planDigest,
      ],
      parsed.encodedExpiry,
    )
  } catch {
    return false
  }
  return timingSafeEqual(parsed.suppliedSignature, expectedSignature)
}

function issuePublicRecoveryRedemptionBinding(
  purpose: PublicRecoveryRedemptionPurpose,
  context: PublicRecoveryRedemptionContext,
  now: Date,
): string {
  const current = currentSeconds(now)
  const expiry = currentSeconds(
    new Date(now.getTime() + recoveryRedemptionBindingLifetimeMilliseconds),
  )
  if (!Number.isSafeInteger(expiry) || expiry <= current) {
    throw new TypeError('Cannot issue a recovery action binding at this time.')
  }
  const encodedExpiry = expiry.toString(36)
  const encodedSignature = signature(
    purpose,
    [context.expectedEpoch],
    encodedExpiry,
  ).toString('base64url')
  return `${actionBindingVersion}.${purpose}.${encodedExpiry}.${encodedSignature}`
}

function verifyPublicRecoveryRedemptionBinding(
  binding: unknown,
  purpose: PublicRecoveryRedemptionPurpose,
  context: PublicRecoveryRedemptionContext,
  now: Date,
): boolean {
  const parsed = parseBinding(binding, purpose)
  if (!parsed) return false

  const expiry = Number.parseInt(parsed.encodedExpiry, 36)
  if (currentSeconds(now) >= expiry) return false

  let expectedSignature: Buffer
  try {
    expectedSignature = signature(purpose, [context.expectedEpoch], parsed.encodedExpiry)
  } catch {
    return false
  }
  return timingSafeEqual(parsed.suppliedSignature, expectedSignature)
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

/** Issues a short-lived proof for one preallocated local-user creation target. */
export function issueLocalUserCreateActionBinding(
  input: LocalUserCreateActionBindingIssuance,
  now = new Date(),
): LocalUserCreateActionBinding {
  return issueAuthenticatedFormBinding(
    localUserCreateActionBindingPurpose,
    input,
    now,
  ) as LocalUserCreateActionBinding
}

/** Re-checks every server-observed identity dimension bound into local-user creation. */
export function verifyLocalUserCreateActionBinding(
  binding: unknown,
  context: LocalUserCreateActionBindingContext,
  now = new Date(),
): binding is LocalUserCreateActionBinding {
  return verifyAuthenticatedFormBinding(
    binding,
    localUserCreateActionBindingPurpose,
    context,
    now,
  )
}

/** Issues a purpose-separated, short-lived proof for one member reset target. */
export function issueMemberResetIssueActionBinding(
  input: MemberResetIssueActionBindingIssuance,
  now = new Date(),
): MemberResetIssueActionBinding {
  return issueAuthenticatedFormBinding(
    memberResetIssueActionBindingPurpose,
    input,
    now,
  ) as MemberResetIssueActionBinding
}

/** Re-checks every server-observed identity dimension bound into member reset issuance. */
export function verifyMemberResetIssueActionBinding(
  binding: unknown,
  context: MemberResetIssueActionBindingContext,
  now = new Date(),
): binding is MemberResetIssueActionBinding {
  return verifyAuthenticatedFormBinding(
    binding,
    memberResetIssueActionBindingPurpose,
    context,
    now,
  )
}

/** Issues a purpose-separated proof for one exact owner reset preview. */
export function issueInstanceResetActionBinding(
  input: DestructivePlanActionBindingIssuance,
  now = new Date(),
): InstanceResetActionBinding {
  return issueDestructivePlanActionBinding(
    instanceResetActionBindingPurpose,
    input,
    now,
  ) as InstanceResetActionBinding
}

/** Rechecks every server-observed authority and preview dimension for reset. */
export function verifyInstanceResetActionBinding(
  binding: unknown,
  context: InstanceResetActionBindingContext,
  now = new Date(),
): binding is InstanceResetActionBinding {
  return verifyDestructivePlanActionBinding(
    binding,
    instanceResetActionBindingPurpose,
    context,
    now,
  )
}

/** Issues a purpose-separated proof for one exact trainee-data preview. */
export function issueTraineeDataDeletionActionBinding(
  input: DestructivePlanActionBindingIssuance,
  now = new Date(),
): TraineeDataDeletionActionBinding {
  return issueDestructivePlanActionBinding(
    traineeDataDeletionActionBindingPurpose,
    input,
    now,
  ) as TraineeDataDeletionActionBinding
}

/** Rechecks every server-observed authority and preview dimension for subject deletion. */
export function verifyTraineeDataDeletionActionBinding(
  binding: unknown,
  context: TraineeDataDeletionActionBindingContext,
  now = new Date(),
): binding is TraineeDataDeletionActionBinding {
  return verifyDestructivePlanActionBinding(
    binding,
    traineeDataDeletionActionBindingPurpose,
    context,
    now,
  )
}

/** Issues a session-independent proof for member-reset redemption on one generation. */
export function issueMemberResetRedemptionActionBinding(
  context: MemberResetRedemptionActionBindingContext,
  now = new Date(),
): MemberResetRedemptionActionBinding {
  return issuePublicRecoveryRedemptionBinding(
    memberResetRedemptionActionBindingPurpose,
    context,
    now,
  ) as MemberResetRedemptionActionBinding
}

/** Verifies member-redemption purpose and current installation generation. */
export function verifyMemberResetRedemptionActionBinding(
  binding: unknown,
  context: MemberResetRedemptionActionBindingContext,
  now = new Date(),
): binding is MemberResetRedemptionActionBinding {
  return verifyPublicRecoveryRedemptionBinding(
    binding,
    memberResetRedemptionActionBindingPurpose,
    context,
    now,
  )
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

/** Issues a session-independent proof for owner recovery on one installation generation. */
export function issueOwnerRecoveryRedemptionActionBinding(
  context: OwnerRecoveryRedemptionActionBindingContext,
  now = new Date(),
): OwnerRecoveryRedemptionActionBinding {
  return issuePublicRecoveryRedemptionBinding(
    ownerRecoveryRedemptionActionBindingPurpose,
    context,
    now,
  ) as OwnerRecoveryRedemptionActionBinding
}

/** Verifies owner-recovery purpose and current installation generation. */
export function verifyOwnerRecoveryRedemptionActionBinding(
  binding: unknown,
  context: OwnerRecoveryRedemptionActionBindingContext,
  now = new Date(),
): binding is OwnerRecoveryRedemptionActionBinding {
  return verifyPublicRecoveryRedemptionBinding(
    binding,
    ownerRecoveryRedemptionActionBindingPurpose,
    context,
    now,
  )
}
