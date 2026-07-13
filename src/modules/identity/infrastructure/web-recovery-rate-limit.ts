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
  transaction: DatabaseTransaction,
  scope: WebRecoveryScope,
  key: string,
): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`indigo:web-recovery-rate:${scope}:${key}`}, 0)
    )`,
  )
}

async function readBucket(
  transaction: DatabaseTransaction,
  scope: WebRecoveryScope,
  key: string,
): Promise<RateBucket | undefined> {
  const [bucket] = await transaction
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
  transaction: DatabaseTransaction,
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
    await transaction.insert(webRecoveryRateLimitBuckets).values({
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
    await transaction
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

  const attemptCount = input.bucket.attemptCount + 1
  await transaction
    .update(webRecoveryRateLimitBuckets)
    .set({
      attemptCount,
      retryAfter: attemptCount >= maximumAttempts ? priorWindowEnd : null,
      lastAttemptAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(webRecoveryRateLimitBuckets.scope, input.scope),
        eq(webRecoveryRateLimitBuckets.bucketKey, input.key),
      ),
    )
}

/**
 * Admits address first so random-email floods cannot create unbounded email buckets.
 * Every bucket contains only a keyed digest; raw submitted identities never persist.
 */
export async function admitWebRecoveryAttempt(input: {
  readonly purpose: WebRecoveryPurpose
  readonly email: string
  readonly clientAddress: string
  readonly now?: Date
}): Promise<WebRecoveryAdmission> {
  const now = input.now ?? new Date()
  const dimensions = rateDimensions(input)

  return getDb().transaction(async (transaction) => {
    for (const dimension of dimensions) {
      await lockBucket(transaction, dimension.scope, dimension.key)
    }

    const buckets = []
    for (const dimension of dimensions) {
      buckets.push(await readBucket(transaction, dimension.scope, dimension.key))
    }

    const throttledIndex = buckets.findIndex((bucket) => isActivelyThrottled(bucket, now))
    if (throttledIndex >= 0) {
      const throttledDimension = dimensions[throttledIndex]
      if (!throttledDimension) throw new Error('Missing throttled recovery dimension.')
      return { admitted: false, scope: throttledDimension.scope }
    }

    for (const [index, dimension] of dimensions.entries()) {
      await reserveDimension(transaction, {
        scope: dimension.scope,
        key: dimension.key,
        dimension: dimension.dimension,
        bucket: buckets[index],
        now,
      })
    }

    await transaction.execute(sql`
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

    return { admitted: true }
  })
}
