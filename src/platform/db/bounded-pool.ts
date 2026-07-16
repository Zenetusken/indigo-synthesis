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
  readonly _clients: readonly PoolClient[]
  _pulseQueue(): void
  _remove(client: PoolClient, callback: () => void): void
}

const pgPoolRemove = (Pool.prototype as unknown as PgPoolRetirementAdapter)._remove

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

export type MonitoredPoolClient = {
  readonly client: PoolClient
  readonly error: () => Error | undefined
  readonly dispose: () => void
  readonly subscribe: (listener: (error: Error) => void) => () => void
}

function monitorCheckedOutClient(client: PoolClient): MonitoredPoolClient {
  let observed: Error | undefined
  const listeners = new Set<(error: Error) => void>()
  const onError = (error: Error): void => {
    if (observed) return
    observed = error instanceof Error ? error : new Error('Database client error.')
    for (const listener of listeners) listener(observed)
  }
  client.on('error', onError)
  return {
    client,
    error: () => observed,
    dispose() {
      listeners.clear()
      client.removeListener('error', onError)
    },
    subscribe(listener) {
      if (observed) {
        listener(observed)
        return () => undefined
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

type DriverCheckout = {
  readonly client: PoolClient
  readonly monitor: MonitoredPoolClient
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
  #physicalRetirements = 0
  readonly #physicalRetirementWaiters: Array<() => void> = []

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
    if (!callback) return this.#checkout({})

    void this.#checkoutOwned({}).then(
      (checkout) => {
        const error = checkout.monitor.error()
        if (error) {
          try {
            checkout.client.release(error)
          } catch {
            // Preserve the owned connection error delivered to the callback.
          }
          callback(error, undefined, () => undefined)
          return
        }
        callback(undefined, checkout.client, checkout.client.release)
      },
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

  /** Attaches error ownership in pg-pool's checkout callback before the client can escape. */
  acquireMonitored(options: AdmissionAcquireOptions = {}): Promise<MonitoredPoolClient> {
    return this.#checkoutOwned(options).then((checkout) => checkout.monitor)
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
      super.end(() => {
        void this.#waitForPhysicalRetirements().then(callback)
      })
      return undefined
    }
    return super.end().then(() => this.#waitForPhysicalRetirements())
  }

  /**
   * pg-pool removes a client from its logical count before asynchronous backend shutdown finishes.
   * Intercept every driver retirement path (error, idle timeout, expiry, max-use, and pool end) so
   * a replacement cannot be established while the old physical backend is still alive.
   *
   * `_remove` is an intentionally pinned pg-pool 3.14 seam. The dependency implementation and
   * delayed-end regressions must be revalidated together on upgrade.
   */
  _remove(client: PoolClient, callback?: () => void): void {
    this.#physicalRetirements += 1
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      this.removeListener('remove', onRemove)
      this.#physicalRetirements -= 1
      try {
        callback?.()
      } finally {
        if (this.#physicalRetirements === 0) {
          for (const resolve of this.#physicalRetirementWaiters.splice(0)) resolve()
        }
      }
    }
    const onRemove = (removedClient: PoolClient): void => {
      if (removedClient === client) finish()
    }

    // Run before arbitrary observers: an observer exception must not hide a confirmed physical
    // removal and permanently strand the runtime. The wrapped driver callback is idempotent.
    this.prependListener('remove', onRemove)
    // If pg-pool throws before confirmation, the listener and retirement count deliberately remain:
    // admitting a replacement after an unconfirmed shutdown could exceed the role allowance.
    pgPoolRemove.call(this, client, finish)
  }

  #checkout(options: AdmissionAcquireOptions): Promise<PoolClient> {
    return this.#checkoutOwned(options).then((checkout) => {
      const error = checkout.monitor.error()
      if (!error) return checkout.client
      try {
        checkout.client.release(error)
      } catch {
        // The checked-out client was still retired through the bounded release path.
      }
      throw error
    })
  }

  #checkoutOwned(options: AdmissionAcquireOptions): Promise<DriverCheckout> {
    // Keep this call outside an async function: invalid priority use remains a synchronous
    // programmer error, while capacity/cancellation remains a normal rejected acquisition.
    const admission = this.#admission.acquire(options)
    return admission.then((lease) => this.#connectAdmitted(lease, options.signal))
  }

  async #connectAdmitted(
    lease: { release(): void },
    signal: AbortSignal | undefined,
  ): Promise<DriverCheckout> {
    if (signal?.aborted) {
      lease.release()
      throw new CoordinationError('uow.cancelled')
    }

    let checkout: DriverCheckout
    try {
      await this.#waitForPhysicalRetirements()
      checkout = await this.#driverCheckout()
    } catch (error) {
      lease.release()
      throw error
    }
    const { client } = checkout

    if (signal?.aborted) {
      const cancellation = new CoordinationError('uow.cancelled')
      try {
        this.#returnClient(client, client.release, lease, cancellation)
      } catch {
        throw cancellation
      } finally {
        checkout.monitor.dispose()
      }
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
        this.#returnClient(
          client,
          driverRelease,
          lease,
          checkout.monitor.error() ?? error,
        )
      } finally {
        checkout.monitor.dispose()
      }
    }

    try {
      client.release = boundedRelease
    } catch (assignmentError) {
      try {
        this.#returnClient(
          client,
          driverRelease,
          lease,
          assignmentError instanceof Error ? assignmentError : true,
        )
      } catch {
        throw assignmentError
      } finally {
        checkout.monitor.dispose()
      }
      throw assignmentError
    }

    return checkout
  }

  #driverCheckout(): Promise<DriverCheckout> {
    return new Promise<DriverCheckout>((resolve, reject) => {
      let settled = false
      const finish = (error: Error | undefined, client: PoolClient | undefined) => {
        if (settled) return
        settled = true
        if (error || !client) {
          reject(error ?? new Error('Database checkout returned no client.'))
          return
        }
        resolve({
          client,
          monitor: monitorCheckedOutClient(client),
        })
      }
      const returned = super.connect((error, client) => finish(error, client)) as unknown
      if (
        returned &&
        typeof returned === 'object' &&
        'then' in returned &&
        typeof returned.then === 'function'
      ) {
        void (returned as Promise<PoolClient>).then(
          (client) => finish(undefined, client),
          (error: Error) => finish(error, undefined),
        )
      }
    })
  }

  async #waitForPhysicalRetirements(): Promise<void> {
    if (this.#physicalRetirements === 0) return
    await new Promise<void>((resolve) => {
      this.#physicalRetirementWaiters.push(resolve)
    })
  }

  /**
   * Returns an idle client immediately, but holds admission while pg-pool asynchronously retires
   * an errored/expired/ending client. pg-pool removes retiring clients from its logical count before
   * `client.end()` confirms the backend is gone; admitting a replacement in that window can exceed
   * the physical role allowance even though `totalCount` remains within max.
   */
  #returnClient(
    client: PoolClient,
    driverRelease: PoolClient['release'],
    lease: { release(): void },
    error?: Error | boolean,
  ): void {
    const pool = this as unknown as PgPoolRetirementAdapter
    const wasTracked = pool._clients.includes(client)
    let removalObserved = false
    const onRemove = (removedClient: PoolClient): void => {
      if (removedClient !== client) return
      removalObserved = true
      this.removeListener('remove', onRemove)
      lease.release()
    }
    this.on('remove', onRemove)

    try {
      driverRelease.call(client, error)
    } catch (releaseError) {
      this.removeListener('remove', onRemove)
      this.#retirePoisonedClient(client, lease)
      throw releaseError
    }

    if (!wasTracked || pool._clients.includes(client)) {
      this.removeListener('remove', onRemove)
      lease.release()
      return
    }

    // A synchronous Client.end implementation may already have emitted remove and transferred the
    // permit. Otherwise the listener deliberately retains admission until backend teardown.
    if (removalObserved) this.removeListener('remove', onRemove)
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
