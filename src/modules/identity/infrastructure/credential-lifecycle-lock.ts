import { createHmac } from 'node:crypto'
import { Client } from 'pg'
import { getServerConfig } from '@/platform/config/server'
import { getPool } from '@/platform/db/client'
import { normalizeRecoveryEmail } from '../recovery/recovery-policy'

const credentialLockNamespace = 'indigo:credential-lifecycle:'
const instanceFenceKey = 'instance-fence'
export const credentialLifecycleConnectionLimit = 4
export const credentialLifecycleTrustedQueueLimit = 64
export const credentialLifecycleSubmittedEmailQueueLimit = 64

let activeConnectionSlots = 0
const trustedConnectionSlotWaiters: Array<() => void> = []
const submittedEmailConnectionSlotWaiters: Array<() => void> = []
let outstandingLifecycleRequests = 0
const outstandingLifecycleRequestsByPriority = {
  trusted: 0,
  'submitted-email': 0,
}

export class CredentialLifecycleCapacityError extends Error {
  constructor() {
    super('Credential lifecycle capacity is temporarily unavailable.')
    this.name = 'CredentialLifecycleCapacityError'
  }
}

export class CredentialLifecycleUnavailableError extends Error {
  constructor() {
    super('Credential lifecycle is unavailable for the current installation state.')
    this.name = 'CredentialLifecycleUnavailableError'
  }
}

function reserveLifecycleRequest(priority: 'trusted' | 'submitted-email') {
  const priorityLimit =
    credentialLifecycleConnectionLimit +
    (priority === 'trusted'
      ? credentialLifecycleTrustedQueueLimit
      : credentialLifecycleSubmittedEmailQueueLimit)
  const totalLimit =
    credentialLifecycleConnectionLimit +
    credentialLifecycleTrustedQueueLimit +
    credentialLifecycleSubmittedEmailQueueLimit

  if (
    outstandingLifecycleRequests >= totalLimit ||
    outstandingLifecycleRequestsByPriority[priority] >= priorityLimit
  ) {
    throw new CredentialLifecycleCapacityError()
  }

  outstandingLifecycleRequests += 1
  outstandingLifecycleRequestsByPriority[priority] += 1
  let released = false
  return () => {
    if (released) return
    released = true
    outstandingLifecycleRequests -= 1
    outstandingLifecycleRequestsByPriority[priority] -= 1
  }
}

async function acquireConnectionSlot(priority: 'trusted' | 'submitted-email') {
  if (activeConnectionSlots < credentialLifecycleConnectionLimit) {
    activeConnectionSlots += 1
  } else {
    const waiters =
      priority === 'trusted'
        ? trustedConnectionSlotWaiters
        : submittedEmailConnectionSlotWaiters
    const queueLimit =
      priority === 'trusted'
        ? credentialLifecycleTrustedQueueLimit
        : credentialLifecycleSubmittedEmailQueueLimit
    if (waiters.length >= queueLimit) {
      throw new CredentialLifecycleCapacityError()
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve)
    })
    // releaseConnectionSlot transfers an occupied slot directly to this waiter, so the
    // active count stays unchanged and a new arrival cannot steal the released capacity.
  }

  let released = false
  return () => {
    if (released) return
    released = true
    const next =
      trustedConnectionSlotWaiters.shift() ?? submittedEmailConnectionSlotWaiters.shift()
    if (next) next()
    else activeConnectionSlots -= 1
  }
}

function accountLockKey(userId: string): string {
  return `account:${userId}`
}

export function credentialEmailLockDigestForSecret(
  authSecret: string,
  email: string,
): string {
  return createHmac('sha256', authSecret)
    .update(`credential-email-lock-v1\0${normalizeRecoveryEmail(email)}`, 'utf8')
    .digest('hex')
}

export function credentialEmailLockDigest(email: string): string {
  return credentialEmailLockDigestForSecret(getServerConfig().authSecret, email)
}

