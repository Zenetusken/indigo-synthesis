import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateDatabase } from './migrate'

const migrationMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  migrateDatabaseWithClient: vi.fn(),
  release: vi.fn(),
}))

vi.mock('./client', () => ({
  getPool: () => ({ connect: migrationMocks.connect }),
}))

vi.mock('./migration-executor', () => ({
  migrateDatabaseWithClient: migrationMocks.migrateDatabaseWithClient,
}))

beforeEach(() => {
  migrationMocks.release.mockReset()
  migrationMocks.connect.mockReset().mockResolvedValue({
    query: vi.fn(),
    release: migrationMocks.release,
  })
  migrationMocks.migrateDatabaseWithClient.mockReset().mockResolvedValue(undefined)
})

describe('pooled migration compatibility adapter', () => {
  it('releases its disposable/integration checkout after success', async () => {
    await migrateDatabase()

    const client = await migrationMocks.connect.mock.results[0]?.value
    expect(migrationMocks.migrateDatabaseWithClient).toHaveBeenCalledWith(client)
    expect(migrationMocks.release).toHaveBeenCalledOnce()
  })

  it('releases its checkout after migration failure', async () => {
    const migrationFailure = new Error('migration failed')
    migrationMocks.migrateDatabaseWithClient.mockRejectedValue(migrationFailure)

    await expect(migrateDatabase()).rejects.toBe(migrationFailure)

    expect(migrationMocks.release).toHaveBeenCalledOnce()
  })

  it('preserves both migration and release failures', async () => {
    const migrationFailure = new Error('migration failed')
    const releaseFailure = new Error('release failed')
    migrationMocks.migrateDatabaseWithClient.mockRejectedValue(migrationFailure)
    migrationMocks.release.mockImplementation(() => {
      throw releaseFailure
    })

    await expect(migrateDatabase()).rejects.toMatchObject({
      errors: [migrationFailure, releaseFailure],
    })
  })
})
