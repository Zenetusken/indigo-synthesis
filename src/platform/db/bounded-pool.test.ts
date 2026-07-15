import { EventEmitter } from 'node:events'
import type { PoolClient, QueryResult } from 'pg'
import { Pool } from 'pg'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import { BoundedPool, type BoundedPoolConfig } from './bounded-pool'

type Deferred<Value> = {
  readonly promise: Promise<Value>
  readonly reject: (error: unknown) => void
  readonly resolve: (value: Value) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

function fakeClient(
  options: {
    readonly onRelease?: (error?: Error | boolean) => void
    readonly queryResult?: QueryResult
  } = {},
): PoolClient {
  let released = false
  const client = {
    once: vi.fn(),
    query: vi.fn(
      (
        _text: unknown,
        _values: unknown,
        callback: (error: Error | undefined, result?: QueryResult) => void,
      ) => callback(undefined, options.queryResult),
    ),
    release: vi.fn((error?: Error | boolean) => {
      if (released) throw new Error('driver release called twice')
      released = true
      options.onRelease?.(error)
    }),
    removeListener: vi.fn(),
  }

  return client as unknown as PoolClient
}

type DriverConnectCallback = (error?: Error) => void
type DriverRelease = (error?: Error | boolean) => void

/** Minimal in-memory Client exercised through pg-pool itself, not a connect mock. */
class InMemoryPgClient extends EventEmitter {
  _ending = false
  _queryable = true

  connect(callback: DriverConnectCallback): void {
    callback()
  }

  end(callback?: () => void): void {
    this._ending = true
    callback?.()
  }

  ref(): void {}

  unref(): void {}
}

class DelayedConnectPgClient extends InMemoryPgClient {
  static readonly pending: DriverConnectCallback[] = []

  override connect(callback: DriverConnectCallback): void {
    DelayedConnectPgClient.pending.push(callback)
  }

  static finishConnect(): void {
    const callback = DelayedConnectPgClient.pending.shift()
    if (!callback) throw new Error('No pending driver connection.')
    callback()
  }
}

const releaseAssignmentFailure = new TypeError('release is not writable')

class RejectBoundedReleaseClient extends InMemoryPgClient {
  #release: DriverRelease = () => undefined
  #releaseAssignments = 0

  get release(): DriverRelease {
    return this.#release
  }

  set release(release: DriverRelease) {
    this.#releaseAssignments += 1
    if (this.#releaseAssignments === 2) throw releaseAssignmentFailure
    this.#release = release
  }
}

function inMemoryPool(Client: typeof InMemoryPgClient = InMemoryPgClient): BoundedPool {
  return new BoundedPool({
    admissionMode: 'fifo',
    Client,
    max: 1,
  } as unknown as BoundedPoolConfig)
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function spyOnDriverConnect(): Mock<() => Promise<PoolClient>> {
  return vi.spyOn(Pool.prototype, 'connect') as unknown as Mock<() => Promise<PoolClient>>
}

afterEach(() => {
  vi.restoreAllMocks()
  DelayedConnectPgClient.pending.length = 0
})

describe('BoundedPool', () => {
  it('does not reach the driver while bounded admission is saturated', async () => {
    const firstClient = fakeClient()
    const secondClient = fakeClient()
    const driverConnect = spyOnDriverConnect()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient)
    const pool = new BoundedPool({ admissionMode: 'fifo', max: 1 })

    const first = await pool.connect()
    const secondPromise = pool.connect()
    await flushMicrotasks()

    expect(driverConnect).toHaveBeenCalledTimes(1)
    expect(pool.snapshot()).toEqual({
      admission: {
        active: 1,
        closed: false,
        queued: 1,
        queuedByPriority: { fifo: 1, 'submitted-email': 0, trusted: 0 },
      },
      driver: { idle: 0, max: 1, total: 0, waiting: 0 },
    })

    first.release()
    const second = await secondPromise
    expect(driverConnect).toHaveBeenCalledTimes(2)
    second.release()
    expect(pool.snapshot().admission).toMatchObject({ active: 0, queued: 0 })
  })

  it('bounds inherited Pool.query and returns its permit on success', async () => {
    const queryResult = {
      command: 'SELECT',
      rowCount: 1,
      rows: [{ value: 1 }],
    } as QueryResult
    const client = fakeClient({ queryResult })
    const driverRelease = client.release
    spyOnDriverConnect().mockResolvedValue(client)
    const pool = new BoundedPool({ admissionMode: 'fifo', max: 1 })

    await expect(pool.query('select 1 as value')).resolves.toBe(queryResult)

    expect(client.query).toHaveBeenCalledWith(
      'select 1 as value',
      undefined,
      expect.any(Function),
    )
    expect(driverRelease).toHaveBeenCalledOnce()
    expect(pool.snapshot().admission.active).toBe(0)
  })

  it('supports Pool.connect callback callers with the same bounded release handle', async () => {
    const client = fakeClient()
    const driverRelease = client.release
    spyOnDriverConnect().mockResolvedValue(client)
    const pool = new BoundedPool({ admissionMode: 'fifo', max: 1 })

    await new Promise<void>((resolve, reject) => {
      pool.connect((error, connected, done) => {
        if (error || !connected) {
          reject(error ?? new Error('missing client'))
          return
        }

        expect(done).toBe(connected.release)
        done()
        resolve()
      })
    })

    expect(driverRelease).toHaveBeenCalledOnce()
    expect(pool.snapshot().admission.active).toBe(0)
  })

  it('returns admission after driver connect failure without replacing the error', async () => {
    const failure = new Error('driver failed')
    const nextClient = fakeClient()
    spyOnDriverConnect().mockRejectedValueOnce(failure).mockResolvedValueOnce(nextClient)
    const pool = new BoundedPool({ admissionMode: 'fifo', max: 1 })

    await expect(pool.connect()).rejects.toBe(failure)
    expect(pool.snapshot().admission.active).toBe(0)

    const next = await pool.connect()
    next.release()
    expect(pool.snapshot().admission.active).toBe(0)
  })

  it('removes a cancelled admission waiter before it reaches the driver', async () => {
    const firstClient = fakeClient()
    const driverConnect = spyOnDriverConnect().mockResolvedValue(firstClient)
    const pool = new BoundedPool({ admissionMode: 'fifo', max: 1 })
    const first = await pool.connect()
    const abortController = new AbortController()
    const cancelled = pool.acquire({ signal: abortController.signal })

    abortController.abort()

    await expect(cancelled).rejects.toMatchObject({
      code: 'uow.cancelled',
      name: 'CoordinationError',
    })
    expect(driverConnect).toHaveBeenCalledOnce()
    expect(pool.snapshot().admission).toMatchObject({ active: 1, queued: 0 })
    first.release()
    expect(pool.snapshot().admission.active).toBe(0)
  })

  it('safely returns a client and permit when cancellation wins during driver connect', async () => {
    const pendingDriver = deferred<PoolClient>()
    spyOnDriverConnect().mockReturnValue(pendingDriver.promise)
    const pool = new BoundedPool({ admissionMode: 'fifo', max: 1 })
    const abortController = new AbortController()
    const cancelled = pool.acquire({ signal: abortController.signal })

    await flushMicrotasks()
    abortController.abort()
    const client = fakeClient()
    pendingDriver.resolve(client)

    await expect(cancelled).rejects.toMatchObject({
      code: 'uow.cancelled',
      name: 'CoordinationError',
    })
    expect(client.release).toHaveBeenCalledOnce()
    expect(pool.snapshot().admission.active).toBe(0)
  })

  it('retires a poisoned pg-pool client before handing bounded admission onward', async () => {
    const pool = inMemoryPool()
    const first = await pool.connect()
    const secondCheckout = pool.connect()
    const releaseFailure = new Error('release observer failed')
    pool.once('release', () => {
      throw releaseFailure
    })

    expect(() => first.release()).toThrow(releaseFailure)
    expect(pool.snapshot().driver.waiting).toBe(0)

    const second = await secondCheckout
    expect(pool.snapshot()).toMatchObject({
      admission: { active: 1, queued: 0 },
      driver: { idle: 0, total: 1, waiting: 0 },
    })

    second.release()
    expect(pool.snapshot().admission.active).toBe(0)
    await pool.end()
  })

  it('fails admission closed if poisoned-client removal cannot be confirmed', async () => {
    const releaseFailure = new Error('release failed')
    const client = fakeClient({
      onRelease: () => {
        throw releaseFailure
      },
    })
    const driverConnect = spyOnDriverConnect().mockResolvedValue(client)
    const driverEnd = vi.spyOn(Pool.prototype, 'end').mockResolvedValue()
    const pool = new BoundedPool({ admissionMode: 'fifo', max: 1 })
    const connected = await pool.connect()

    expect(() => connected.release()).toThrow(releaseFailure)
    expect(pool.snapshot().admission.active).toBe(1)

    const next = pool.connect()
    await flushMicrotasks()
    expect(driverConnect).toHaveBeenCalledOnce()
    expect(pool.snapshot()).toMatchObject({
      admission: { active: 1, queued: 1 },
      driver: { waiting: 0 },
    })

    await pool.end()
    await expect(next).rejects.toMatchObject({ code: 'uow.capacity' })
    expect(driverEnd).toHaveBeenCalledOnce()
  })

  it('returns the checked-out client and permit if release wrapping fails', async () => {
    const client = fakeClient()
    const driverRelease = client.release
    Object.defineProperty(client, 'release', { writable: false })
    spyOnDriverConnect().mockResolvedValue(client)
    const pool = new BoundedPool({ admissionMode: 'fifo', max: 1 })

    await expect(pool.connect()).rejects.toBeInstanceOf(TypeError)

    expect(driverRelease).toHaveBeenCalledOnce()
    expect(driverRelease).toHaveBeenCalledWith(expect.any(TypeError))
    expect(pool.snapshot().admission.active).toBe(0)
  })

  it('retires after cancellation cleanup release throws and preserves cancellation', async () => {
    const pool = inMemoryPool(DelayedConnectPgClient)
    const abortController = new AbortController()
    const cancelled = pool.acquire({ signal: abortController.signal })
    const cleanupFailure = new Error('cancellation release observer failed')
    pool.once('release', () => {
      throw cleanupFailure
    })

    await flushMicrotasks()
    abortController.abort()
    DelayedConnectPgClient.finishConnect()

    await expect(cancelled).rejects.toMatchObject({
      code: 'uow.cancelled',
      name: 'CoordinationError',
    })
    expect(pool.snapshot()).toMatchObject({
      admission: { active: 0, queued: 0 },
      driver: { total: 0, waiting: 0 },
    })
    await pool.end()
  })

  it('retires after wrapper cleanup release throws and preserves assignment failure', async () => {
    const pool = inMemoryPool(RejectBoundedReleaseClient)
    const cleanupFailure = new Error('assignment release observer failed')
    pool.once('release', () => {
      throw cleanupFailure
    })

    await expect(pool.connect()).rejects.toBe(releaseAssignmentFailure)
    expect(pool.snapshot()).toMatchObject({
      admission: { active: 0, queued: 0 },
      driver: { total: 0, waiting: 0 },
    })
    await pool.end()
  })

  it('uses strict trusted priority while preserving FIFO within each priority', async () => {
    const clients = Array.from({ length: 4 }, () => fakeClient())
    const driverConnect = spyOnDriverConnect()
    for (const client of clients) driverConnect.mockResolvedValueOnce(client)

    const pool = new BoundedPool({ admissionMode: 'priority', max: 1 })
    const active = await pool.acquire({ priority: 'submitted-email' })
    const entered: string[] = []
    const submitted = pool.acquire({ priority: 'submitted-email' }).then((client) => {
      entered.push('submitted')
      return client
    })
    const trustedFirst = pool.acquire({ priority: 'trusted' }).then((client) => {
      entered.push('trusted-first')
      return client
    })
    const trustedSecond = pool.acquire({ priority: 'trusted' }).then((client) => {
      entered.push('trusted-second')
      return client
    })

    active.release()
    const first = await trustedFirst
    expect(entered).toEqual(['trusted-first'])
    first.release()
    const second = await trustedSecond
    expect(entered).toEqual(['trusted-first', 'trusted-second'])
    second.release()
    const last = await submitted
    expect(entered).toEqual(['trusted-first', 'trusted-second', 'submitted'])
    last.release()
    expect(driverConnect).toHaveBeenCalledTimes(4)
  })

  it('rejects missing priority before a priority pool reaches the driver', async () => {
    const driverConnect = spyOnDriverConnect()
    const pool = new BoundedPool({ admissionMode: 'priority', max: 1 })

    expect(() => pool.connect()).toThrow('requires a priority')
    expect(driverConnect).not.toHaveBeenCalled()
  })

  it('closes admission before ending the driver and rejects queued and future work', async () => {
    const firstClient = fakeClient()
    spyOnDriverConnect().mockResolvedValue(firstClient)
    const driverEnd = vi.spyOn(Pool.prototype, 'end').mockResolvedValue()
    const pool = new BoundedPool({ admissionMode: 'fifo', max: 1 })
    const active = await pool.connect()
    const queued = pool.connect()

    await pool.end()

    await expect(queued).rejects.toMatchObject({ code: 'uow.capacity' })
    await expect(pool.connect()).rejects.toMatchObject({ code: 'uow.capacity' })
    expect(driverEnd).toHaveBeenCalledOnce()
    expect(pool.snapshot().admission).toMatchObject({
      active: 1,
      closed: true,
      queued: 0,
    })
    active.release()
    expect(pool.snapshot().admission).toMatchObject({ active: 0, closed: true })
  })
})
