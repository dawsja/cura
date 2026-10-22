import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import { user } from './auth';

/**
 * Per-user key-value store. Used for SimpleFIN access URL, last-sync timestamps,
 * UI preferences, and anything else that doesn't deserve a dedicated column.
 *
 * NOTE: values are stored as text. The SimpleFIN access URL is sensitive;
 * consider encrypting it at rest before deploying to a multi-tenant host.
 */
export const settings = sqliteTable(
  'settings',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.key] }),
  }),
);

export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
