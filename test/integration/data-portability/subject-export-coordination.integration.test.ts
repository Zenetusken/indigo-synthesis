import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getProductionDataPortabilitySubjectExportPort } from '@/composition/data-portability-subject-export'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
import { createSubjectDeletionPlan } from '@/modules/data-portability/application/deletion'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { createScopedIdentityMutationGateway } from '@/modules/identity/infrastructure/scoped-mutation-auth'
import { issueSubjectExportCommand } from '@/modules/identity/infrastructure/subject-export-authority'
import { captureSubjectExportCommand } from '@/modules/identity/server/subject-export-command'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import {
  renderSubjectDeletionIntegrationBinding,
  submitSubjectDeletionThroughProductionPort,
} from '../support/destructive-mutation'
import { createSubjectExportThroughProductionPort } from '../support/subject-export'

const ownerPassword = 'export-coordination-owner-password'
const memberPassword = 'export-coordination-member-password'

let database: DisposableIntegrationDatabase
let inspector: Client
let owner: AuthenticatedActor
let member: AuthenticatedActor
let reverseMember: AuthenticatedActor
let ownerToken: string
let memberToken: string
let reverseMemberToken: string
let ownerCookie: string

async function authRequest(
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const origin = getServerConfig().appOrigin
  return createScopedIdentityMutationGateway(getDb()).signInEmail(
    new Request(`${origin}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    }),
  )
}

async function signIn(
  email: string,
  password: string,
): Promise<Readonly<{ token: string; cookie: string }>> {
  const response = await authRequest('/sign-in/email', { email, password })
  const body = (await response.json()) as { token?: string }
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!response.ok || !body.token || !cookie) {
    throw new Error(`Could not create coordination session for ${email}.`)
  }
  return Object.freeze({ token: body.token, cookie })
}

async function currentAdvisoryWaiterPids(): Promise<ReadonlySet<number>> {
  const result = await inspector.query<{ pid: number }>(
    `SELECT pid
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND wait_event_type = 'Lock'
       AND wait_event = 'advisory'`,
  )
  return new Set(result.rows.map(({ pid }) => pid))
}

async function waitForNewAdvisoryWaiter(
  excludedPids: ReadonlySet<number>,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const current = await currentAdvisoryWaiterPids()
    if ([...current].some((pid) => !excludedPids.has(pid))) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for a new advisory-lock waiter.')
}

async function waitForSubjectSharedLock(subjectUserId: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await inspector.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [subjectUserId],
    )
    if (result.rows[0]?.acquired === false) return
    await inspector.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
      subjectUserId,
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for subject lock ${subjectUserId}.`)
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), 5_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

beforeAll(async () => {
  database = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'export_coordination',
  })
  await database.create()
  database.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const createdOwner = await createOwnerWithBootstrapCode({
    name: 'Export Coordination Owner',
    email: 'export-coordination-owner@example.test',
    password: ownerPassword,
    code: bootstrap.code,
  })
  owner = { ...createdOwner, userId: createdOwner.id, role: 'owner' }
  const ownerSignIn = await signIn(owner.email, ownerPassword)
  ownerToken = ownerSignIn.token
  ownerCookie = ownerSignIn.cookie

  const createdMember = await createLocalUserAsOwner(owner, {
    name: 'Export Coordination Member',
    email: 'export-coordination-member@example.test',
    password: memberPassword,
  })
  member = { ...createdMember, userId: createdMember.id, role: 'member' }
  memberToken = (await signIn(member.email, memberPassword)).token

  const createdReverseMember = await createLocalUserAsOwner(owner, {
    name: 'Reverse Export Coordination Member',
    email: 'reverse-export-coordination-member@example.test',
    password: memberPassword,
  })
  reverseMember = {
    ...createdReverseMember,
    userId: createdReverseMember.id,
    role: 'member',
  }
  reverseMemberToken = (await signIn(reverseMember.email, memberPassword)).token

  inspector = new Client({ connectionString: database.databaseUrl })
  await inspector.connect()
})

afterAll(async () => {
  await inspector?.end().catch(() => undefined)
  resetAuthForTests()
  await closeDb()
  database?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await database?.cleanup()
})

