import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
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
  (table) => [index('session_user_id_idx').on(table.userId)],
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
      sql`${table.purpose} IN ('trainee-data-deletion', 'instance-reset')`,
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
