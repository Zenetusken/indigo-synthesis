import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { resetServerConfigForTests } from '../../src/platform/config/server'
import {
  assertBackupRestoreDrillDatabaseName,
  type BackupRestoreDrillPgClient,
  omitAmbientPostgresEnvironment,
  resolveBackupRestoreDrillPgClient,
} from '../../src/platform/db/backup-restore-drill-guard'
import { closeDb, getPool } from '../../src/platform/db/client'
import { createDisposableIntegrationDatabase } from '../../src/platform/db/disposable-integration-database'
import { migrateDatabase } from '../../src/platform/db/migrate'
import { parseGuardedPostgresUrl } from '../../src/platform/db/postgres-url-guard'
import { assertDatabaseReady } from '../../src/platform/db/preflight'

const commandOutputLimitBytes = 64 * 1024 * 1024
const markerId = 'backup-restore-drill-marker'
const markerMetadata = { proof: 'seed-survived-backup-restore' } as const
const containerPasswordPrelude = `unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSFILE
IFS= read -r PGPASSWORD
export PGPASSWORD
exec "$@"`

type PgConnection = {
  readonly database: string
  readonly host: string
  readonly password: string
  readonly port: string
  readonly username: string
}

function decodedPassword(databaseUrl: string): string {
  const encoded = new URL(databaseUrl).password
  try {
    return decodeURIComponent(encoded)
  } catch {
    throw new Error('Disposable database password contains invalid URL encoding.')
  }
}

function pgConnection(databaseUrl: string): PgConnection {
  const guarded = parseGuardedPostgresUrl('drill database URL', databaseUrl)
  const host =
    guarded.hostname.startsWith('[') && guarded.hostname.endsWith(']')
      ? guarded.hostname.slice(1, -1)
      : guarded.hostname

  return {
    database: guarded.database,
    host,
    password: decodedPassword(databaseUrl),
    port: guarded.effectivePort,
    username: guarded.username,
  }
}

function commandFailure(label: string, result: ReturnType<typeof spawnSync>): Error {
  if (result.error) {
    const missingTool = (result.error as NodeJS.ErrnoException).code === 'ENOENT'
    const detail = missingTool
      ? 'the required executable was not found'
      : result.error.message
    return new Error(`${label} failed: ${detail}.`)
  }

  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString('utf8').trim()
    : String(result.stderr ?? '').trim()
  const status =
    result.status === null ? `signal ${result.signal}` : `exit ${result.status}`
  return new Error(`${label} failed (${status})${stderr ? `: ${stderr}` : '.'}`)
}

