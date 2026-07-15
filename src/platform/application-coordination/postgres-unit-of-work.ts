import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import type { PoolClient, QueryArrayResult, QueryResult, QueryResultRow } from 'pg'
import {
  type ContentLockedUnitOfWorkExecution,
  type ContentLockedUnitOfWorkRequest,
  CoordinationError,
  type ExactReplayAuthorizer,
  type NewCommandAuthorizer,
  type ReadOnlyUnitOfWorkRequest,
  type ReadWriteUnitOfWorkRequest,
  type UnitOfWork,
  type UnitOfWorkContentScope,
  type UnitOfWorkRequest,
  type UnitOfWorkScope,
} from '@/application/coordination'
import type {
  PrelockedSessionLease,
  PrelockedSessionOperation,
} from '@/application/coordination/prelocked-session'
import { prepareStablePostgresValue } from '@/platform/db/postgres-value'
import {
  bindContentLockedUnitOfWorkExecution,
  type ConsumedContentLockPlan,
  consumeVerifiedContentLockPlan,
} from './content-lock-plan'
import { bindPrelockedSessionExecution } from './prelocked-session'
import { captureUnitOfWorkRequest } from './request-matrix'
import { transactionLocalStateForRequest } from './transaction-local-state'

const credentialLockNamespace = 'indigo:credential-lifecycle:'
const credentialInstanceFenceKey = `${credentialLockNamespace}instance-fence`
const productMutationFenceKey = 'indigo:product-mutation-fence'
const maximumPostgresParameterCount = 65_535

type SessionLock = {
  readonly key: string
  readonly mode: 'exclusive' | 'shared'
}

export type SafeQueryConfig = {
  readonly text: string
  readonly values?: readonly unknown[]
}

export type ScopedTransactionClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
  query<Row extends QueryResultRow = QueryResultRow>(
    config: SafeQueryConfig,
  ): Promise<QueryResult<Row>>
  queryArray<Row extends unknown[] = unknown[]>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryArrayResult<Row>>
}

export type PostgresUnitOfWorkGatewayContext<ReadGateways, WriteGateways> = {
  /** Must perform at least one query; it is the only phase permitted before owner gateways. */
  recheckIdentity(): Promise<void>
  readonly readGateways: ReadGateways
  readonly writeGateways: WriteGateways
}

export type ResolvedPrelockedSession = {
  readonly client: PoolClient
  readonly signal: AbortSignal
  finish(): void
  /** Destroys the outer lease when inner session state is no longer trustworthy. */
  destroy(error: Error): void
}

export type PostgresUnitOfWorkOptions<ReadGateways, WriteGateways> = {
  readonly acquireOrdinary: (options: {
    readonly signal?: AbortSignal
  }) => Promise<PoolClient>
  readonly resolvePrelockedSession: (
    lease: PrelockedSessionLease<PrelockedSessionOperation>,
    request: UnitOfWorkRequest,
  ) => ResolvedPrelockedSession
  readonly createGatewayContext: (input: {
    readonly client: ScopedTransactionClient
    readonly request: UnitOfWorkRequest
    /** Owner DML methods call this immediately before issuing their first write. */
    readonly requireWriteAuthorized: () => void
    /** Injected only into owning receipt gateways; exact replay grants no write authority. */
    readonly exactReplayAuthorizer: ExactReplayAuthorizer | null
    /** Injected only into owning receipt gateways after an absent-receipt proof. */
    readonly newCommandAuthorizer: NewCommandAuthorizer | null
  }) => PostgresUnitOfWorkGatewayContext<ReadGateways, WriteGateways>
  readonly lockTimeoutMs?: number
  readonly ownerRowLockTimeoutMs?: number
  readonly queryTimeoutMs?: number
  readonly detachedDrainTimeoutMs?: number
}

type WorkRecord = {
  observed: boolean
  settled: boolean
  readonly rawPromise: Promise<unknown>
  readonly visiblePromise: Promise<unknown>
}

class AsyncWorkTracker {
  readonly #records: WorkRecord[] = []
  #active = false

  open(): void {
    this.#active = true
  }

  revoke(): void {
    this.#active = false
  }

  assertActive(): void {
    if (!this.#active) throw new CoordinationError('uow.scope-revoked')
  }

  track<Result>(
    rawPromise: Promise<Result>,
    visiblePromise = rawPromise,
  ): Promise<Result> {
    const record: WorkRecord = {
      observed: false,
      settled: false,
      rawPromise,
      visiblePromise,
    }
    this.#records.push(record)
    void rawPromise.then(
      () => {
        record.settled = true
      },
      () => {
        record.settled = true
      },
    )
    if (visiblePromise !== rawPromise) {
      void visiblePromise.catch(() => undefined)
    }
    return trackedPromise(record) as Promise<Result>
  }

  hasDetachedWork(): boolean {
    return this.#records.some((record) => !record.observed || !record.settled)
  }

  async drainWithin(milliseconds: number): Promise<boolean> {
    const pending = this.#records.filter(({ settled }) => !settled)
    if (pending.length === 0) return true
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.allSettled(pending.map(({ rawPromise }) => rawPromise)).then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), milliseconds)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

class InFlightQueryUncertain extends Error {
  constructor(readonly publicError: CoordinationError) {
    super(publicError.message)
    this.name = 'InFlightQueryUncertain'
  }
}

function connectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  return (
    /^08/.test(code) ||
    ['EPIPE', 'ECONNRESET', 'ECONNREFUSED', '57P01', '57P02', '57P03'].includes(code) ||
    /connection (?:terminated|closed)|not queryable|socket hang up/i.test(error.message)
  )
}

function lockTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === '55P03'
  )
}

type StableQuery = {
  readonly form: 'config' | 'positional'
  readonly sql: string
  readonly values: readonly unknown[] | undefined
}

