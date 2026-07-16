import { newUuidV7 } from '@/platform/ids/uuid-v7'
import { withExternalHostOneShot } from './external-host-one-shot'
import { assertDatabaseReady, type DatabasePreflight } from './preflight'

/** Production preflight over the single separately budgeted external-host connection. */
export function assertHostDatabaseReady(): Promise<DatabasePreflight> {
  return withExternalHostOneShot({ hostInvocationId: newUuidV7() }, (query) =>
    assertDatabaseReady(query),
  )
}
