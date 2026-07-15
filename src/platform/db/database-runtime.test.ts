import { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundedPool } from './bounded-pool'
import { DatabaseRuntime, deriveDatabaseConnectionBudget } from './database-runtime'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('database connection budget', () => {
  it.each([
    [6, 2, 5],
    [10, 6, 9],
    [64, 60, 63],
  ])('partitions budget %i into ordinary %i, app %i, and fixed reserved slots', (poolMax, ordinaryMax, applicationMax) => {
    expect(deriveDatabaseConnectionBudget(poolMax)).toEqual({
      poolMax,
      ordinaryMax,
      controlMax: 2,
      captureMax: 1,
      externalHostMax: 1,
      applicationMax,
    })
  })

  it('fails closed outside the exact server contract', () => {
    for (const poolMax of [5, 6.5, 65]) {
      expect(() => deriveDatabaseConnectionBudget(poolMax)).toThrow(
        'integer from 6 through 64',
      )
    }
  })
})

describe('DatabaseRuntime', () => {
  it.each([
    6, 10, 64,
  ])('constructs exactly the accepted app topology for %i', async (poolMax) => {
    const runtime = new DatabaseRuntime({
      connectionString: 'postgresql://localhost/indigo_runtime_test',
      poolMax,
    })

    const snapshot = runtime.snapshot()
    expect(Object.keys(snapshot.pools).sort()).toEqual(['capture', 'control', 'ordinary'])
    expect(snapshot.pools).toMatchObject({
      ordinary: { driver: { max: poolMax - 4 } },
      control: { driver: { max: 2 } },
      capture: { driver: { max: 1 } },
    })
    expect(
      snapshot.pools.ordinary.driver.max +
        snapshot.pools.control.driver.max +
        snapshot.pools.capture.driver.max,
    ).toBe(poolMax - 1)

    await runtime.close()
  })

  it('uses distinct app names and fixes priority in narrow acquisition methods', async () => {
    const runtime = new DatabaseRuntime({
      connectionString: 'postgresql://localhost/indigo_runtime_test',
      poolMax: 10,
    })
    const ordinary = runtime.ordinaryPoolForCompatibility()
    const denied = new Error('stop before driver access')
    const acquire = vi.spyOn(BoundedPool.prototype, 'acquire').mockRejectedValue(denied)
    const acquireMonitored = vi
      .spyOn(BoundedPool.prototype, 'acquireMonitored')
      .mockRejectedValue(denied)

    expect(Object.keys(ordinary).sort()).toEqual(['connect', 'query'])
    await expect(runtime.acquireOrdinary()).rejects.toBe(denied)
    await expect(runtime.acquireTrustedControl()).rejects.toBe(denied)
    await expect(runtime.acquireSubmittedEmailControl()).rejects.toBe(denied)
    await expect(runtime.acquireTrustedCapture()).rejects.toBe(denied)
    await expect(runtime.acquireSubmittedEmailCapture()).rejects.toBe(denied)
    await expect(runtime.acquireTrustedMonitoredControl()).rejects.toBe(denied)
    await expect(runtime.acquireSubmittedEmailMonitoredControl()).rejects.toBe(denied)
    expect(acquire.mock.calls).toEqual([
      [{ priority: 'trusted' }],
      [{ priority: 'submitted-email' }],
      [{ priority: 'trusted' }],
      [{ priority: 'submitted-email' }],
    ])
    expect(acquireMonitored.mock.calls).toEqual([
      [{}],
      [{ priority: 'trusted' }],
      [{ priority: 'submitted-email' }],
    ])

    await runtime.close()
  })

  it('owns and reuses the ordinary Drizzle binding', async () => {
    const runtime = new DatabaseRuntime({
      connectionString: 'postgresql://localhost/indigo_runtime_test',
      poolMax: 10,
    })

    expect(runtime.ordinaryDatabase()).toBe(runtime.ordinaryDatabase())
    expect(runtime.snapshot().pools.ordinary.driver.max).toBe(6)

    await runtime.close()
  })

  it('does not expose driver lifecycle on compatibility checkouts', async () => {
    const rawClient = {
      end: vi.fn(),
      query: vi.fn(),
      release: vi.fn(),
    }
    vi.spyOn(BoundedPool.prototype, 'connect').mockResolvedValue(
      rawClient as unknown as Awaited<ReturnType<BoundedPool['connect']>>,
    )
    const runtime = new DatabaseRuntime({
      connectionString: 'postgresql://localhost/indigo_runtime_test',
      poolMax: 10,
    })

    const client = await runtime.ordinaryPoolForCompatibility().connect()

    expect(Object.keys(client).sort()).toEqual(['query', 'release'])
    expect('end' in client).toBe(false)
    client.release()
    expect(rawClient.release).toHaveBeenCalledOnce()
    await runtime.close()
  })

  it('attempts every pool close, aggregates failures, and stays idempotent', async () => {
    const firstFailure = new Error('ordinary close failed')
    const secondFailure = new Error('control close failed')
    const end = vi
      .spyOn(Pool.prototype, 'end')
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(secondFailure)
      .mockResolvedValueOnce()
    const runtime = new DatabaseRuntime({
      connectionString: 'postgresql://localhost/indigo_runtime_test',
      poolMax: 10,
    })

    const firstClose = runtime.close()
    const secondClose = runtime.close()

    expect(secondClose).toBe(firstClose)
    await expect(firstClose).rejects.toMatchObject({
      errors: [firstFailure, secondFailure],
      message: 'One or more database pools failed to close.',
    })
    expect(end).toHaveBeenCalledTimes(3)
    await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError)
    expect(end).toHaveBeenCalledTimes(3)
  })
})
