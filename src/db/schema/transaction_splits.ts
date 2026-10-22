import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, unique, foreignKey, check } from 'drizzle-orm/sqlite-core';
import { user } from './auth';
import { categories, transactionTypes } from './categories';
import { subCategories } from './sub_categories';
import { transactions } from './transactions';

/** Effective ledger allocations for a transaction; the parent remains the source record. */
export const transactionSplits = sqliteTable(
  'transaction_splits',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    transactionId: text('transaction_id').notNull(),
    amountCents: integer('amount_cents', { mode: 'number' }).notNull(),
    category: text('category').notNull(),
    subCategory: text('sub_category').notNull(),
    categoryId: text('category_id'),
    subCategoryId: text('sub_category_id'),
    type: text('type', { enum: transactionTypes }).notNull(),
    sortOrder: integer('sort_order').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    userIdx: index('idx_transaction_splits_user').on(t.userId),
    transactionIdx: index('idx_transaction_splits_transaction').on(t.userId, t.transactionId),
    categoryAssignmentIdx: index('idx_transaction_splits_user_category_assignment').on(t.userId, t.categoryId, t.subCategoryId),
    transactionOrderUnique: unique('transaction_splits_transaction_order_unique').on(
      t.userId,
      t.transactionId,
      t.sortOrder,
    ),
    tenantTransactionFk: foreignKey({
      columns: [t.userId, t.transactionId],
      foreignColumns: [transactions.userId, transactions.id],
      name: 'transaction_splits_user_transaction_fk',
    }).onDelete('cascade'),
    tenantCategoryFk: foreignKey({
      columns: [t.userId, t.categoryId],
      foreignColumns: [categories.userId, categories.id],
      name: 'transaction_splits_user_category_fk',
    }),
    tenantSubCategoryFk: foreignKey({
      columns: [t.userId, t.subCategoryId],
      foreignColumns: [subCategories.userId, subCategories.id],
      name: 'transaction_splits_user_sub_category_fk',
    }),
    positiveSafeAmount: check(
      'transaction_splits_amount_cents_positive_safe_integer',
      sql`${t.amountCents} BETWEEN 1 AND 9007199254740991`,
    ),
    nonNegativeOrder: check('transaction_splits_sort_order_non_negative', sql`${t.sortOrder} >= 0`),
  }),
);

export type TransactionSplitRow = typeof transactionSplits.$inferSelect;
export type NewTransactionSplitRow = typeof transactionSplits.$inferInsert;
