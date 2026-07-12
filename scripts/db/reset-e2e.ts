import { Client } from 'pg'
import { resetAuthForTests } from '../../src/modules/identity/infrastructure/auth'
import { resetServerConfigForTests } from '../../src/platform/config/server'
import { closeDb } from '../../src/platform/db/client'
import { validateLocalE2eResetTarget } from '../../src/platform/db/e2e-reset-guard'
import { migrateDatabase } from '../../src/platform/db/migrate'

const administrationUrl = process.env.DATABASE_URL
const e2eUrl = process.env.E2E_DATABASE_URL
const databaseName = validateLocalE2eResetTarget(administrationUrl, e2eUrl)

// Parsing again is safe only after the pure destructive-target guard has passed.
const administration = new URL(administrationUrl as string)
const target = new URL(e2eUrl as string)

const client = new Client({ connectionString: administration.toString() })
await client.connect()

try {
  await client.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [databaseName],
  )
  await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
  await client.query(`CREATE DATABASE "${databaseName}"`)
} finally {
  await client.end()
}

process.env.DATABASE_URL = target.toString()
resetServerConfigForTests()
resetAuthForTests()
await closeDb()

try {
  await migrateDatabase()
  process.stdout.write(`Fresh E2E database ready: ${databaseName}\n`)
} finally {
  await closeDb()
}
