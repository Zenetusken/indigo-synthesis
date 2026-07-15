import type { PoolClient } from 'pg'
import { getDatabaseRuntime } from './runtime-registry'

export type PrelockedControlClientOptions = { readonly signal?: AbortSignal }
export type PrelockedControlClient = {
  readonly client: PoolClient
  readonly error: () => Error | undefined
  readonly dispose: () => void
  readonly subscribe: (listener: (error: Error) => void) => () => void
}

/** Exact database-layer bridge for the trusted credential-control lane. */
export function acquireTrustedPrelockedControlClient(
  options: PrelockedControlClientOptions = {},
): Promise<PrelockedControlClient> {
  return getDatabaseRuntime().acquireTrustedMonitoredControl(options)
}

/** Exact database-layer bridge for the submitted-email credential-control lane. */
export function acquireSubmittedEmailPrelockedControlClient(
  options: PrelockedControlClientOptions = {},
): Promise<PrelockedControlClient> {
  return getDatabaseRuntime().acquireSubmittedEmailMonitoredControl(options)
}
