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

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

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
  const monitored = () => ({
    client,
    error: (): Error | undefined => undefined,
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  })
  const runtime = {
    acquireTrustedMonitoredCapture: vi.fn().mockImplementation(async () => monitored()),
    acquireSubmittedEmailMonitoredCapture: vi
      .fn()
      .mockImplementation(async () => monitored()),
    acquireTrustedMonitoredControl: vi.fn().mockImplementation(async () => monitored()),
    acquireSubmittedEmailMonitoredControl: vi
      .fn()
      .mockImplementation(async () => monitored()),
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

    expect(runtime.acquireTrustedMonitoredCapture).toHaveBeenCalledWith({ signal })
    expect(runtime.acquireSubmittedEmailMonitoredCapture).toHaveBeenCalledWith({
      signal,
    })
    expect(runtime.acquireTrustedMonitoredControl).toHaveBeenCalledWith({ signal })
    expect(runtime.acquireSubmittedEmailMonitoredControl).toHaveBeenCalledWith({
      signal,
    })
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
    runtime.acquireTrustedMonitoredControl.mockRejectedValueOnce(acquisitionCapacity)

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

  it('rejects a replayed checkout error before capture work and destroys the client', async () => {
    const connectionFailure = new Error('capture connection failed during handoff')
    const client = fakeClient()
    const dispose = vi.fn()
    const runtime = installRuntime(client)
    runtime.acquireSubmittedEmailMonitoredCapture.mockResolvedValueOnce({
      client,
      error: () => connectionFailure,
      subscribe(listener: (error: Error) => void) {
        listener(connectionFailure)
        return () => undefined
      },
      dispose,
    })
    const callback = vi.fn(async () => 'must not run')

    await expect(withSubmittedEmailCredentialCapture(callback)).rejects.toBe(
      connectionFailure,
    )

    expect(callback).not.toHaveBeenCalled()
    expect(client.query).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledWith(connectionFailure)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps ownership until callback settlement and preserves its error after connection loss', async () => {
    const connectionFailure = new Error('control connection lost')
    const callbackFailure = new Error('protected callback failed')
    const callbackStarted = deferred<void>()
    const callbackGate = deferred<never>()
    const client = fakeClient()
    const dispose = vi.fn()
    const unsubscribe = vi.fn()
    let emitConnectionError: (error: Error) => void = () => undefined
    const runtime = installRuntime(client)
    runtime.acquireTrustedMonitoredControl.mockResolvedValueOnce({
      client,
      error: () => undefined,
      subscribe(listener: (error: Error) => void) {
        emitConnectionError = listener
        return unsubscribe
      },
      dispose,
    })

    const operation = withTrustedCredentialControl(async () => {
      callbackStarted.resolve(undefined)
      await callbackGate.promise
    })
    await callbackStarted.promise
    emitConnectionError(connectionFailure)
    await Promise.resolve()

    expect(client.release).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    callbackGate.reject(callbackFailure)
    await expect(operation).rejects.toBe(callbackFailure)
    expect(client.release).toHaveBeenCalledWith(connectionFailure)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('preserves an observed connection error when poisoned release also throws', async () => {
    const connectionFailure = new Error('capture connection lost')
    const releaseFailure = new Error('poisoned release observer failed')
    const client = fakeClient({
      release: () => {
        throw releaseFailure
      },
    })
    const dispose = vi.fn()
    const unsubscribe = vi.fn()
    let emitConnectionError: (error: Error) => void = () => undefined
    const runtime = installRuntime(client)
    runtime.acquireTrustedMonitoredCapture.mockResolvedValueOnce({
      client,
      error: () => undefined,
      subscribe(listener: (error: Error) => void) {
        emitConnectionError = listener
        return unsubscribe
      },
      dispose,
    })

    await expect(
      withTrustedCredentialCapture(async () => {
        emitConnectionError(connectionFailure)
        return 'callback completed'
      }),
    ).rejects.toBe(connectionFailure)

    expect(client.release).toHaveBeenCalledWith(connectionFailure)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