function emailLockKey(emailDigest: string): string {
  return `email:${emailDigest}`
}

function unknownAccountLockKey(emailDigest: string): string {
  return `unknown-account:${emailDigest}`
}

async function acquireLock(
  client: Client,
  key: string,
  acquiredLocks: AdvisoryLock[],
  mode: AdvisoryLock['mode'] = 'exclusive',
): Promise<void> {
  const statement =
    mode === 'shared'
      ? 'SELECT pg_advisory_lock_shared(hashtextextended($1, 0))'
      : 'SELECT pg_advisory_lock(hashtextextended($1, 0))'
  await client.query(statement, [`${credentialLockNamespace}${key}`])
  acquiredLocks.push({ key, mode })
}

type AdvisoryLock = {
  readonly key: string
  readonly mode: 'exclusive' | 'shared'
}

async function releaseLocks(
  client: Client,
  acquiredLocks: AdvisoryLock[],
): Promise<void> {
  for (const lock of acquiredLocks.reverse()) {
    const statement =
      lock.mode === 'shared'
        ? 'SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))'
        : 'SELECT pg_advisory_unlock(hashtextextended($1, 0))'
    await client
      .query(statement, [`${credentialLockNamespace}${lock.key}`])
      .catch(() => undefined)
  }
}

async function installationOwnerUserId(client: Client): Promise<string | null> {
  const result = await client.query<{ owner_user_id: string | null }>(
    'SELECT owner_user_id FROM installation_state WHERE singleton = 1',
  )
  return result.rows[0]?.owner_user_id ?? null
}

async function captureInstallationOwnerUserId(): Promise<string | null> {
  const result = await getPool().query<{ owner_user_id: string | null }>(
    'SELECT owner_user_id FROM installation_state WHERE singleton = 1',
  )
  return result.rows[0]?.owner_user_id ?? null
}

async function assertSameClaimedInstallation(
  client: Client,
  expectedOwnerUserId: string | null,
): Promise<void> {
  const currentOwnerUserId = await installationOwnerUserId(client)
  if (!expectedOwnerUserId || currentOwnerUserId !== expectedOwnerUserId) {
    throw new CredentialLifecycleUnavailableError()
  }
}

/**
 * Holds a PostgreSQL session advisory lock on a dedicated connection. The protected
 * callback may use the normal application pool without consuming the connection that
 * owns the lock, avoiding pool starvation when an authentication handler creates its
 * session on another connection.
 */
export async function withCredentialLifecycleLock<T>(
  userId: string,
  callback: () => Promise<T>,
): Promise<T> {
  return withCredentialLifecycleLocks([userId], callback)
}

/**
 * Acquires every lifecycle key on one PostgreSQL connection in lexical order. Owner
 * actions use this for actor + target locking, so recovery of the owner's credential
 * cannot cross a successful re-authentication and target sign-in cannot cross a reset.
 */
export async function withCredentialLifecycleLocks<T>(
  userIds: readonly string[],
  callback: () => Promise<T>,
): Promise<T> {
  const orderedKeys = [...new Set(userIds)].sort().map(accountLockKey)
  if (orderedKeys.length === 0) {
    throw new Error('At least one credential lifecycle key is required.')
  }

  // Resolve configuration before reserving a process-local slot. A malformed runtime
  // configuration must not permanently consume capacity before the guarded finally block
  // exists.
  const databaseUrl = getServerConfig().databaseUrl
  const releaseLifecycleRequest = reserveLifecycleRequest('trusted')

  try {
    // Capture the installation identity before this request can wait in the dedicated
    // connection queue. The normal application pool is itself bounded, while the
    // request reservation above bounds its pending capture work. A request queued before
    // reset therefore cannot adopt a replacement owner after re-bootstrap.
    const expectedOwnerUserId = await captureInstallationOwnerUserId()
    const releaseConnectionSlot = await acquireConnectionSlot('trusted')
    let client: Client | undefined
    const acquiredLocks: AdvisoryLock[] = []

    try {
      client = new Client({
        connectionString: databaseUrl,
        application_name: 'indigo-credential-lifecycle',
      })
      await client.connect()
      await client.query("SET lock_timeout = '10s'")
      await acquireLock(client, instanceFenceKey, acquiredLocks, 'shared')
      await assertSameClaimedInstallation(client, expectedOwnerUserId)
      for (const key of orderedKeys) {
        await acquireLock(client, key, acquiredLocks)
      }
      return await callback()
    } finally {
      if (client) {
        await releaseLocks(client, acquiredLocks)
        await client.end().catch(() => undefined)
      }
      releaseConnectionSlot()
    }
  } finally {
    releaseLifecycleRequest()
  }
}

