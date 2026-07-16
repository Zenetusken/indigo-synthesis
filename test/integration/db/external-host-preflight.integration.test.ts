import { spawn } from 'node:child_process'
import { Client, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import type { MonitoredPoolClient } from '@/platform/db/bounded-pool'
import { closeDb } from '@/platform/db/client'
import {
  DatabaseRuntime,
  type DatabaseRuntimeSnapshot,
} from '@/platform/db/database-runtime'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import { assertDatabaseReady, type DatabasePreflightQuery } from '@/platform/db/preflight'

const migrationLockId = 7_134_910_421

type QueryClient = Pick<PoolClient, 'query'>
type RunningHostCommand = Readonly<{
  child: ReturnType<typeof spawn>
  completed: Promise<Readonly<{ code: number | null; stderr: string; stdout: string }>>
  output(): Readonly<{ stderr: string; stdout: string }>
}>

let database: DisposableIntegrationDatabase

function hostEnvironment(databaseUrl = database.databaseUrl): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    INDIGO_DATABASE_POOL_MAX: '6',
    INDIGO_CONTENT_MODE: 'development',
    INDIGO_LLM_MODE: 'disabled',
    NODE_ENV: 'test',
  }
}

function startCommand(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): RunningHostCommand {
  const child = spawn(executable, [...arguments_], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const completed = new Promise<{
    code: number | null
    stderr: string
    stdout: string
  }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr, stdout }))
  })
  return { child, completed, output: () => ({ stderr, stdout }) }
}

function startHostCommand(entrypoint: string, databaseUrl?: string): RunningHostCommand {
  return startCommand(
    'bash',
    ['scripts/run-external-host-command.sh', entrypoint],
    hostEnvironment(databaseUrl),
  )
}

async function terminateCommand(command: RunningHostCommand | undefined): Promise<void> {
  if (!command) return
  if (command.child.exitCode === null && command.child.signalCode === null) {
    command.child.kill('SIGKILL')
  }
  await command.completed.catch(() => undefined)
}

async function finishCommand(
  command: RunningHostCommand,
  label: string,
): Promise<Readonly<{ code: number | null; stderr: string; stdout: string }>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      command.completed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not exit within 10 seconds.`)),
          10_000,
        )
      }),
    ])
  } catch (error) {
    await terminateCommand(command)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForRows<Row extends QueryResultRow>(
  inspector: QueryClient,
  command: RunningHostCommand,
  statement: string,
  values: readonly unknown[],
  accept: (rows: readonly Row[]) => boolean,
  label: string,
): Promise<readonly Row[]> {
  const deadline = Date.now() + 10_000
  let lastRows: readonly Row[] = []
  while (Date.now() < deadline) {
    // The lock holder is inside a transaction; PostgreSQL otherwise caches its statistics
    // snapshot and hides a backend that connected after the first poll.
    await inspector.query('SELECT pg_stat_clear_snapshot()')
    const result = await inspector.query<Row>(statement, [...values])
    lastRows = result.rows
    if (accept(result.rows)) return result.rows
    if (command.child.exitCode !== null || command.child.signalCode !== null) {
      const finished = await finishCommand(command, `${label} early exit`)
      throw new Error(
        `${label} command exited early (${finished.code}): ${finished.stderr}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(
    `Timed out waiting for ${label}: rows=${JSON.stringify(lastRows)}, child=${JSON.stringify(command.output())}.`,
  )
}

async function clientConnectionCounts(
  inspector: QueryClient,
): Promise<Record<string, number>> {
  await inspector.query('SELECT pg_stat_clear_snapshot()')
  const result = await inspector.query<{
    applicationName: string
    count: number
  }>(
    `SELECT application_name AS "applicationName", count(*)::integer AS count
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND usename = session_user
       AND backend_type = 'client backend'
     GROUP BY application_name`,
  )
  const counts: Record<string, number> = {}
  for (const row of result.rows) counts[row.applicationName] = Number(row.count)
  return counts
}

async function waitForExternalHostExit(inspector: QueryClient): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const counts = await clientConnectionCounts(inspector)
    if ((counts['indigo-synthesis:external-host'] ?? 0) === 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('External-host PostgreSQL backend did not close.')
}

function assertNoRuntimeQueues(snapshot: DatabaseRuntimeSnapshot): void {
  for (const pool of Object.values(snapshot.pools)) {
    expect(pool.driver.waiting).toBe(0)
    expect(pool.admission.queued).toBe(0)
  }
}

