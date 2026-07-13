import { describe, expect, it, vi } from 'vitest'
import {
  createBoundedAsyncSingleFlight,
  SingleFlightCapacityError,
} from './future-load-explanation-singleflight'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('bounded explanation single-flight', () => {
  it('shares one pending operation for the same cache identity and forgets it afterward', async () => {
    const flight = createBoundedAsyncSingleFlight(2)
    const gate = deferred<string>()
    const operation = vi.fn(() => gate.promise)

    const first = flight.run('same', operation)
    const second = flight.run('same', operation)
    await Promise.resolve()
    expect(operation).toHaveBeenCalledTimes(1)

    gate.resolve('available')
    await expect(Promise.all([first, second])).resolves.toEqual([
      'available',
      'available',
    ])

    await expect(flight.run('same', async () => 'retry')).resolves.toBe('retry')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('forgets rejected operations so the key can be retried', async () => {
    const flight = createBoundedAsyncSingleFlight(1)

    await expect(
      flight.run('failed', async () => {
        throw new Error('generation failed')
      }),
    ).rejects.toThrow('generation failed')
    await expect(flight.run('failed', async () => 'retry')).resolves.toBe('retry')
  })

  it('fails soft at capacity instead of waiting behind an unrelated generation', async () => {
    const flight = createBoundedAsyncSingleFlight(1)
    const gate = deferred<void>()
    const pending = flight.run('first', () => gate.promise)

    await expect(flight.run('unrelated', async () => 'never')).rejects.toBeInstanceOf(
      SingleFlightCapacityError,
    )

    gate.resolve()
    await pending
  })
})
