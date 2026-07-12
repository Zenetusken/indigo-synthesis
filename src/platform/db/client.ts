import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { getServerConfig } from '@/platform/config/server'
import * as schema from './schema'

type Database = NodePgDatabase<typeof schema>

const globalDatabase = globalThis as typeof globalThis & {
  indigoPool?: Pool
  indigoDb?: Database
}

export function getPool(): Pool {
  globalDatabase.indigoPool ??= new Pool({
    connectionString: getServerConfig().databaseUrl,
    max: 10,
    application_name: 'indigo-synthesis',
  })

  return globalDatabase.indigoPool
}

export function getDb(): Database {
  globalDatabase.indigoDb ??= drizzle(getPool(), { schema })
  return globalDatabase.indigoDb
}

export async function closeDb(): Promise<void> {
  await globalDatabase.indigoPool?.end()
  globalDatabase.indigoPool = undefined
  globalDatabase.indigoDb = undefined
}
