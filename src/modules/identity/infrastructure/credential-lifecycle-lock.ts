import { Client } from 'pg'
import { getServerConfig } from '@/platform/config/server'

const credentialLockNamespace = 'indigo:credential-lifecycle:'

/**
 * Holds a PostgreSQL session advisory lock on a dedicated connection. The protected
 * callback may use the normal application pool without consuming the connection that
 * owns the lock, avoiding pool starvation when an authentication handler creates its
 * session on another connection.
 */
export async function withCredentialLifecycleLock<T>(
  userId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: getServerConfig().databaseUrl,
    application_name: 'indigo-credential-lifecycle',
  })
  let locked = false

  await client.connect()
  try {
    await client.query("SET lock_timeout = '10s'")
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      `${credentialLockNamespace}${userId}`,
    ])
    locked = true
    return await callback()
  } finally {
    if (locked) {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
          `${credentialLockNamespace}${userId}`,
        ])
        .catch(() => undefined)
    }
    await client.end().catch(() => undefined)
  }
}
