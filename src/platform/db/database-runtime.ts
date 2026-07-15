import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Pool, PoolClient } from 'pg'
import { BoundedPool, type BoundedPoolSnapshot } from './bounded-pool'
import * as schema from './schema'

export type Database = NodePgDatabase<typeof schema>
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type OrdinaryDatabaseClient = Pick<PoolClient, 'query' | 'release'>
export type OrdinaryDatabasePool = {
  connect(): Promise<OrdinaryDatabaseClient>
  connect(
    callback: (
      error: Error | undefined,
      client: OrdinaryDatabaseClient | undefined,
      release: (releaseError?: Error | boolean) => void,
    ) => void,
  ): void
  query: Pool['query']
}

export const credentialControlConnectionCount = 2
export const credentialCaptureConnectionCount = 1
export const externalHostConnectionCount = 1
export const totalReservedConnectionCount =
  credentialControlConnectionCount +
  credentialCaptureConnectionCount +
  externalHostConnectionCount

export type DatabaseConnectionBudget = {
  readonly applicationMax: number
  readonly captureMax: number
  readonly controlMax: number
  readonly externalHostMax: number
  readonly ordinaryMax: number
  readonly poolMax: number
}

export function deriveDatabaseConnectionBudget(
  poolMax: number,
): DatabaseConnectionBudget {
  if (!Number.isInteger(poolMax) || poolMax < 6 || poolMax > 64) {
    throw new TypeError('Database pool budget must be an integer from 6 through 64.')
  }

  const budget = {
    poolMax,
    ordinaryMax: poolMax - totalReservedConnectionCount,
    controlMax: credentialControlConnectionCount,
    captureMax: credentialCaptureConnectionCount,
    externalHostMax: externalHostConnectionCount,
    applicationMax: poolMax - externalHostConnectionCount,
  }
  if (
    budget.ordinaryMax + budget.controlMax + budget.captureMax !==
      budget.applicationMax ||
    budget.applicationMax + budget.externalHostMax !== budget.poolMax
  ) {
    throw new Error('Database connection budget partition is inconsistent.')
  }

  return budget
}

export type DatabaseRuntimeOptions = {
  readonly connectionString: string
  readonly poolMax: number
}

export type DatabaseRuntimeSnapshot = {
  readonly budget: DatabaseConnectionBudget
  readonly pools: {
    readonly capture: BoundedPoolSnapshot
    readonly control: BoundedPoolSnapshot
    readonly ordinary: BoundedPoolSnapshot
  }
}

/**
 * Owns the installation's in-process PostgreSQL connection budget.
 *
 * The external-host slot is deliberately not a pool: one-shot operator processes serialize that
 * single separately-created Client through the host lock. The three app pool maxima therefore sum
 * to `poolMax - 1`, leaving that process-wide slot physically available under saturation.
 */
export class DatabaseRuntime {
  readonly #ordinaryPool: BoundedPool
  readonly #credentialControlPool: BoundedPool
  readonly #credentialCapturePool: BoundedPool
  readonly #ordinaryDatabase: Database
  readonly #ordinaryPoolCompatibility: OrdinaryDatabasePool
  readonly #budget: DatabaseConnectionBudget
  #closePromise: Promise<void> | undefined

  constructor(options: DatabaseRuntimeOptions) {
    this.#budget = deriveDatabaseConnectionBudget(options.poolMax)
    const shared = { connectionString: options.connectionString }

    this.#ordinaryPool = new BoundedPool({
      ...shared,
      admissionMode: 'fifo',
      application_name: 'indigo-synthesis:ordinary',
      max: this.#budget.ordinaryMax,
    })
    this.#credentialControlPool = new BoundedPool({
      ...shared,
      admissionMode: 'priority',
      application_name: 'indigo-synthesis:control',
      max: this.#budget.controlMax,
    })
    this.#credentialCapturePool = new BoundedPool({
      ...shared,
      admissionMode: 'priority',
      application_name: 'indigo-synthesis:capture',
      max: this.#budget.captureMax,
    })
    this.#ordinaryDatabase = drizzle(this.#ordinaryPool, { schema })
    this.#ordinaryPoolCompatibility = {
      connect: ((callback?: Parameters<OrdinaryDatabasePool['connect']>[0]) => {
        if (callback) {
          this.#ordinaryPool.connect((error, client) => {
            if (error || !client) {
              callback(
                error ?? new Error('Database checkout returned no client.'),
                undefined,
                () => undefined,
              )
              return
            }

            const narrowed = this.#narrowOrdinaryClient(client)
            callback(undefined, narrowed, narrowed.release)
          })
          return undefined
        }

        return this.#ordinaryPool
          .connect()
          .then((client) => this.#narrowOrdinaryClient(client))
      }) as OrdinaryDatabasePool['connect'],
      query: this.#ordinaryPool.query.bind(this.#ordinaryPool),
    }
  }

  ordinaryPoolForCompatibility(): OrdinaryDatabasePool {
    return this.#ordinaryPoolCompatibility
  }

  ordinaryDatabase(): Database {
    return this.#ordinaryDatabase
  }

  acquireOrdinary(options: { readonly signal?: AbortSignal } = {}): Promise<PoolClient> {
    return this.#ordinaryPool.acquire(options)
  }

  acquireTrustedControl(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PoolClient> {
    return this.#credentialControlPool.acquire({ ...options, priority: 'trusted' })
  }

  acquireSubmittedEmailControl(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PoolClient> {
    return this.#credentialControlPool.acquire({
      ...options,
      priority: 'submitted-email',
    })
  }

  acquireTrustedCapture(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PoolClient> {
    return this.#credentialCapturePool.acquire({ ...options, priority: 'trusted' })
  }

  acquireSubmittedEmailCapture(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PoolClient> {
    return this.#credentialCapturePool.acquire({
      ...options,
      priority: 'submitted-email',
    })
  }

  snapshot(): DatabaseRuntimeSnapshot {
    return {
      budget: this.#budget,
      pools: {
        capture: this.#credentialCapturePool.snapshot(),
        control: this.#credentialControlPool.snapshot(),
        ordinary: this.#ordinaryPool.snapshot(),
      },
    }
  }

  #narrowOrdinaryClient(client: PoolClient): OrdinaryDatabaseClient {
    return {
      query: client.query.bind(client),
      release: client.release.bind(client),
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeAllPools()
    return this.#closePromise
  }

  async #closeAllPools(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [this.#ordinaryPool, this.#credentialControlPool, this.#credentialCapturePool].map(
        async (pool) => pool.end(),
      ),
    )
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    )

    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more database pools failed to close.')
    }
  }
}