function stableQuery(args: readonly unknown[]): StableQuery | null {
  const query = args[0]
  if (typeof query === 'string') {
    if (args.length < 1 || args.length > 2) return null
    const capturedValues = captureQueryValues(args[1])
    if (capturedValues === null) return null
    return {
      form: 'positional',
      sql: query,
      values: capturedValues,
    }
  }
  if (query === null || typeof query !== 'object' || args.length !== 1) return null

  const descriptors = Object.getOwnPropertyDescriptors(query)
  const allowedKeys = new Set<PropertyKey>(['text', 'values'])
  if (Reflect.ownKeys(descriptors).some((key) => !allowedKeys.has(key))) return null
  const textDescriptor = descriptors.text
  if (!textDescriptor || !('value' in textDescriptor)) return null
  if (typeof textDescriptor.value !== 'string') return null
  if (
    Reflect.ownKeys(descriptors).some((key) => {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined
      return descriptor && !('value' in descriptor)
    })
  ) {
    return null
  }

  const capturedValues = captureQueryValues(descriptors.values?.value)
  if (capturedValues === null) return null
  return {
    form: 'config',
    sql: textDescriptor.value,
    values: capturedValues,
  }
}

function captureQueryValues(values: unknown): readonly unknown[] | undefined | null {
  if (values === undefined) return undefined
  if (!Array.isArray(values)) return null
  const valueDescriptors = Object.getOwnPropertyDescriptors(values)
  const lengthDescriptor = Reflect.get(valueDescriptors, 'length') as
    | PropertyDescriptor
    | undefined
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumPostgresParameterCount
  ) {
    return null
  }
  const length = lengthDescriptor.value
  if (
    Reflect.ownKeys(valueDescriptors).some((key) => {
      if (key === 'length') return false
      if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)) return true
      const index = Number(key)
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) return true
      const descriptor = Reflect.get(valueDescriptors, key) as
        | PropertyDescriptor
        | undefined
      return !descriptor || !('value' in descriptor)
    })
  ) {
    return null
  }
  const capturedValues = Array.from<unknown>({ length })
  for (let index = 0; index < capturedValues.length; index += 1) {
    const descriptor = valueDescriptors[String(index)]
    if (descriptor && 'value' in descriptor) capturedValues[index] = descriptor.value
  }
  return Object.freeze(capturedValues)
}

function materializePgValues(
  values: readonly unknown[] | undefined,
): readonly (Buffer | null | string)[] | undefined {
  if (values === undefined) return undefined
  const materialized = values.map(prepareStablePostgresValue)
  return Object.freeze(materialized)
}

function materializedQueryConfig(
  query: StableQuery,
  values: readonly (Buffer | null | string)[] | undefined,
  rowMode: 'array' | null,
): SafeQueryConfig & { readonly rowMode?: 'array' } {
  const config = Object.create(null) as SafeQueryConfig & {
    readonly rowMode?: 'array'
  }
  Object.defineProperty(config, 'text', {
    configurable: false,
    enumerable: true,
    value: query.sql,
    writable: false,
  })
  if (values !== undefined) {
    Object.defineProperty(config, 'values', {
      configurable: false,
      enumerable: true,
      value: values,
      writable: false,
    })
  }
  if (rowMode !== null) {
    Object.defineProperty(config, 'rowMode', {
      configurable: false,
      enumerable: true,
      value: rowMode,
      writable: false,
    })
  }
  return Object.freeze(config)
}

function materializeQueryArgs(
  query: StableQuery,
  rowMode: 'array' | null,
): readonly unknown[] {
  const values = materializePgValues(query.values)
  if (rowMode !== null) {
    return [materializedQueryConfig(query, values, rowMode)]
  }
  if (query.form === 'positional') {
    return values === undefined ? [query.sql] : [query.sql, values]
  }
  return [materializedQueryConfig(query, values, null)]
}

const mutationStatementPattern =
  /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|CALL|COPY|REFRESH|VACUUM|ANALYZE|REINDEX|CLUSTER|COMMENT|DO|SET|RESET|DISCARD|LISTEN|UNLISTEN|NOTIFY|LOAD)\b/i
const transactionControlStatementPattern =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE\s+SAVEPOINT|PREPARE\s+TRANSACTION|SET\s+(?:LOCAL\s+)?TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION)\b/i
const sessionControlStatementPattern =
  /^(?:SET|RESET|DISCARD|LISTEN|UNLISTEN|NOTIFY|LOAD|PREPARE|EXECUTE|DEALLOCATE|DECLARE|FETCH|MOVE|CLOSE|LOCK)\b/i
const retainedSessionCommandPattern =
  /\b(?:PREPARE|EXECUTE|DEALLOCATE|DECLARE|FETCH|MOVE|CLOSE)\b/i
const opaqueOrDdlStatementPattern =
  /^(?:CREATE|ALTER|DROP|GRANT|REVOKE|CALL|COPY|REFRESH|VACUUM|ANALYZE|REINDEX|CLUSTER|COMMENT|DO|TRUNCATE|SECURITY\s+LABEL|REASSIGN\s+OWNED|IMPORT\s+FOREIGN\s+SCHEMA)\b/i
const temporarySessionObjectPattern =
  /\b(?:CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?TEMP(?:ORARY)?|INTO\s+(?:(?:GLOBAL|LOCAL)\s+)?TEMP(?:ORARY)?(?:\s+TABLE)?\s+|pg_temp(?:_\d+)?\s*\.)/i
