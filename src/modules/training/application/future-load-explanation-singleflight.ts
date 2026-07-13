export type AsyncSingleFlight = {
  readonly run: <T>(key: string, operation: () => Promise<T>) => Promise<T>
}

export class SingleFlightCapacityError extends Error {
  constructor() {
    super('Explanation generation is already at its single-instance concurrency limit')
    this.name = 'SingleFlightCapacityError'
  }
}

/**
 * Bounded, process-local request coalescing for the supported single Node instance.
 * Pending promises only are retained and every entry is removed in `finally`.
 */
export function createBoundedAsyncSingleFlight(maxPending = 128): AsyncSingleFlight {
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new TypeError('maxPending must be a positive integer')
  }

  const pending = new Map<string, Promise<unknown>>()

  return {
    async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
      const existing = pending.get(key)
      if (existing) return existing as Promise<T>

      // Do not spend an interactive timeout queued behind unrelated model calls.
      if (pending.size >= maxPending) throw new SingleFlightCapacityError()

      const promise = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (pending.get(key) === promise) pending.delete(key)
        })
      pending.set(key, promise)
      return promise
    },
  }
}
