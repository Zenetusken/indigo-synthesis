import { closeDb } from '../../src/platform/db/client'
import { migrateDatabase } from '../../src/platform/db/migrate'

try {
  await migrateDatabase()
  process.stdout.write('Database migrations are current.\n')
} finally {
  await closeDb()
}