function checkedSpawn(
  label: string,
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly input?: Buffer
  } = {},
): Buffer {
  const result = spawnSync(command, [...args], {
    env: options.env,
    input: options.input,
    encoding: null,
    maxBuffer: commandOutputLimitBytes,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (result.status !== 0 || result.error) throw commandFailure(label, result)
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '')
}

function containerArgs(
  client: Extract<BackupRestoreDrillPgClient, { readonly kind: 'container' }>,
  connection: PgConnection,
  tool: 'pg_dump' | 'pg_restore',
  args: readonly string[],
): string[] {
  return [
    'exec',
    '-i',
    '-e',
    `PGHOST=${client.host === '[::1]' ? '::1' : client.host}`,
    '-e',
    `PGPORT=${client.port}`,
    '-e',
    `PGUSER=${connection.username}`,
    '-e',
    `PGDATABASE=${connection.database}`,
    '-e',
    'PGCONNECT_TIMEOUT=5',
    '-e',
    'PGAPPNAME=indigo-backup-restore-drill',
    client.container,
    'sh',
    '-ceu',
    containerPasswordPrelude,
    'indigo-backup-restore-drill',
    tool,
    ...args,
  ]
}

function runPgTool(
  client: BackupRestoreDrillPgClient,
  connection: PgConnection,
  tool: 'pg_dump' | 'pg_restore',
  args: readonly string[],
  input = Buffer.alloc(0),
): Buffer {
  if (client.kind === 'host') {
    return checkedSpawn(tool, tool, args, {
      env: {
        ...omitAmbientPostgresEnvironment(process.env),
        NODE_ENV: process.env.NODE_ENV,
        PGAPPNAME: 'indigo-backup-restore-drill',
        PGCONNECT_TIMEOUT: '5',
        PGDATABASE: connection.database,
        PGHOST: connection.host,
        PGPASSWORD: connection.password,
        PGPORT: connection.port,
        PGUSER: connection.username,
      },
      input,
    })
  }

  if (/[\r\n]/.test(connection.password)) {
    throw new Error(
      'Container-backed PostgreSQL tooling does not accept a password containing a line break.',
    )
  }

  return checkedSpawn(tool, 'docker', containerArgs(client, connection, tool, args), {
    input: Buffer.concat([Buffer.from(`${connection.password}\n`), input]),
  })
}

function pgToolVersion(
  client: BackupRestoreDrillPgClient,
  tool: 'pg_dump' | 'pg_restore',
): string {
  const output =
    client.kind === 'host'
      ? checkedSpawn(`${tool} version check`, tool, ['--version'])
      : checkedSpawn(`${tool} version check`, 'docker', [
          'exec',
          client.container,
          tool,
          '--version',
        ])
  return output.toString('utf8').trim()
}

function assertMatchingPgTools(client: BackupRestoreDrillPgClient): string {
  const dumpVersion = pgToolVersion(client, 'pg_dump')
  const restoreVersion = pgToolVersion(client, 'pg_restore')
  const dumpMajor = dumpVersion.match(/PostgreSQL\) (\d+)/)?.[1]
  const restoreMajor = restoreVersion.match(/PostgreSQL\) (\d+)/)?.[1]

  if (
    !dumpMajor ||
    !restoreMajor ||
    dumpMajor !== restoreMajor ||
    Number(dumpMajor) < 18
  ) {
    throw new Error(
      `Backup/restore drill requires matching PostgreSQL 18+ pg_dump and pg_restore clients; found ${dumpVersion} and ${restoreVersion}.`,
    )
  }
  return `${dumpVersion}; ${restoreVersion}`
}

async function seedProof(databaseUrl: string): Promise<string> {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'indigo-backup-restore-drill',
  })
  await client.connect()
  try {
    const epoch = await client.query<{ productMutationEpoch: string }>(
      `SELECT product_mutation_epoch AS "productMutationEpoch"
       FROM installation_state WHERE singleton = 1`,
    )
    const expectedEpoch = epoch.rows[0]?.productMutationEpoch
    if (!expectedEpoch) throw new Error('Backup seed has no installation mutation epoch.')
    await client.query(
      `INSERT INTO audit_event (
         id, event_type, entity_type, entity_id, metadata
       ) VALUES ($1, 'backup-restore-drill', 'backup-restore-drill', $1, $2::jsonb)`,
      [markerId, JSON.stringify(markerMetadata)],
    )
    return expectedEpoch
  } finally {
    await client.end()
  }
}

async function wipeDisposableSchema(
  databaseUrl: string,
  databaseName: string,
): Promise<void> {
  assertBackupRestoreDrillDatabaseName(databaseName)
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'indigo-backup-restore-drill',
  })
  await client.connect()
  try {
    const identity = await client.query<{ database: string }>(
      'SELECT current_database() AS database',
    )
    if (identity.rows[0]?.database !== databaseName) {
      throw new Error('Connected database does not match the guarded disposable target.')
    }

    await client.query('DROP SCHEMA public CASCADE')
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
    await client.query('CREATE SCHEMA public')
    const empty = await client.query<{
      applicationRelation: string | null
      migrationRelation: string | null
    }>(
      `SELECT
         to_regclass('public.audit_event')::text AS "applicationRelation",
         to_regclass('drizzle.__drizzle_migrations')::text AS "migrationRelation"`,
    )
    if (
      empty.rows[0]?.applicationRelation !== null ||
      empty.rows[0]?.migrationRelation !== null
    ) {
      throw new Error('Disposable database wipe did not remove all restored relations.')
    }
  } finally {
    await client.end()
  }
}

