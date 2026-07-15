import { readlinkSync } from 'node:fs'
import { Client, type QueryResult, type QueryResultRow } from 'pg'
import { CoordinationError, type PrelockedSessionPort } from '@/application/coordination'
import {
  createPlatformPrelockedSessionPort,
  withPlatformExternalHostConnection,
} from '@/platform/application-coordination/prelocked-session'
import { getServerConfig } from '@/platform/config/server'

const inheritedLockMarker = 'INDIGO_EXTERNAL_HOST_LOCK_HELD'
const inheritedLockFileDescriptor = 'INDIGO_EXTERNAL_HOST_LOCK_FD'
const inheritedLockPath = 'INDIGO_EXTERNAL_HOST_LOCK_PATH'
const defaultPhaseTimeoutMs = 30_000
const maximumPhaseTimeoutMs = 120_000

export type ExternalHostCaptureQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

type ExternalHostCommandOptions = {
  readonly hostInvocationId: string
  /** Test-only escape used by disposable-database integration composition. */
  readonly allowTestWithoutInheritedLock?: boolean
  readonly connectTimeoutMs?: number
  readonly captureTimeoutMs?: number
  readonly closeTimeoutMs?: number
}

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

function tryHardDestroy(client: Client): void {
  try {
    hardDestroy(client)
  } catch {
    // The stable bounded failure remains authoritative. The synchronous hard-close was attempted;
    // no connection owner or pool exists to receive this one-shot client.
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

async function closeDedicatedClient(client: Client, timeoutMs: number): Promise<void> {
  try {
    await bounded(
      Promise.resolve().then(() => client.end()),
      timeoutMs,
      new CoordinationError('uow.cleanup-failed'),
      () => tryHardDestroy(client),
    )
  } catch (error) {
    tryHardDestroy(client)
    throw error
  }
}

/**
 * Owns one dedicated PostgreSQL session from pre-queue capture through lease cleanup. The capture
 * query view is revoked before the nominal prelocked-session port is exposed, so host composition
 * cannot retain a raw connection or instantiate an application pool.
 */
export async function withExternalHostCommand<Capture, Result>(
  options: ExternalHostCommandOptions,
  capture: (query: ExternalHostCaptureQuery) => Promise<Capture>,
  run: (captured: Capture, prelockedSessions: PrelockedSessionPort) => Promise<Result>,
): Promise<Result> {
  if (!options.hostInvocationId) {
    throw new TypeError('An external-host invocation identity is required.')
  }
  const connectTimeoutMs = phaseTimeout(options.connectTimeoutMs, 'connect')
  const captureTimeoutMs = phaseTimeout(options.captureTimeoutMs, 'capture')
  const closeTimeoutMs = phaseTimeout(options.closeTimeoutMs, 'close')
  const testBypass = options.allowTestWithoutInheritedLock === true
  if (testBypass && process.env.NODE_ENV !== 'test') {
    throw new TypeError('The external-host lock bypass is restricted to test processes.')
  }
  if (!testBypass) assertInheritedExternalHostLock()

  const client = new Client({
    connectionString: getServerConfig().databaseUrl,
    application_name: 'indigo-synthesis:external-host',
    connectionTimeoutMillis: connectTimeoutMs,
  })
  let captureConnectionError: Error | undefined
  const onCaptureConnectionError = (error: Error): void => {
    captureConnectionError ??= error
  }
  client.on('error', onCaptureConnectionError)

  try {
    await bounded(
      client.connect(),
      connectTimeoutMs,
      new CoordinationError('uow.connection-lost'),
      () => tryHardDestroy(client),
    )
  } catch (error) {
    tryHardDestroy(client)
    try {
      await closeDedicatedClient(client, closeTimeoutMs)
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'External-host connection failed and its dedicated client did not close cleanly.',
      )
    } finally {
      client.removeListener('error', onCaptureConnectionError)
    }
    throw error
  }

  let captureActive = true
  const query = Object.freeze({
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
  try {
    captured = await bounded(
      Promise.resolve().then(() => capture(query)),
      captureTimeoutMs,
      new CoordinationError('uow.connection-lost'),
      () => tryHardDestroy(client),
    )
    if (captureConnectionError) throw captureConnectionError
  } catch (error) {
    try {
      await closeDedicatedClient(client, closeTimeoutMs)
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'External-host capture failed and its dedicated client did not close cleanly.',
      )
    }
    throw error
  } finally {
    captureActive = false
    client.removeListener('error', onCaptureConnectionError)
  }

  return withPlatformExternalHostConnection(
    {
      hostInvocationId: options.hostInvocationId,
      client,
      closeTimeoutMs,
      close: () => client.end(),
      forceDestroy: () => hardDestroy(client),
    },
    (externalHostConnection) =>
      run(captured, createPlatformPrelockedSessionPort({ externalHostConnection })),
  )
}
