import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateDatabaseFromHostCli } from './host-migrate'

const hostMocks = vi.hoisted(() => ({
  migrateDatabaseWithClient: vi.fn(),
  newUuidV7: vi.fn(),
  withExternalHostClientOwner: vi.fn(),
}))

vi.mock('@/platform/ids/uuid-v7', () => ({
  newUuidV7: hostMocks.newUuidV7,
}))

vi.mock('./external-host-one-shot', () => ({
  withExternalHostClientOwner: hostMocks.withExternalHostClientOwner,
}))

vi.mock('./migration-executor', () => ({
  migrateDatabaseWithClient: hostMocks.migrateDatabaseWithClient,
}))

beforeEach(() => {
  hostMocks.newUuidV7.mockReset().mockReturnValue('host-migration-id')
  hostMocks.withExternalHostClientOwner.mockReset().mockResolvedValue(undefined)
  hostMocks.migrateDatabaseWithClient.mockReset().mockResolvedValue(undefined)
})

describe('host migration adapter', () => {
  it('hands the separately owned raw client to the injected migration executor', async () => {
    await migrateDatabaseFromHostCli()

    expect(hostMocks.withExternalHostClientOwner).toHaveBeenCalledOnce()
    const [options, capture, run] =
      hostMocks.withExternalHostClientOwner.mock.calls[0] ?? []
    expect(options).toEqual({
      hostInvocationId: 'host-migration-id',
      runTimeoutMs: 120_000,
    })
    await expect(capture()).resolves.toBeUndefined()

    const client = new EventEmitter()
    Object.assign(client, { query: vi.fn() })
    await run(undefined, { client })
    expect(hostMocks.migrateDatabaseWithClient).toHaveBeenCalledWith(client)
    expect(client.listenerCount('error')).toBe(0)
  })

  it('owns idle client errors during migration and rejects after cleanup', async () => {
    const connectionFailure = new Error('migration socket failed')
    hostMocks.migrateDatabaseWithClient.mockImplementation(async (client) => {
      client.emit('error', connectionFailure)
    })
    await migrateDatabaseFromHostCli()
    const [, , run] = hostMocks.withExternalHostClientOwner.mock.calls[0] ?? []
    const client = new EventEmitter()
    Object.assign(client, { query: vi.fn() })

    await expect(run(undefined, { client })).rejects.toBe(connectionFailure)

    expect(client.listenerCount('error')).toBe(0)
  })
})
