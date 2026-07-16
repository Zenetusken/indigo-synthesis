import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { PoolClient } from 'pg'

const migrationLockId = 7_134_910_421

export type DatabaseMigrationClient = Pick<PoolClient, 'query'>

/**
 * Runs the migration journal on a caller-owned PostgreSQL session. Connection construction and
 * release stay with the caller so production host commands can use their separately budgeted
 * one-shot client while disposable test harnesses can keep using an application pool.
 */
export async function migrateDatabaseWithClient(
  client: DatabaseMigrationClient,
): Promise<void> {
  let lockAcquired = false
  let outcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockId])
    lockAcquired = true
    // Drizzle's public overload names the full driver client even though its migrator only needs
    // the query surface. Lifecycle ownership deliberately remains outside this executor.
    await migrate(drizzle(client as PoolClient), { migrationsFolder: './drizzle' })
    outcome = { ok: true }
  } catch (error) {
    outcome = { ok: false, error }
  }

  let unlockOutcome:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: unknown } = { ok: true }
  if (lockAcquired) {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId])
    } catch (error) {
      unlockOutcome = { ok: false, error }
    }
  }

  if (!outcome.ok) {
    if (!unlockOutcome.ok) {
      throw new AggregateError(
        [outcome.error, unlockOutcome.error],
        'Database migration and advisory-lock cleanup both failed.',
      )
    }
    throw outcome.error
  }
  if (!unlockOutcome.ok) throw unlockOutcome.error
}