function releaseMonitored(clients: readonly MonitoredPoolClient[]): void {
  for (const monitored of clients.toReversed()) {
    monitored.dispose()
    monitored.client.release()
  }
}

function queryResult<Row extends QueryResultRow>(rows: readonly Row[]): QueryResult<Row> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows: [...rows],
  }
}

beforeAll(async () => {
  database = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'ext_host',
  })
  await database.create()
  database.activateDatabaseUrl()
  resetServerConfigForTests()
  await closeDb()
  await migrateDatabase()
  await closeDb()
})

afterAll(async () => {
  await closeDb()
  database?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await database?.cleanup()
})

describe.sequential('external-host preflight and migration topology', () => {
  it.each([
    'scripts/db/preflight.ts',
    'scripts/db/migrate.ts',
  ])('rejects direct %s invocation before opening a database connection', async (entrypoint) => {
    const directEnvironment = hostEnvironment()
    delete directEnvironment.INDIGO_EXTERNAL_HOST_LOCK_HELD
    delete directEnvironment.INDIGO_EXTERNAL_HOST_LOCK_FD
    delete directEnvironment.INDIGO_EXTERNAL_HOST_LOCK_PATH

    const command = startCommand(
      process.execPath,
      ['--import', 'tsx', entrypoint],
      directEnvironment,
    )
    try {
      const finished = await finishCommand(command, `direct ${entrypoint}`)
      expect(finished.code).toBe(1)
      expect(finished.stdout).toBe('')
      expect(finished.stderr).toContain('run-external-host-command.sh')
    } finally {
      await terminateCommand(command)
    }
  })

  it('fails the concrete preflight when the authenticated role is below the pool budget', async () => {
    const originalPoolMax = process.env.INDIGO_DATABASE_POOL_MAX
    const verifier = new Client({ connectionString: database.databaseUrl })
    await verifier.connect()
    process.env.INDIGO_DATABASE_POOL_MAX = '6'
    resetServerConfigForTests()
    const query: DatabasePreflightQuery = {
      query<Row extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<Row>> {
        if (text.includes('FROM pg_roles AS role')) {
          return Promise.resolve(
            queryResult([
              {
                connectionLimit: 5,
                roleName: 'injected-limited-role',
              } as unknown as Row,
            ]),
          )
        }
        return values ? verifier.query<Row>(text, [...values]) : verifier.query<Row>(text)
      },
    }

    try {
      await expect(assertDatabaseReady(query)).rejects.toThrow(
        'authenticated PostgreSQL role connection allowance is below INDIGO_DATABASE_POOL_MAX=6 (role injected-limited-role, rolconnlimit 5; -1 means unlimited)',
      )
    } finally {
      await verifier.end()
      if (originalPoolMax === undefined) {
        delete process.env.INDIGO_DATABASE_POOL_MAX
      } else {
        process.env.INDIGO_DATABASE_POOL_MAX = originalPoolMax
      }
      resetServerConfigForTests()
    }
  })

  it('normalizes a hostile connection search path before observational preflight', async () => {
    const setup = new Client({ connectionString: database.databaseUrl })
    await setup.connect()
    try {
      await setup.query('CREATE SCHEMA hostile_preflight')
      await setup.query(
        `CREATE TABLE hostile_preflight.installation_state (
           singleton integer,
           owner_user_id text,
           bootstrap_closed_at timestamptz,
           product_mutation_epoch text
         )`,
      )
      await setup.query(
        `INSERT INTO hostile_preflight.installation_state
           (singleton, owner_user_id, bootstrap_closed_at, product_mutation_epoch)
         VALUES (2, NULL, NULL, 'not-an-epoch')`,
      )
      await setup.query(
        `CREATE TABLE hostile_preflight.program_revision (
           methodology_review_status text,
           template_review_status text
         )`,
      )
      await setup.query(
        `INSERT INTO hostile_preflight.program_revision
         VALUES ('not-reviewed', 'not-reviewed')`,
      )

      const hostileUrl = new URL(database.databaseUrl)
      hostileUrl.searchParams.set('options', '-csearch_path=hostile_preflight,public')
      const command = startHostCommand('scripts/db/preflight.ts', hostileUrl.toString())
      try {
        const finished = await finishCommand(command, 'hostile-search-path preflight')
        expect(finished.code).toBe(0)
        expect(finished.stderr).toBe('')
        expect(finished.stdout).toContain('Database ready: PostgreSQL')
      } finally {
        await terminateCommand(command)
      }
    } finally {
      await setup.query('DROP SCHEMA IF EXISTS hostile_preflight CASCADE')
      await setup.end()
    }
  })

  it('uses only the external slot while migration waits on its advisory lock', async () => {
    const runtime = new DatabaseRuntime({
      connectionString: database.databaseUrl,
      poolMax: 6,
    })
    const blocker = await runtime.acquireOrdinary()
    let command: RunningHostCommand | undefined
    try {
      await blocker.client.query('SELECT pg_advisory_lock($1)', [migrationLockId])
      command = startHostCommand('scripts/db/migrate.ts')
      await waitForRows<{ applicationName: string }>(
        blocker.client,
        command,
        `SELECT application_name AS "applicationName"
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = 'indigo-synthesis:external-host'
           AND wait_event_type = 'Lock'
           AND wait_event = 'advisory'`,
        [],
        (rows) => rows.length === 1,
        'blocked external-host migration',
      )

      expect(await clientConnectionCounts(blocker.client)).toEqual({
        'indigo-synthesis:ordinary': 1,
        'indigo-synthesis:external-host': 1,
      })
      assertNoRuntimeQueues(runtime.snapshot())

      await blocker.client.query('SELECT pg_advisory_unlock($1)', [migrationLockId])
      const finished = await finishCommand(command, 'blocked migration')
      expect(finished).toEqual({
        code: 0,
        stderr: '',
        stdout: 'Database migrations are current.\n',
      })
      await waitForExternalHostExit(blocker.client)
    } finally {
      await blocker.client.query('SELECT pg_advisory_unlock($1)', [migrationLockId])
      await terminateCommand(command)
      releaseMonitored([blocker])
      await runtime.close()
    }
  })

  it('preserves the exact six-connection budget under full application saturation', async () => {
    const runtime = new DatabaseRuntime({
      connectionString: database.databaseUrl,
      poolMax: 6,
    })
    const ordinary = await Promise.all([
      runtime.acquireOrdinary(),
      runtime.acquireOrdinary(),
    ])
    const control = await Promise.all([
      runtime.acquireTrustedMonitoredControl(),
      runtime.acquireTrustedMonitoredControl(),
    ])
    const capture = await runtime.acquireTrustedMonitoredCapture()
    const held = [...ordinary, ...control, capture]
    const blocker = ordinary[0]
    if (!blocker) throw new Error('Missing ordinary saturation blocker.')
    let command: RunningHostCommand | undefined
    try {
      await blocker.client.query('BEGIN')
      await blocker.client.query(
        'LOCK TABLE public.installation_state IN ACCESS EXCLUSIVE MODE',
      )
      command = startHostCommand('scripts/db/preflight.ts')
      const waiting = await waitForRows<{
        applicationName: string
        query: string
        waitEvent: string | null
        waitEventType: string | null
      }>(
        blocker.client,
        command,
        `SELECT application_name AS "applicationName",
                wait_event_type AS "waitEventType",
                wait_event AS "waitEvent",
                query
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND usename = session_user
           AND backend_type = 'client backend'
           AND application_name = 'indigo-synthesis:external-host'`,
        [],
        (rows) =>
          rows.length === 1 &&
          rows[0]?.waitEventType === 'Lock' &&
          rows[0].query.includes('installation_state'),
        'relation-blocked external-host preflight',
      )
      expect(waiting[0]?.waitEvent).toBe('relation')

      expect(await clientConnectionCounts(blocker.client)).toEqual({
        'indigo-synthesis:ordinary': 2,
        'indigo-synthesis:control': 2,
        'indigo-synthesis:capture': 1,
        'indigo-synthesis:external-host': 1,
      })
      expect(
        Object.values(await clientConnectionCounts(blocker.client)).reduce(
          (total, count) => total + count,
          0,
        ),
      ).toBe(6)
      assertNoRuntimeQueues(runtime.snapshot())

      await blocker.client.query('COMMIT')
      const finished = await finishCommand(command, 'saturated preflight')
      expect(finished.code).toBe(0)
      expect(finished.stderr).toBe('')
      expect(finished.stdout).toContain('Database ready: PostgreSQL')
      await waitForExternalHostExit(blocker.client)
    } finally {
      await blocker.client.query('ROLLBACK')
      await terminateCommand(command)
      releaseMonitored(held)
      await runtime.close()
    }
  })
})
