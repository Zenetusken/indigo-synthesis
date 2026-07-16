import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  captureExpiredSessionMaintenance,
  claimExpiredSessionMaintenanceMutationScope,
  ExpiredSessionMaintenanceCapture,
  ExpiredSessionMaintenanceCaptureInvariantError,
  expiredSessionMaintenanceCaptureView,
  type IdentityExpiredSessionMaintenanceQuery,
  maximumExpiredSessionMaintenanceBatchSize,
  recheckExpiredSessionMaintenance,
} from './expired-session-maintenance'

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const nextEpoch = '223e4567-e89b-42d3-a456-426614174001'
const ownerUserId = 'owner-user'
const hostInvocationId = 'maintenance-invocation-1'
const authorityCursor = 'encoded-maintenance-cursor'
const cutoff = new Date('2026-07-15T12:00:00.000Z')
const firstExpiry = '2026-07-01T10:00:00.000000Z'
const secondExpiry = '2026-07-02T10:00:00.000000Z'
const seek = Object.freeze({ expiresAt: firstExpiry, id: 'session-before-page' })

type ResultRow = QueryResultRow & Record<string, unknown>

function result(row: ResultRow): QueryResult<ResultRow> {
  return {
    command: 'SELECT',
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [row],
  }
}

function querySequence(...rows: readonly ResultRow[]) {
  const query = vi.fn()
  for (const row of rows) query.mockResolvedValueOnce(result(row))
  return {
    query,
    surface: { query } as unknown as IdentityExpiredSessionMaintenanceQuery,
  }
}

function sessionRow(
  id: string,
  accountUserId: string,
  expiresAt: string,
): Record<string, unknown> {
  return { id, accountUserId, expiresAt }
}

function snapshotRow(
  input: {
    readonly epoch?: string
    readonly ownerUserId?: string | null
    readonly sessions?: readonly Record<string, unknown>[]
  } = {},
): ResultRow {
  return {
    product_mutation_epoch: input.epoch ?? epoch,
    installation_owner_user_id:
      input.ownerUserId === undefined ? ownerUserId : input.ownerUserId,
    expired_session_rows: input.sessions ?? [
      sessionRow('session-a', 'user-z', secondExpiry),
      sessionRow('session-b', 'user-a', secondExpiry),
      sessionRow('session-c', 'user-z', '2026-07-03T10:00:00.000000Z'),
    ],
  }
}

function captureInput(
  overrides: Partial<Parameters<typeof captureExpiredSessionMaintenance>[1]> = {},
) {
  return {
    hostInvocationId,
    authorityCursor,
    cutoff,
    seek,
    batchSize: 3,
    ...overrides,
  }
}

