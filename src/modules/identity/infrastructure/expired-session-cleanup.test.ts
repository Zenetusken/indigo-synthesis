import type { QueryResult } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { IdentityAuthMutationQuery } from './auth-mutation-capture'
import {
  accountSessionCleanupBatchSize,
  cleanupExpiredAccountSessions,
} from './expired-session-cleanup'

function querySurface(deletedCount: number) {
  const query = vi.fn().mockResolvedValue({
    command: 'SELECT',
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [{ deleted_count: deletedCount }],
  } satisfies QueryResult<{ deleted_count: number }>)
  return { query, surface: { query } as unknown as IdentityAuthMutationQuery }
}

describe('bounded account session cleanup', () => {
  it('binds a canonical account scope and one fixed deterministic page', async () => {
    const { query, surface } = querySurface(2)
    const now = new Date('2026-07-15T12:00:00.000Z')

    await expect(
      cleanupExpiredAccountSessions(surface, ['user-z', 'user-a'], now),
    ).resolves.toBe(2)
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      [['user-a', 'user-z'], now, accountSessionCleanupBatchSize],
    )
    expect(query.mock.calls[0]?.[0]).toEqual(expect.stringContaining('ORDER BY'))
    expect(query.mock.calls[0]?.[0]).toEqual(expect.stringContaining('DELETE FROM'))
  })

  it('executes the same bounded work class for an empty resolved-account scope', async () => {
    const { query, surface } = querySurface(0)
    await expect(cleanupExpiredAccountSessions(surface, [])).resolves.toBe(0)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WITH expired_sessions'), [
      [],
      expect.any(Date),
      accountSessionCleanupBatchSize,
    ])
  })

  it('rejects duplicate accounts and impossible deletion evidence', async () => {
    const duplicate = querySurface(0)
    await expect(
      cleanupExpiredAccountSessions(duplicate.surface, ['user-a', 'user-a']),
    ).rejects.toThrow('account scope')
    expect(duplicate.query).not.toHaveBeenCalled()

    const oversizedResult = querySurface(accountSessionCleanupBatchSize + 1)
    await expect(
      cleanupExpiredAccountSessions(oversizedResult.surface, ['user-a']),
    ).rejects.toThrow('invalid deletion evidence')
  })
})
