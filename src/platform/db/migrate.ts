import { getPool } from './client'
import { migrateDatabaseWithClient } from './migration-executor'

/** Compatibility entry point for disposable databases and integration harnesses. */
export async function migrateDatabase(): Promise<void> {
  const client = await getPool().connect()

  let outcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  try {
    await migrateDatabaseWithClient(client)
    outcome = { ok: true }
  } catch (error) {
    outcome = { ok: false, error }
  }

  let releaseOutcome:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: unknown }
  try {
    client.release()
    releaseOutcome = { ok: true }
  } catch (error) {
    releaseOutcome = { ok: false, error }
  }

  if (!outcome.ok) {
    if (!releaseOutcome.ok) {
      throw new AggregateError(
        [outcome.error, releaseOutcome.error],
        'Database migration and pooled-client release both failed.',
      )
    }
    throw outcome.error
  }
  if (!releaseOutcome.ok) throw releaseOutcome.error
}
