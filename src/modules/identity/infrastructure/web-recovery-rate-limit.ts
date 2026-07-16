import { createHmac } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from '@/platform/db/client'
import { webRecoveryRateLimitBuckets } from '@/platform/db/schema'
import { normalizeRecoveryEmail, recoveryAbusePolicy } from '../recovery/recovery-policy'

export type WebRecoveryPurpose = 'sign-in' | 'member-reset' | 'owner-recovery'
type WebRecoveryDimension = 'email' | 'address'
type WebRecoveryScope = `${WebRecoveryPurpose}:${WebRecoveryDimension}`

export type WebRecoveryAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly scope: WebRecoveryScope }

type DatabaseTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0]

type RateLimitDatabase = Pick<
  DatabaseTransaction,
  'delete' | 'execute' | 'insert' | 'select' | 'update'
>

type RateBucket = typeof webRecoveryRateLimitBuckets.$inferSelect

function rateDimensions(input: {
  readonly purpose: WebRecoveryPurpose
  readonly email: string
  readonly clientAddress: string
}) {
  const normalizedEmail = normalizeRecoveryEmail(input.email)
  return [
    {
      dimension: 'address' as const,
      scope: `${input.purpose}:address` as WebRecoveryScope,
      value: input.clientAddress,
    },
    {
      dimension: 'email' as const,
      scope: `${input.purpose}:email` as WebRecoveryScope,
      value: normalizedEmail,
    },
  ].map((dimension) => ({
    ...dimension,
    key: bucketDigest(dimension.scope, dimension.value),
  }))
}

function bucketDigest(scope: WebRecoveryScope, value: string): string {
  return createHmac('sha256', getServerConfig().authSecret)
    .update(`indigo-web-recovery-rate-v1\0${scope}\0${value}`, 'utf8')
    .digest('hex')
}

