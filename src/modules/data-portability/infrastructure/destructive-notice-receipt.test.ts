import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import {
  issueInstanceResetNoticeReceipt,
  issueSubjectDeletionNoticeReceipt,
  verifyInstanceResetNoticeReceipt,
  verifySubjectDeletionNoticeReceipt,
} from './destructive-notice-receipt'

const authSecret = 'destructive-notice-receipt-test-secret-at-least-32-characters'
const receiptDomain = 'indigo-data-portability-destructive-notice-receipt-v1\0'
const now = new Date('2026-07-16T12:00:00.500Z')
const nowSeconds = Math.floor(now.getTime() / 1_000)

function signedReceipt(fields: {
  readonly purpose: string
  readonly kind: string
  readonly actorRole: string
  readonly warning: string
  readonly issuedAt?: string
  readonly expiresAt?: string
}): string {
  const issuedAt = fields.issuedAt ?? nowSeconds.toString(36)
  const expiresAt = fields.expiresAt ?? (nowSeconds + 15 * 60).toString(36)
  const payload = [
    'dpnr1',
    fields.purpose,
    fields.kind,
    fields.actorRole,
    fields.warning,
    issuedAt,
    expiresAt,
  ].join('.')
  const signature = createHmac('sha256', authSecret)
    .update(receiptDomain, 'utf8')
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
    const receipt = issueSubjectDeletionNoticeReceipt(payload, now)

    expect(receipt.split('.')).toHaveLength(8)
    expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toEqual(payload)
    expect(verifyInstanceResetNoticeReceipt(receipt, now)).toBeNull()
  })

  it.each([
    { kind: 'reset', warning: null },
    { kind: 'reset', warning: 'cleanup-failed' },
    { kind: 'outcome-unknown' },
  ] as const)('round-trips the instance-reset payload %#', (payload) => {
    const receipt = issueInstanceResetNoticeReceipt(payload, now)

    expect(receipt.split('.')).toHaveLength(8)
    expect(verifyInstanceResetNoticeReceipt(receipt, now)).toEqual(payload)
    expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toBeNull()
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
  ] as const)('round-trips purpose-separated failure kind %s', (kind) => {
    const subjectReceipt = issueSubjectDeletionNoticeReceipt({ kind }, now)
    const resetReceipt = issueInstanceResetNoticeReceipt({ kind }, now)

    expect(verifySubjectDeletionNoticeReceipt(subjectReceipt, now)).toEqual({ kind })
    expect(verifyInstanceResetNoticeReceipt(subjectReceipt, now)).toBeNull()
    expect(verifyInstanceResetNoticeReceipt(resetReceipt, now)).toEqual({ kind })
    expect(verifySubjectDeletionNoticeReceipt(resetReceipt, now)).toBeNull()
  })

  it('contains no actor identity, email, authentication secret, or unbounded field', () => {
    const receipt = issueSubjectDeletionNoticeReceipt(
      { kind: 'deleted', actorRole: 'owner', warning: 'cleanup-failed' },
      now,
    )

    expect(Buffer.byteLength(receipt, 'utf8')).toBeLessThanOrEqual(192)
    expect(receipt).not.toContain(authSecret)
    expect(receipt).not.toContain('owner@example.test')
    expect(receipt).not.toContain('019f-actor-id')
    expect(receipt).toMatch(
      /^dpnr1\.subject-deletion\.deleted\.owner\.cleanup-failed\.[1-9a-z][0-9a-z]*\.[1-9a-z][0-9a-z]*\.[A-Za-z0-9_-]{43}$/,
    )
  })

  it('rejects a tampered MAC and a purpose rewritten in transit', () => {
    const receipt = issueSubjectDeletionNoticeReceipt(
      { kind: 'deleted', actorRole: 'member', warning: null },
      now,
    )
    const tampered = `${receipt.slice(0, -1)}${receipt.endsWith('A') ? 'B' : 'A'}`
    const rewritten = receipt.replace('.subject-deletion.', '.instance-reset.')

    expect(verifySubjectDeletionNoticeReceipt(tampered, now)).toBeNull()
    expect(verifySubjectDeletionNoticeReceipt(rewritten, now)).toBeNull()
  })

  it('expires after fifteen minutes and rejects a receipt before its issue time', () => {
    const receipt = issueInstanceResetNoticeReceipt({ kind: 'outcome-unknown' }, now)

    expect(
      verifyInstanceResetNoticeReceipt(
        receipt,
        new Date(nowSeconds * 1_000 + 15 * 60 * 1_000 - 1),
      ),
    ).toEqual({ kind: 'outcome-unknown' })
    expect(
      verifyInstanceResetNoticeReceipt(
        receipt,
        new Date(nowSeconds * 1_000 + 15 * 60 * 1_000),
      ),
    ).toBeNull()
    expect(
      verifyInstanceResetNoticeReceipt(receipt, new Date(nowSeconds * 1_000 - 1)),
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
      'x'.repeat(193),
      'ü'.repeat(100),
    ]

    for (const receipt of inputs) {
      expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toBeNull()
      expect(verifyInstanceResetNoticeReceipt(receipt, now)).toBeNull()
    }
  })

  it.each([
    null,
    undefined,
    '',
    'dpnr1.subject-deletion.deleted.owner.none.abc.def',
    'dpnr1.subject-deletion.deleted.owner.none.abc.def.invalid',
    'dpnr1.subject-deletion.deleted.owner.none.abc.def.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extra',
    'dpnr1.subject-deletion.deleted.owner.none.abc.def.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa+',
    'dpnr1.subject-deletion.deleted.owner.none.abc.def.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ])('fails closed for malformed transport %#', (receipt) => {
    expect(verifySubjectDeletionNoticeReceipt(receipt, now)).toBeNull()
    expect(verifyInstanceResetNoticeReceipt(receipt, now)).toBeNull()
  })

  it('fails closed for an invalid verification clock and refuses invalid issuance input', () => {
    const receipt = issueInstanceResetNoticeReceipt({ kind: 'reset', warning: null }, now)

    expect(verifyInstanceResetNoticeReceipt(receipt, new Date(Number.NaN))).toBeNull()
    expect(() =>
      issueInstanceResetNoticeReceipt({ kind: 'reset', warning: null }, new Date(0)),
    ).toThrow('clock')
    expect(() =>
      issueSubjectDeletionNoticeReceipt(
        {
          kind: 'deleted',
          actorRole: 'administrator',
          warning: null,
        } as never,
        now,
      ),
    ).toThrow('actor role')
    expect(() =>
      issueInstanceResetNoticeReceipt(
        { kind: 'reset', warning: 'email@example.test' } as never,
        now,
      ),
    ).toThrow('warning')
  })
})
