import type { PoolClient } from 'pg'
import { CoordinationError } from '@/application/coordination/errors'
import {
  credentialControlConnectionCount,
  submittedEmailAdmissionQueueLimit,
  trustedAdmissionQueueLimit,
} from './connection-topology'
import { getDatabaseRuntime } from './runtime-registry'

export {
  credentialControlConnectionCount as credentialLifecycleConnectionLimit,
  submittedEmailAdmissionQueueLimit as credentialLifecycleSubmittedEmailQueueLimit,
  trustedAdmissionQueueLimit as credentialLifecycleTrustedQueueLimit,
}

export type CredentialConnection = Pick<PoolClient, 'query'>
export type CredentialConnectionOptions = { readonly signal?: AbortSignal }

export class CredentialConnectionCapacityError extends Error {
  constructor(options: { readonly cause: CoordinationError }) {
    super('Credential database admission is full.', options)
    this.name = 'CredentialConnectionCapacityError'
  }
}

type CallbackOutcome<Result> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly error: unknown }

type MonitoredCredentialClient = {
  readonly client: PoolClient
  readonly error: () => Error | undefined
  readonly dispose: () => void
  readonly subscribe: (listener: (error: Error) => void) => () => void
}

async function withCredentialConnection<Result>(
  acquire: () => Promise<MonitoredCredentialClient>,
  callback: (connection: CredentialConnection) => Promise<Result>,
): Promise<Result> {
  let acquired: MonitoredCredentialClient
  try {
    acquired = await acquire()
  } catch (error) {
    if (error instanceof CoordinationError && error.code === 'uow.capacity') {
      throw new CredentialConnectionCapacityError({ cause: error })
    }
    throw error
  }
  const { client } = acquired
  const connection: CredentialConnection = { query: client.query.bind(client) }
  let connectionError: Error | undefined
  const unsubscribe = acquired.subscribe((error) => {
    if (connectionError) return
    connectionError = error
  })
  let outcome: CallbackOutcome<Result>
  if (connectionError) {
    outcome = { ok: false, error: connectionError }
  } else {
    try {
      outcome = { ok: true, value: await callback(connection) }
    } catch (error) {
      outcome = { ok: false, error }
    }
  }

  try {
    client.release(
      connectionError ??
        (outcome.ok ? undefined : outcome.error instanceof Error ? outcome.error : true),
    )
  } catch (releaseError) {
    if (outcome.ok && !connectionError) throw releaseError
  } finally {
    unsubscribe()
    acquired.dispose()
  }

  if (outcome.ok && connectionError) throw connectionError
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

export function withTrustedCredentialCapture<Result>(
  callback: (connection: CredentialConnection) => Promise<Result>,
  options: CredentialConnectionOptions = {},
): Promise<Result> {
  return withCredentialConnection(
    () => getDatabaseRuntime().acquireTrustedMonitoredCapture(options),
    callback,
  )
}

export function withSubmittedEmailCredentialCapture<Result>(
  callback: (connection: CredentialConnection) => Promise<Result>,
  options: CredentialConnectionOptions = {},
): Promise<Result> {
  return withCredentialConnection(
    () => getDatabaseRuntime().acquireSubmittedEmailMonitoredCapture(options),
    callback,
  )
}

export function withTrustedCredentialControl<Result>(
  callback: (connection: CredentialConnection) => Promise<Result>,
  options: CredentialConnectionOptions = {},
): Promise<Result> {
  return withCredentialConnection(
    () => getDatabaseRuntime().acquireTrustedMonitoredControl(options),
    callback,
  )
}

export function withSubmittedEmailCredentialControl<Result>(
  callback: (connection: CredentialConnection) => Promise<Result>,
  options: CredentialConnectionOptions = {},
): Promise<Result> {
  return withCredentialConnection(
    () => getDatabaseRuntime().acquireSubmittedEmailMonitoredControl(options),
    callback,
  )
}
