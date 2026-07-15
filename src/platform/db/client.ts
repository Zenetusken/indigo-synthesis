import { getServerConfig } from '@/platform/config/server'
import {
  type Database,
  DatabaseRuntime,
  type DatabaseTransaction,
  type OrdinaryDatabaseClient,
  type OrdinaryDatabasePool,
} from './database-runtime'

export type {
  Database,
  DatabaseTransaction,
  OrdinaryDatabaseClient,
  OrdinaryDatabasePool,
}

type DatabaseRuntimeState =
  | { readonly kind: 'live'; readonly runtime: DatabaseRuntime }
  | {
      readonly kind: 'closing'
      readonly runtime: DatabaseRuntime
      readonly promise: Promise<void>
    }
  | { readonly kind: 'poisoned'; readonly error: unknown }

const globalDatabase = globalThis as typeof globalThis & {
  indigoDatabaseRuntimeState?: DatabaseRuntimeState
}

function getRuntime(): DatabaseRuntime {
  const state = globalDatabase.indigoDatabaseRuntimeState
  if (state?.kind === 'live') return state.runtime
  if (state?.kind === 'closing') throw new Error('The database runtime is closing.')
  if (state?.kind === 'poisoned') {
    throw new Error('The database runtime shutdown was uncertain; restart the process.', {
      cause: state.error,
    })
  }

  const config = getServerConfig()
  const runtime = new DatabaseRuntime({
    connectionString: config.databaseUrl,
    poolMax: config.databasePoolMax,
  })
  globalDatabase.indigoDatabaseRuntimeState = { kind: 'live', runtime }
  return runtime
}

/** Compatibility boundary for ordinary Drizzle and node-postgres callers. */
export function getPool(): OrdinaryDatabasePool {
  return getRuntime().ordinaryPoolForCompatibility()
}

export function getDb(): Database {
  return getRuntime().ordinaryDatabase()
}

export async function closeDb(): Promise<void> {
  const state = globalDatabase.indigoDatabaseRuntimeState
  if (!state) return
  if (state.kind === 'closing') return state.promise
  if (state.kind === 'poisoned') throw state.error

  const runtime = state.runtime
  const promise = runtime.close()
  globalDatabase.indigoDatabaseRuntimeState = { kind: 'closing', runtime, promise }
  try {
    await promise
  } catch (error) {
    const current = globalDatabase.indigoDatabaseRuntimeState
    if (current?.kind === 'closing' && current.runtime === runtime) {
      globalDatabase.indigoDatabaseRuntimeState = { kind: 'poisoned', error }
    }
    throw error
  }

  const current = globalDatabase.indigoDatabaseRuntimeState
  if (current?.kind === 'closing' && current.runtime === runtime) {
    globalDatabase.indigoDatabaseRuntimeState = undefined
  }
}
