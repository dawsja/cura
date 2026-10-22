import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import { user } from './auth';

/**
 * Provider identities the user has deleted. SimpleFIN sync skips these
 * so a later poll cannot recreate a transaction the user removed.
 */
export const simpleFinIgnoredTransactions = sqliteTable(
  'simplefin_ignored_transactions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    primaryKey: primaryKey({ columns: [t.userId, t.externalId] }),
  }),
);