describe('subject export coordination', () => {
  it('captures the production command from a same-origin signed browser cookie', async () => {
    const capture = await captureSubjectExportCommand(
      new Request(`${getServerConfig().appOrigin}/api/export`, {
        headers: { cookie: ownerCookie },
      }),
    )

    expect(capture.kind).toBe('captured')
    if (capture.kind !== 'captured') return
    const result = await getProductionDataPortabilitySubjectExportPort().create(
      capture.command,
    )
    expect(result.kind).toBe('exported')
    if (result.kind === 'exported') {
      expect(result.archive.identity.id).toBe(owner.userId)
    }
  })

  it('allows a different subject to export while one subject lock is occupied', async () => {
    const blocker = new Client({ connectionString: database.databaseUrl })
    await blocker.connect()
    let lockHeld = false
    let ownerExport:
      | Promise<Awaited<ReturnType<typeof createSubjectExportThroughProductionPort>>>
      | undefined
    try {
      await blocker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        owner.userId,
      ])
      lockHeld = true
      const existingWaiters = await currentAdvisoryWaiterPids()
      let ownerSettled = false
      ownerExport = createSubjectExportThroughProductionPort(ownerToken)
      void ownerExport.then(
        () => {
          ownerSettled = true
        },
        () => {
          ownerSettled = true
        },
      )
      await waitForNewAdvisoryWaiter(existingWaiters)

      const memberArchive = await within(
        createSubjectExportThroughProductionPort(memberToken),
        'Different-subject export',
      )
      expect(memberArchive.identity.id).toBe(member.userId)
      expect(ownerSettled).toBe(false)

      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        owner.userId,
      ])
      lockHeld = false
      const ownerArchive = await within(ownerExport, 'Blocked owner export')
      expect(ownerArchive.identity.id).toBe(owner.userId)
    } finally {
      if (lockHeld) {
        await blocker
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [owner.userId])
          .catch(() => undefined)
      }
      await blocker.end()
      await ownerExport?.catch(() => undefined)
    }
  })

  it('finishes an in-flight export before deleting the same subject', async () => {
    const plan = await createSubjectDeletionPlan(member)
    const renderedBinding = await renderSubjectDeletionIntegrationBinding({
      sessionToken: memberToken,
      plan,
    })
    const blocker = new Client({ connectionString: database.databaseUrl })
    await blocker.connect()
    let transactionOpen = false
    let subjectExport:
      | Promise<Awaited<ReturnType<typeof createSubjectExportThroughProductionPort>>>
      | undefined
    let deletion:
      | ReturnType<typeof submitSubjectDeletionThroughProductionPort>
      | undefined
    try {
      await blocker.query('BEGIN')
      transactionOpen = true
      await blocker.query('LOCK TABLE public.audit_event IN ACCESS EXCLUSIVE MODE')

      let exportSettled = false
      subjectExport = createSubjectExportThroughProductionPort(memberToken)
      void subjectExport.then(
        () => {
          exportSettled = true
        },
        () => {
          exportSettled = true
        },
      )
      await waitForSubjectSharedLock(member.userId)
      const existingWaiters = await currentAdvisoryWaiterPids()

      let deletionSettled = false
      deletion = submitSubjectDeletionThroughProductionPort({
        sessionToken: memberToken,
        plan,
        password: memberPassword,
        renderedBinding,
      })
      void deletion.then(
        () => {
          deletionSettled = true
        },
        () => {
          deletionSettled = true
        },
      )
      await waitForNewAdvisoryWaiter(existingWaiters)
      expect(exportSettled).toBe(false)
      expect(deletionSettled).toBe(false)

      await blocker.query('COMMIT')
      transactionOpen = false
      const archive = await within(subjectExport, 'Same-subject export')
      expect(archive.identity.id).toBe(member.userId)
      await expect(within(deletion, 'Queued subject deletion')).resolves.toEqual({
        kind: 'deleted',
        actorRole: 'member',
        warning: null,
      })
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end()
      await subjectExport?.catch(() => undefined)
      await deletion?.catch(() => undefined)
    }
  })

  it('returns no archive when same-subject deletion wins the lock order', async () => {
    const plan = await createSubjectDeletionPlan(reverseMember)
    const renderedBinding = await renderSubjectDeletionIntegrationBinding({
      sessionToken: reverseMemberToken,
      plan,
    })
    const blocker = new Client({ connectionString: database.databaseUrl })
    await blocker.connect()
    let lockHeld = false
    let deletion:
      | ReturnType<typeof submitSubjectDeletionThroughProductionPort>
      | undefined
    let subjectExport:
      | ReturnType<
          ReturnType<typeof getProductionDataPortabilitySubjectExportPort>['create']
        >
      | undefined
    try {
      await blocker.query('SELECT pg_advisory_lock_shared(hashtextextended($1, 0))', [
        reverseMember.userId,
      ])
      lockHeld = true
      const beforeDeletion = await currentAdvisoryWaiterPids()

      let deletionSettled = false
      deletion = submitSubjectDeletionThroughProductionPort({
        sessionToken: reverseMemberToken,
        plan,
        password: memberPassword,
        renderedBinding,
      })
      void deletion.then(
        () => {
          deletionSettled = true
        },
        () => {
          deletionSettled = true
        },
      )
      await waitForNewAdvisoryWaiter(beforeDeletion)
      expect(deletionSettled).toBe(false)

      const beforeExport = await currentAdvisoryWaiterPids()
      let exportSettled = false
      subjectExport = getProductionDataPortabilitySubjectExportPort().create(
        issueSubjectExportCommand({ verifiedSessionToken: reverseMemberToken }),
      )
      void subjectExport.then(
        () => {
          exportSettled = true
        },
        () => {
          exportSettled = true
        },
      )
      await waitForNewAdvisoryWaiter(beforeExport)
      expect(exportSettled).toBe(false)

      await blocker.query('SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))', [
        reverseMember.userId,
      ])
      lockHeld = false
      await expect(within(deletion, 'Winning subject deletion')).resolves.toEqual({
        kind: 'deleted',
        actorRole: 'member',
        warning: null,
      })
      const result = await within(subjectExport, 'Losing subject export')
      expect(result).toEqual({ kind: 'stale' })
      expect('archive' in result).toBe(false)
    } finally {
      if (lockHeld) {
        await blocker
          .query('SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))', [
            reverseMember.userId,
          ])
          .catch(() => undefined)
      }
      await blocker.end()
      await deletion?.catch(() => undefined)
      await subjectExport?.catch(() => undefined)
    }
  })
})