const coordinationPrimitivePattern =
  /\b(?:pg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?|pg_advisory_unlock(?:_shared|_all)?|pg_(?:terminate|cancel)_backend|set_config|setseed|lo_[a-z0-9_$]+|lowrite|loread|dblink[a-z0-9_$]*)\s*\(/i
const mutationFunctionPattern =
  /\b(?:nextval|setval|pg_notify|dblink(?:_exec|_send_query)?|lo_(?:create|creat|unlink|import|export|put|truncate|write)|indigo_[a-z0-9_$]+)\s*\(/i

function sqlCodeForInspection(sql: string): string {
  let code = ''
  let index = 0
  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      code += ' '
      continue
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1
      index += 2
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth += 1
          index += 2
        } else if (sql.startsWith('*/', index)) {
          depth -= 1
          index += 2
        } else {
          index += 1
        }
      }
      code += ' '
      continue
    }
    if (sql[index] === "'") {
      const escapeString =
        index > 0 &&
        /e/i.test(sql[index - 1] ?? '') &&
        (index < 2 || !/[a-z0-9_$]/i.test(sql[index - 2] ?? ''))
      index += 1
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2
        } else if (sql[index] === "'") {
          index += 1
          break
        } else if (escapeString && sql[index] === '\\') {
          index += 2
        } else {
          index += 1
        }
      }
      code += ' '
      continue
    }
    if (sql[index] === '"') {
      let identifier = ''
      index += 1
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          identifier += '"'
          index += 2
        } else if (sql[index] === '"') {
          index += 1
          break
        } else {
          identifier += sql[index]
          index += 1
        }
      }
      if (!/^[a-z_][a-z0-9_$]*$/i.test(identifier)) {
        throw new TypeError(
          'Scoped transaction SQL contains an unsupported quoted identifier.',
        )
      }
      code += identifier
      continue
    }
    if (sql[index] === '$') {
      const delimiter = sql.slice(index).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0]
      if (delimiter) {
        const end = sql.indexOf(delimiter, index + delimiter.length)
        index = end === -1 ? sql.length : end + delimiter.length
        code += ' '
        continue
      }
    }
    code += sql[index]
    index += 1
  }
  return code
}

function hasControlledStatement(normalizedSql: string, pattern: RegExp): boolean {
  return normalizedSql.split(';').some((statement) => pattern.test(statement.trimStart()))
}

function isMutationStatement(sql: string): boolean {
  const normalized = sqlCodeForInspection(sql)
  return (
    mutationStatementPattern.test(normalized) ||
    mutationFunctionPattern.test(normalized) ||
    /\bSELECT\b[^;]*\bINTO\b/i.test(normalized)
  )
}

