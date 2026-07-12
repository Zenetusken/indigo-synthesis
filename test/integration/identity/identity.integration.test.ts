import { count, eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AuthenticatedActor,
  deriveIdentityRole,
  OwnerAuthorizationError,
} from '@/modules/identity/application/actor'
import { getAuth, resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { getInstallationOwnerUserId } from '@/modules/identity/infrastructure/installation'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import { migrateDatabase } from '@/platform/db/migrate'
import { account, installationState, session, user } from '@/platform/db/schema'

type BootstrapIdentity = {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly password: string
}

type AuthResponseBody = {
  readonly token?: string | null
  readonly user?: {
    readonly id: string
    readonly name: string
    readonly email: string
  }
}

const bootstrapCandidates = [
  {
    name: 'First Owner',
    email: 'first-owner@example.test',
    password: 'first-owner-password',
  },
  {
    name: 'Second Owner',
    email: 'second-owner@example.test',
    password: 'second-owner-password',
  },
] as const

let sourceDatabaseUrl: string
let disposableDatabaseName: string
let administrationClient: Client
let administrationConnected = false
let disposableDatabaseCreated = false
let owner: BootstrapIdentity
let localMember: BootstrapIdentity

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
      headers: {
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify(body),
    }),
  )
}

async function parseAuthResponse(response: Response): Promise<AuthResponseBody> {
  return (await response.json()) as AuthResponseBody
}

beforeAll(async () => {
  const configuredDatabaseUrl = process.env.DATABASE_URL

  if (!configuredDatabaseUrl) {
    throw new Error('DATABASE_URL is required for identity integration tests.')
  }

  sourceDatabaseUrl = configuredDatabaseUrl
  disposableDatabaseName = `indigo_identity_${process.pid}_${Date.now()}`
  administrationClient = new Client({ connectionString: sourceDatabaseUrl })
  await administrationClient.connect()
  administrationConnected = true
  await administrationClient.query(
    `CREATE DATABASE ${quotedIdentifier(disposableDatabaseName)}`,
  )
  disposableDatabaseCreated = true

  const disposableUrl = new URL(sourceDatabaseUrl)
  disposableUrl.pathname = `/${disposableDatabaseName}`
  process.env.DATABASE_URL = disposableUrl.toString()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()
})

afterAll(async () => {
  resetAuthForTests()
  await closeDb()

  if (sourceDatabaseUrl) {
    process.env.DATABASE_URL = sourceDatabaseUrl
    resetServerConfigForTests()
  }

  if (administrationConnected) {
    try {
      if (disposableDatabaseCreated) {
        await administrationClient.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [disposableDatabaseName],
        )
        await administrationClient.query(
          `DROP DATABASE IF EXISTS ${quotedIdentifier(disposableDatabaseName)}`,
        )
      }
    } finally {
      await administrationClient.end()
    }
  }
})

describe('identity database boundary', () => {
  it('serializes concurrent Better Auth bootstrap attempts exactly once', async () => {
    const responses = await Promise.all(
      bootstrapCandidates.map((candidate) => authRequest('/sign-up/email', candidate)),
    )
    const successfulIndexes = responses
      .map((response, index) => (response.ok ? index : -1))
      .filter((index) => index >= 0)

    expect(successfulIndexes).toHaveLength(1)

    const successfulIndex = successfulIndexes[0]
    const successfulResponse = responses[successfulIndex]
    const winningCandidate = bootstrapCandidates[successfulIndex]

    if (!successfulResponse || !winningCandidate) {
      throw new Error('Concurrent bootstrap produced no successful owner.')
    }

    const responseBody = await parseAuthResponse(successfulResponse)

    if (!responseBody.user) {
      throw new Error('Successful bootstrap returned no user.')
    }

    owner = {
      ...winningCandidate,
      id: responseBody.user.id,
    }

    const [userCount] = await getDb().select({ value: count() }).from(user)
    const [accountCount] = await getDb().select({ value: count() }).from(account)
    const [installation] = await getDb()
      .select()
      .from(installationState)
      .where(eq(installationState.singleton, 1))

    expect(userCount?.value).toBe(1)
    expect(accountCount?.value).toBe(1)
    expect(installation?.ownerUserId).toBe(owner.id)
    expect(await getInstallationOwnerUserId()).toBe(owner.id)
    expect(installation?.bootstrapClosedAt).toBeInstanceOf(Date)
    expect(responses.filter((response) => !response.ok)).toHaveLength(1)
  })

  it('authenticates the bootstrapped credential through Better Auth', async () => {
    const response = await authRequest('/sign-in/email', {
      email: owner.email,
      password: owner.password,
    })
    const responseBody = await parseAuthResponse(response)

    expect(response.status).toBe(200)
    expect(responseBody.user?.id).toBe(owner.id)
    expect(responseBody.token).toEqual(expect.any(String))

    const [sessionCount] = await getDb()
      .select({ value: count() })
      .from(session)
      .where(eq(session.userId, owner.id))

    expect(sessionCount?.value).toBe(1)
  })

  it('keeps public signup closed after bootstrap', async () => {
    const response = await authRequest('/sign-up/email', {
      name: 'Public Intruder',
      email: 'public-intruder@example.test',
      password: 'public-intruder-password',
    })
    const [userCount] = await getDb().select({ value: count() }).from(user)

    expect(response.ok).toBe(false)
    expect(userCount?.value).toBe(1)
  })

  it('lets the database-confirmed owner create one controlled local user', async () => {
    const actor: AuthenticatedActor = {
      userId: owner.id,
      name: owner.name,
      email: owner.email,
      role: deriveIdentityRole(owner.id, owner.id),
    }
    const input = {
      name: 'Local Member',
      email: 'LOCAL-MEMBER@EXAMPLE.TEST',
      password: 'local-member-password',
    }
    const createdUser = await createLocalUserAsOwner(actor, input)

    localMember = {
      ...input,
      id: createdUser.id,
      email: input.email.toLowerCase(),
    }

    const [userCount] = await getDb().select({ value: count() }).from(user)
    const [installation] = await getDb()
      .select({ ownerUserId: installationState.ownerUserId })
      .from(installationState)
      .where(eq(installationState.singleton, 1))
    const modeResult = await getDb().execute<{ mode: string }>(
      sql`SELECT current_setting('indigo.user_creation_mode', true) AS mode`,
    )

    expect(createdUser.email).toBe(localMember.email)
    expect(userCount?.value).toBe(2)
    expect(installation?.ownerUserId).toBe(owner.id)
    expect(modeResult.rows[0]?.mode ?? '').toBe('')
  })

  it('authenticates the controlled local user as a credential account', async () => {
    const response = await authRequest('/sign-in/email', {
      email: localMember.email,
      password: localMember.password,
    })
    const responseBody = await parseAuthResponse(response)

    expect(response.status).toBe(200)
    expect(responseBody.user?.id).toBe(localMember.id)
    expect(responseBody.token).toEqual(expect.any(String))
  })

  it('rechecks ownership inside the transaction even if a member role is forged', async () => {
    const forgedActor: AuthenticatedActor = {
      userId: localMember.id,
      name: localMember.name,
      email: localMember.email,
      role: 'owner',
    }

    await expect(
      createLocalUserAsOwner(forgedActor, {
        name: 'Unauthorized Member',
        email: 'unauthorized-member@example.test',
        password: 'unauthorized-member-password',
      }),
    ).rejects.toBeInstanceOf(OwnerAuthorizationError)

    const [userCount] = await getDb().select({ value: count() }).from(user)
    expect(userCount?.value).toBe(2)
  })
})
