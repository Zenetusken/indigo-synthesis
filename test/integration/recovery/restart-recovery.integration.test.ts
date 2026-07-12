import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'

const execFile = promisify(execFileCallback)

type RestartWorkerResult = {
  readonly pid: number
  readonly userId: string
  readonly sessionId: string
  readonly setCommandId: string
  readonly session: {
    readonly status: string
    readonly optimisticVersion: number
    readonly exercises: readonly {
      readonly sets: readonly {
        readonly status: string
        readonly actualLoadGrams: number | null
        readonly actualRepetitions: number | null
        readonly rpe: number | null
        readonly note: string | null
      }[]
    }[]
  }
  readonly today: { readonly kind: string; readonly sessionId?: string }
}

let integrationDatabase: DisposableIntegrationDatabase | undefined

async function runWorker(arguments_: readonly string[]): Promise<RestartWorkerResult> {
  const { stdout } = await execFile(
    process.execPath,
    ['--import', 'tsx', 'test/integration/recovery/restart-worker.ts', ...arguments_],
    { cwd: process.cwd(), env: process.env },
  )
  return JSON.parse(stdout.trim()) as RestartWorkerResult
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'restart_recovery',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  await closeDb()
  await migrateDatabase()
  await closeDb()
})

afterAll(async () => {
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe('active workout process restart recovery', () => {
  it('recovers the exact PostgreSQL-backed paused session in a new application process', async () => {
    const beforeRestart = await runWorker(['write'])
    const afterRestart = await runWorker([
      'read',
      beforeRestart.userId,
      beforeRestart.sessionId,
      beforeRestart.setCommandId,
    ])

    expect(afterRestart.pid).not.toBe(beforeRestart.pid)
    expect(afterRestart.userId).toBe(beforeRestart.userId)
    expect(afterRestart.sessionId).toBe(beforeRestart.sessionId)
    expect(afterRestart.setCommandId).toBe(beforeRestart.setCommandId)
    expect(afterRestart.session).toEqual(beforeRestart.session)
    expect(afterRestart.today).toEqual(beforeRestart.today)
    expect(afterRestart.today).toEqual({
      kind: 'active',
      sessionId: beforeRestart.sessionId,
      status: 'paused',
      contentEligibility: { eligible: true },
    })

    const firstSet = afterRestart.session.exercises[0]?.sets[0]
    const secondSet = afterRestart.session.exercises[0]?.sets[1]
    expect(afterRestart.session.status).toBe('paused')
    expect(afterRestart.session.optimisticVersion).toBe(3)
    expect(firstSet).toMatchObject({
      status: 'performed',
      actualLoadGrams: 62_500,
      actualRepetitions: 5,
      rpe: 8,
      note: 'Persist this exact set across the process boundary.',
    })
    expect(secondSet).toMatchObject({
      status: 'pending',
      actualLoadGrams: null,
      actualRepetitions: null,
    })
  })
})