function guardedInFlightQuery<Result>(input: {
  readonly promise: Promise<Result>
  readonly signal?: AbortSignal
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
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', onAbort)
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
    void input.promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

class TransactionQueryTracker {
  readonly #client: PoolClient
  readonly #work = new AsyncWorkTracker()
  readonly #signal: AbortSignal | undefined
  readonly #queryTimeoutMs: number
  readonly #onUncertain: (error: InFlightQueryUncertain) => void
  readonly #requireWriteAuthorized: () => void
  #queryCount = 0
  #uncertain: unknown

  constructor(
    client: PoolClient,
    signal: AbortSignal | undefined,
    queryTimeoutMs: number,
    onUncertain: (error: InFlightQueryUncertain) => void,
    requireWriteAuthorized: () => void,
  ) {
    this.#client = client
    this.#signal = signal
    this.#queryTimeoutMs = queryTimeoutMs
    this.#onUncertain = onUncertain
    this.#requireWriteAuthorized = requireWriteAuthorized
  }

  #markUncertain(error: InFlightQueryUncertain): void {
    if (this.#uncertain !== undefined) return
    this.#uncertain = error
    this.#work.revoke()
    this.#onUncertain(error)
  }

  #rejectQuery(error: unknown): Promise<never> {
    return this.#work.track(Promise.reject(error))
  }

  #executeQuery(args: readonly unknown[], rowMode: 'array' | null): Promise<unknown> {
    this.#work.assertActive()
    if (this.#signal?.aborted) {
      return this.#rejectQuery(new CoordinationError('uow.cancelled'))
    }
    if (typeof args.at(-1) === 'function') {
      return this.#rejectQuery(
        new TypeError('Scoped transaction queries must use the Promise interface.'),
      )
    }
    let query: StableQuery | null
    try {
      query = stableQuery(args)
    } catch (error) {
      return this.#rejectQuery(error)
    }
    if (query === null) {
      return this.#rejectQuery(
        new TypeError('Scoped transaction queries must expose stable SQL text.'),
      )
    }
    if (rowMode !== null && query.form !== 'positional') {
      return this.#rejectQuery(
        new TypeError('Scoped array queries must use positional SQL text.'),
      )
    }
    const normalizedSql = sqlCodeForInspection(query.sql)
    if (hasControlledStatement(normalizedSql, transactionControlStatementPattern)) {
      return this.#rejectQuery(
        new TypeError('Transaction control belongs to UnitOfWork.'),
      )
    }
    if (
      hasControlledStatement(normalizedSql, sessionControlStatementPattern) ||
      retainedSessionCommandPattern.test(normalizedSql) ||
      hasControlledStatement(normalizedSql, opaqueOrDdlStatementPattern) ||
      temporarySessionObjectPattern.test(normalizedSql) ||
      /\bSELECT\b[^;]*\bINTO\b/i.test(normalizedSql) ||
      coordinationPrimitivePattern.test(normalizedSql)
    ) {
      return this.#rejectQuery(
        new TypeError('Connection and lock control belongs to UnitOfWork.'),
      )
    }
    if (isMutationStatement(query.sql)) this.#requireWriteAuthorized()

    let queryArgs: readonly unknown[]
    try {
      queryArgs = materializeQueryArgs(query, rowMode)
    } catch (error) {
      return this.#rejectQuery(error)
    }
    let promise: Promise<unknown>
    try {
      promise = Reflect.apply(
        this.#client.query,
        this.#client,
        queryArgs,
      ) as Promise<unknown>
    } catch (error) {
      promise = Promise.reject(error)
    }
    this.#queryCount += 1
    const mapped = promise.catch((error: unknown) => {
      if (lockTimeout(error)) throw new CoordinationError('uow.lock-timeout')
      if (connectionFailure(error)) {
        this.#markUncertain(
          new InFlightQueryUncertain(new CoordinationError('uow.connection-lost')),
        )
        throw new CoordinationError('uow.connection-lost')
      }
      throw error
    })
    const visible = guardedInFlightQuery({
      promise: mapped,
      signal: this.#signal,
      timeoutMs: this.#queryTimeoutMs,
      timeoutError: new CoordinationError('uow.connection-lost'),
      onUncertain: (error) => {
        this.#markUncertain(error)
      },
    })
    return this.#work.track(promise, visible)
  }

  readonly scopedClient: ScopedTransactionClient = {
    query: ((...args: readonly unknown[]) =>
      this.#executeQuery(args, null)) as ScopedTransactionClient['query'],
    queryArray: ((...args: readonly unknown[]) =>
      this.#executeQuery(args, 'array')) as ScopedTransactionClient['queryArray'],
  }

  open(): void {
    this.#work.open()
  }

  revoke(): void {
    this.#work.revoke()
  }

  queryCount(): number {
    return this.#queryCount
  }

  hasDetachedWork(): boolean {
    return this.#work.hasDetachedWork()
  }

  drainWithin(milliseconds: number): Promise<boolean> {
    return this.#work.drainWithin(milliseconds)
  }

  uncertainError(): unknown {
    return this.#uncertain
  }
}

function trackedPromise(
  record: WorkRecord,
  visiblePromise = record.visiblePromise,
): Promise<unknown> {
  const markObserved = (): void => {
    record.observed = true
  }
  return {
    // biome-ignore lint/suspicious/noThenProperty: a tracked thenable records whether database work was actually joined by the callback
    then(onFulfilled, onRejected) {
      markObserved()
      const chained = visiblePromise.then(onFulfilled, onRejected)
      void chained.catch(() => undefined)
      return chained
    },
    catch(onRejected) {
      const chained = visiblePromise.catch(onRejected)
      void chained.catch(() => undefined)
      return trackedPromise(record, chained)
    },
    finally(onFinally) {
      const chained = visiblePromise.finally(onFinally)
      void chained.catch(() => undefined)
      return trackedPromise(record, chained)
    },
    [Symbol.toStringTag]: 'Promise',
  } as Promise<unknown>
}

class GatewayInvocationTracker<Gateways> {
  readonly #work = new AsyncWorkTracker()
  readonly #facades = new WeakMap<object, object>()

  wrap(gateways: Gateways): Gateways {
    if ((typeof gateways !== 'object' && typeof gateways !== 'function') || !gateways) {
      throw new TypeError('UnitOfWork gateways must be an object.')
    }
    return this.#facadeFor(gateways as object) as Gateways
  }

  #facadeFor(target: object): object {
    const existing = this.#facades.get(target)
    if (existing) return existing
    const facade = Object.create(null) as Record<PropertyKey, unknown>
    this.#facades.set(target, facade)
    const defined = new Set<PropertyKey>()
    let owner: object | null = target
    while (owner && owner !== Object.prototype && owner !== Function.prototype) {
      for (const property of Reflect.ownKeys(owner)) {
        if (property === 'constructor' || defined.has(property)) continue
        defined.add(property)
        const descriptor = Reflect.getOwnPropertyDescriptor(owner, property)
        if (!descriptor) continue
        const value = Reflect.get(target, property, target) as unknown
        const safeValue =
          typeof value === 'function'
            ? (...args: readonly unknown[]) => {
                this.#work.assertActive()
                const result = Reflect.apply(value, target, args) as unknown
                if (
                  (typeof result === 'object' || typeof result === 'function') &&
                  result !== null &&
                  'then' in result &&
                  typeof result.then === 'function'
                ) {
                  return this.#work.track(Promise.resolve(result))
                }
                return result
              }
            : value !== null && typeof value === 'object'
              ? this.#facadeFor(value)
              : value
        Reflect.defineProperty(facade, property, {
          configurable: false,
          enumerable: descriptor.enumerable ?? false,
          value: safeValue,
          writable: false,
        })
      }
      owner = Reflect.getPrototypeOf(owner)
    }
    return Object.freeze(facade)
  }

  open(): void {
    this.#work.open()
  }

  revoke(): void {
    this.#work.revoke()
  }

  hasDetachedWork(): boolean {
    return this.#work.hasDetachedWork()
  }

  drainWithin(milliseconds: number): Promise<boolean> {
    return this.#work.drainWithin(milliseconds)
  }
}

type CallbackOutcome<Result> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly error: unknown }

function transactionStatement(request: UnitOfWorkRequest): string {
  const isolation =
    request.mode.isolation === 'serializable'
      ? 'SERIALIZABLE'
      : request.mode.isolation === 'repeatable-read'
        ? 'REPEATABLE READ'
        : 'READ COMMITTED'
  const access = request.mode.access === 'read-only' ? 'READ ONLY' : 'READ WRITE'
  return `BEGIN ISOLATION LEVEL ${isolation} ${access}`
}

function ordinaryCredentialLocks(request: UnitOfWorkRequest): readonly SessionLock[] {
  if (request.session.kind !== 'ordinary') return []
  if (request.authority.kind !== 'authenticated-session') {
    throw new CoordinationError('identity.authority-stale')
  }
  return [
    { key: credentialInstanceFenceKey, mode: 'shared' },
    {
      key: `${credentialLockNamespace}account:${request.authority.actorUserId}`,
      mode: 'shared',
    },
  ]
}

