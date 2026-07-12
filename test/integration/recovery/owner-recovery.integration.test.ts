import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { and, count, eq } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAuth, resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import {
  issueOwnerRecovery,
  redeemOwnerRecovery,
} from '@/modules/identity/recovery/owner-recovery'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import { migrateDatabase } from '@/platform/db/migrate'
import { auditEvents, session, user, verification } from '@/platform/db/schema'

const execFile = promisify(execFileCallback)
const owner = {
  name: 'Recovery Owner',
  email: 'recovery-owner@example.test',
  originalPassword: 'original-owner-password',
  recoveredPassword: 'recovered-owner-password',
} as const

let sourceDatabaseUrl: string
let disposableDatabaseName: string
let administrationClient: Client
let ownerUserId: string
let secretsDirectory: string

function quotedIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

async function authRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const origin = getServerConfig().appOrigin
  return getAuth().handler(
    new Request(`${origin}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    }),
  )
}

async function runRecoveryCli(arguments_: readonly string[]) {
  return execFile(
    process.execPath,
    ['--import', 'tsx', 'scripts/identity/recover-owner.ts', ...arguments_],
    {
      cwd: process.cwd(),
      env: process.env,
    },
  )
}

beforeAll(async () => {
  const configuredDatabaseUrl = process.env.DATABASE_URL
  if (!configuredDatabaseUrl) {
    throw new Error('DATABASE_URL is required for owner recovery integration tests.')
  }

  sourceDatabaseUrl = configuredDatabaseUrl
  disposableDatabaseName = `indigo_recovery_${process.pid}_${Date.now()}`
  administrationClient = new Client({ connectionString: sourceDatabaseUrl })
  await administrationClient.connect()
  await administrationClient.query(
    `CREATE DATABASE ${quotedIdentifier(disposableDatabaseName)}`,
  )

  const disposableUrl = new URL(sourceDatabaseUrl)
  disposableUrl.pathname = `/${disposableDatabaseName}`
  process.env.DATABASE_URL = disposableUrl.toString()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await authRequest('/sign-up/email', {
    name: owner.name,
    email: owner.email,
    password: owner.originalPassword,
  })
  const body = (await bootstrap.json()) as { user?: { id: string } }
  if (!bootstrap.ok || !body.user) throw new Error('Could not bootstrap recovery owner.')
  ownerUserId = body.user.id

  secretsDirectory = await mkdtemp(join(tmpdir(), 'indigo-owner-recovery-'))
  await chmod(secretsDirectory, 0o700)
})

afterAll(async () => {
  resetAuthForTests()
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
  if (secretsDirectory) await rm(secretsDirectory, { recursive: true, force: true })
})

describe('host-local owner recovery', () => {
  it('expires and consumes an elapsed recovery code without changing the credential', async () => {
    const issuedAt = new Date('2026-07-11T12:00:00.000Z')
    const issued = await issueOwnerRecovery({
      ownerEmail: owner.email,
      ttlMinutes: 5,
      now: issuedAt,
    })

    await expect(
      redeemOwnerRecovery({
        ownerEmail: owner.email,
        code: issued.code,
        newPassword: owner.recoveredPassword,
        now: new Date('2026-07-11T12:05:00.001Z'),
      }),
    ).rejects.toMatchObject({
      code: 'owner-recovery.code-invalid',
    })

    const [pendingCount] = await getDb().select({ value: count() }).from(verification)
    expect(pendingCount?.value).toBe(0)

    const stillAuthenticates = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.originalPassword,
    })
    expect(stillAuthenticates.status).toBe(200)
  })

  it('issues through owner-only storage and redeems once without printing secrets', async () => {
    const codeFile = join(secretsDirectory, 'owner-recovery-code')
    const passwordFile = join(secretsDirectory, 'new-owner-password')
    await writeFile(passwordFile, `${owner.recoveredPassword}\n`, { mode: 0o600 })

    const issuedProcess = await runRecoveryCli([
      'issue',
      '--owner-email',
      owner.email,
      '--code-file',
      codeFile,
      '--ttl-minutes',
      '15',
    ])
    const code = (await readFile(codeFile, 'utf8')).trim()
    const codeMetadata = await stat(codeFile)
    expect(code).toMatch(/^indigo_r1_[A-Za-z0-9_-]{43}$/)
    expect(codeMetadata.mode & 0o077).toBe(0)
    expect(`${issuedProcess.stdout}${issuedProcess.stderr}`).not.toContain(code)
    expect(`${issuedProcess.stdout}${issuedProcess.stderr}`).not.toContain(
      owner.recoveredPassword,
    )

    const [stored] = await getDb()
      .select({ value: verification.value })
      .from(verification)
    expect(stored?.value).not.toContain(code)

    await expect(
      redeemOwnerRecovery({
        ownerEmail: owner.email,
        code: `${code}-wrong`,
        newPassword: owner.recoveredPassword,
      }),
    ).rejects.toMatchObject({
      code: 'owner-recovery.code-invalid',
    })

    const [sessionsBefore] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, ownerUserId))
    expect(sessionsBefore?.value).toBeGreaterThan(0)

    const redeemedProcess = await runRecoveryCli([
      'redeem',
      '--owner-email',
      owner.email,
      '--code-file',
      codeFile,
      '--password-file',
      passwordFile,
    ])
    expect(`${redeemedProcess.stdout}${redeemedProcess.stderr}`).not.toContain(code)
    expect(`${redeemedProcess.stdout}${redeemedProcess.stderr}`).not.toContain(
      owner.recoveredPassword,
    )
    await expect(stat(codeFile)).rejects.toMatchObject({ code: 'ENOENT' })

    const [sessionsAfter] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, ownerUserId))
    const [pendingAfter] = await getDb().select({ value: count() }).from(verification)
    expect(sessionsAfter?.value).toBe(0)
    expect(pendingAfter?.value).toBe(0)

    const oldCredential = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.originalPassword,
    })
    const newCredential = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.recoveredPassword,
    })
    expect(oldCredential.ok).toBe(false)
    expect(newCredential.status).toBe(200)

    await expect(
      redeemOwnerRecovery({
        ownerEmail: owner.email,
        code,
        newPassword: 'another-secure-password',
      }),
    ).rejects.toMatchObject({
      code: 'owner-recovery.code-invalid',
    })

    const recoveryAudits = await getDb()
      .select({ type: auditEvents.eventType, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.subjectUserId, ownerUserId),
          eq(auditEvents.entityType, 'owner-recovery'),
        ),
      )
    expect(recoveryAudits.some((event) => event.type === 'owner-recovery-issued')).toBe(
      true,
    )
    expect(recoveryAudits.some((event) => event.type === 'owner-recovery-redeemed')).toBe(
      true,
    )
    const serializedAudit = JSON.stringify(recoveryAudits)
    expect(serializedAudit).not.toContain(code)
    expect(serializedAudit).not.toContain(owner.originalPassword)
    expect(serializedAudit).not.toContain(owner.recoveredPassword)

    const [ownerStillPresent] = await getDb()
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, ownerUserId))
    expect(ownerStillPresent?.id).toBe(ownerUserId)
  })
})
