import type { Client } from 'pg'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import { withExternalHostClientOwner } from './external-host-one-shot'
import { migrateDatabaseWithClient } from './migration-executor'

async function migrateOwnedClient(client: Client): Promise<void> {
  let connectionError: Error | undefined
  const onConnectionError = (error: Error): void => {
    connectionError ??= error
  }
  client.on('error', onConnectionError)

  let outcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  try {
    await migrateDatabaseWithClient(client)
    outcome = { ok: true }
  } catch (error) {
    outcome = { ok: false, error }
  } finally {
    client.removeListener('error', onConnectionError)
  }

  if (!outcome.ok) {
    if (connectionError && connectionError !== outcome.error) {
      throw new AggregateError(
        [outcome.error, connectionError],
        'Database migration and its dedicated connection both failed.',
      )
    }
    throw outcome.error
  }
  if (connectionError) throw connectionError
}

/** Production CLI adapter: exactly one separately budgeted session, owned outside app pools. */
export function migrateDatabaseFromHostCli(): Promise<void> {
  return withExternalHostClientOwner(
    {
      hostInvocationId: newUuidV7(),
      runTimeoutMs: 120_000,
    },
    async () => undefined,
    async (_captured, owner) => migrateOwnedClient(owner.client),
  )
}