function requestLocks(
  request: UnitOfWorkRequest,
  contentPlan: ConsumedContentLockPlan | null,
): readonly SessionLock[] {
  const locks = [...ordinaryCredentialLocks(request)]
  locks.push({ key: productMutationFenceKey, mode: request.productFence })
  if (request.subjectLock) {
    locks.push({ key: request.subjectLock.subjectUserId, mode: request.subjectLock.mode })
  }
  for (const key of contentPlan?.lockKeys ?? []) {
    locks.push({ key, mode: 'exclusive' })
  }
  return locks
}

function lockStatement(mode: SessionLock['mode']): string {
  return mode === 'shared'
    ? 'SELECT pg_advisory_lock_shared(hashtextextended($1, 0))'
    : 'SELECT pg_advisory_lock(hashtextextended($1, 0))'
}

function unlockStatement(mode: SessionLock['mode']): string {
  return mode === 'shared'
    ? 'SELECT pg_advisory_unlock_shared(hashtextextended($1, 0)) AS unlocked'
    : 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked'
}

function combinedSignal(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
}

function queryWithGuard<Row extends Record<string, unknown> = Record<string, unknown>>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] | undefined,
  options: {
    readonly signal?: AbortSignal
    readonly timeoutError: CoordinationError
    readonly timeoutMs: number
  },
) {
  const promise = values ? client.query<Row>(text, [...values]) : client.query<Row>(text)
  return guardedInFlightQuery({
    promise,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    timeoutError: options.timeoutError,
    onUncertain: () => undefined,
  })
}

async function settleWithSignal<Result>(
  promise: Promise<Result>,
  signal: AbortSignal | undefined,
): Promise<Result> {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.catch(() => undefined)
    throw new CoordinationError('uow.cancelled')
  }
  return new Promise<Result>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void =>
      finish(() => reject(new CoordinationError('uow.cancelled')))
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

function errorForDestruction(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('The coordinated database session failed.', { cause: error })
}

function contentScope(
  contentPlan: ConsumedContentLockPlan | null,
): UnitOfWorkContentScope {
  return contentPlan
    ? {
        kind: 'verified',
        transactionScope: contentPlan.transactionScope,
        attestor: contentPlan.attestor,
      }
    : { kind: 'none' }
}

/**
 * Platform-owned PostgreSQL implementation of the neutral UnitOfWork port.
 *
 * It deliberately knows no product schema or module. Identity authority and owner gateways are
 * injected over one tracked transaction client, after every session lock and BEGIN.
 */
