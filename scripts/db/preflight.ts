import { assertHostDatabaseReady } from '../../src/platform/db/host-preflight'

const result = await assertHostDatabaseReady()
process.stdout.write(`Database ready: ${result.databaseVersion}\n`)
