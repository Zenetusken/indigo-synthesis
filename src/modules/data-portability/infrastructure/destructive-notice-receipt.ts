import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getServerConfig } from '@/platform/config/server'

const receiptVersion = 'dpnr2'
const receiptDomain = 'indigo-data-portability-destructive-notice-receipt-v2\0'
const actorBindingDomain = 'indigo-data-portability-destructive-notice-actor-binding-v1\0'
const subjectDeletionPurpose = 'subject-deletion'
const instanceResetPurpose = 'instance-reset'
const receiptLifetimeSeconds = 15 * 60
const maximumReceiptBytes = 192
const receiptNonceBytes = 12
const canonicalBase36Pattern = /^[1-9a-z][0-9a-z]*$/
const base64urlSha256Pattern = /^[A-Za-z0-9_-]{43}$/
const base64urlNoncePattern = /^[A-Za-z0-9_-]{16}$/

type ReceiptPurpose = typeof subjectDeletionPurpose | typeof instanceResetPurpose

type NoticeWarning = null | 'cleanup-failed'

export type DestructiveNoticeFailureKind =
  | 'confirmation-rejected'
  | 'execution-failed'
  | 'plan-changed'
  | 'plan-invalid'
  | 'preview-failed'
  | 'reauthentication-failed'
  | 'reauthentication-incomplete'
  | 'reauthentication-locked'
  | 'request-not-verified'
  | 'stale'
  | 'unavailable'

const destructiveNoticeFailureKinds = new Set<DestructiveNoticeFailureKind>([
  'confirmation-rejected',
  'execution-failed',
  'plan-changed',
  'plan-invalid',
  'preview-failed',
  'reauthentication-failed',
  'reauthentication-incomplete',
  'reauthentication-locked',
  'request-not-verified',
  'stale',
  'unavailable',
])

function isDestructiveNoticeFailureKind(
  value: string,
): value is DestructiveNoticeFailureKind {
  return destructiveNoticeFailureKinds.has(value as DestructiveNoticeFailureKind)
}

type DestructiveNoticeFailurePayload = {
  readonly kind: DestructiveNoticeFailureKind
}

export type SubjectDeletionNoticeReceiptPayload =
  | {
      readonly kind: 'deleted'
      readonly actorRole: 'owner' | 'member'
      readonly warning: NoticeWarning
    }
  | {
      readonly kind: 'outcome-unknown'
      readonly actorRole: 'owner' | 'member'
    }
  | DestructiveNoticeFailurePayload

export type InstanceResetNoticeReceiptPayload =
  | {
      readonly kind: 'reset'
      readonly warning: NoticeWarning
    }
  | {
      readonly kind: 'outcome-unknown'
    }
  | DestructiveNoticeFailurePayload

declare const subjectDeletionNoticeReceiptBrand: unique symbol
declare const instanceResetNoticeReceiptBrand: unique symbol

export type SubjectDeletionNoticeReceipt = string & {
  readonly [subjectDeletionNoticeReceiptBrand]: true
}

export type InstanceResetNoticeReceipt = string & {
  readonly [instanceResetNoticeReceiptBrand]: true
}

type ParsedReceipt = {
  readonly actorBinding: Buffer
  readonly nonce: string
  readonly purpose: ReceiptPurpose
  readonly payload:
    | SubjectDeletionNoticeReceiptPayload
    | InstanceResetNoticeReceiptPayload
  readonly issuedAt: number
  readonly expiresAt: number
  readonly canonicalPayload: string
  readonly suppliedSignature: Buffer
}

function clockSeconds(now: Date): number | null {
  const milliseconds = now.getTime()
  if (!Number.isFinite(milliseconds)) return null

  const seconds = Math.floor(milliseconds / 1_000)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null
}

function issuanceSeconds(now: Date): number {
  const seconds = clockSeconds(now)
  if (seconds === null || seconds > Number.MAX_SAFE_INTEGER - receiptLifetimeSeconds) {
    throw new TypeError(
      'The destructive notice receipt clock is outside the supported range.',
    )
  }
  return seconds
}

function signature(canonicalPayload: string): Buffer {
  return createHmac('sha256', getServerConfig().authSecret)
    .update(receiptDomain, 'utf8')
    .update(canonicalPayload, 'utf8')
    .digest()
}

