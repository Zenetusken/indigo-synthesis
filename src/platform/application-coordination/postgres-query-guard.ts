import { CoordinationError } from '@/application/coordination'

export class InFlightQueryUncertain extends Error {
  constructor(readonly publicError: CoordinationError) {
    super(publicError.message)
    this.name = 'InFlightQueryUncertain'
  }
}

export function connectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  return (
    /^08/.test(code) ||
    ['EPIPE', 'ECONNRESET', 'ECONNREFUSED', '57P01', '57P02', '57P03'].includes(code) ||
    /connection (?:terminated|closed)|not queryable|socket hang up/i.test(error.message)
  )
}

export function lockTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === '55P03'
  )
}

/**
 * A timeout or abort after dispatch makes the backend state unknowable. The caller must retire the
 * connection; the raw promise remains observed so a late driver rejection cannot escape.
 */
export function guardedInFlightQuery<Result>(input: {
  readonly promise: Promise<Result>
  readonly signal?: AbortSignal
  readonly subscribeUncertain?: (
    fail: (publicError: CoordinationError) => void,
  ) => () => void
  readonly timeoutMs: number
  readonly timeoutError: CoordinationError
  readonly onUncertain: (error: InFlightQueryUncertain) => void
}): Promise<Result> {
  if (input.signal?.aborted) {
    const error = new InFlightQueryUncertain(new CoordinationError('uow.cancelled'))
    void input.promise.catch(() => undefined)
    input.onUncertain(error)
    return Promise.reject(error)
  }
  return new Promise<Result>((resolve, reject) => {
    let settled = false
    let unsubscribeUncertain = (): void => undefined
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', onAbort)
      unsubscribeUncertain()
      callback()
    }
    const failUncertain = (publicError: CoordinationError): void => {
      const error = new InFlightQueryUncertain(publicError)
      finish(() => reject(error))
      input.onUncertain(error)
    }
    const onAbort = (): void => failUncertain(new CoordinationError('uow.cancelled'))
    const timeout = setTimeout(() => failUncertain(input.timeoutError), input.timeoutMs)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const registeredUnsubscribe = input.subscribeUncertain?.(failUncertain)
    if (registeredUnsubscribe) {
      if (settled) registeredUnsubscribe()
      else unsubscribeUncertain = registeredUnsubscribe
    }
    void input.promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}
