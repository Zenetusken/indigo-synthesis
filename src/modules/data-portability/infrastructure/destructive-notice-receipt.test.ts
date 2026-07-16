import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import {
  issueInstanceResetNoticeReceipt,
  issueSubjectDeletionNoticeReceipt,
  verifyInstanceResetNoticeReceipt,
  verifyInstanceResetNoticeReceiptForActor,
  verifySubjectDeletionNoticeReceipt,
  verifySubjectDeletionNoticeReceiptForActor,
} from './destructive-notice-receipt'

const authSecret = 'destructive-notice-receipt-test-secret-at-least-32-characters'
const receiptDomain = 'indigo-data-portability-destructive-notice-receipt-v2\0'
const actorBindingDomain = 'indigo-data-portability-destructive-notice-actor-binding-v1\0'
const legacyReceiptDomain = 'indigo-data-portability-destructive-notice-receipt-v1\0'
const now = new Date('2026-07-16T12:00:00.500Z')
const nowSeconds = Math.floor(now.getTime() / 1_000)
const memberActorId = 'member-user-019f'
const otherMemberActorId = 'member-user-02aa'
const ownerActorId = 'owner-user-019f'
const replacementOwnerActorId = 'owner-user-02aa'

function actorBinding(fields: {
  readonly actorUserId: string
  readonly purpose: string
  readonly nonce: string
  readonly issuedAt: string
  readonly expiresAt: string
}): string {
  return createHmac('sha256', authSecret)
    .update(actorBindingDomain, 'utf8')
    .update(fields.purpose, 'utf8')
    .update('\0', 'utf8')
    .update(fields.nonce, 'utf8')
    .update('\0', 'utf8')
    .update(fields.issuedAt, 'utf8')
    .update('\0', 'utf8')
    .update(fields.expiresAt, 'utf8')
    .update('\0', 'utf8')
    .update(fields.actorUserId, 'utf8')
    .digest('base64url')
}

function signedReceipt(fields: {
  readonly purpose: string
  readonly kind: string
  readonly actorRole: string
  readonly warning: string
  readonly actorUserId?: string
  readonly nonce?: string
  readonly encodedActorBinding?: string
  readonly issuedAt?: string
  readonly expiresAt?: string
}): string {
  const issuedAt = fields.issuedAt ?? nowSeconds.toString(36)
  const expiresAt = fields.expiresAt ?? (nowSeconds + 15 * 60).toString(36)
  const nonce = fields.nonce ?? 'AAAAAAAAAAAAAAAA'
  const encodedActorBinding =
    fields.encodedActorBinding ??
    actorBinding({
      actorUserId: fields.actorUserId ?? ownerActorId,
      purpose: fields.purpose,
      nonce,
      issuedAt,
      expiresAt,
    })
  const payload = [
    'dpnr2',
    fields.purpose,
    fields.kind,
    fields.actorRole,
    fields.warning,
    nonce,
    encodedActorBinding,
    issuedAt,
    expiresAt,
  ].join('.')
  const signature = createHmac('sha256', authSecret)
    .update(receiptDomain, 'utf8')
    .update(payload, 'utf8')
    .digest('base64url')
  return `${payload}.${signature}`
}

function legacyV1Receipt(): string {
  const payload = [
    'dpnr1',
    'subject-deletion',
    'deleted',
    'member',
    'none',
    nowSeconds.toString(36),
    (nowSeconds + 15 * 60).toString(36),
  ].join('.')
  const signature = createHmac('sha256', authSecret)
    .update(legacyReceiptDomain, 'utf8')
    .update(payload, 'utf8')
    .digest('base64url')
  return `${payload}.${signature}`
}