export class PostgresUnitOfWork<ReadGateways, WriteGateways extends ReadGateways>
  implements UnitOfWork<ReadGateways, WriteGateways>
{
  readonly #options: Required<
    Pick<
      PostgresUnitOfWorkOptions<ReadGateways, WriteGateways>,
      | 'detachedDrainTimeoutMs'
      | 'lockTimeoutMs'
      | 'ownerRowLockTimeoutMs'
      | 'queryTimeoutMs'
    >
  > &
    Omit<
      PostgresUnitOfWorkOptions<ReadGateways, WriteGateways>,
      | 'detachedDrainTimeoutMs'
      | 'lockTimeoutMs'
      | 'ownerRowLockTimeoutMs'
      | 'queryTimeoutMs'
    >
  readonly #nesting = new AsyncLocalStorage<boolean>()

  constructor(options: PostgresUnitOfWorkOptions<ReadGateways, WriteGateways>) {
    const lockTimeoutMs = options.lockTimeoutMs ?? 5_000
    const ownerRowLockTimeoutMs = options.ownerRowLockTimeoutMs ?? 5_000
    const queryTimeoutMs = options.queryTimeoutMs ?? 30_000
    const detachedDrainTimeoutMs = options.detachedDrainTimeoutMs ?? 250
    for (const [label, value] of [
      ['lock', lockTimeoutMs],
      ['owner-row lock', ownerRowLockTimeoutMs],
      ['query', queryTimeoutMs],
      ['detached drain', detachedDrainTimeoutMs],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError(`UnitOfWork ${label} timeout must be a positive integer.`)
      }
    }
    this.#options = {
      ...options,
      lockTimeoutMs,
      ownerRowLockTimeoutMs,
      queryTimeoutMs,
      detachedDrainTimeoutMs,
    }
  }

  run<Result>(
    request: ContentLockedUnitOfWorkRequest,
    callback: (scope: UnitOfWorkScope<WriteGateways>) => Promise<Result>,
  ): ContentLockedUnitOfWorkExecution<Result>
  run<Result>(
    request: ReadOnlyUnitOfWorkRequest,
    callback: (scope: UnitOfWorkScope<ReadGateways>) => Promise<Result>,
  ): Promise<Result>
  run<Result>(
    request: Exclude<ReadWriteUnitOfWorkRequest, ContentLockedUnitOfWorkRequest>,
    callback: (scope: UnitOfWorkScope<WriteGateways>) => Promise<Result>,
  ): Promise<Result>
  run<Result>(
    requestValue: UnitOfWorkRequest,
    callback: unknown,
  ): Promise<Result> | ContentLockedUnitOfWorkExecution<Result> {
    const request = captureUnitOfWorkRequest(requestValue)
    const failure =
      this.#nesting.getStore() !== undefined
        ? new CoordinationError('uow.nested')
        : typeof callback !== 'function'
          ? new TypeError('UnitOfWork callback must be a function.')
          : undefined
    const execution = failure
      ? this.#rejectedExecution<Result>(request, failure)
      : this.#nesting.run(true, () =>
          this.#run(
            request,
            callback as (
              scope: UnitOfWorkScope<ReadGateways | WriteGateways>,
            ) => Promise<Result>,
          ),
        )
    if (failure && request.content.kind !== 'verified') return execution
    return this.#bindExecution(request, execution)
  }

  async #rejectedExecution<Result>(
    request: UnitOfWorkRequest,
    error: unknown,
  ): Promise<Result> {
    if (request.content.kind === 'verified') {
      const consumed = consumeVerifiedContentLockPlan(request.content.plan, request)
      consumed.finish()
    }
    throw error
  }

  #bindExecution<Result>(
    request: UnitOfWorkRequest,
    execution: Promise<Result>,
  ): Promise<Result> | ContentLockedUnitOfWorkExecution<Result> {
    if (request.content.kind === 'verified') {
      return bindContentLockedUnitOfWorkExecution(request.content.plan, execution)
    }
    if (request.session.kind === 'prelocked') {
      return bindPrelockedSessionExecution(
        request.session.lease as PrelockedSessionLease<PrelockedSessionOperation>,
        execution,
      )
    }
    return execution
  }

  async #run<Result>(
    request: UnitOfWorkRequest,
    callback: (scope: UnitOfWorkScope<ReadGateways | WriteGateways>) => Promise<Result>,
  ): Promise<Result> {
    const consumedContent =
      request.content.kind === 'verified'
        ? consumeVerifiedContentLockPlan(request.content.plan, request)
        : null
    let client: PoolClient | undefined
    let ordinary = false
    let destroyPrelocked: ((error: Error) => void) | undefined
    let finishPrelocked: (() => void) | undefined
    const acquiredLocks: SessionLock[] = []
    let transactionStarted = false
    let transactionCommitted = false
    let poison: unknown
    let skipDatabaseCleanup = false
    let finalOutcome: CallbackOutcome<Result> | undefined
    let queryTracker: TransactionQueryTracker | undefined
    let gatewayTracker: GatewayInvocationTracker<ReadGateways | WriteGateways> | undefined
    let connectionError: Error | undefined
    const connectionAbort = new AbortController()
    const uncertaintyAbort = new AbortController()
    let operationSignal = combinedSignal([
      request.signal,
      consumedContent?.signal,
      uncertaintyAbort.signal,
    ])
    const onConnectionError = (error: Error): void => {
      connectionError ??= error
      connectionAbort.abort()
    }

    try {
      if (request.session.kind === 'ordinary') {
        client = await this.#options.acquireOrdinary({ signal: operationSignal })
        ordinary = true
      } else {
        const resolved = this.#options.resolvePrelockedSession(
          request.session.lease as PrelockedSessionLease<PrelockedSessionOperation>,
          request,
        )
        client = resolved.client
        destroyPrelocked = resolved.destroy
        finishPrelocked = resolved.finish
        operationSignal = combinedSignal([
          operationSignal,
          resolved.signal,
          connectionAbort.signal,
        ])
      }
      operationSignal = combinedSignal([operationSignal, connectionAbort.signal])
      client.on('error', onConnectionError)

      try {
        await queryWithGuard(
          client,
          "SELECT set_config('indigo.user_creation_mode', '', false), set_config('indigo.deletion_mode', '', false)",
          undefined,
          {
            signal: operationSignal,
            timeoutMs: this.#options.queryTimeoutMs,
            timeoutError: new CoordinationError('uow.connection-lost'),
          },
        )
      } catch (error) {
        // This is the security scrub for session-scoped state on a reused backend. If it did
        // not certainly complete, the backend must never return to either pool or outer lease.
        poison = error
        skipDatabaseCleanup = true
        if (error instanceof InFlightQueryUncertain) throw error.publicError
        if (connectionFailure(error)) throw new CoordinationError('uow.connection-lost')
        throw new CoordinationError('uow.begin-failed')
      }

      await this.#acquireLocks(
        client,
        requestLocks(request, consumedContent),
        acquiredLocks,
        operationSignal,
      )
      consumedContent?.assertActive()
      if (operationSignal?.aborted) throw new CoordinationError('uow.cancelled')

      await queryWithGuard(
        client,
        "SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false), set_config('standard_conforming_strings', 'on', false)",
        [`${this.#options.ownerRowLockTimeoutMs}ms`, `${this.#options.queryTimeoutMs}ms`],
        {
          signal: operationSignal,
          timeoutMs: this.#options.queryTimeoutMs,
          timeoutError: new CoordinationError('uow.connection-lost'),
        },
      )

      try {
        await queryWithGuard(client, transactionStatement(request), undefined, {
          signal: operationSignal,
          timeoutMs: this.#options.queryTimeoutMs,
          timeoutError: new CoordinationError('uow.begin-failed'),
        })
        transactionStarted = true
      } catch (error) {
        poison = error
        if (error instanceof InFlightQueryUncertain || connectionFailure(error)) {
          skipDatabaseCleanup = true
        }
        throw new CoordinationError('uow.begin-failed')
      }

      const tracker = new TransactionQueryTracker(
        client,
        operationSignal,
        this.#options.queryTimeoutMs,
        (error) => uncertaintyAbort.abort(error.publicError),
        () => consumedContent?.assertWriteAuthorized(),
      )
      queryTracker = tracker
      const gatewayContext = this.#options.createGatewayContext({
        client: tracker.scopedClient,
        request,
        requireWriteAuthorized: () => consumedContent?.assertWriteAuthorized(),
        exactReplayAuthorizer: consumedContent?.exactReplayAuthorizer ?? null,
        newCommandAuthorizer: consumedContent?.newCommandAuthorizer ?? null,
      })
      tracker.open()
      const identityQueryCount = tracker.queryCount()
      await settleWithSignal(gatewayContext.recheckIdentity(), operationSignal)
      if (tracker.queryCount() <= identityQueryCount || tracker.hasDetachedWork()) {
        throw new CoordinationError('identity.authority-stale')
      }
      if (tracker.uncertainError() !== undefined) {
        poison ??= tracker.uncertainError()
        skipDatabaseCleanup = true
        throw new CoordinationError('uow.connection-lost')
      }
      consumedContent?.assertActive()
      if (operationSignal?.aborted) throw new CoordinationError('uow.cancelled')

      const transactionLocalState = transactionLocalStateForRequest(request)
      try {
        await queryWithGuard(
          client,
          "SELECT set_config('indigo.user_creation_mode', $1, true), set_config('indigo.deletion_mode', $2, true)",
          [transactionLocalState.userCreationMode, transactionLocalState.deletionMode],
          {
            signal: operationSignal,
            timeoutMs: this.#options.queryTimeoutMs,
            timeoutError: new CoordinationError('uow.connection-lost'),
          },
        )
      } catch (error) {
        if (error instanceof InFlightQueryUncertain) {
          poison = error
          skipDatabaseCleanup = true
          throw error.publicError
        }
        if (connectionFailure(error)) {
          poison = error
          skipDatabaseCleanup = true
          throw new CoordinationError('uow.connection-lost')
        }
        throw new CoordinationError('uow.begin-failed')
      }

      consumedContent?.activateCommandAuthorizers()

      let outcome: CallbackOutcome<Result>
      const invocations = new GatewayInvocationTracker<ReadGateways | WriteGateways>()
      gatewayTracker = invocations
      let callbackSettled = false
      let callbackPromise: Promise<Result> | undefined
      try {
        const gateways =
          request.mode.access === 'read-only'
            ? gatewayContext.readGateways
            : gatewayContext.writeGateways
        const scopedGateways = invocations.wrap(gateways)
        invocations.open()
        callbackPromise = Promise.resolve(
          callback({
            gateways: scopedGateways,
            content: contentScope(consumedContent),
          }),
        )
        void callbackPromise.then(
          () => {
            callbackSettled = true
          },
          () => {
            callbackSettled = true
          },
        )
        outcome = {
          ok: true,
          value: await settleWithSignal(callbackPromise, operationSignal),
        }
      } catch (error) {
        outcome = { ok: false, error }
      }

      tracker.revoke()
      invocations.revoke()
      if (!callbackSettled && callbackPromise) {
        poison ??= new CoordinationError('uow.detached-work')
        let callbackDrainTimer: ReturnType<typeof setTimeout> | undefined
        const callbackDrained = await Promise.race([
          callbackPromise.then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => {
            callbackDrainTimer = setTimeout(
              () => resolve(false),
              this.#options.detachedDrainTimeoutMs,
            )
          }),
        ])
        if (callbackDrainTimer) clearTimeout(callbackDrainTimer)
        if (!callbackDrained) skipDatabaseCleanup = true
        if (outcome.ok) {
          outcome = { ok: false, error: new CoordinationError('uow.detached-work') }
        }
      }
      if (tracker.hasDetachedWork() || invocations.hasDetachedWork()) {
        poison ??= new CoordinationError('uow.detached-work')
        const [queriesDrained, gatewaysDrained] = await Promise.all([
          tracker.drainWithin(this.#options.detachedDrainTimeoutMs),
          invocations.drainWithin(this.#options.detachedDrainTimeoutMs),
        ])
        if (!queriesDrained || !gatewaysDrained) skipDatabaseCleanup = true
        if (outcome.ok) {
          outcome = { ok: false, error: new CoordinationError('uow.detached-work') }
        }
      }
      if (tracker.uncertainError() !== undefined) {
        poison ??= tracker.uncertainError()
        skipDatabaseCleanup = true
        if (outcome.ok) {
          outcome = { ok: false, error: new CoordinationError('uow.connection-lost') }
        }
      }
      if (operationSignal?.aborted && outcome.ok) {
        outcome = { ok: false, error: new CoordinationError('uow.cancelled') }
      }
      if (outcome.ok) {
        try {
          consumedContent?.assertReadyToCommit(outcome.value)
        } catch (error) {
          outcome = { ok: false, error }
        }
      }

      if (!outcome.ok) {
        if (!skipDatabaseCleanup) {
          try {
            await queryWithGuard(client, 'ROLLBACK', undefined, {
              timeoutMs: this.#options.queryTimeoutMs,
              timeoutError: new CoordinationError('uow.cleanup-failed'),
            })
            transactionStarted = false
          } catch (rollbackError) {
            poison = rollbackError
            skipDatabaseCleanup = true
          }
        }
        throw outcome.error
      }

      try {
        const commit = await queryWithGuard(client, 'COMMIT', undefined, {
          timeoutMs: this.#options.queryTimeoutMs,
          timeoutError: new CoordinationError('uow.commit-outcome-unknown'),
        })
        transactionStarted = false
        if (Array.isArray(commit) || commit.command !== 'COMMIT') {
          poison = new CoordinationError('uow.transaction-aborted')
          throw poison
        }
        transactionCommitted = true
      } catch (error) {
        transactionStarted = false
        poison ??= error
        if (
          error instanceof CoordinationError &&
          error.code === 'uow.transaction-aborted'
        ) {
          throw error
        }
        skipDatabaseCleanup = true
        throw new CoordinationError('uow.commit-outcome-unknown')
      }
      finalOutcome = { ok: true, value: outcome.value }
    } catch (error) {
      queryTracker?.revoke()
      gatewayTracker?.revoke()
      let reportedError = error
      const trackedUncertainty = queryTracker?.uncertainError()
      const preservesTransactionPhase =
        error instanceof CoordinationError &&
        [
          'uow.begin-failed',
          'uow.commit-outcome-unknown',
          'uow.transaction-aborted',
        ].includes(error.code)
      const connectionDerivedError =
        error instanceof InFlightQueryUncertain ||
        connectionFailure(error) ||
        (error instanceof CoordinationError &&
          ['uow.cancelled', 'uow.connection-lost'].includes(error.code))
      if (preservesTransactionPhase) {
        reportedError = error
      } else if (connectionError) {
        poison ??= connectionError
        skipDatabaseCleanup = true
        if (connectionDerivedError) {
          reportedError = new CoordinationError('uow.connection-lost')
        }
      } else if (trackedUncertainty instanceof InFlightQueryUncertain) {
        poison ??= trackedUncertainty
        skipDatabaseCleanup = true
        reportedError = trackedUncertainty.publicError
      } else if (error instanceof InFlightQueryUncertain) {
        poison ??= error
        skipDatabaseCleanup = true
        reportedError = error.publicError
      } else if (connectionFailure(error)) {
        poison ??= error
        skipDatabaseCleanup = true
        reportedError = new CoordinationError('uow.connection-lost')
      }
      if (queryTracker?.uncertainError() !== undefined) {
        poison ??= queryTracker.uncertainError()
        skipDatabaseCleanup = true
      }
      if (queryTracker?.hasDetachedWork() || gatewayTracker?.hasDetachedWork()) {
        const [queriesDrained, gatewaysDrained] = await Promise.all([
          queryTracker?.drainWithin(this.#options.detachedDrainTimeoutMs) ?? true,
          gatewayTracker?.drainWithin(this.#options.detachedDrainTimeoutMs) ?? true,
        ])
        if (!queriesDrained || !gatewaysDrained) skipDatabaseCleanup = true
      }
      if (transactionStarted && client && !skipDatabaseCleanup) {
        try {
          await queryWithGuard(client, 'ROLLBACK', undefined, {
            timeoutMs: this.#options.queryTimeoutMs,
            timeoutError: new CoordinationError('uow.cleanup-failed'),
          })
          transactionStarted = false
        } catch (rollbackError) {
          poison ??= rollbackError
          skipDatabaseCleanup = true
        }
      }
      finalOutcome = { ok: false, error: reportedError }
    } finally {
      queryTracker?.revoke()
      gatewayTracker?.revoke()
      consumedContent?.finish()
      if (client) {
        let cleanupError: unknown
        if (!skipDatabaseCleanup) {
          try {
            await this.#releaseLocks(client, acquiredLocks)
            await queryWithGuard(client, 'RESET lock_timeout', undefined, {
              timeoutMs: this.#options.queryTimeoutMs,
              timeoutError: new CoordinationError('uow.cleanup-failed'),
            })
            await queryWithGuard(client, 'RESET statement_timeout', undefined, {
              timeoutMs: this.#options.queryTimeoutMs,
              timeoutError: new CoordinationError('uow.cleanup-failed'),
            })
            await queryWithGuard(client, 'RESET standard_conforming_strings', undefined, {
              timeoutMs: this.#options.queryTimeoutMs,
              timeoutError: new CoordinationError('uow.cleanup-failed'),
            })
          } catch (error) {
            cleanupError = error
            poison ??= error
            skipDatabaseCleanup = true
          }
        }

        poison ??= connectionError

        try {
          if (poison !== undefined || skipDatabaseCleanup) {
            const destroyError = errorForDestruction(
              poison ?? new CoordinationError('uow.cleanup-failed'),
            )
            if (ordinary) client.release(destroyError)
            else destroyPrelocked?.(destroyError)
          } else if (ordinary) {
            client.release()
          }
        } catch (error) {
          cleanupError ??= error
        } finally {
          client.removeListener('error', onConnectionError)
          finishPrelocked?.()
        }

        if (cleanupError !== undefined && transactionCommitted && finalOutcome?.ok) {
          finalOutcome = {
            ok: false,
            error: new CoordinationError('uow.cleanup-failed'),
          }
        }
      }
    }

    if (!finalOutcome) throw new CoordinationError('uow.cleanup-failed')
    if (!finalOutcome.ok) throw finalOutcome.error
    return finalOutcome.value
  }

  async #acquireLocks(
    client: PoolClient,
    locks: readonly SessionLock[],
    acquired: SessionLock[],
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = performance.now() + this.#options.lockTimeoutMs
    for (const lock of locks) {
      const remaining = Math.ceil(deadline - performance.now())
      if (remaining <= 0) throw new CoordinationError('uow.lock-timeout')
      try {
        await queryWithGuard(
          client,
          "SELECT set_config('lock_timeout', $1, false)",
          [`${remaining}ms`],
          {
            signal,
            timeoutMs: remaining,
            timeoutError: new CoordinationError('uow.lock-timeout'),
          },
        )
        const lockRemaining = Math.ceil(deadline - performance.now())
        if (lockRemaining <= 0) throw new CoordinationError('uow.lock-timeout')
        await queryWithGuard(client, lockStatement(lock.mode), [lock.key], {
          signal,
          timeoutMs: lockRemaining,
          timeoutError: new CoordinationError('uow.lock-timeout'),
        })
        acquired.push(lock)
      } catch (error) {
        if (error instanceof InFlightQueryUncertain) throw error
        if (lockTimeout(error)) throw new CoordinationError('uow.lock-timeout')
        if (connectionFailure(error)) {
          throw new InFlightQueryUncertain(new CoordinationError('uow.connection-lost'))
        }
        throw error
      }
    }
  }

  async #releaseLocks(client: PoolClient, acquired: SessionLock[]): Promise<void> {
    let firstError: unknown
    for (const lock of acquired.reverse()) {
      try {
        const result = await queryWithGuard<{ unlocked: boolean }>(
          client,
          unlockStatement(lock.mode),
          [lock.key],
          {
            timeoutMs: this.#options.queryTimeoutMs,
            timeoutError: new CoordinationError('uow.cleanup-failed'),
          },
        )
        if (result.rows[0]?.unlocked !== true) {
          throw new Error('A coordinated advisory lock was not held at cleanup.')
        }
      } catch (error) {
        firstError ??= error
        if (error instanceof InFlightQueryUncertain || connectionFailure(error)) break
      }
    }
    if (firstError !== undefined) throw firstError
  }
}