function validActorUserId(actorUserId: unknown): actorUserId is string {
  return (
    typeof actorUserId === 'string' &&
    actorUserId.length > 0 &&
    Buffer.byteLength(actorUserId, 'utf8') <= 512 &&
    !actorUserId.includes('\0')
  )
}

function actorBinding(
  actorUserId: string,
  purpose: ReceiptPurpose,
  nonce: string,
  issuedAt: number,
  expiresAt: number,
): Buffer {
  return createHmac('sha256', getServerConfig().authSecret)
    .update(actorBindingDomain, 'utf8')
    .update(purpose, 'utf8')
    .update('\0', 'utf8')
    .update(nonce, 'utf8')
    .update('\0', 'utf8')
    .update(issuedAt.toString(36), 'utf8')
    .update('\0', 'utf8')
    .update(expiresAt.toString(36), 'utf8')
    .update('\0', 'utf8')
    .update(actorUserId, 'utf8')
    .digest()
}

function issueReceipt(
  purpose: ReceiptPurpose,
  kind: 'deleted' | 'outcome-unknown' | 'reset' | DestructiveNoticeFailureKind,
  actorRole: 'owner' | 'member' | 'none',
  warning: 'none' | 'cleanup-failed',
  actorUserId: string,
  now: Date,
): string {
  if (!validActorUserId(actorUserId)) {
    throw new TypeError('A valid destructive notice actor is required.')
  }
  const issuedAt = issuanceSeconds(now)
  const expiresAt = issuedAt + receiptLifetimeSeconds
  const nonce = randomBytes(receiptNonceBytes).toString('base64url')
  const canonicalPayload = [
    receiptVersion,
    purpose,
    kind,
    actorRole,
    warning,
    nonce,
    actorBinding(actorUserId, purpose, nonce, issuedAt, expiresAt).toString('base64url'),
    issuedAt.toString(36),
    expiresAt.toString(36),
  ].join('.')
  return `${canonicalPayload}.${signature(canonicalPayload).toString('base64url')}`
}

function parseCanonicalSeconds(encoded: string): number | null {
  if (!canonicalBase36Pattern.test(encoded)) return null

  const parsed = Number.parseInt(encoded, 36)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed.toString(36) !== encoded) {
    return null
  }
  return parsed
}

function parsePayload(
  purpose: string,
  kind: string,
  actorRole: string,
  warning: string,
): {
  readonly purpose: ReceiptPurpose
  readonly payload:
    | SubjectDeletionNoticeReceiptPayload
    | InstanceResetNoticeReceiptPayload
} | null {
  const failureKind = isDestructiveNoticeFailureKind(kind) ? kind : null
  if (purpose === subjectDeletionPurpose) {
    if (failureKind && actorRole === 'none' && warning === 'none') {
      return { purpose, payload: { kind: failureKind } }
    }
    if (actorRole !== 'owner' && actorRole !== 'member') return null
    if (kind === 'deleted' && (warning === 'none' || warning === 'cleanup-failed')) {
      return {
        purpose,
        payload: {
          kind,
          actorRole,
          warning: warning === 'none' ? null : warning,
        },
      }
    }
    if (kind === 'outcome-unknown' && warning === 'none') {
      return { purpose, payload: { kind, actorRole } }
    }
    return null
  }

  if (purpose === instanceResetPurpose && actorRole === 'none') {
    if (kind === 'reset' && (warning === 'none' || warning === 'cleanup-failed')) {
      return {
        purpose,
        payload: { kind, warning: warning === 'none' ? null : warning },
      }
    }
    if (kind === 'outcome-unknown' && warning === 'none') {
      return { purpose, payload: { kind } }
    }
    if (failureKind && warning === 'none') {
      return { purpose, payload: { kind: failureKind } }
    }
  }
  return null
}

