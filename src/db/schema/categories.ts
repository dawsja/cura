import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { user } from './auth';

// `transfer` covers credit card payments, account-to-account moves, and
// any other transaction where money moves between two of the user's own
// accounts. Transfers are excluded from income/expense totals because
// they don't change net worth — they just reallocate it.
export const transactionTypes = ['income', 'expense', 'transfer'] as const;

/**
 * Main categories (e.g. "Food & Dining"). Children live in `sub_categories`.
 *
 * `sortOrder` is a per-user ordering field. The user can drag-and-drop
 * main categories on the Categories page; the new order is persisted
 * and respected by the Budget page (which renders the same list).
 */
export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: transactionTypes }).notNull(),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    userIdx: index('idx_categories_user').on(t.userId),
    userIdUnique: unique('categories_user_id_id_unique').on(t.userId, t.id),
  }),
);

export type CategoryRow = typeof categories.$inferSelect;
export type NewCategoryRow = typeof categories.$inferInsert;
