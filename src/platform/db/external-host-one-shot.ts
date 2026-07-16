import { readlinkSync } from 'node:fs'
import { Client, type QueryResult, type QueryResultRow } from 'pg'
import { CoordinationError } from '@/application/coordination'
import { getServerConfig } from '@/platform/config/server'

const inheritedLockMarker = 'INDIGO_EXTERNAL_HOST_LOCK_HELD'
const inheritedLockFileDescriptor = 'INDIGO_EXTERNAL_HOST_LOCK_FD'
const inheritedLockPath = 'INDIGO_EXTERNAL_HOST_LOCK_PATH'
const defaultPhaseTimeoutMs = 30_000
const maximumPhaseTimeoutMs = 120_000
type ExternalHostOwnerLease = { teardownUnconfirmed: boolean }
let activeExternalHostOwner: ExternalHostOwnerLease | undefined

export type ExternalHostOneShotQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

export type ExternalHostOneShotOptions = {
  readonly hostInvocationId: string
  /** Test-only escape used by disposable-database integration composition. */
  readonly allowTestWithoutInheritedLock?: boolean
  readonly connectTimeoutMs?: number
  readonly captureTimeoutMs?: number
  readonly runTimeoutMs?: number
  readonly closeTimeoutMs?: number
}

type ExternalHostClientOwner = Readonly<{
  client: Client
  close(): Promise<void>
  closeTimeoutMs: number
  forceDestroy(): void
  hostInvocationId: string
}>

type DestroyableStream = { destroy(): void }

function phaseTimeout(value: number | undefined, label: string): number {
  const milliseconds = value ?? defaultPhaseTimeoutMs
  if (
    !Number.isInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > maximumPhaseTimeoutMs
  ) {
    throw new TypeError(
      `External-host ${label} timeout must be from 1 through ${maximumPhaseTimeoutMs} milliseconds.`,
    )
  }
  return milliseconds
}

function hardDestroy(client: Client): void {
  const connection = Reflect.get(client, 'connection')
  const stream =
    connection && typeof connection === 'object'
      ? Reflect.get(connection, 'stream')
      : undefined
  if (
    !stream ||
    typeof stream !== 'object' ||
    typeof Reflect.get(stream, 'destroy') !== 'function'
  ) {
    throw new Error('The dedicated PostgreSQL client socket is unavailable for cleanup.')
  }
  ;(stream as DestroyableStream).destroy()
}

function tryHardDestroy(client: Client, lease: ExternalHostOwnerLease): void {
  try {
    hardDestroy(client)
  } catch {
    // Retain the in-process owner lease and its error listener. A second connection must not be
    // admitted while physical teardown of the first one is unconfirmed.
    lease.teardownUnconfirmed = true
  }
}

async function bounded<Result>(
  operation: Promise<Result>,
  milliseconds: number,
  timeoutError: CoordinationError,
  onTimeout: () => void,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(timeoutError)
        }, milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function assertInheritedExternalHostLock(): void {
  const descriptor = process.env[inheritedLockFileDescriptor]
  const expectedPath = process.env[inheritedLockPath]
  if (
    process.env[inheritedLockMarker] !== '1' ||
    !descriptor ||
    !/^[1-9][0-9]*$/.test(descriptor) ||
    !expectedPath
  ) {
    throw new Error(
      'This host command must be launched through scripts/run-external-host-command.sh.',
    )
  }

  let actualPath: string
  try {
    actualPath = readlinkSync(`/proc/self/fd/${descriptor}`)
  } catch (error) {
    throw new Error('The inherited external-host lock descriptor is unavailable.', {
      cause: error,
    })
  }
  if (actualPath !== expectedPath) {
    throw new Error(
      'The inherited external-host lock descriptor does not match its path.',
    )
  }
}

async function closeDedicatedClient(
  client: Client,
  timeoutMs: number,
  lease: ExternalHostOwnerLease,
): Promise<void> {
  try {
    await bounded(
      Promise.resolve().then(() => client.end()),
      timeoutMs,
      new CoordinationError('uow.cleanup-failed'),
      () => tryHardDestroy(client, lease),
    )
  } catch (error) {
    tryHardDestroy(client, lease)
    throw error
  }
}

/**
 * Lowest-level ownership of the one separately budgeted host connection. Only exact Platform
 * bridges may receive the raw owner; ordinary host observations use withExternalHostOneShot.
 */
export async function withExternalHostClientOwner<Capture, Result>(
  options: ExternalHostOneShotOptions,
  capture: (query: ExternalHostOneShotQuery) => Promise<Capture>,
  run: (captured: Capture, owner: ExternalHostClientOwner) => Promise<Result>,
): Promise<Result> {
  if (!options.hostInvocationId) {
    throw new TypeError('An external-host invocation identity is required.')
  }
  const connectTimeoutMs = phaseTimeout(options.connectTimeoutMs, 'connect')
  const captureTimeoutMs = phaseTimeout(options.captureTimeoutMs, 'capture')
  const runTimeoutMs =
    options.runTimeoutMs === undefined
      ? undefined
      : phaseTimeout(options.runTimeoutMs, 'run')
  const closeTimeoutMs = phaseTimeout(options.closeTimeoutMs, 'close')
  const testBypass = options.allowTestWithoutInheritedLock === true
  if (testBypass && process.env.NODE_ENV !== 'test') {
    throw new TypeError('The external-host lock bypass is restricted to test processes.')
  }
  if (!testBypass) assertInheritedExternalHostLock()

  if (activeExternalHostOwner) {
    throw new Error(
      'An external-host database connection is already active or its teardown is unconfirmed.',
    )
  }
  const lease: ExternalHostOwnerLease = { teardownUnconfirmed: false }
  activeExternalHostOwner = lease
  try {
    return await runExternalHostClientOwner(
      options,
      { captureTimeoutMs, closeTimeoutMs, connectTimeoutMs, runTimeoutMs },
      lease,
      capture,
      run,
    )
  } finally {
    if (!lease.teardownUnconfirmed && activeExternalHostOwner === lease) {
      activeExternalHostOwner = undefined
    }
  }
}