function parseReceipt(receipt: unknown): ParsedReceipt | null {
  if (
    typeof receipt !== 'string' ||
    receipt.length > maximumReceiptBytes ||
    Buffer.byteLength(receipt, 'utf8') > maximumReceiptBytes
  ) {
    return null
  }

  const [
    version,
    purpose,
    kind,
    actorRole,
    warning,
    nonce,
    encodedActorBinding,
    encodedIssuedAt,
    encodedExpiresAt,
    encodedSignature,
    extra,
  ] = receipt.split('.')
  if (
    extra !== undefined ||
    version !== receiptVersion ||
    !purpose ||
    !kind ||
    !actorRole ||
    !warning ||
    !nonce ||
    !encodedActorBinding ||
    !encodedIssuedAt ||
    !encodedExpiresAt ||
    !encodedSignature ||
    !base64urlNoncePattern.test(nonce) ||
    !base64urlSha256Pattern.test(encodedActorBinding) ||
    !base64urlSha256Pattern.test(encodedSignature)
  ) {
    return null
  }

  const parsedPayload = parsePayload(purpose, kind, actorRole, warning)
  const issuedAt = parseCanonicalSeconds(encodedIssuedAt)
  const expiresAt = parseCanonicalSeconds(encodedExpiresAt)
  if (
    !parsedPayload ||
    issuedAt === null ||
    expiresAt === null ||
    issuedAt > Number.MAX_SAFE_INTEGER - receiptLifetimeSeconds ||
    expiresAt !== issuedAt + receiptLifetimeSeconds
  ) {
    return null
  }

  const suppliedSignature = Buffer.from(encodedSignature, 'base64url')
  const suppliedActorBinding = Buffer.from(encodedActorBinding, 'base64url')
  if (
    suppliedSignature.length !== 32 ||
    suppliedSignature.toString('base64url') !== encodedSignature ||
    suppliedActorBinding.length !== 32 ||
    suppliedActorBinding.toString('base64url') !== encodedActorBinding
  ) {
    return null
  }

  return {
    ...parsedPayload,
    actorBinding: suppliedActorBinding,
    nonce,
    issuedAt,
    expiresAt,
    canonicalPayload: receipt.slice(0, receipt.lastIndexOf('.')),
    suppliedSignature,
  }
}

function verifyReceipt(
  receipt: unknown,
  expectedPurpose: ReceiptPurpose,
  now: Date,
): ParsedReceipt | null {
  const parsed = parseReceipt(receipt)
  const current = clockSeconds(now)
  if (!parsed || current === null) return null

  const expectedSignature = signature(parsed.canonicalPayload)
  if (!timingSafeEqual(parsed.suppliedSignature, expectedSignature)) return null
  if (
    parsed.purpose !== expectedPurpose ||
    current < parsed.issuedAt ||
    current >= parsed.expiresAt
  ) {
    return null
  }
  return parsed
}

function verifyReceiptForActor(
  receipt: unknown,
  expectedPurpose: ReceiptPurpose,
  actorUserId: unknown,
  now: Date,
): ParsedReceipt | null {
  if (!validActorUserId(actorUserId)) return null

  const parsed = verifyReceipt(receipt, expectedPurpose, now)
  if (!parsed) return null

  const expectedActorBinding = actorBinding(
    actorUserId,
    parsed.purpose,
    parsed.nonce,
    parsed.issuedAt,
    parsed.expiresAt,
  )
  return timingSafeEqual(parsed.actorBinding, expectedActorBinding) ? parsed : null
}

function subjectDeletionPayload(
  parsed: ParsedReceipt | null,
): SubjectDeletionNoticeReceiptPayload | null {
  const payload = parsed?.payload
  if (payload?.kind === 'deleted') return payload
  if (payload?.kind === 'outcome-unknown' && 'actorRole' in payload) return payload
  if (payload && isDestructiveNoticeFailureKind(payload.kind)) {
    return { kind: payload.kind }
  }
  return null
}

function instanceResetPayload(
  parsed: ParsedReceipt | null,
): InstanceResetNoticeReceiptPayload | null {
  const payload = parsed?.payload
  if (payload?.kind === 'reset') return payload
  if (payload?.kind === 'outcome-unknown' && !('actorRole' in payload)) return payload
  if (payload && isDestructiveNoticeFailureKind(payload.kind)) {
    return { kind: payload.kind }
  }
  return null
}

