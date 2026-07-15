import type { PoolClient, PoolConfig } from 'pg'
import { Pool } from 'pg'
import { CoordinationError } from '@/application/coordination/errors'
import {
  type AdmissionAcquireOptions,
  type AdmissionMode,
  type AdmissionSnapshot,
  BoundedAdmissionController,
} from './admission'

type PoolConnectCallback = Parameters<Pool['connect']>[0]

/**
 * Narrow adapter for pg-pool 3.14.0's checked-out-client retirement path. node-postgres does not
 * expose a public way to remove a client after its one-shot release function has thrown. Keep this
 * surface deliberately small and covered by a real pg-pool regression test; a dependency upgrade
 * must revalidate both members against pg-pool's implementation.
 */
type PgPoolRetirementAdapter = {
  _pulseQueue(): void
  _remove(client: PoolClient, callback: () => void): void
}

export type BoundedPoolConfig = PoolConfig & {
  /** FIFO for ordinary work; priority for credential capture and control work. */
  readonly admissionMode: AdmissionMode
}

export type BoundedPoolSnapshot = {
  readonly admission: AdmissionSnapshot
  readonly driver: {
    readonly idle: number
    readonly max: number
    readonly total: number
    readonly waiting: number
  }
}

/**
 * A node-postgres pool whose public checkout boundary is guarded by bounded admission.
 *
 * Capacity is exactly the driver's `max`, so an admitted checkout can never become an
 * unbounded node-postgres waiter. Ordinary `Pool.query()` and Drizzle calls are covered because
 * node-postgres dispatches them through this overridden `connect()`. Priority pools deliberately
 * require callers to use `acquire({ priority })`; an unclassified `connect()` is rejected before
 * it reaches the driver.
 */
export class BoundedPool extends Pool {
  readonly #admission: BoundedAdmissionController

  constructor(config: BoundedPoolConfig) {
    const { admissionMode, ...poolConfig } = config
    super(poolConfig)

    this.#admission = new BoundedAdmissionController({
      capacity: this.options.max,
      mode: admissionMode,
    })
  }

  override connect(): Promise<PoolClient>
  override connect(callback: PoolConnectCallback): void
  override connect(callback?: PoolConnectCallback): Promise<PoolClient> | undefined {
    const checkout = this.#checkout({})
    if (!callback) return checkout

    void checkout.then(
      (client) => callback(undefined, client, client.release),
      (error: Error) => callback(error, undefined, () => undefined),
    )
  }

  /**
   * Explicit checkout for cancellation and for the closed priority classification used by
   * credential capture/control pools.
   */
  acquire(options: AdmissionAcquireOptions = {}): Promise<PoolClient> {
    return this.#checkout(options)
  }

  snapshot(): BoundedPoolSnapshot {
    return {
      admission: this.#admission.snapshot(),
      driver: {
        idle: this.idleCount,
        max: this.options.max,
        total: this.totalCount,
        waiting: this.waitingCount,
      },
    }
  }

  override end(): Promise<void>
  override end(callback: () => void): void
  override end(callback?: () => void): Promise<void> | undefined {
    this.#admission.close()
    if (callback) {
      super.end(callback)
      return undefined
    }
    return super.end()
  }

  #checkout(options: AdmissionAcquireOptions): Promise<PoolClient> {
    // Keep this call outside an async function: invalid priority use remains a synchronous
    // programmer error, while capacity/cancellation remains a normal rejected acquisition.
    const admission = this.#admission.acquire(options)
    return admission.then((lease) => this.#connectAdmitted(lease, options.signal))
  }

  async #connectAdmitted(
    lease: { release(): void },
    signal: AbortSignal | undefined,
  ): Promise<PoolClient> {
    if (signal?.aborted) {
      lease.release()
      throw new CoordinationError('uow.cancelled')
    }

    let client: PoolClient
    try {
      client = await super.connect()
    } catch (error) {
      lease.release()
      throw error
    }

    if (signal?.aborted) {
      const cancellation = new CoordinationError('uow.cancelled')
      try {
        client.release(cancellation)
      } catch {
        this.#retirePoisonedClient(client, lease)
        throw cancellation
      }

      lease.release()
      throw cancellation
    }

    const driverRelease = client.release
    let returned = false
    const boundedRelease = (error?: Error | boolean): void => {
      if (returned) {
        // Preserve node-postgres's double-release behavior without touching admission twice.
        driverRelease.call(client, error)
        return
      }

      returned = true
      try {
        driverRelease.call(client, error)
      } catch (releaseError) {
        this.#retirePoisonedClient(client, lease)
        throw releaseError
      }

      lease.release()
    }

    try {
      client.release = boundedRelease
    } catch (assignmentError) {
      try {
        driverRelease.call(
          client,
          assignmentError instanceof Error ? assignmentError : true,
        )
      } catch {
        this.#retirePoisonedClient(client, lease)
        throw assignmentError
      }

      lease.release()
      throw assignmentError
    }

    return client
  }

  /**
   * A raw pg release marks its one-shot handle consumed before the pool has necessarily idled or
   * removed the client. If release then throws, returning admission would let the next checkout
   * enter pg-pool's unbounded internal queue behind that poisoned client. Retire it directly and
   * return admission only from pg-pool's confirmed removal callback; any failure before that
   * callback intentionally leaves the permit occupied (fail closed).
   */
  #retirePoisonedClient(client: PoolClient, lease: { release(): void }): void {
    const pool = this as unknown as PgPoolRetirementAdapter
    let removalConfirmed = false

    try {
      pool._remove(client, () => {
        if (removalConfirmed) return
        removalConfirmed = true

        try {
          lease.release()
        } finally {
          // Mirrors pg-pool's normal removal callback so `end()` can finish. There must not be a
          // driver waiter here; the admission regression pins that invariant.
          pool._pulseQueue()
        }
      })
    } catch {
      // Preserve the operation's original error and fail closed if removal was not confirmed.
    }
  }
}
