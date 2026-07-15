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

async function withCredentialConnection<Result>(
  acquire: () => Promise<PoolClient>,
  callback: (connection: CredentialConnection) => Promise<Result>,
): Promise<Result> {
  let client: PoolClient
  try {
    client = await acquire()
  } catch (error) {
    if (error instanceof CoordinationError && error.code === 'uow.capacity') {
      throw new CredentialConnectionCapacityError({ cause: error })
    }
    throw error
  }
  const connection: CredentialConnection = { query: client.query.bind(client) }
  let outcome: CallbackOutcome<Result>
  try {
    outcome = { ok: true, value: await callback(connection) }
  } catch (error) {
    outcome = { ok: false, error }
  }

  try {
    client.release(
      outcome.ok ? undefined : outcome.error instanceof Error ? outcome.error : true,
    )
  } catch (releaseError) {
    if (outcome.ok) throw releaseError
  }

  if (!outcome.ok) throw outcome.error
  return outcome.value
}

export function withTrustedCredentialCapture<Result>(
  callback: (connection: CredentialConnection) => Promise<Result>,
  options: CredentialConnectionOptions = {},
): Promise<Result> {
  return withCredentialConnection(
    () => getDatabaseRuntime().acquireTrustedCapture(options),
    callback,
  )
}

export function withSubmittedEmailCredentialCapture<Result>(
  callback: (connection: CredentialConnection) => Promise<Result>,
  options: CredentialConnectionOptions = {},
): Promise<Result> {
  return withCredentialConnection(
    () => getDatabaseRuntime().acquireSubmittedEmailCapture(options),
    callback,
  )
}

export function withTrustedCredentialControl<Result>(
  callback: (connection: CredentialConnection) => Promise<Result>,
  options: CredentialConnectionOptions = {},
): Promise<Result> {
  return withCredentialConnection(
    () => getDatabaseRuntime().acquireTrustedControl(options),
    callback,
  )
}

export function withSubmittedEmailCredentialControl<Result>(
  callback: (connection: CredentialConnection) => Promise<Result>,
  options: CredentialConnectionOptions = {},
): Promise<Result> {
  return withCredentialConnection(
    () => getDatabaseRuntime().acquireSubmittedEmailControl(options),
    callback,
  )
}