describe('expired-session maintenance capture', () => {
  it('captures one fixed seek page and exposes only redacted canonical lock bindings', async () => {
    const { query, surface } = querySequence(snapshotRow())
    const capture = await captureExpiredSessionMaintenance(surface, captureInput())
    const view = expiredSessionMaintenanceCaptureView(capture)

    expect(view).toEqual({
      purpose: 'expired-session-maintenance',
      expectedEpoch: epoch,
      ownerUserId,
      hostInvocationId,
      authorityCursor,
      batchSize: 3,
      capturedSessionCount: 3,
      resolvedAccountUserIds: ['user-a', 'user-z'],
    })
    expect(view).not.toHaveProperty('sessions')
    expect(JSON.stringify(view)).not.toContain('session-a')

    const [statement, values] = query.mock.calls[0] ?? []
    expect(statement).toContain('(candidate.expires_at, candidate.id COLLATE "C")')
    expect(statement).toContain('> ($2::timestamptz, $3::text COLLATE "C")')
    expect(statement).toContain('ORDER BY candidate.expires_at, candidate.id COLLATE "C"')
    expect(statement).toContain('LIMIT $4')
    expect(statement).not.toMatch(/SKIP\s+LOCKED/i)
    expect(statement).not.toMatch(/CURRENT_(?:DATE|TIME|TIMESTAMP)/i)
    expect(values).toEqual([cutoff, firstExpiry, seek.id, 3])
  })

  it('rechecks the exact page once, then yields one post-recheck private scope', async () => {
    const row = snapshotRow()
    const { query, surface } = querySequence(row, row)
    const capture = await captureExpiredSessionMaintenance(surface, captureInput())

    await expect(recheckExpiredSessionMaintenance(surface, capture)).resolves.toEqual({
      status: 'current',
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]?.[1]).toEqual([cutoff, firstExpiry, seek.id, 3])
    expect(() => expiredSessionMaintenanceCaptureView(capture)).toThrow('no longer fresh')

    const scope = claimExpiredSessionMaintenanceMutationScope(capture)
    expect(scope).toMatchObject({
      purpose: 'expired-session-maintenance',
      hostInvocationId,
      authorityCursor,
      cutoff,
      seek,
      batchSize: 3,
      ownerUserId,
    })
    expect(scope.sessions).toEqual([
      { id: 'session-a', accountUserId: 'user-z', expiresAt: secondExpiry },
      { id: 'session-b', accountUserId: 'user-a', expiresAt: secondExpiry },
      {
        id: 'session-c',
        accountUserId: 'user-z',
        expiresAt: '2026-07-03T10:00:00.000000Z',
      },
    ])
    expect(() => claimExpiredSessionMaintenanceMutationScope(capture)).toThrow(
      'no longer fresh',
    )
    await expect(recheckExpiredSessionMaintenance(surface, capture)).rejects.toThrow(
      'no longer fresh',
    )
  })

  it('spends a stale capture for every installation or exact-page drift', async () => {
    const changes: readonly [ResultRow, string][] = [
      [snapshotRow({ epoch: nextEpoch }), 'installation-epoch-changed'],
      [
        snapshotRow({ ownerUserId: 'replacement-owner' }),
        'installation-authority-changed',
      ],
      [
        snapshotRow({
          sessions: [sessionRow('replacement-session', 'user-z', secondExpiry)],
        }),
        'session-page-changed',
      ],
    ]

    for (const [changed, reason] of changes) {
      const { surface } = querySequence(snapshotRow(), changed)
      const capture = await captureExpiredSessionMaintenance(surface, captureInput())
      await expect(recheckExpiredSessionMaintenance(surface, capture)).resolves.toEqual({
        status: 'stale',
        reason,
      })
      expect(() => claimExpiredSessionMaintenanceMutationScope(capture)).toThrow(
        'no longer fresh',
      )
    }
  })

  it('accepts an empty terminal page and a bootstrap-open installation snapshot', async () => {
    const row = snapshotRow({ ownerUserId: null, sessions: [] })
    const { surface } = querySequence(row, row)
    const capture = await captureExpiredSessionMaintenance(
      surface,
      captureInput({
        authorityCursor: null,
        seek: null,
        batchSize: maximumExpiredSessionMaintenanceBatchSize,
      }),
    )
    expect(expiredSessionMaintenanceCaptureView(capture)).toMatchObject({
      ownerUserId: null,
      capturedSessionCount: 0,
      resolvedAccountUserIds: [],
    })
    await expect(recheckExpiredSessionMaintenance(surface, capture)).resolves.toEqual({
      status: 'current',
    })
    expect(claimExpiredSessionMaintenanceMutationScope(capture).sessions).toEqual([])
  })

  it('rejects malformed input before querying and incoherent database pages', async () => {
    const inputCases = [
      captureInput({ batchSize: 0 }),
      captureInput({ batchSize: maximumExpiredSessionMaintenanceBatchSize + 1 }),
      captureInput({ cutoff: new Date(Number.NaN) }),
      captureInput({ authorityCursor: null }),
      captureInput({ seek: null }),
      captureInput({ hostInvocationId: '' }),
      captureInput({ authorityCursor: 'a'.repeat(8_193) }),
    ]
    for (const input of inputCases) {
      const { query, surface } = querySequence(snapshotRow())
      await expect(captureExpiredSessionMaintenance(surface, input)).rejects.toThrow(
        /invalid/i,
      )
      expect(query).not.toHaveBeenCalled()
    }

    const malformedPages = [
      [
        sessionRow('session-b', 'user-a', secondExpiry),
        sessionRow('session-a', 'user-a', secondExpiry),
      ],
      [sessionRow('session-before-page', 'user-a', firstExpiry)],
      [sessionRow('session-after-cutoff', 'user-a', '2026-07-15T12:00:00.001000Z')],
      [sessionRow('', 'user-a', secondExpiry)],
      [sessionRow('three-digit-expiry', 'user-a', '2026-07-02T10:00:00.000Z')],
      [sessionRow('year-zero-expiry', 'user-a', '0000-01-01T00:00:00.000000Z')],
    ]
    for (const sessions of malformedPages) {
      const { surface } = querySequence(snapshotRow({ sessions }))
      await expect(
        captureExpiredSessionMaintenance(surface, captureInput()),
      ).rejects.toBeInstanceOf(ExpiredSessionMaintenanceCaptureInvariantError)
    }

    const { surface } = querySequence({
      ...snapshotRow(),
      product_mutation_epoch: [epoch],
    })
    await expect(
      captureExpiredSessionMaintenance(surface, captureInput()),
    ).rejects.toBeInstanceOf(ExpiredSessionMaintenanceCaptureInvariantError)
  })

  it('preserves PostgreSQL microseconds when validating SQL tuple order', async () => {
    const sessions = [
      sessionRow('z-earlier', 'user-a', '2026-07-02T10:00:00.000100Z'),
      sessionRow('a-later', 'user-a', '2026-07-02T10:00:00.000200Z'),
    ]
    const row = snapshotRow({ sessions })
    const { surface } = querySequence(row, row)
    const capture = await captureExpiredSessionMaintenance(
      surface,
      captureInput({ authorityCursor: null, seek: null, batchSize: 2 }),
    )

    await expect(recheckExpiredSessionMaintenance(surface, capture)).resolves.toEqual({
      status: 'current',
    })
    expect(claimExpiredSessionMaintenanceMutationScope(capture).sessions).toEqual([
      {
        id: 'z-earlier',
        accountUserId: 'user-a',
        expiresAt: '2026-07-02T10:00:00.000100Z',
      },
      {
        id: 'a-later',
        accountUserId: 'user-a',
        expiresAt: '2026-07-02T10:00:00.000200Z',
      },
    ])
  })

  it('rejects forged and cross-purpose capture objects without querying', async () => {
    const captures = [
      Object.create(
        ExpiredSessionMaintenanceCapture.prototype,
      ) as ExpiredSessionMaintenanceCapture,
      Object.freeze({
        purpose: 'owner-recovery-issue',
      }) as unknown as ExpiredSessionMaintenanceCapture,
    ]
    for (const capture of captures) {
      const { query, surface } = querySequence(snapshotRow())
      expect(() => expiredSessionMaintenanceCaptureView(capture)).toThrow('not issued')
      await expect(recheckExpiredSessionMaintenance(surface, capture)).rejects.toThrow(
        'not issued',
      )
      expect(() => claimExpiredSessionMaintenanceMutationScope(capture)).toThrow(
        'not issued',
      )
      expect(query).not.toHaveBeenCalled()
    }
  })
})
