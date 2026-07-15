import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb } from '@/platform/db/client'
import { createDisposableIntegrationDatabase } from '@/platform/db/disposable-integration-database'
import { expectedMigrationCount, inspectDatabase } from '@/platform/db/preflight'

const epochPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

async function applyMigrations(
  client: Client,
  migrations: readonly MigrationMeta[],
): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS drizzle')
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `)
  for (const migration of migrations) {
    await client.query('BEGIN')
    try {
      for (const statement of migration.sql) {
        if (statement.trim()) await client.query(statement)
      }
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
}

describe('installation mutation epoch upgrade', () => {
  it('backfills a claimed singleton without rewriting its owner lifecycle', async () => {
    const database = createDisposableIntegrationDatabase({
      administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
      suite: 'epoch_upgrade',
    })
    let client: Client | undefined
    await database.create()

    try {
      client = new Client({ connectionString: database.databaseUrl })
      await client.connect()
      const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
      expect(migrations).toHaveLength(expectedMigrationCount)

      await applyMigrations(client, migrations.slice(0, -1))
      await client.query(
        `SELECT set_config('indigo.user_creation_mode', 'bootstrap-owner', false)`,
      )
      await client.query(
        `INSERT INTO "user" (id, name, email, email_verified)
         VALUES ('epoch-owner', 'Epoch owner', 'epoch-owner@example.test', true)`,
      )
      const before = await client.query<{
        bootstrapClosedAt: Date
        createdAt: Date
        ownerUserId: string
        updatedAt: Date
      }>(
        `SELECT owner_user_id AS "ownerUserId",
                bootstrap_closed_at AS "bootstrapClosedAt",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM installation_state WHERE singleton = 1`,
      )
      await applyMigrations(client, migrations.slice(-1))

      const backfilled = await client.query<{
        bootstrapClosedAt: Date
        createdAt: Date
        epoch: string
        ownerUserId: string
        updatedAt: Date
      }>(
        `SELECT owner_user_id AS "ownerUserId",
                bootstrap_closed_at AS "bootstrapClosedAt",
                created_at AS "createdAt", updated_at AS "updatedAt",
                product_mutation_epoch::text AS epoch
         FROM installation_state WHERE singleton = 1`,
      )
      const originalEpoch = backfilled.rows[0]?.epoch
      expect(originalEpoch).toMatch(epochPattern)
      expect(backfilled.rows[0]).toMatchObject(before.rows[0] ?? {})

      await client.query(
        `UPDATE installation_state
         SET product_mutation_epoch = DEFAULT
         WHERE singleton = 1`,
      )
      const rotated = await client.query<{ epoch: string }>(
        `SELECT product_mutation_epoch::text AS epoch
         FROM installation_state WHERE singleton = 1`,
      )
      expect(rotated.rows[0]?.epoch).toMatch(epochPattern)
      expect(rotated.rows[0]?.epoch).not.toBe(originalEpoch)

      const column = await client.query<{
        columnDefault: string | null
        isNullable: string
      }>(
        `SELECT column_default AS "columnDefault", is_nullable AS "isNullable"
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'installation_state'
           AND column_name = 'product_mutation_epoch'`,
      )
      expect(column.rows[0]).toEqual({
        columnDefault: expect.stringContaining('gen_random_uuid()'),
        isNullable: 'NO',
      })
    } finally {
      await client?.end()
      await database.cleanup()
    }
  })

  it('creates one open singleton when the pre-epoch database has no row', async () => {
    const database = createDisposableIntegrationDatabase({
      administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
      suite: 'epoch_rowless',
    })
    let client: Client | undefined
    await database.create()

    try {
      client = new Client({ connectionString: database.databaseUrl })
      await client.connect()
      const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
      await applyMigrations(client, migrations.slice(0, -1))
      const before = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM installation_state',
      )
      expect(before.rows[0]?.count).toBe(0)

      await applyMigrations(client, migrations.slice(-1))
      const rows = await client.query<{
        bootstrapClosedAt: Date | null
        epoch: string
        ownerUserId: string | null
        singleton: number
      }>(
        `SELECT singleton, owner_user_id AS "ownerUserId",
                bootstrap_closed_at AS "bootstrapClosedAt",
                product_mutation_epoch::text AS epoch
         FROM installation_state`,
      )
      expect(rows.rows).toEqual([
        {
          bootstrapClosedAt: null,
          epoch: expect.stringMatching(epochPattern),
          ownerUserId: null,
          singleton: 1,
        },
      ])

      database.activateDatabaseUrl()
      resetServerConfigForTests()
      await closeDb()
      await expect(inspectDatabase()).resolves.toMatchObject({
        installationMutationEpochPresent: true,
      })

      await client.query(
        'ALTER TABLE installation_state ALTER COLUMN product_mutation_epoch DROP DEFAULT',
      )
      await expect(inspectDatabase()).resolves.toMatchObject({
        installationMutationEpochPresent: false,
      })
      await client.query(
        'ALTER TABLE installation_state ALTER COLUMN product_mutation_epoch SET DEFAULT gen_random_uuid()',
      )
      await client.query(
        'ALTER TABLE installation_state DROP CONSTRAINT installation_state_singleton_check',
      )
      await client.query('UPDATE installation_state SET singleton = 2')
      await expect(inspectDatabase()).resolves.toMatchObject({
        installationMutationEpochPresent: false,
      })
      await client.query('DELETE FROM installation_state')
      await expect(inspectDatabase()).resolves.toMatchObject({
        installationMutationEpochPresent: false,
      })
    } finally {
      await closeDb()
      database.restoreDatabaseUrl()
      resetServerConfigForTests()
      await client?.end()
      await database.cleanup()
    }
  })
})
