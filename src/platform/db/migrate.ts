import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { PoolClient } from 'pg'
import { getPool } from './client'

const migrationLockId = 7_134_910_421

export async function migrateDatabase(): Promise<void> {
  const client = await getPool().connect()

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockId])
    // Drizzle's public overload requires the full driver client even though the migrator uses the
    // query surface. The runtime facade deliberately withholds driver lifecycle methods.
    await migrate(drizzle(client as PoolClient), { migrationsFolder: './drizzle' })
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId])
    client.release()
  }
}
