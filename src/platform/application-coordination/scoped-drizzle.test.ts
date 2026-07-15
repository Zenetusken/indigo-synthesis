import { eq } from 'drizzle-orm'
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type { QueryArrayResult, QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ScopedTransactionClient } from './postgres-unit-of-work'
import { createScopedDrizzleDatabase } from './scoped-drizzle'

const left = pgTable('scoped_drizzle_left', {
  id: text('id').primaryKey(),
  value: integer('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
})

const right = pgTable('scoped_drizzle_right', {
  id: text('id').primaryKey(),
  leftId: text('left_id').notNull(),
})

function objectResult<Row extends QueryResultRow>(
  rows: readonly Row[] = [],
  command = 'SELECT',
): QueryResult<Row> {
  return { command, fields: [], oid: 0, rowCount: rows.length, rows: [...rows] }
}

function arrayResult<Row extends unknown[]>(
  rows: readonly Row[] = [],
  command = 'SELECT',
): QueryArrayResult<Row> {
  return { command, fields: [], oid: 0, rowCount: rows.length, rows: [...rows] }
}

function scopedClient() {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) =>
    objectResult(),
  )
  const queryArray = vi.fn(async (_sql: string, _values?: readonly unknown[]) =>
    arrayResult(),
  )
  return {
    client: { query, queryArray } as unknown as ScopedTransactionClient,
    query,
    queryArray,
  }
}

function runtimeClient(database: ReturnType<typeof createScopedDrizzleDatabase>): {
  query(...args: readonly unknown[]): Promise<unknown>
} {
  return Reflect.get(database, '$client') as {
    query(...args: readonly unknown[]): Promise<unknown>
  }
}

function compileTimeSurface(
  database: ReturnType<typeof createScopedDrizzleDatabase>,
): void {
  // @ts-expect-error The local Drizzle runtime shim is deliberately absent from the public type.
  void database.$client
}

function drizzleTypes(parser: () => unknown = () => 'unused') {
  return {
    getTypeParser: parser,
  }
}

describe('scoped Drizzle bridge', () => {
  void compileTimeSurface
  it('routes raw and selected queries without forwarding parser or prepared state', async () => {
    const scoped = scopedClient()
    const database = createScopedDrizzleDatabase(scoped.client)
    const createdAt = new Date('2025-01-02T03:04:05.000Z')

    await database.insert(left).values({ id: 'left-1', value: 1, createdAt })
    expect(scoped.query).toHaveBeenCalledWith(
      expect.stringContaining('insert into "scoped_drizzle_left"'),
      ['left-1', 1, createdAt.toISOString()],
    )

    scoped.queryArray.mockResolvedValueOnce(
      arrayResult([[createdAt, 'left-1', 'right-1']]),
    )
    await expect(
      database
        .select({
          left: { createdAt: left.createdAt, id: left.id },
          right: { id: right.id },
        })
        .from(left)
        .innerJoin(right, eq(left.id, right.leftId)),
    ).resolves.toEqual([
      {
        left: { createdAt, id: 'left-1' },
        right: { id: 'right-1' },
      },
    ])
    expect(scoped.queryArray).toHaveBeenCalledWith(
      expect.stringContaining('inner join "scoped_drizzle_right"'),
      [],
    )
  })

  it('strips executable parser config and rejects every expanded runtime surface', async () => {
    const scoped = scopedClient()
    const database = createScopedDrizzleDatabase(scoped.client)
    const runtime = runtimeClient(database)
    const parser = vi.fn(() => {
      throw new Error('parser must not run')
    })
    const valid = {
      name: undefined,
      text: 'SELECT 1',
      types: drizzleTypes(parser),
    }

    await expect(runtime.query(valid, [])).resolves.toMatchObject({ rows: [] })
    expect(parser).not.toHaveBeenCalled()
    expect(scoped.query).toHaveBeenLastCalledWith('SELECT 1', [])
    scoped.query.mockClear()
    scoped.queryArray.mockClear()

    const accessor = Object.defineProperty(
      { name: undefined, types: drizzleTypes() },
      'text',
      {
        enumerable: true,
        get() {
          throw new Error('text getter must not run')
        },
      },
    )
    const nameAccessor = Object.defineProperty(
      { text: 'SELECT 1', types: drizzleTypes() },
      'name',
      {
        enumerable: true,
        get() {
          throw new Error('name getter must not run')
        },
      },
    )
    const rowModeAccessor = Object.defineProperty({ ...valid }, 'rowMode', {
      enumerable: true,
      get() {
        throw new Error('row-mode getter must not run')
      },
    })
    const typesAccessor = Object.defineProperty(
      { name: undefined, text: 'SELECT 1' },
      'types',
      {
        enumerable: true,
        get() {
          throw new Error('types getter must not run')
        },
      },
    )
    const parserAccessor = Object.defineProperty({}, 'getTypeParser', {
      enumerable: true,
      get() {
        throw new Error('parser getter must not run')
      },
    })
    const symbolKey = Symbol('hostile-query-config')
    const symbolConfig = { ...valid, [symbolKey]: true }
    const nullPrototype = Object.assign(Object.create(null), valid)
    const frozenConfig = Object.freeze({ ...valid })
    const hostile: readonly (readonly unknown[])[] = [
      [{ ...valid, name: 'prepared-name' }, []],
      [{ ...valid, extra: true }, []],
      [{ ...valid, rowMode: 'object' }, []],
      [{ ...valid, rowMode: 'array', extra: true }, []],
      [{ ...valid, types: { ...drizzleTypes(), extra: true } }, []],
      [{ ...valid, types: parserAccessor }, []],
      [accessor, []],
      [nameAccessor, []],
      [rowModeAccessor, []],
      [typesAccessor, []],
      [symbolConfig, []],
      [nullPrototype, []],
      [frozenConfig, []],
      [valid, 'not-an-array'],
      [valid, [], () => undefined],
    ]
    for (const args of hostile) {
      await expect(Reflect.apply(runtime.query, runtime, args)).rejects.toThrow(
        'unsupported query contract',
      )
    }
    expect(scoped.query).not.toHaveBeenCalled()
    expect(scoped.queryArray).not.toHaveBeenCalled()
  })

  it('rejects named preparation and sends nested transactions to the scoped guard', async () => {
    const scoped = scopedClient()
    scoped.query.mockImplementation(async (sql: string) => {
      if (/^begin\b/i.test(sql)) {
        throw new TypeError('Transaction control belongs to UnitOfWork.')
      }
      return objectResult()
    })
    const database = createScopedDrizzleDatabase(scoped.client)

    await expect(
      database.select().from(left).prepare('named-query').execute(),
    ).rejects.toMatchObject({
      cause: { message: 'Scoped Drizzle emitted an unsupported query contract.' },
    })
    expect(scoped.query).not.toHaveBeenCalled()
    expect(scoped.queryArray).not.toHaveBeenCalled()
    await expect(database.transaction(async () => 'never')).rejects.toMatchObject({
      cause: { message: 'Transaction control belongs to UnitOfWork.' },
    })
    expect(scoped.query).toHaveBeenCalledWith(expect.stringMatching(/^begin$/i), [])
  })
})
