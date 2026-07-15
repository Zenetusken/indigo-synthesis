import type { PoolClient } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoordinationError } from '@/application/coordination/errors'
import {
  CredentialConnectionCapacityError,
  withSubmittedEmailCredentialCapture,
  withSubmittedEmailCredentialControl,
  withTrustedCredentialCapture,
  withTrustedCredentialControl,
} from './credential-connections'
import type { DatabaseRuntime } from './database-runtime'
import { getDatabaseRuntime } from './runtime-registry'

vi.mock('./runtime-registry', () => ({ getDatabaseRuntime: vi.fn() }))

function fakeClient(
  input: { readonly release?: (error?: Error | boolean) => void } = {},
): PoolClient {
  return {
    connection: { end: vi.fn() },
    end: vi.fn(),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(input.release),
  } as unknown as PoolClient
}

function installRuntime(client: PoolClient) {
  const runtime = {
    acquireTrustedCapture: vi.fn().mockResolvedValue(client),
    acquireSubmittedEmailCapture: vi.fn().mockResolvedValue(client),
    acquireTrustedControl: vi.fn().mockResolvedValue(client),
    acquireSubmittedEmailControl: vi.fn().mockResolvedValue(client),
  }
  vi.mocked(getDatabaseRuntime).mockReturnValue(runtime as unknown as DatabaseRuntime)
  return runtime
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('credential database connections', () => {
  it('fixes queue priority in four separate acquisition methods', async () => {
    const client = fakeClient()
    const runtime = installRuntime(client)
    const signal = new AbortController().signal

    await withTrustedCredentialCapture(async () => undefined, { signal })
    await withSubmittedEmailCredentialCapture(async () => undefined, { signal })
    await withTrustedCredentialControl(async () => undefined, { signal })
    await withSubmittedEmailCredentialControl(async () => undefined, { signal })

    expect(runtime.acquireTrustedCapture).toHaveBeenCalledWith({ signal })
    expect(runtime.acquireSubmittedEmailCapture).toHaveBeenCalledWith({ signal })
    expect(runtime.acquireTrustedControl).toHaveBeenCalledWith({ signal })
    expect(runtime.acquireSubmittedEmailControl).toHaveBeenCalledWith({ signal })
  })

  it('physically exposes only a bound query and releases after callback completion', async () => {
    const client = fakeClient()
    installRuntime(client)

    const value = await withTrustedCredentialControl(async (connection) => {
      expect(Object.keys(connection)).toEqual(['query'])
      expect('release' in connection).toBe(false)
      expect('end' in connection).toBe(false)
      expect('connection' in connection).toBe(false)
      await connection.query('select 1')
      return 'done'
    })

    expect(value).toBe('done')
    expect(client.query).toHaveBeenCalledWith('select 1')
    expect(client.release).toHaveBeenCalledWith(undefined)
  })

  it('destroys the checked-out client on callback failure and preserves that error', async () => {
    const callbackError = new Error('callback failed')
    const client = fakeClient({
      release: () => {
        throw new Error('release observer failed')
      },
    })
    installRuntime(client)

    await expect(
      withSubmittedEmailCredentialControl(async () => {
        throw callbackError
      }),
    ).rejects.toBe(callbackError)
    expect(client.release).toHaveBeenCalledWith(callbackError)
  })

  it('reports release failure after a successful callback', async () => {
    const releaseError = new Error('release failed')
    const client = fakeClient({
      release: () => {
        throw releaseError
      },
    })
    installRuntime(client)

    await expect(withTrustedCredentialCapture(async () => 'done')).rejects.toBe(
      releaseError,
    )
  })

  it('classifies only acquisition capacity and preserves the same callback error', async () => {
    const acquisitionCapacity = new CoordinationError('uow.capacity')
    const runtime = installRuntime(fakeClient())
    runtime.acquireTrustedControl.mockRejectedValueOnce(acquisitionCapacity)

    await expect(
      withTrustedCredentialControl(async () => undefined),
    ).rejects.toMatchObject({
      cause: acquisitionCapacity,
      name: CredentialConnectionCapacityError.name,
    })

    const callbackCapacity = new CoordinationError('uow.capacity')
    await expect(
      withTrustedCredentialControl(async () => {
        throw callbackCapacity
      }),
    ).rejects.toBe(callbackCapacity)
  })
})
