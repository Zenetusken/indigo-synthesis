import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { session } from '@/platform/db/schema'
import {
  captureExpiredSessionMaintenance,
  type ExpiredSessionMaintenanceCapture,
  type IdentityExpiredSessionMaintenanceQuery,
  recheckExpiredSessionMaintenance,
} from './expired-session-maintenance'
import {
  createScopedExpiredSessionMaintenanceMutationGateway,
  ScopedExpiredSessionMaintenanceInvariantError,
} from './scoped-expired-session-maintenance'

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const ownerUserId = 'owner-user'
const hostInvocationId = 'maintenance-invocation-1'
const cutoff = new Date('2026-07-15T12:00:00.000Z')
const firstExpiry = '2026-07-01T10:00:00.000000Z'
const secondExpiry = '2026-07-02T10:00:00.000000Z'

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

function snapshotRow(
  sessions: readonly Record<string, unknown>[] = [
    { id: 'session-a', accountUserId: 'user-a', expiresAt: firstExpiry },
    { id: 'session-b', accountUserId: 'user-b', expiresAt: secondExpiry },
  ],
): ResultRow {
  return {
    product_mutation_epoch: epoch,
    installation_owner_user_id: ownerUserId,
    expired_session_rows: sessions,
  }
}

function repeatedQuery(row: ResultRow): IdentityExpiredSessionMaintenanceQuery {
  return {
    query: vi.fn().mockResolvedValue(result(row)),
  } as unknown as IdentityExpiredSessionMaintenanceQuery
}

async function captureFor(
  sessions: readonly Record<string, unknown>[],
  batchSize = sessions.length,
) {
  const row = snapshotRow(sessions)
  const query = repeatedQuery(row)
  const capture = await captureExpiredSessionMaintenance(query, {
    hostInvocationId,
    authorityCursor: null,
    cutoff,
    seek: null,
    batchSize,
  })
  return { capture, query }
}

async function recheckedCapture(
  sessions: readonly Record<string, unknown>[],
  batchSize = sessions.length,
) {
  const prepared = await captureFor(sessions, batchSize)
  await expect(
    recheckExpiredSessionMaintenance(prepared.query, prepared.capture),
  ).resolves.toEqual({ status: 'current' })
  return prepared.capture
}

function fakeDatabase(returned: readonly unknown[]) {
  const operations: Array<Readonly<{ table: unknown; condition: unknown }>> = []
  const database = {
    delete(table: unknown) {
      const builder = {
        where(condition: unknown) {
          operations.push({ table, condition })
          return builder
        },
        returning() {
          return Promise.resolve(returned)
        },
      }
      return builder
    },
  }
  return { database: database as never, operations }
}

const capturedRows = [
  { id: 'session-a', accountUserId: 'user-a', expiresAt: firstExpiry },
  { id: 'session-b', accountUserId: 'user-b', expiresAt: secondExpiry },
] as const

describe('scoped expired-session maintenance gateway', () => {
  it('claims lazily after recheck and deletes only the captured IDs with exact evidence', async () => {
    const { capture, query } = await captureFor(capturedRows)
    const { database, operations } = fakeDatabase([
      { id: 'session-b', accountUserId: 'user-b' },
      { id: 'session-a', accountUserId: 'user-a' },
    ])
    const gateway = createScopedExpiredSessionMaintenanceMutationGateway(
      database,
      capture,
    )
    expect(operations).toEqual([])

    await expect(recheckExpiredSessionMaintenance(query, capture)).resolves.toEqual({
      status: 'current',
    })
    await expect(gateway.deleteCapturedPage()).resolves.toEqual({
      deletedSessionCount: 2,
      complete: false,
      last: { expiresAt: secondExpiry, id: 'session-b' },
    })
    expect(operations).toHaveLength(1)
    expect(operations[0]?.table).toBe(session)

    const operationCount = operations.length
    expect(() => gateway.deleteCapturedPage()).toThrow(
      ScopedExpiredSessionMaintenanceInvariantError,
    )
    expect(operations).toHaveLength(operationCount)
  })

  it('reports a partial page as complete and returns the captured terminal tuple', async () => {
    const capture = await recheckedCapture(capturedRows, 3)
    const { database } = fakeDatabase([
      { id: 'session-a', accountUserId: 'user-a' },
      { id: 'session-b', accountUserId: 'user-b' },
    ])
    const gateway = createScopedExpiredSessionMaintenanceMutationGateway(
      database,
      capture,
    )

    await expect(gateway.deleteCapturedPage()).resolves.toEqual({
      deletedSessionCount: 2,
      complete: true,
      last: { expiresAt: secondExpiry, id: 'session-b' },
    })
  })

  it('accepts an empty terminal page without issuing broad or empty-list DML', async () => {
    const capture = await recheckedCapture([], 100)
    const { database, operations } = fakeDatabase([])
    const gateway = createScopedExpiredSessionMaintenanceMutationGateway(
      database,
      capture,
    )

    await expect(gateway.deleteCapturedPage()).resolves.toEqual({
      deletedSessionCount: 0,
      complete: true,
      last: null,
    })
    expect(operations).toEqual([])
  })

  it('rejects missing, duplicate, extra, and cross-account deletion evidence', async () => {
    const evidenceCases: readonly (readonly unknown[])[] = [
      [{ id: 'session-a', accountUserId: 'user-a' }],
      [
        { id: 'session-a', accountUserId: 'user-a' },
        { id: 'session-a', accountUserId: 'user-a' },
      ],
      [
        { id: 'session-a', accountUserId: 'user-a' },
        { id: 'session-b', accountUserId: 'user-b' },
        { id: 'session-c', accountUserId: 'user-c' },
      ],
      [
        { id: 'session-a', accountUserId: 'user-a' },
        { id: 'session-b', accountUserId: 'user-a' },
      ],
    ]

    for (const returned of evidenceCases) {
      const capture = await recheckedCapture(capturedRows)
      const { database } = fakeDatabase(returned)
      const gateway = createScopedExpiredSessionMaintenanceMutationGateway(
        database,
        capture,
      )
      await expect(gateway.deleteCapturedPage()).rejects.toBeInstanceOf(
        ScopedExpiredSessionMaintenanceInvariantError,
      )
    }
  })

  it('rejects pre-recheck, forged, and cross-purpose captures before DML', async () => {
    const { capture } = await captureFor(capturedRows)
    const captures = [
      capture,
      Object.create(
        (capture as object).constructor.prototype,
      ) as ExpiredSessionMaintenanceCapture,
      Object.freeze({
        purpose: 'owner-recovery-issue',
      }) as unknown as ExpiredSessionMaintenanceCapture,
    ]

    for (const candidate of captures) {
      const { database, operations } = fakeDatabase([])
      const gateway = createScopedExpiredSessionMaintenanceMutationGateway(
        database,
        candidate,
      )
      await expect(gateway.deleteCapturedPage()).rejects.toThrow(/not issued|fresh/)
      expect(operations).toEqual([])
      expect(() => gateway.deleteCapturedPage()).toThrow(
        ScopedExpiredSessionMaintenanceInvariantError,
      )
    }
  })
})