async function lockBucket(
  database: RateLimitDatabase,
  scope: WebRecoveryScope,
  key: string,
): Promise<void> {
  await database.execute(
    sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`indigo:web-recovery-rate:${scope}:${key}`}, 0)
    )`,
  )
}

async function readBucket(
  database: RateLimitDatabase,
  scope: WebRecoveryScope,
  key: string,
): Promise<RateBucket | undefined> {
  const [bucket] = await database
    .select()
    .from(webRecoveryRateLimitBuckets)
    .where(
      and(
        eq(webRecoveryRateLimitBuckets.scope, scope),
        eq(webRecoveryRateLimitBuckets.bucketKey, key),
      ),
    )
    .for('update')
    .limit(1)
  return bucket
}

function windowEndsAt(bucket: RateBucket): Date {
  return new Date(
    bucket.windowStartedAt.getTime() + recoveryAbusePolicy.windowMilliseconds,
  )
}

function isActivelyThrottled(bucket: RateBucket | undefined, now: Date): boolean {
  if (!bucket) return false
  const windowEnd = windowEndsAt(bucket)
  return (
    windowEnd > now &&
    (bucket.attemptCount >=
      recoveryAbusePolicy.maximumAttempts[
        bucket.scope.endsWith(':email') ? 'email' : 'address'
      ] ||
      (bucket.retryAfter !== null && bucket.retryAfter > now))
  )
}

/**
 * Cheap read-only load shedder. This is intentionally not the authority for admission:
 * callers repeat the check and atomically reserve both dimensions under their lifecycle
 * lock with admitWebRecoveryAttempt. Its purpose is to keep an already-active throttle
 * from allocating or queueing another dedicated lifecycle-lock connection.
 */
export async function isWebRecoveryAttemptThrottled(input: {
  readonly purpose: WebRecoveryPurpose
  readonly email: string
  readonly clientAddress: string
  readonly now?: Date
}): Promise<boolean> {
  const now = input.now ?? new Date()
  let throttled = false
  for (const dimension of rateDimensions(input)) {
    const [bucket] = await getDb()
      .select()
      .from(webRecoveryRateLimitBuckets)
      .where(
        and(
          eq(webRecoveryRateLimitBuckets.scope, dimension.scope),
          eq(webRecoveryRateLimitBuckets.bucketKey, dimension.key),
        ),
      )
      .limit(1)
    throttled = isActivelyThrottled(bucket, now) || throttled
  }
  return throttled
}

async function reserveDimension(
  database: RateLimitDatabase,
  input: {
    readonly scope: WebRecoveryScope
    readonly key: string
    readonly dimension: WebRecoveryDimension
    readonly bucket: RateBucket | undefined
    readonly now: Date
  },
): Promise<void> {
  const maximumAttempts = recoveryAbusePolicy.maximumAttempts[input.dimension]
  if (!input.bucket) {
    await database.insert(webRecoveryRateLimitBuckets).values({
      scope: input.scope,
      bucketKey: input.key,
      windowStartedAt: input.now,
      attemptCount: 1,
      retryAfter: null,
      lastAttemptAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    return
  }

  const priorWindowEnd = windowEndsAt(input.bucket)
  if (priorWindowEnd <= input.now) {
    await database
      .update(webRecoveryRateLimitBuckets)
      .set({
        windowStartedAt: input.now,
        attemptCount: 1,
        retryAfter: null,
        lastAttemptAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(webRecoveryRateLimitBuckets.scope, input.scope),
          eq(webRecoveryRateLimitBuckets.bucketKey, input.key),
        ),
      )
    return
  }

  // Requests carry their fixed command-entry time through queueing. An older request can
  // therefore acquire this row after a newer request has already advanced it. Preserve that
  // request-time admission decision, but never move durable bucket clocks backwards (or violate
  // window_started_at <= last_attempt_at) when persisting the serialized attempt.
  const effectiveAttemptAt = new Date(
    Math.max(
      input.now.getTime(),
      input.bucket.windowStartedAt.getTime(),
      input.bucket.lastAttemptAt.getTime(),
    ),
  )
  const attemptCount = input.bucket.attemptCount + 1
  await database
    .update(webRecoveryRateLimitBuckets)
    .set({
      attemptCount,
      retryAfter: attemptCount >= maximumAttempts ? priorWindowEnd : null,
      lastAttemptAt: effectiveAttemptAt,
      updatedAt: effectiveAttemptAt,
    })
    .where(
      and(
        eq(webRecoveryRateLimitBuckets.scope, input.scope),
        eq(webRecoveryRateLimitBuckets.bucketKey, input.key),
      ),
    )
}

async function cleanupExpiredBuckets(
  database: RateLimitDatabase,
  now: Date,
): Promise<void> {
  await database.execute(sql`
    WITH expired_buckets AS (
      SELECT scope, bucket_key
      FROM web_recovery_rate_limit_bucket
      WHERE window_started_at <= ${new Date(
        now.getTime() - recoveryAbusePolicy.windowMilliseconds,
      )}
      ORDER BY updated_at, scope, bucket_key
      FOR UPDATE SKIP LOCKED
      LIMIT ${recoveryAbusePolicy.maximumCleanupRows}
    )
    DELETE FROM web_recovery_rate_limit_bucket AS bucket
    USING expired_buckets
    WHERE bucket.scope = expired_buckets.scope
      AND bucket.bucket_key = expired_buckets.bucket_key
  `)
}

/**
 * Admits address first so random-email floods cannot create unbounded email buckets.
 * Every bucket contains only a keyed digest; raw submitted identities never persist.
 */
type WebRecoveryAttempt = {
  readonly purpose: WebRecoveryPurpose
  readonly email: string
  readonly clientAddress: string
  readonly now?: Date
}

async function admitWebRecoveryAttemptWithAdvisoryDatabase(
  database: RateLimitDatabase,
  input: WebRecoveryAttempt,
): Promise<WebRecoveryAdmission> {
  const now = input.now ?? new Date()
  const dimensions = rateDimensions(input)

  for (const dimension of dimensions) {
    await lockBucket(database, dimension.scope, dimension.key)
  }

  const buckets = []
  for (const dimension of dimensions) {
    buckets.push(await readBucket(database, dimension.scope, dimension.key))
  }

  const throttledIndex = buckets.findIndex((bucket) => isActivelyThrottled(bucket, now))
  if (throttledIndex >= 0) {
    const throttledDimension = dimensions[throttledIndex]
    if (!throttledDimension) throw new Error('Missing throttled recovery dimension.')
    return { admitted: false, scope: throttledDimension.scope }
  }

  for (const [index, dimension] of dimensions.entries()) {
    await reserveDimension(database, {
      scope: dimension.scope,
      key: dimension.key,
      dimension: dimension.dimension,
      bucket: buckets[index],
      now,
    })
  }

  await cleanupExpiredBuckets(database, now)

  return { admitted: true }
}

type PreparedBucket = {
  readonly bucket: RateBucket
  readonly created: boolean
}

async function prepareRowLockedBucket(
  database: RateLimitDatabase,
  dimension: ReturnType<typeof rateDimensions>[number],
  now: Date,
): Promise<PreparedBucket> {
  const [created] = await database
    .insert(webRecoveryRateLimitBuckets)
    .values({
      scope: dimension.scope,
      bucketKey: dimension.key,
      windowStartedAt: now,
      attemptCount: 1,
      retryAfter: null,
      lastAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning()
  if (created) return { bucket: created, created: true }

  const bucket = await readBucket(database, dimension.scope, dimension.key)
  if (!bucket) {
    throw new Error('Rate-limit bucket disappeared while acquiring its row lock.')
  }
  return { bucket, created: false }
}

async function removeProvisionalBuckets(
  database: RateLimitDatabase,
  dimensions: readonly ReturnType<typeof rateDimensions>[number][],
): Promise<void> {
  for (const dimension of dimensions) {
    await database
      .delete(webRecoveryRateLimitBuckets)
      .where(
        and(
          eq(webRecoveryRateLimitBuckets.scope, dimension.scope),
          eq(webRecoveryRateLimitBuckets.bucketKey, dimension.key),
        ),
      )
  }
}

/**
 * The scoped UoW query guard owns all advisory locks. Absent buckets therefore serialize by
 * inserting the primary-key row, while existing buckets serialize with FOR UPDATE. Provisional
 * rows are removed if a later dimension is already throttled, preserving the address-first
 * random-email flood bound without opening a nested transaction or savepoint.
 */
async function admitWebRecoveryAttemptWithRowLocks(
  database: RateLimitDatabase,
  input: WebRecoveryAttempt,
): Promise<WebRecoveryAdmission> {
  const now = input.now ?? new Date()
  const dimensions = rateDimensions(input)
  const prepared: PreparedBucket[] = []
  const provisionalDimensions: ReturnType<typeof rateDimensions>[number][] = []
  const existingBuckets: Array<RateBucket | undefined> = []

  // Lock every row that already exists before creating any missing dimension. An already
  // active throttle therefore rejects without INSERT/DELETE churn, including a burst whose
  // cheap pre-capture observation became stale while it waited for credential serialization.
  for (const dimension of dimensions) {
    existingBuckets.push(await readBucket(database, dimension.scope, dimension.key))
  }
  const existingThrottle = existingBuckets.findIndex((bucket) =>
    isActivelyThrottled(bucket, now),
  )
  if (existingThrottle >= 0) {
    const dimension = dimensions[existingThrottle]
    if (!dimension) throw new Error('Missing throttled recovery dimension.')
    return { admitted: false, scope: dimension.scope }
  }

  for (const [index, dimension] of dimensions.entries()) {
    const existing = existingBuckets[index]
    const bucket = existing
      ? { bucket: existing, created: false }
      : await prepareRowLockedBucket(database, dimension, now)
    prepared.push(bucket)
    if (bucket.created) provisionalDimensions.push(dimension)
    if (isActivelyThrottled(bucket.bucket, now)) {
      await removeProvisionalBuckets(database, provisionalDimensions)
      return { admitted: false, scope: dimension.scope }
    }
  }

  for (const [index, dimension] of dimensions.entries()) {
    const bucket = prepared[index]
    if (!bucket) throw new Error('Missing prepared recovery admission bucket.')
    if (bucket.created) continue
    await reserveDimension(database, {
      scope: dimension.scope,
      key: dimension.key,
      dimension: dimension.dimension,
      bucket: bucket.bucket,
      now,
    })
  }

  await cleanupExpiredBuckets(database, now)
  return { admitted: true }
}

/** Existing recovery paths retain their own transaction until their Stage 3 cutover. */
export async function admitWebRecoveryAttempt(
  input: WebRecoveryAttempt,
): Promise<WebRecoveryAdmission> {
  return getDb().transaction((transaction) =>
    admitWebRecoveryAttemptWithAdvisoryDatabase(transaction, input),
  )
}

/** Transaction-scoped admission used by the production Identity auth gateway. */
export function createScopedWebRecoveryRateLimitGateway(database: RateLimitDatabase): {
  admit(input: WebRecoveryAttempt): Promise<WebRecoveryAdmission>
} {
  return Object.freeze({
    admit: (input) => admitWebRecoveryAttemptWithRowLocks(database, input),
  })
}