/**
 * Takes the submitted-email lock before resolving an account, then takes the resolved
 * account locks (or one deterministic synthetic target) on the same PostgreSQL session.
 * This ordering is shared by sign-in, creation, and web recovery.
 */
export async function withSubmittedEmailCredentialLifecycleLocks<T>(input: {
  readonly email: string
  readonly resolveAccountUserIds: () => Promise<readonly string[]>
  readonly callback: (resolvedAccountUserIds: readonly string[]) => Promise<T>
}): Promise<T> {
  const emailDigest = credentialEmailLockDigest(input.email)
  const databaseUrl = getServerConfig().databaseUrl
  const releaseLifecycleRequest = reserveLifecycleRequest('submitted-email')

  try {
    const expectedOwnerUserId = await captureInstallationOwnerUserId()
    const releaseConnectionSlot = await acquireConnectionSlot('submitted-email')
    let client: Client | undefined
    const acquiredLocks: AdvisoryLock[] = []

    try {
      client = new Client({
        connectionString: databaseUrl,
        application_name: 'indigo-credential-lifecycle',
      })
      await client.connect()
      await client.query("SET lock_timeout = '10s'")
      await acquireLock(client, instanceFenceKey, acquiredLocks, 'shared')
      await assertSameClaimedInstallation(client, expectedOwnerUserId)
      await acquireLock(client, emailLockKey(emailDigest), acquiredLocks)

      const resolvedAccountUserIds = [
        ...new Set(await input.resolveAccountUserIds()),
      ].sort()
      const targetKeys =
        resolvedAccountUserIds.length > 0
          ? resolvedAccountUserIds.map(accountLockKey)
          : [unknownAccountLockKey(emailDigest)]
      for (const key of targetKeys) {
        await acquireLock(client, key, acquiredLocks)
      }

      return await input.callback(resolvedAccountUserIds)
    } finally {
      if (client) {
        await releaseLocks(client, acquiredLocks)
        await client.end().catch(() => undefined)
      }
      releaseConnectionSlot()
    }
  } finally {
    releaseLifecycleRequest()
  }
}

/**
 * Excludes every credential lifecycle operation for the complete duration of an
 * instance reset. Ordinary lifecycle work takes the shared form of this fence before
 * any email or account lock, so a pre-reset request must finish before the wipe and a
 * post-reset request cannot cross it.
 */
export async function withExclusiveCredentialLifecycleFence<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const databaseUrl = getServerConfig().databaseUrl
  const releaseLifecycleRequest = reserveLifecycleRequest('trusted')

  try {
    const releaseConnectionSlot = await acquireConnectionSlot('trusted')
    let client: Client | undefined
    const acquiredLocks: AdvisoryLock[] = []

    try {
      client = new Client({
        connectionString: databaseUrl,
        application_name: 'indigo-credential-lifecycle',
      })
      await client.connect()
      await client.query("SET lock_timeout = '10s'")
      await acquireLock(client, instanceFenceKey, acquiredLocks)
      return await callback()
    } finally {
      if (client) {
        await releaseLocks(client, acquiredLocks)
        await client.end().catch(() => undefined)
      }
      releaseConnectionSlot()
    }
  } finally {
    releaseLifecycleRequest()
  }
}