/** Issues an opaque actor-bound receipt for an exact subject-deletion result. */
export function issueSubjectDeletionNoticeReceipt(
  payload: SubjectDeletionNoticeReceiptPayload,
  actorUserId: string,
  now = new Date(),
): SubjectDeletionNoticeReceipt {
  if (payload.kind === 'deleted') {
    if (payload.actorRole !== 'owner' && payload.actorRole !== 'member') {
      throw new TypeError('The subject-deletion notice actor role is invalid.')
    }
    if (payload.warning !== null && payload.warning !== 'cleanup-failed') {
      throw new TypeError('The subject-deletion notice warning is invalid.')
    }
    return issueReceipt(
      subjectDeletionPurpose,
      payload.kind,
      payload.actorRole,
      payload.warning ?? 'none',
      actorUserId,
      now,
    ) as SubjectDeletionNoticeReceipt
  }
  if (payload.kind === 'outcome-unknown') {
    if (payload.actorRole !== 'owner' && payload.actorRole !== 'member') {
      throw new TypeError('The subject-deletion notice actor role is invalid.')
    }
    return issueReceipt(
      subjectDeletionPurpose,
      payload.kind,
      payload.actorRole,
      'none',
      actorUserId,
      now,
    ) as SubjectDeletionNoticeReceipt
  }
  if (isDestructiveNoticeFailureKind(payload.kind)) {
    return issueReceipt(
      subjectDeletionPurpose,
      payload.kind,
      'none',
      'none',
      actorUserId,
      now,
    ) as SubjectDeletionNoticeReceipt
  }
  throw new TypeError('The subject-deletion notice kind is invalid.')
}

/** Returns only an authenticated, unexpired subject-deletion notice payload. */
export function verifySubjectDeletionNoticeReceipt(
  receipt: unknown,
  now = new Date(),
): SubjectDeletionNoticeReceiptPayload | null {
  return subjectDeletionPayload(verifyReceipt(receipt, subjectDeletionPurpose, now))
}

/** Returns a subject-deletion payload only for the exact issuing actor. */
export function verifySubjectDeletionNoticeReceiptForActor(
  receipt: unknown,
  actorUserId: unknown,
  now = new Date(),
): SubjectDeletionNoticeReceiptPayload | null {
  return subjectDeletionPayload(
    verifyReceiptForActor(receipt, subjectDeletionPurpose, actorUserId, now),
  )
}

/** Issues an opaque actor-bound receipt for an exact instance-reset result. */
export function issueInstanceResetNoticeReceipt(
  payload: InstanceResetNoticeReceiptPayload,
  actorUserId: string,
  now = new Date(),
): InstanceResetNoticeReceipt {
  if (payload.kind === 'reset') {
    if (payload.warning !== null && payload.warning !== 'cleanup-failed') {
      throw new TypeError('The instance-reset notice warning is invalid.')
    }
    return issueReceipt(
      instanceResetPurpose,
      payload.kind,
      'none',
      payload.warning ?? 'none',
      actorUserId,
      now,
    ) as InstanceResetNoticeReceipt
  }
  if (payload.kind === 'outcome-unknown') {
    return issueReceipt(
      instanceResetPurpose,
      payload.kind,
      'none',
      'none',
      actorUserId,
      now,
    ) as InstanceResetNoticeReceipt
  }
  if (isDestructiveNoticeFailureKind(payload.kind)) {
    return issueReceipt(
      instanceResetPurpose,
      payload.kind,
      'none',
      'none',
      actorUserId,
      now,
    ) as InstanceResetNoticeReceipt
  }
  throw new TypeError('The instance-reset notice kind is invalid.')
}

/** Returns only an authenticated, unexpired instance-reset notice payload. */
export function verifyInstanceResetNoticeReceipt(
  receipt: unknown,
  now = new Date(),
): InstanceResetNoticeReceiptPayload | null {
  return instanceResetPayload(verifyReceipt(receipt, instanceResetPurpose, now))
}

/** Returns an instance-reset payload only for the exact issuing actor. */
export function verifyInstanceResetNoticeReceiptForActor(
  receipt: unknown,
  actorUserId: unknown,
  now = new Date(),
): InstanceResetNoticeReceiptPayload | null {
  return instanceResetPayload(
    verifyReceiptForActor(receipt, instanceResetPurpose, actorUserId, now),
  )
}
