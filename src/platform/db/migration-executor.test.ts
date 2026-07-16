import type { QueryResult, QueryResultRow } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type DatabaseMigrationClient,
  migrateDatabaseWithClient,
} from './migration-executor'

const driverMocks = vi.hoisted(() => ({
  database: Object.freeze({ kind: 'migration-database' }),
  drizzle: vi.fn(),
  migrate: vi.fn(),
}))

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: driverMocks.drizzle,
}))

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: driverMocks.migrate,
}))

function queryResult<Row extends QueryResultRow>(
  rows: readonly Row[] = [],
): QueryResult<Row> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows: [...rows],
  }
}

function fakeClient(
  query: (text: string, values?: readonly unknown[]) => Promise<QueryResult>,
): DatabaseMigrationClient {
  return { query: vi.fn(query) } as unknown as DatabaseMigrationClient
}

beforeEach(() => {
  driverMocks.drizzle.mockReset().mockReturnValue(driverMocks.database)
  driverMocks.migrate.mockReset().mockResolvedValue(undefined)
})

describe('database migration executor', () => {
  it('serializes the injected migration session with a session advisory lock', async () => {
    const transcript: string[] = []
    const client = fakeClient(async (text) => {
      transcript.push(text)
      return queryResult()
    })
    driverMocks.migrate.mockImplementation(async () => {
      transcript.push('migrate')
    })

    await migrateDatabaseWithClient(client)

    expect(transcript).toEqual([
      'SELECT pg_advisory_lock($1)',
      'migrate',
      'SELECT pg_advisory_unlock($1)',
    ])
    expect(driverMocks.drizzle).toHaveBeenCalledWith(client)
    expect(driverMocks.migrate).toHaveBeenCalledWith(driverMocks.database, {
      migrationsFolder: './drizzle',
    })
  })

  it('does not attempt an unlock when lock acquisition failed', async () => {
    const lockFailure = new Error('lock failed')
    const query = vi.fn(async () => {
      throw lockFailure
    })
    const client = fakeClient(query)

    await expect(migrateDatabaseWithClient(client)).rejects.toBe(lockFailure)

    expect(query).toHaveBeenCalledOnce()
    expect(driverMocks.drizzle).not.toHaveBeenCalled()
    expect(driverMocks.migrate).not.toHaveBeenCalled()
  })

  it('unlocks after migration failure and preserves both operation and cleanup failures', async () => {
    const migrationFailure = new Error('migration failed')
    const unlockFailure = new Error('unlock failed')
    const query = vi.fn(async (text: string) => {
      if (text.includes('unlock')) throw unlockFailure
      return queryResult()
    })
    const client = fakeClient(query)
    driverMocks.migrate.mockRejectedValue(migrationFailure)

    await expect(migrateDatabaseWithClient(client)).rejects.toMatchObject({
      errors: [migrationFailure, unlockFailure],
    })

    expect(query).toHaveBeenCalledTimes(2)
  })
})
