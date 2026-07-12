import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getPool } from './client'

const migrationLockId = 7_134_910_421

export async function migrateDatabase(): Promise<void> {
  const client = await getPool().connect()

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockId])
    await migrate(drizzle(client), { migrationsFolder: './drizzle' })
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId])
    client.release()
  }
}