async function verifyRestoredProof(
  databaseUrl: string,
  expectedEpoch: string,
): Promise<void> {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'indigo-backup-restore-drill',
  })
  await client.connect()
  try {
    const epoch = await client.query<{ productMutationEpoch: string }>(
      `SELECT product_mutation_epoch AS "productMutationEpoch"
       FROM installation_state WHERE singleton = 1`,
    )
    if (epoch.rows[0]?.productMutationEpoch !== expectedEpoch) {
      throw new Error('Restored installation mutation epoch does not match the backup.')
    }
    const marker = await client.query<{
      eventType: string
      metadata: { readonly proof?: string }
    }>(
      `SELECT event_type AS "eventType", metadata
       FROM audit_event
       WHERE id = $1`,
      [markerId],
    )
    if (
      marker.rows.length !== 1 ||
      marker.rows[0]?.eventType !== 'backup-restore-drill' ||
      marker.rows[0]?.metadata.proof !== markerMetadata.proof
    ) {
      throw new Error('Restored backup does not contain the exact seeded proof row.')
    }

    try {
      await client.query(
        `UPDATE audit_event SET metadata = '{"tampered":true}'::jsonb WHERE id = $1`,
        [markerId],
      )
      throw new Error('Restored audit immutability trigger accepted a forbidden update.')
    } catch (error) {
      const postgresError = error as { readonly code?: string; readonly message?: string }
      if (
        postgresError.code !== '55000' ||
        !postgresError.message?.includes('audit events are append-only')
      ) {
        throw error
      }
    }
  } finally {
    await client.end()
  }
}

const pgClient = resolveBackupRestoreDrillPgClient({
  container: process.env.INDIGO_BACKUP_DRILL_PG_CONTAINER,
  host: process.env.INDIGO_BACKUP_DRILL_CONTAINER_HOST,
  port: process.env.INDIGO_BACKUP_DRILL_CONTAINER_PORT,
})
const toolVersions = assertMatchingPgTools(pgClient)
const database = createDisposableIntegrationDatabase({
  administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
  suite: 'backup_restore',
})
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'indigo-backup-restore-'))
const archivePath = join(temporaryDirectory, 'drill.dump')

try {
  await database.create()
  assertBackupRestoreDrillDatabaseName(database.databaseName)
  database.activateDatabaseUrl()
  resetServerConfigForTests()

  await migrateDatabase()
  await closeDb()
  const expectedEpoch = await seedProof(database.databaseUrl)

  const connection = pgConnection(database.databaseUrl)
  const archive = runPgTool(pgClient, connection, 'pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
  ])
  if (archive.byteLength === 0) throw new Error('pg_dump produced an empty archive.')
  await writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 })

  await wipeDisposableSchema(database.databaseUrl, database.databaseName)
  const retainedArchive = await readFile(archivePath)
  runPgTool(
    pgClient,
    connection,
    'pg_restore',
    [
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      connection.database,
    ],
    retainedArchive,
  )

  await verifyRestoredProof(database.databaseUrl, expectedEpoch)
  const preflight = await assertDatabaseReady(getPool())
  await closeDb()

  const archiveDigest = createHash('sha256').update(retainedArchive).digest('hex')
  process.stdout.write(
    `${[
      'Backup/restore drill passed.',
      `PostgreSQL clients: ${toolVersions}`,
      `Disposable target: ${database.databaseName}`,
      `Archive: ${retainedArchive.byteLength} bytes, sha256 ${archiveDigest}`,
      `Restored preflight: ${preflight.databaseVersion}`,
      'Proof: installation epoch and exact audit row restored; append-only trigger rejected mutation (SQLSTATE 55000).',
    ].join('\n')}\n`,
  )
} finally {
  try {
    await closeDb()
  } finally {
    try {
      await database.cleanup()
    } finally {
      resetServerConfigForTests()
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
