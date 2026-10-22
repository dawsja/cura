import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, unique, foreignKey, check } from 'drizzle-orm/sqlite-core';
import { user } from './auth';
import { categories, transactionTypes } from './categories';
import { subCategories } from './sub_categories';

/**
 * Transactions — the core ledger entry. `external_id` is unique per user
 * to support tenant-scoped SimpleFIN sync dedupe (`sf-<simplefin-tx-id>`).
 *
 * `needs_review` flags SimpleFIN-imported transactions that the user
 * hasn't acknowledged yet. The bell badge + the Transactions banner
 * count rows where this is TRUE. The user can clear it from the review
 * carousel (Skip just clears; Categorize also patches category/sub/type).
 * Manually-entered transactions set it FALSE on insert so the user
 * doesn't have to review the data they just typed in themselves.
 */
export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    sourceDate: text('source_date'),
    dateUserModified: integer('date_user_modified', { mode: 'boolean' }).notNull().default(false),
    merchant: text('merchant').notNull(),
    // User-edited merchant labels must survive SimpleFIN re-syncs.
    merchantUserModified: integer('merchant_user_modified', { mode: 'boolean' }).notNull().default(false),
    // Classification before a user rule or manual correction is applied.
    // Scoped rules match these immutable source values so applying a rule
    // does not change the fields that determine whether it matches.
    sourceCategory: text('source_category').notNull(),
    sourceSubCategory: text('source_sub_category'),
    sourceType: text('source_type', { enum: transactionTypes }).notNull(),
    sourceClassificationTrusted: integer('source_classification_trusted', { mode: 'boolean' }).notNull().default(true),
    category: text('category').notNull(),
    subCategory: text('sub_category'),
    categoryId: text('category_id'),
    subCategoryId: text('sub_category_id'),
    // User-picked assignments are transaction-specific overrides and must
    // not be replaced by later historical rule runs.
    categoryUserModified: integer('category_user_modified', { mode: 'boolean' }).notNull().default(false),
    // Stable ledger identity. `account` remains a display snapshot for
    // compatibility and for rows whose legacy name could not be backfilled.
    accountId: text('account_id'),
    account: text('account').notNull(),
    amountCents: integer('amount_cents', { mode: 'number' }).notNull(),
    type: text('type', { enum: transactionTypes }).notNull(),
    notes: text('notes'),
    externalId: text('external_id'),
    sourcePending: integer('source_pending', { mode: 'boolean' }),
    sourceTransactedAt: integer('source_transacted_at', { mode: 'number' }),
    sourceLastSeenAt: integer('source_last_seen_at', { mode: 'timestamp_ms' }),
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    userIdx: index('idx_transactions_user').on(t.userId),
    dateIdx: index('idx_transactions_date').on(t.date),
    userDateIdx: index('idx_transactions_user_date').on(t.userId, t.date),
    categoryAssignmentIdx: index('idx_transactions_user_category_assignment').on(t.userId, t.categoryId, t.subCategoryId),
    tenantCategoryFk: foreignKey({
      columns: [t.userId, t.categoryId],
      foreignColumns: [categories.userId, categories.id],
      name: 'transactions_user_category_fk',
    }),
    tenantSubCategoryFk: foreignKey({
      columns: [t.userId, t.subCategoryId],
      foreignColumns: [subCategories.userId, subCategories.id],
      name: 'transactions_user_sub_category_fk',
    }),
    userAccountIdx: index('idx_transactions_user_account').on(t.userId, t.accountId),
    externalIdx: uniqueIndex('idx_transactions_user_external').on(t.userId, t.externalId),
    userIdUnique: unique('transactions_user_id_id_unique').on(t.userId, t.id),
    amountSafeInteger: check(
      'transactions_amount_cents_safe_integer',
      sql`${t.amountCents} BETWEEN 0 AND 9007199254740991`,
    ),
    // Hot path: "does this user have transactions awaiting review?" and
    // "fetch the review queue". The compound index supports both with a
    // single row-scan; the order matches the WHERE clause that
    // `pendingReviewCount` / `listReviewQueue` emit.
    userNeedsReviewIdx: index('idx_transactions_user_needs_review').on(t.userId, t.needsReview),
  }),
);

export type TransactionRow = typeof transactions.$inferSelect;
export type NewTransactionRow = typeof transactions.$inferInsert;
