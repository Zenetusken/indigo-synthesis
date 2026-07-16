import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb, getPool } from './client'

const validEnvironment = {
  DATABASE_URL: 'postgresql://localhost/indigo_client_test',
  INDIGO_DATABASE_POOL_MAX: '6',
  BETTER_AUTH_SECRET: 'a-secure-test-secret-that-is-long-enough',
  BETTER_AUTH_URL: 'http://localhost:3000',
  INDIGO_CONTENT_MODE: 'development',
  NODE_ENV: 'test',
} as const

let originalEnvironment: Record<keyof typeof validEnvironment, string | undefined>

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    Object.keys(validEnvironment).map((key) => [
      key,
      process.env[key as keyof typeof validEnvironment],
    ]),
  ) as Record<keyof typeof validEnvironment, string | undefined>
  Object.assign(process.env, validEnvironment)
  resetServerConfigForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await closeDb().catch(() => undefined)
  ;(
    globalThis as typeof globalThis & {
      indigoDatabaseRuntimeState?: unknown
    }
  ).indigoDatabaseRuntimeState = undefined
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetServerConfigForTests()
})

describe('database client compatibility facade', () => {
  it('reuses one bounded runtime and follows the configured ordinary maximum', () => {
    const pool = getPool()

    expect(getPool()).toBe(pool)
    expect(getDb()).toBe(getDb())
    expect(getServerConfig().databasePoolMax).toBe(6)
    expect(Object.keys(pool).sort()).toEqual(['connect', 'query'])
    const lifecycleIsHidden = () => {
      // @ts-expect-error Pool lifecycle is intentionally not exposed by the compatibility facade.
      pool.end()
    }
    const checkoutLifecycleIsHidden = async () => {
      const client = await pool.connect()
      // @ts-expect-error Checked-out driver lifecycle stays owned by the bounded pool.
      client.end()
      // @ts-expect-error The raw driver connection cannot bypass bounded release accounting.
      client.connection.end()
    }
    expect(lifecycleIsHidden).toBeTypeOf('function')
    expect(checkoutLifecycleIsHidden).toBeTypeOf('function')
  })

  it('shares one three-pool shutdown across concurrent close calls', async () => {
    getPool()
    const end = vi.spyOn(Pool.prototype, 'end').mockResolvedValue()

    await Promise.all([closeDb(), closeDb()])

    expect(end).toHaveBeenCalledTimes(3)
  })

  it('rejects access during shutdown and permits a fresh runtime after it settles', async () => {
    type Deferred = {
      readonly promise: Promise<void>
      readonly resolve: () => void
    }
    let resolve!: () => void
    const deferred: Deferred = {
      promise: new Promise<void>((promiseResolve) => {
        resolve = promiseResolve
      }),
      resolve: () => resolve(),
    }
    const firstPool = getPool()
    vi.spyOn(Pool.prototype, 'end').mockImplementation(() => deferred.promise as never)

    const closing = closeDb()
    expect(() => getPool()).toThrow('runtime is closing')

    deferred.resolve()
    await closing
    vi.restoreAllMocks()

    expect(getPool()).not.toBe(firstPool)
  })

  it('poisons the process lifecycle after an uncertain pool shutdown', async () => {
    const closeFailure = new Error('driver shutdown failed')
    getPool()
    vi.spyOn(Pool.prototype, 'end')
      .mockRejectedValueOnce(closeFailure)
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()

    await expect(closeDb()).rejects.toMatchObject({
      errors: [closeFailure],
      message: 'One or more database pools failed to close.',
    })
    expect(() => getPool()).toThrow('shutdown was uncertain')
    await expect(closeDb()).rejects.toMatchObject({ errors: [closeFailure] })
  })
})
