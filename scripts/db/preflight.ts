import { closeDb } from '../../src/platform/db/client'
import { assertDatabaseReady } from '../../src/platform/db/preflight'

try {
  const result = await assertDatabaseReady()
  process.stdout.write(`Database ready: ${result.databaseVersion}\n`)
} finally {
  await closeDb()
}
