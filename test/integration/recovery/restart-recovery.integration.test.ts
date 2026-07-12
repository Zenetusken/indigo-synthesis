import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb } from '@/platform/db/client'
import { migrateDatabase } from '@/platform/db/migrate'

const execFile = promisify(execFileCallback)

type RestartWorkerResult = {
  readonly pid: number
  readonly userId: string
  readonly sessionId: string
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

let sourceDatabaseUrl: string
let disposableDatabaseName: string
let administrationClient: Client

function quotedIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

async function runWorker(arguments_: readonly string[]): Promise<RestartWorkerResult> {
  const { stdout } = await execFile(
    process.execPath,
    ['--import', 'tsx', 'test/integration/recovery/restart-worker.ts', ...arguments_],
    { cwd: process.cwd(), env: process.env },
  )
  return JSON.parse(stdout.trim()) as RestartWorkerResult
}

beforeAll(async () => {
  const configuredDatabaseUrl = process.env.DATABASE_URL
  if (!configuredDatabaseUrl) {
    throw new Error('DATABASE_URL is required for restart recovery integration tests.')
  }

  sourceDatabaseUrl = configuredDatabaseUrl
  disposableDatabaseName = `indigo_restart_${process.pid}_${Date.now()}`
  administrationClient = new Client({ connectionString: sourceDatabaseUrl })
  await administrationClient.connect()
  await administrationClient.query(
    `CREATE DATABASE ${quotedIdentifier(disposableDatabaseName)}`,
  )

  const disposableUrl = new URL(sourceDatabaseUrl)
  disposableUrl.pathname = `/${disposableDatabaseName}`
  process.env.DATABASE_URL = disposableUrl.toString()
  resetServerConfigForTests()
  await closeDb()
  await migrateDatabase()
  await closeDb()
})

afterAll(async () => {
  await closeDb()
  if (sourceDatabaseUrl) {
    process.env.DATABASE_URL = sourceDatabaseUrl
    resetServerConfigForTests()
  }

  if (administrationClient) {
    try {
      await administrationClient.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [disposableDatabaseName],
      )
      await administrationClient.query(
        `DROP DATABASE IF EXISTS ${quotedIdentifier(disposableDatabaseName)}`,
      )
    } finally {
      await administrationClient.end()
    }
  }
})

describe('active workout process restart recovery', () => {
  it('recovers the exact PostgreSQL-backed paused session in a new application process', async () => {
    const beforeRestart = await runWorker(['write'])
    const afterRestart = await runWorker([
      'read',
      beforeRestart.userId,
      beforeRestart.sessionId,
    ])

    expect(afterRestart.pid).not.toBe(beforeRestart.pid)
    expect(afterRestart.userId).toBe(beforeRestart.userId)
    expect(afterRestart.sessionId).toBe(beforeRestart.sessionId)
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
