import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull()

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull()

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('session_user_id_idx').on(table.userId),
    index('session_expires_at_id_idx').on(table.expiresAt, sql`${table.id} COLLATE "C"`),
  ],
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('account_user_id_idx').on(table.userId),
    uniqueIndex('account_provider_account_uidx').on(table.providerId, table.accountId),
  ],
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
)

/**
 * Mutable security state for destructive password challenges. Successful
 * reauthentication removes the row; audit_event retains append-only evidence of
 * denied attempts without retaining account or subject identifiers after deletion.
 */
export const destructiveReauthenticationStates = pgTable(
  'destructive_reauthentication_state',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    windowStartedAt: timestamp('window_started_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    failedAttempts: integer('failed_attempts').notNull(),
    lockedUntil: timestamp('locked_until', {
      withTimezone: true,
      mode: 'date',
    }),
    lastAttemptAt: timestamp('last_attempt_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('destructive_reauthentication_account_purpose_uidx').on(
      table.accountId,
      table.purpose,
    ),
    check(
      'destructive_reauthentication_purpose_check',
      sql`${table.purpose} IN (
        'trainee-data-deletion',
        'instance-reset',
        'member-reset-issue',
        'local-user-create'
      )`,
    ),
    check(
      'destructive_reauthentication_attempts_check',
      sql`${table.failedAttempts} BETWEEN 1 AND 5`,
    ),
    check(
      'destructive_reauthentication_window_check',
      sql`${table.windowStartedAt} <= ${table.lastAttemptAt}`,
    ),
    check(
      'destructive_reauthentication_lock_check',
      sql`(${table.failedAttempts} < 5 AND ${table.lockedUntil} IS NULL)
        OR (${table.failedAttempts} = 5
          AND ${table.lockedUntil} IS NOT NULL
          AND ${table.lockedUntil} > ${table.windowStartedAt})`,
    ),
  ],
)

/**
 * Mutable lifecycle state for one member's active reset capability. The row is
 * target-keyed so the issuance cooldown survives successful redemption, while the
 * active verification reference becomes null when the one-use capability is consumed.
 */
export const memberResetStates = pgTable(
  'member_reset_state',
  {
    targetUserId: text('target_user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeVerificationId: text('active_verification_id').references(
      () => verification.id,
      { onDelete: 'set null' },
    ),
    lastIssuedAt: timestamp('last_issued_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    failedAttempts: integer('failed_attempts').default(0).notNull(),
    retryAfter: timestamp('retry_after', { withTimezone: true, mode: 'date' }),
    lastAttemptAt: timestamp('last_attempt_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('member_reset_state_active_verification_uidx').on(
      table.activeVerificationId,
    ),
    check('member_reset_state_attempts_check', sql`${table.failedAttempts} >= 0`),
    check(
      'member_reset_state_attempt_shape_check',
      sql`(${table.failedAttempts} = 0 AND ${table.lastAttemptAt} IS NULL AND ${table.retryAfter} IS NULL)
        OR (${table.failedAttempts} > 0 AND ${table.lastAttemptAt} IS NOT NULL)`,
    ),
    check(
      'member_reset_state_attempt_order_check',
      sql`${table.lastAttemptAt} IS NULL OR ${table.lastAttemptAt} >= ${table.lastIssuedAt}`,
    ),
    check(
      'member_reset_state_retry_check',
      sql`${table.retryAfter} IS NULL OR ${table.retryAfter} > ${table.lastAttemptAt}`,
    ),
  ],
)

/**
 * Durable, cleanup-friendly web admission state. bucket_key contains only an
 * HMAC-SHA-256 digest of the normalized email or client address; raw identifiers never
 * enter this table.
 */
export const webRecoveryRateLimitBuckets = pgTable(
  'web_recovery_rate_limit_bucket',
  {
    scope: text('scope').notNull(),
    bucketKey: text('bucket_key').notNull(),
    windowStartedAt: timestamp('window_started_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    attemptCount: integer('attempt_count').notNull(),
    retryAfter: timestamp('retry_after', { withTimezone: true, mode: 'date' }),
    lastAttemptAt: timestamp('last_attempt_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: 'web_recovery_rate_limit_bucket_pk',
      columns: [table.scope, table.bucketKey],
    }),
    index('web_recovery_rate_limit_bucket_updated_idx').on(
      table.updatedAt,
      table.scope,
      table.bucketKey,
    ),
    check(
      'web_recovery_rate_limit_bucket_scope_check',
      sql`${table.scope} IN (
        'sign-in:email',
        'sign-in:address',
        'member-reset:email',
        'member-reset:address',
        'owner-recovery:email',
        'owner-recovery:address'
      )`,
    ),
    check(
      'web_recovery_rate_limit_bucket_key_check',
      sql`${table.bucketKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'web_recovery_rate_limit_bucket_attempts_check',
      sql`${table.attemptCount} >= 1`,
    ),
    check(
      'web_recovery_rate_limit_bucket_window_check',
      sql`${table.windowStartedAt} <= ${table.lastAttemptAt}`,
    ),
    check(
      'web_recovery_rate_limit_bucket_retry_check',
      sql`${table.retryAfter} IS NULL OR ${table.retryAfter} > ${table.lastAttemptAt}`,
    ),
  ],
)