async function runExternalHostClientOwner<Capture, Result>(
  options: ExternalHostOneShotOptions,
  timeouts: Readonly<{
    captureTimeoutMs: number
    closeTimeoutMs: number
    connectTimeoutMs: number
    runTimeoutMs: number | undefined
  }>,
  lease: ExternalHostOwnerLease,
  capture: (query: ExternalHostOneShotQuery) => Promise<Capture>,
  run: (captured: Capture, owner: ExternalHostClientOwner) => Promise<Result>,
): Promise<Result> {
  const { captureTimeoutMs, closeTimeoutMs, connectTimeoutMs, runTimeoutMs } = timeouts
  const client = new Client({
    connectionString: getServerConfig().databaseUrl,
    application_name: 'indigo-synthesis:external-host',
    connectionTimeoutMillis: connectTimeoutMs,
  })
  let ownedConnectionError: Error | undefined
  const onCaptureConnectionError = (error: Error): void => {
    ownedConnectionError ??= error
  }
  client.on('error', onCaptureConnectionError)

  try {
    await bounded(
      client.connect(),
      connectTimeoutMs,
      new CoordinationError('uow.connection-lost'),
      () => tryHardDestroy(client, lease),
    )
  } catch (error) {
    tryHardDestroy(client, lease)
    try {
      await closeDedicatedClient(client, closeTimeoutMs, lease)
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'External-host connection failed and its dedicated client did not close cleanly.',
      )
    } finally {
      if (!lease.teardownUnconfirmed) {
        client.removeListener('error', onCaptureConnectionError)
      }
    }
    throw error
  }

  let closePromise: Promise<void> | undefined
  const owner: ExternalHostClientOwner = Object.freeze({
    client,
    closeTimeoutMs,
    hostInvocationId: options.hostInvocationId,
    close() {
      closePromise ??= closeDedicatedClient(client, closeTimeoutMs, lease)
      return closePromise
    },
    forceDestroy() {
      try {
        hardDestroy(client)
      } catch (error) {
        lease.teardownUnconfirmed = true
        throw error
      }
    },
  })

  let captureActive = true
  const query: ExternalHostOneShotQuery = Object.freeze({
    query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      if (!captureActive) {
        return Promise.reject(new Error('The external-host capture scope is revoked.'))
      }
      return values ? client.query<Row>(text, [...values]) : client.query<Row>(text)
    },
  })

  let captured: Capture
  let captureSucceeded = false
  try {
    await bounded(
      client.query(
        "SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', false)",
      ),
      captureTimeoutMs,
      new CoordinationError('uow.connection-lost'),
      () => tryHardDestroy(client, lease),
    )
    captured = await bounded(
      Promise.resolve().then(() => capture(query)),
      captureTimeoutMs,
      new CoordinationError('uow.connection-lost'),
      () => tryHardDestroy(client, lease),
    )
    if (ownedConnectionError) throw ownedConnectionError
    captureSucceeded = true
  } catch (error) {
    try {
      await owner.close()
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'External-host capture failed and its dedicated client did not close cleanly.',
      )
    }
    throw error
  } finally {
    captureActive = false
    if (!captureSucceeded && !lease.teardownUnconfirmed) {
      client.removeListener('error', onCaptureConnectionError)
    }
  }

  let outcome:
    | { readonly ok: true; readonly value: Result }
    | {
        readonly ok: false
        readonly error: unknown
      }
  try {
    const operation = Promise.resolve().then(() => run(captured, owner))
    const value =
      runTimeoutMs === undefined
        ? await operation
        : await bounded(
            operation,
            runTimeoutMs,
            new CoordinationError('uow.connection-lost'),
            () => tryHardDestroy(client, lease),
          )
    if (ownedConnectionError) throw ownedConnectionError
    outcome = {
      ok: true,
      value,
    }
  } catch (error) {
    outcome = { ok: false, error }
  }

  let closeOutcome:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: unknown }
  try {
    await owner.close()
    closeOutcome = { ok: true }
  } catch (error) {
    closeOutcome = { ok: false, error }
  } finally {
    if (!lease.teardownUnconfirmed) {
      client.removeListener('error', onCaptureConnectionError)
    }
  }

  const failures: unknown[] = []
  const addFailure = (error: unknown): void => {
    if (!failures.some((existing) => Object.is(existing, error))) failures.push(error)
  }
  if (!outcome.ok) addFailure(outcome.error)
  if (ownedConnectionError) addFailure(ownedConnectionError)
  if (!closeOutcome.ok) addFailure(closeOutcome.error)
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'External-host work and dedicated-client cleanup both failed.',
    )
  }
  if (failures.length === 1) throw failures[0]
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

/** Query-only host one-shot that returns only after its dedicated client is closed. */
export function withExternalHostOneShot<Result>(
  options: ExternalHostOneShotOptions,
  operation: (query: ExternalHostOneShotQuery) => Promise<Result>,
): Promise<Result> {
  return withExternalHostClientOwner(options, operation, async (captured) => captured)
}
