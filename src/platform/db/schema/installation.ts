import { sql } from 'drizzle-orm'
import { check, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth'

export const installationState = pgTable(
  'installation_state',
  {
    singleton: smallint('singleton').primaryKey(),
    ownerUserId: text('owner_user_id')
      .unique()
      .references(() => user.id, { onDelete: 'restrict' }),
    bootstrapClosedAt: timestamp('bootstrap_closed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check('installation_state_singleton_check', sql`${table.singleton} = 1`),
    check(
      'installation_state_owner_closed_check',
      sql`(${table.ownerUserId} IS NULL AND ${table.bootstrapClosedAt} IS NULL)
        OR (${table.ownerUserId} IS NOT NULL AND ${table.bootstrapClosedAt} IS NOT NULL)`,
    ),
  ],
)
