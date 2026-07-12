import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedActor } from './actor'
import { OwnerAuthorizationError } from './actor'
import { type LocalUserReader, listLocalUsers } from './local-users'

const owner: AuthenticatedActor = {
  userId: 'owner-id',
  email: 'owner@example.test',
  name: 'Owner',
  role: 'owner',
}

describe('local user queries', () => {
  it('returns repository summaries through the owner-authorized application boundary', async () => {
    const summaries = [
      {
        id: 'owner-id',
        email: 'owner@example.test',
        name: 'Owner',
        createdAt: new Date('2026-07-11T12:00:00.000Z'),
      },
    ]
    const reader: LocalUserReader = { list: vi.fn().mockResolvedValue(summaries) }

    await expect(listLocalUsers(owner, reader)).resolves.toEqual(summaries)
    expect(reader.list).toHaveBeenCalledOnce()
  })

  it('rejects members before invoking the persistence adapter', async () => {
    const reader: LocalUserReader = { list: vi.fn() }

    await expect(
      listLocalUsers({ ...owner, userId: 'member-id', role: 'member' }, reader),
    ).rejects.toBeInstanceOf(OwnerAuthorizationError)
    expect(reader.list).not.toHaveBeenCalled()
  })
})
