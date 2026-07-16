import { describe, expect, it } from 'vitest'
import {
  ExpiredSessionMaintenanceError,
  encodeExpiredSessionMaintenanceCursor,
  parseExpiredSessionMaintenanceInput,
  toExpiredSessionMaintenanceResult,
} from './expired-session-maintenance'

const cutoff = new Date('2026-07-15T12:00:00.000Z')
const expiry = '2026-07-14T11:00:00.000000Z'

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

describe('expired-session maintenance application contract', () => {
  it('parses a fresh bounded page against one cloned sweep cutoff', () => {
    const parsed = parseExpiredSessionMaintenanceInput({ batchSize: 64, now: cutoff })
    expect(parsed).toEqual({
      batchSize: 64,
      cursor: null,
      sweepCutoff: cutoff,
      seek: null,
    })
    expect(parsed.sweepCutoff).not.toBe(cutoff)
    cutoff.setUTCFullYear(2030)
    expect(parsed.sweepCutoff.toISOString()).toBe('2026-07-15T12:00:00.000Z')
    cutoff.setUTCFullYear(2026)
  })

  it('round-trips a canonical opaque cursor with a non-UUID session identity', () => {
    const cursor = encodeExpiredSessionMaintenanceCursor({
      sweepCutoff: cutoff,
      last: { expiresAt: expiry, id: 'better-auth/session:not-a-uuid' },
    })
    const parsed = parseExpiredSessionMaintenanceInput({
      batchSize: 7,
      cursor,
      now: new Date('2099-01-01T00:00:00.000Z'),
    })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(cursor).not.toContain('=')
    expect(parsed).toEqual({
      batchSize: 7,
      cursor,
      sweepCutoff: cutoff,
      seek: { expiresAt: expiry, id: 'better-auth/session:not-a-uuid' },
    })
  })

  it('keeps every accepted 512-byte provider identity representable', () => {
    const id = '\u0001'.repeat(512)
    const cursor = encodeExpiredSessionMaintenanceCursor({
      sweepCutoff: cutoff,
      last: { expiresAt: expiry, id },
    })
    expect(cursor.length).toBeGreaterThan(300)
    expect(cursor.length).toBeLessThanOrEqual(8_192)
    expect(
      parseExpiredSessionMaintenanceInput({
        batchSize: 1,
        cursor,
        now: cutoff,
      }).seek,
    ).toEqual({ expiresAt: expiry, id })
  })

  it('rejects invalid page input without accepting Date or integer coercion', () => {
    for (const input of [
      { batchSize: 0 },
      { batchSize: 65 },
      { batchSize: 1.5 },
      { batchSize: '4' },
      { batchSize: 4, now: new Date(Number.NaN) },
      { batchSize: 4, now: cutoff.toISOString() },
    ]) {
      expect(() => parseExpiredSessionMaintenanceInput(input as never)).toThrowError(
        expect.objectContaining({
          code: 'expired-session-maintenance.invalid-input',
        }),
      )
    }
  })

  it('rejects malformed, padded, non-canonical, oversized, and forward cursors', () => {
    const cases = [
      '',
      'not+base64url',
      `${encoded([1, cutoff.toISOString(), expiry, 'id'])}=`,
      encoded([2, cutoff.toISOString(), expiry, 'id']),
      encoded([1, cutoff.toISOString(), expiry, 'id', 'extra']),
      encoded([1, '2026-07-15T12:00:00Z', expiry, 'id']),
      encoded([1, cutoff.toISOString(), '2026-07-14T11:00:00.000Z', 'id']),
      encoded([1, cutoff.toISOString(), '0000-01-01T00:00:00.000000Z', 'id']),
      encoded([1, cutoff.toISOString(), '2026-07-15T12:00:00.001000Z', 'id']),
      encoded([1, cutoff.toISOString(), expiry, '']),
      encodeExpiredSessionMaintenanceCursor({
        sweepCutoff: new Date('2099-01-01T00:00:00.000Z'),
        last: { expiresAt: expiry, id: 'future-cutoff' },
      }),
      'a'.repeat(8_193),
    ]
    for (const cursor of cases) {
      expect(() =>
        parseExpiredSessionMaintenanceInput({ batchSize: 4, cursor, now: cutoff }),
      ).toThrowError(
        expect.objectContaining({
          code: 'expired-session-maintenance.invalid-cursor',
        }),
      )
    }
  })

  it('maps terminal and continuation pages without exposing the cutoff separately', () => {
    expect(
      toExpiredSessionMaintenanceResult({
        sweepCutoff: cutoff,
        page: {
          deletedSessionCount: 2,
          complete: true,
          last: { expiresAt: expiry, id: 'b' },
        },
      }),
    ).toEqual({ status: 'complete', deletedCount: 2, nextCursor: null })

    const continued = toExpiredSessionMaintenanceResult({
      sweepCutoff: cutoff,
      page: {
        deletedSessionCount: 2,
        complete: false,
        last: { expiresAt: expiry, id: 'b' },
      },
    })
    expect(continued).toMatchObject({ status: 'continue', deletedCount: 2 })
    if (continued.status !== 'continue') throw new Error('Expected continuation.')
    expect(
      parseExpiredSessionMaintenanceInput({
        batchSize: 2,
        cursor: continued.nextCursor,
        now: cutoff,
      }).seek,
    ).toEqual({ expiresAt: expiry, id: 'b' })
  })

  it('fails closed before emitting an unusable or incoherent result cursor', () => {
    const cases = [
      { deletedSessionCount: -1, complete: true, last: null },
      { deletedSessionCount: 1, complete: false, last: null },
      { deletedSessionCount: 0, complete: false, last: { expiresAt: expiry, id: 'x' } },
      {
        deletedSessionCount: 1,
        complete: false,
        last: { expiresAt: expiry, id: 'x'.repeat(513) },
      },
    ] as const
    for (const page of cases) {
      expect(() =>
        toExpiredSessionMaintenanceResult({ sweepCutoff: cutoff, page }),
      ).toThrowError(ExpiredSessionMaintenanceError)
    }
  })
})
