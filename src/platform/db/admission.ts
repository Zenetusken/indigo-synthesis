import { CoordinationError } from '@/application/coordination/errors'
import {
  ordinaryAdmissionQueueLimit,
  submittedEmailAdmissionQueueLimit,
  trustedAdmissionQueueLimit,
} from './connection-topology'

export {
  ordinaryAdmissionQueueLimit,
  submittedEmailAdmissionQueueLimit,
  trustedAdmissionQueueLimit,
}

export type AdmissionPriority = 'trusted' | 'submitted-email'
export type AdmissionMode = 'fifo' | 'priority'

export type AdmissionControllerOptions = {
  readonly capacity: number
  readonly mode: AdmissionMode
}

export type AdmissionAcquireOptions = {
  readonly priority?: AdmissionPriority
  readonly signal?: AbortSignal
}

export type AdmissionSnapshot = {
  readonly active: number
  readonly closed: boolean
  readonly queued: number
  readonly queuedByPriority: {
    readonly fifo: number
    readonly 'submitted-email': number
    readonly trusted: number
  }
}

export interface AdmissionLease {
  /** Idempotently returns this admission slot to the next eligible waiter. */
  release(): void
}

type Waiter = {
  readonly priority: AdmissionPriority | 'fifo'
  readonly resolve: (lease: AdmissionLease) => void
  readonly reject: (error: CoordinationError) => void
  readonly signal?: AbortSignal
  abortListener?: () => void
}

function capacityError(): CoordinationError {
  return new CoordinationError('uow.capacity')
}

function cancelledError(): CoordinationError {
  return new CoordinationError('uow.cancelled')
}

/**
 * In-process admission that bounds work before it can enter node-postgres' internal queue.
 *
 * FIFO mode is used by ordinary database work. Priority mode is used independently by the
 * credential control and capture pools; it never interrupts current work, but always transfers a
 * released slot to the oldest trusted waiter before the oldest submitted-email waiter.
 */
export class BoundedAdmissionController {
  readonly #capacity: number
  readonly #mode: AdmissionMode
  readonly #fifoWaiters: Waiter[] = []
  readonly #trustedWaiters: Waiter[] = []
  readonly #submittedEmailWaiters: Waiter[] = []
  #active = 0
  #closed = false

  constructor(options: AdmissionControllerOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity <= 0) {
      throw new TypeError('Admission capacity must be a positive integer.')
    }
    if (options.mode !== 'fifo' && options.mode !== 'priority') {
      throw new TypeError('Admission mode must be fifo or priority.')
    }

    this.#capacity = options.capacity
    this.#mode = options.mode
  }

  acquire(options: AdmissionAcquireOptions = {}): Promise<AdmissionLease> {
    const priority = this.#requestPriority(options.priority)

    if (this.#closed) {
      return Promise.reject(capacityError())
    }
    if (options.signal?.aborted) {
      return Promise.reject(cancelledError())
    }
    if (this.#active < this.#capacity) {
      this.#active += 1
      return Promise.resolve(this.#createLease())
    }

    const queue = this.#queue(priority)
    if (queue.length >= this.#queueLimit(priority)) {
      return Promise.reject(capacityError())
    }

    return new Promise<AdmissionLease>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        reject,
        resolve,
        signal: options.signal,
      }

      if (options.signal) {
        waiter.abortListener = () => {
          const index = queue.indexOf(waiter)
          if (index < 0) return

          queue.splice(index, 1)
          this.#removeAbortListener(waiter)
          reject(cancelledError())
        }
        options.signal.addEventListener('abort', waiter.abortListener, { once: true })
      }

      queue.push(waiter)
    })
  }

  snapshot(): AdmissionSnapshot {
    const fifo = this.#fifoWaiters.length
    const trusted = this.#trustedWaiters.length
    const submittedEmail = this.#submittedEmailWaiters.length

    return {
      active: this.#active,
      closed: this.#closed,
      queued: fifo + trusted + submittedEmail,
      queuedByPriority: {
        fifo,
        'submitted-email': submittedEmail,
        trusted,
      },
    }
  }

  /**
   * Stops new admission and rejects every waiter. Active leases remain observable until their
   * owners release them, allowing pool shutdown to wait for or destroy active clients separately.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true

    const error = capacityError()
    for (const queue of [
      this.#fifoWaiters,
      this.#trustedWaiters,
      this.#submittedEmailWaiters,
    ]) {
      for (const waiter of queue.splice(0)) {
        this.#removeAbortListener(waiter)
        waiter.reject(error)
      }
    }
  }

  #requestPriority(priority: AdmissionPriority | undefined): Waiter['priority'] {
    if (this.#mode === 'fifo') {
      if (priority !== undefined) {
        throw new TypeError('FIFO admission does not accept a priority.')
      }
      return 'fifo'
    }

    if (priority === undefined) {
      throw new TypeError('Priority admission requires a priority.')
    }
    if (priority !== 'trusted' && priority !== 'submitted-email') {
      throw new TypeError('Admission priority must be trusted or submitted-email.')
    }
    return priority
  }

  #queue(priority: Waiter['priority']): Waiter[] {
    if (priority === 'fifo') return this.#fifoWaiters
    if (priority === 'trusted') return this.#trustedWaiters
    return this.#submittedEmailWaiters
  }

  #queueLimit(priority: Waiter['priority']): number {
    if (priority === 'fifo') return ordinaryAdmissionQueueLimit
    if (priority === 'trusted') return trustedAdmissionQueueLimit
    return submittedEmailAdmissionQueueLimit
  }

  #createLease(): AdmissionLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.#transferOrReleaseSlot()
      },
    }
  }

  #transferOrReleaseSlot(): void {
    const next = this.#nextWaiter()
    if (!next) {
      this.#active -= 1
      return
    }

    this.#removeAbortListener(next)
    next.resolve(this.#createLease())
  }

  #nextWaiter(): Waiter | undefined {
    if (this.#mode === 'fifo') return this.#fifoWaiters.shift()
    return this.#trustedWaiters.shift() ?? this.#submittedEmailWaiters.shift()
  }

  #removeAbortListener(waiter: Waiter): void {
    if (!waiter.signal || !waiter.abortListener) return
    waiter.signal.removeEventListener('abort', waiter.abortListener)
    waiter.abortListener = undefined
  }
}
