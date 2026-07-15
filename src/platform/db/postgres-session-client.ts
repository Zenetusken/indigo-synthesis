import type { Client } from 'pg'

/**
 * Exact PostgreSQL session surface used by coordination. Both a pooled checkout and a dedicated
 * one-shot `pg.Client` satisfy it; connection ownership and release stay with their adapters.
 */
export type PostgresSessionClient = {
  readonly query: Client['query']
  on(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
}
