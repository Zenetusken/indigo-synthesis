import { createHmac } from 'node:crypto'
import { getServerConfig } from '@/platform/config/server'
import {
  type CredentialConnection,
  CredentialConnectionCapacityError,
  credentialLifecycleConnectionLimit,
  credentialLifecycleSubmittedEmailQueueLimit,
  credentialLifecycleTrustedQueueLimit,
  withSubmittedEmailCredentialCapture,
  withSubmittedEmailCredentialControl,
  withTrustedCredentialCapture,
  withTrustedCredentialControl,
} from '@/platform/db/credential-connections'
import { normalizeRecoveryEmail } from '../recovery/recovery-policy'

const credentialLockNamespace = 'indigo:credential-lifecycle:'
const instanceFenceKey = 'instance-fence'

export {
  credentialLifecycleConnectionLimit,
  credentialLifecycleSubmittedEmailQueueLimit,
  credentialLifecycleTrustedQueueLimit,
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
  client: CredentialConnection,
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
  client: CredentialConnection,
  acquiredLocks: AdvisoryLock[],
): Promise<void> {
  let firstError: unknown
  for (const lock of acquiredLocks.reverse()) {
    const statement =
      lock.mode === 'shared'
        ? 'SELECT pg_advisory_unlock_shared(hashtextextended($1, 0)) AS unlocked'
        : 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked'
    try {
      const result = await client.query<{ unlocked: boolean }>(statement, [
        `${credentialLockNamespace}${lock.key}`,
      ])
      if (result.rows[0]?.unlocked !== true) {
        throw new Error(`Credential advisory lock ${lock.key} was not held at cleanup.`)
      }
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== undefined) throw firstError
}

async function installationOwnerUserId(
  client: CredentialConnection,
): Promise<string | null> {
  const result = await client.query<{ owner_user_id: string | null }>(
    'SELECT owner_user_id FROM installation_state WHERE singleton = 1',
  )
  return result.rows[0]?.owner_user_id ?? null
}

async function assertSameClaimedInstallation(
  client: CredentialConnection,
  expectedOwnerUserId: string | null,
): Promise<void> {
  const currentOwnerUserId = await installationOwnerUserId(client)
  if (!expectedOwnerUserId || currentOwnerUserId !== expectedOwnerUserId) {
    throw new CredentialLifecycleUnavailableError()
  }
}

type CallbackOutcome<Result> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly error: unknown }

async function withReverseUnlock<Result>(
  client: CredentialConnection,
  acquiredLocks: AdvisoryLock[],
  callback: () => Promise<Result>,
): Promise<Result> {
  let outcome: CallbackOutcome<Result>
  try {
    outcome = { ok: true, value: await callback() }
  } catch (error) {
    outcome = { ok: false, error }
  }

  let cleanupError: unknown
  try {
    await releaseLocks(client, acquiredLocks)
  } catch (error) {
    cleanupError = error
  }

  if (!outcome.ok) throw outcome.error
  if (cleanupError !== undefined) throw cleanupError
  return outcome.value
}

function mapLifecycleCapacity(error: unknown): never {
  if (error instanceof CredentialConnectionCapacityError) {
    throw new CredentialLifecycleCapacityError()
  }
  throw error
}

/**
 * Holds a PostgreSQL session advisory lock on a reserved control connection. The protected
 * callback remains a legacy ordinary-pool consumer until the same-session Identity gateway
 * cutover; reserving control/capture here removes unmanaged clients from the physical budget.
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

  try {
    const expectedOwnerUserId = await withTrustedCredentialCapture(
      installationOwnerUserId,
    )
    return await withTrustedCredentialControl(async (client) => {
      const acquiredLocks: AdvisoryLock[] = []
      return withReverseUnlock(client, acquiredLocks, async () => {
        await client.query("SET lock_timeout = '5s'")
        await acquireLock(client, instanceFenceKey, acquiredLocks, 'shared')
        await assertSameClaimedInstallation(client, expectedOwnerUserId)
        for (const key of orderedKeys) {
          await acquireLock(client, key, acquiredLocks)
        }
        return callback()
      })
    })
  } catch (error) {
    mapLifecycleCapacity(error)
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
  try {
    const expectedOwnerUserId = await withSubmittedEmailCredentialCapture(
      installationOwnerUserId,
    )
    return await withSubmittedEmailCredentialControl(async (client) => {
      const acquiredLocks: AdvisoryLock[] = []
      return withReverseUnlock(client, acquiredLocks, async () => {
        await client.query("SET lock_timeout = '5s'")
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

        return input.callback(resolvedAccountUserIds)
      })
    })
  } catch (error) {
    mapLifecycleCapacity(error)
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
  try {
    return await withTrustedCredentialControl(async (client) => {
      const acquiredLocks: AdvisoryLock[] = []
      return withReverseUnlock(client, acquiredLocks, async () => {
        await client.query("SET lock_timeout = '5s'")
        await acquireLock(client, instanceFenceKey, acquiredLocks)
        return callback()
      })
    })
  } catch (error) {
    mapLifecycleCapacity(error)
  }
}