describe('destructive notice receipts', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/indigo_notice_receipt_test')
    vi.stubEnv('BETTER_AUTH_SECRET', authSecret)
    vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:3000')
    vi.stubEnv('INDIGO_CONTENT_MODE', 'development')
    vi.stubEnv('NODE_ENV', 'test')
    resetServerConfigForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetServerConfigForTests()
  })

  it.each([
    { kind: 'deleted', actorRole: 'owner', warning: null },
    { kind: 'deleted', actorRole: 'member', warning: 'cleanup-failed' },
    { kind: 'outcome-unknown', actorRole: 'owner' },
    { kind: 'outcome-unknown', actorRole: 'member' },
  ] as const)('round-trips the subject-deletion payload %#', (payload) => {
    const actorUserId = payload.actorRole === 'owner' ? ownerActorId : memberActorId
    const receipt = issueSubjectDeletionNoticeReceipt(payload, actorUserId, now)

    expect(receipt.split('.')).toHaveLength(10)
    expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toEqual(payload)
    expect(verifySubjectDeletionNoticeReceiptForActor(receipt, actorUserId, now)).toEqual(
      payload,
    )
    expect(verifyInstanceResetNoticeReceipt(receipt, now)).toBeNull()
    expect(verifyInstanceResetNoticeReceiptForActor(receipt, actorUserId, now)).toBeNull()
  })

  it.each([
    { kind: 'reset', warning: null },
    { kind: 'reset', warning: 'cleanup-failed' },
    { kind: 'outcome-unknown' },
  ] as const)('round-trips the instance-reset payload %#', (payload) => {
    const receipt = issueInstanceResetNoticeReceipt(payload, ownerActorId, now)

    expect(receipt.split('.')).toHaveLength(10)
    expect(verifyInstanceResetNoticeReceipt(receipt, now)).toEqual(payload)
    expect(verifyInstanceResetNoticeReceiptForActor(receipt, ownerActorId, now)).toEqual(
      payload,
    )
    expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toBeNull()
    expect(
      verifySubjectDeletionNoticeReceiptForActor(receipt, ownerActorId, now),
    ).toBeNull()
  })

  it.each([
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
  ] as const)('round-trips actor-bound, purpose-separated failure kind %s', (kind) => {
    const subjectReceipt = issueSubjectDeletionNoticeReceipt({ kind }, memberActorId, now)
    const resetReceipt = issueInstanceResetNoticeReceipt({ kind }, ownerActorId, now)

    expect(verifySubjectDeletionNoticeReceipt(subjectReceipt, now)).toEqual({ kind })
    expect(
      verifySubjectDeletionNoticeReceiptForActor(subjectReceipt, memberActorId, now),
    ).toEqual({ kind })
    expect(
      verifySubjectDeletionNoticeReceiptForActor(subjectReceipt, otherMemberActorId, now),
    ).toBeNull()
    expect(verifyInstanceResetNoticeReceipt(subjectReceipt, now)).toBeNull()

    expect(verifyInstanceResetNoticeReceipt(resetReceipt, now)).toEqual({ kind })
    expect(
      verifyInstanceResetNoticeReceiptForActor(resetReceipt, ownerActorId, now),
    ).toEqual({ kind })
    expect(
      verifyInstanceResetNoticeReceiptForActor(
        resetReceipt,
        replacementOwnerActorId,
        now,
      ),
    ).toBeNull()
    expect(verifySubjectDeletionNoticeReceipt(resetReceipt, now)).toBeNull()
  })

  it('allows generic orientation but rejects a same-role different member', () => {
    const payload = {
      kind: 'outcome-unknown',
      actorRole: 'member',
    } as const
    const receipt = issueSubjectDeletionNoticeReceipt(payload, memberActorId, now)

    expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toEqual(payload)
    expect(
      verifySubjectDeletionNoticeReceiptForActor(receipt, memberActorId, now),
    ).toEqual(payload)
    expect(
      verifySubjectDeletionNoticeReceiptForActor(receipt, otherMemberActorId, now),
    ).toBeNull()
  })

  it('rejects an old owner receipt for a replacement owner', () => {
    const payload = { kind: 'outcome-unknown' } as const
    const receipt = issueInstanceResetNoticeReceipt(payload, ownerActorId, now)

    expect(verifyInstanceResetNoticeReceipt(receipt, now)).toEqual(payload)
    expect(verifyInstanceResetNoticeReceiptForActor(receipt, ownerActorId, now)).toEqual(
      payload,
    )
    expect(
      verifyInstanceResetNoticeReceiptForActor(receipt, replacementOwnerActorId, now),
    ).toBeNull()
  })

  it('contains only an opaque actor binding, never the raw actor identity or secret', () => {
    const privateActorId = 'member.user+destructive-receipt@example.test'
    const receipt = issueSubjectDeletionNoticeReceipt(
      { kind: 'deleted', actorRole: 'member', warning: 'cleanup-failed' },
      privateActorId,
      now,
    )

    expect(Buffer.byteLength(receipt, 'utf8')).toBeLessThanOrEqual(192)
    expect(receipt).not.toContain(authSecret)
    expect(receipt).not.toContain(privateActorId)
    expect(receipt).not.toContain(encodeURIComponent(privateActorId))
    expect(receipt).toMatch(
      /^dpnr2\.subject-deletion\.deleted\.member\.cleanup-failed\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}\.[1-9a-z][0-9a-z]*\.[1-9a-z][0-9a-z]*\.[A-Za-z0-9_-]{43}$/,
    )
  })

  it('derives distinct opaque bindings for different actors, purposes, and windows', () => {
    const payload = { kind: 'reset', warning: null } as const
    const first = issueInstanceResetNoticeReceipt(payload, ownerActorId, now)
    const otherActor = issueInstanceResetNoticeReceipt(
      payload,
      replacementOwnerActorId,
      now,
    )
    const otherWindow = issueInstanceResetNoticeReceipt(
      payload,
      ownerActorId,
      new Date(now.getTime() + 1_000),
    )
    const otherPurpose = issueSubjectDeletionNoticeReceipt(
      { kind: 'unavailable' },
      ownerActorId,
      now,
    )

    expect(first.split('.')[6]).not.toBe(otherActor.split('.')[6])
    expect(first.split('.')[6]).not.toBe(otherWindow.split('.')[6])
    expect(first.split('.')[6]).not.toBe(otherPurpose.split('.')[6])
    expect(first.split('.')[5]).not.toBe(otherActor.split('.')[5])

    const sameActorAndWindow = issueInstanceResetNoticeReceipt(
      { kind: 'outcome-unknown' },
      ownerActorId,
      now,
    )
    expect(first.split('.')[5]).not.toBe(sameActorAndWindow.split('.')[5])
    expect(first.split('.')[6]).not.toBe(sameActorAndWindow.split('.')[6])
  })

  it('rejects a tampered MAC, binding, or purpose rewritten in transit', () => {
    const receipt = issueSubjectDeletionNoticeReceipt(
      { kind: 'deleted', actorRole: 'member', warning: null },
      memberActorId,
      now,
    )
    const tamperedMac = `${receipt.slice(0, -1)}${receipt.endsWith('A') ? 'B' : 'A'}`
    const fields = receipt.split('.')
    fields[6] = `${fields[6]?.slice(0, -1)}${fields[6]?.endsWith('A') ? 'B' : 'A'}`
    const tamperedBinding = fields.join('.')
    const rewrittenPurpose = receipt.replace('.subject-deletion.', '.instance-reset.')

    for (const candidate of [tamperedMac, tamperedBinding, rewrittenPurpose]) {
      expect(verifySubjectDeletionNoticeReceipt(candidate, now)).toBeNull()
      expect(
        verifySubjectDeletionNoticeReceiptForActor(candidate, memberActorId, now),
      ).toBeNull()
    }
  })

  it('expires after fifteen minutes and rejects a receipt before its issue time', () => {
    const receipt = issueInstanceResetNoticeReceipt(
      { kind: 'outcome-unknown' },
      ownerActorId,
      now,
    )
    const lastValidInstant = new Date(nowSeconds * 1_000 + 15 * 60 * 1_000 - 1)
    const expiryInstant = new Date(nowSeconds * 1_000 + 15 * 60 * 1_000)
    const beforeIssue = new Date(nowSeconds * 1_000 - 1)

    expect(verifyInstanceResetNoticeReceipt(receipt, lastValidInstant)).toEqual({
      kind: 'outcome-unknown',
    })
    expect(
      verifyInstanceResetNoticeReceiptForActor(receipt, ownerActorId, lastValidInstant),
    ).toEqual({ kind: 'outcome-unknown' })
    expect(verifyInstanceResetNoticeReceipt(receipt, expiryInstant)).toBeNull()
    expect(
      verifyInstanceResetNoticeReceiptForActor(receipt, ownerActorId, expiryInstant),
    ).toBeNull()
    expect(verifyInstanceResetNoticeReceipt(receipt, beforeIssue)).toBeNull()
    expect(
      verifyInstanceResetNoticeReceiptForActor(receipt, ownerActorId, beforeIssue),
    ).toBeNull()
  })

  it('rejects validly signed but noncanonical, overlong, or invalid fixed-shape payloads', () => {
    const canonicalIssuedAt = nowSeconds.toString(36)
    const canonicalExpiresAt = (nowSeconds + 15 * 60).toString(36)
    const inputs = [
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        issuedAt: `0${canonicalIssuedAt}`,
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        expiresAt: (nowSeconds + 15 * 60 + 1).toString(36),
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'outcome-unknown',
        actorRole: 'owner',
        warning: 'cleanup-failed',
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'plan-invalid',
        actorRole: 'owner',
        warning: 'none',
      }),
      signedReceipt({
        purpose: 'instance-reset',
        kind: 'reset',
        actorRole: 'member',
        warning: 'none',
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        issuedAt: 'zzzzzzzzzzzzzzzz',
        expiresAt: canonicalExpiresAt,
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        nonce: 'a'.repeat(15),
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        nonce: 'a'.repeat(17),
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        nonce: `${'a'.repeat(15)}+`,
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        encodedActorBinding: 'a'.repeat(42),
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        encodedActorBinding: 'a'.repeat(44),
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        encodedActorBinding: `${'a'.repeat(42)}+`,
      }),
      signedReceipt({
        purpose: 'subject-deletion',
        kind: 'deleted',
        actorRole: 'owner',
        warning: 'none',
        // The final base64url character has nonzero discarded bits.
        encodedActorBinding: 'a'.repeat(43),
      }),
      'x'.repeat(193),
      'ü'.repeat(100),
    ]

    for (const receipt of inputs) {
      expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toBeNull()
      expect(
        verifySubjectDeletionNoticeReceiptForActor(receipt, ownerActorId, now),
      ).toBeNull()
      expect(verifyInstanceResetNoticeReceipt(receipt, now)).toBeNull()
      expect(
        verifyInstanceResetNoticeReceiptForActor(receipt, ownerActorId, now),
      ).toBeNull()
    }
  })

  it('invalidates a correctly signed legacy v1 receipt', () => {
    const receipt = legacyV1Receipt()

    expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toBeNull()
    expect(
      verifySubjectDeletionNoticeReceiptForActor(receipt, memberActorId, now),
    ).toBeNull()
    expect(verifyInstanceResetNoticeReceipt(receipt, now)).toBeNull()
  })

  it.each([
    null,
    undefined,
    '',
    'dpnr2.subject-deletion.deleted.owner.none.binding.abc.def',
    'dpnr2.subject-deletion.deleted.owner.none.binding.abc.def.invalid',
    'dpnr2.subject-deletion.deleted.owner.none.binding.abc.def.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extra',
    'dpnr2.subject-deletion.deleted.owner.none.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.abc.def.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa+',
    'dpnr2.subject-deletion.deleted.owner.none.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.abc.def.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ])('fails closed for malformed transport %#', (receipt) => {
    expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toBeNull()
    expect(
      verifySubjectDeletionNoticeReceiptForActor(receipt, memberActorId, now),
    ).toBeNull()
    expect(verifyInstanceResetNoticeReceipt(receipt, now)).toBeNull()
    expect(
      verifyInstanceResetNoticeReceiptForActor(receipt, ownerActorId, now),
    ).toBeNull()
  })

  it('fails closed for invalid actor input during verification', () => {
    const subjectReceipt = issueSubjectDeletionNoticeReceipt(
      { kind: 'outcome-unknown', actorRole: 'member' },
      memberActorId,
      now,
    )
    const resetReceipt = issueInstanceResetNoticeReceipt(
      { kind: 'outcome-unknown' },
      ownerActorId,
      now,
    )
    const invalidActors = [
      null,
      undefined,
      '',
      'actor\0suffix',
      'a'.repeat(513),
      'ü'.repeat(257),
    ]

    for (const actorUserId of invalidActors) {
      expect(
        verifySubjectDeletionNoticeReceiptForActor(subjectReceipt, actorUserId, now),
      ).toBeNull()
      expect(
        verifyInstanceResetNoticeReceiptForActor(resetReceipt, actorUserId, now),
      ).toBeNull()
    }
    expect(verifySubjectDeletionNoticeReceipt(subjectReceipt, now)).not.toBeNull()
    expect(verifyInstanceResetNoticeReceipt(resetReceipt, now)).not.toBeNull()
  })

  it('refuses invalid actors during issuance', () => {
    const invalidActors = [
      null,
      undefined,
      '',
      'actor\0suffix',
      'a'.repeat(513),
      'ü'.repeat(257),
    ]

    for (const actorUserId of invalidActors) {
      expect(() =>
        issueSubjectDeletionNoticeReceipt(
          { kind: 'outcome-unknown', actorRole: 'member' },
          actorUserId as never,
          now,
        ),
      ).toThrow('actor')
      expect(() =>
        issueInstanceResetNoticeReceipt(
          { kind: 'outcome-unknown' },
          actorUserId as never,
          now,
        ),
      ).toThrow('actor')
    }
  })

  it('fails closed for an invalid clock and refuses invalid payload input', () => {
    const receipt = issueInstanceResetNoticeReceipt(
      { kind: 'reset', warning: null },
      ownerActorId,
      now,
    )

    expect(verifyInstanceResetNoticeReceipt(receipt, new Date(Number.NaN))).toBeNull()
    expect(
      verifyInstanceResetNoticeReceiptForActor(
        receipt,
        ownerActorId,
        new Date(Number.NaN),
      ),
    ).toBeNull()
    expect(() =>
      issueInstanceResetNoticeReceipt(
        { kind: 'reset', warning: null },
        ownerActorId,
        new Date(0),
      ),
    ).toThrow('clock')
    expect(() =>
      issueSubjectDeletionNoticeReceipt(
        {
          kind: 'deleted',
          actorRole: 'administrator',
          warning: null,
        } as never,
        memberActorId,
        now,
      ),
    ).toThrow('actor role')
    expect(() =>
      issueInstanceResetNoticeReceipt(
        { kind: 'reset', warning: 'email@example.test' } as never,
        ownerActorId,
        now,
      ),
    ).toThrow('warning')
  })
})
