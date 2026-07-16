import type {
  Database,
  DatabaseTransaction,
  OrdinaryDatabaseClient,
  OrdinaryDatabasePool,
} from './database-runtime'
import { closeDatabaseRuntime, getDatabaseRuntime } from './runtime-registry'

export type {
  Database,
  DatabaseTransaction,
  OrdinaryDatabaseClient,
  OrdinaryDatabasePool,
}

/** Compatibility boundary for ordinary Drizzle and node-postgres callers. */
export function getPool(): OrdinaryDatabasePool {
  return getDatabaseRuntime().ordinaryPoolForCompatibility()
}

export function getDb(): Database {
  return getDatabaseRuntime().ordinaryDatabase()
}

export function closeDb(): Promise<void> {
  return closeDatabaseRuntime()
}
