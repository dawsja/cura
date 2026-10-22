import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, foreignKey } from 'drizzle-orm/sqlite-core';
import { accounts } from './accounts';
import { user } from './auth';
import { categories, transactionTypes } from './categories';
import { subCategories } from './sub_categories';

/**
 * Categorization rules have explicit match conditions and an assignment.
 * Existing merchant-only rows keep nullable conditions and therefore remain
 * broad; rules created from a transaction include its source account, type,
 * and category so similarly named activity on another account is unaffected.
 *
 * `matchType` is currently always `'exact'` at the storage layer; actual
 * matching is exact-or-prefix (see `src/lib/merchant-match.ts`) so a rule
 * for "Starbucks" also catches "STARBUCKS #12345". `matchValue` stores the
 * merchant string verbatim for display. Nullable source fields are wildcards.
 * `category`, `subCategory`, and `type` are the assignment to apply.
 */
export const rules = sqliteTable(
  'rules',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    matchType: text('match_type').notNull().default('exact'),
    matchValue: text('match_value').notNull(),
    // Trimmed, lower-cased, with whitespace runs collapsed to one space.
    // SQLite has no regex, so tabs and line breaks become spaces and
    // five rounds of double-space replacement collapse runs up to 32 long.
    normalizedMatchValue: text('normalized_match_value').generatedAlwaysAs(
      sql`lower(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace("match_value", char(9), ' '), char(10), ' '), char(13), ' '), char(12), ' '), char(11), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')))`,
    ),
    accountId: text('account_id'),
    sourceType: text('source_type', { enum: transactionTypes }),
    sourceCategory: text('source_category'),
    sourceSubCategory: text('source_sub_category'),
    category: text('category').notNull(),
    subCategory: text('sub_category'),
    categoryId: text('category_id'),
    subCategoryId: text('sub_category_id'),
    type: text('type', { enum: transactionTypes }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
    version: integer('version').notNull().default(1),
  },
  (t) => ({
    // Hot path: list/filter by user. Matching is done in app code over
    // the user's (typically small) rule set, so a plain user index is
    // enough — we no longer rely on equality on match_value alone.
    userMerchantIdx: index('idx_rules_user_merchant').on(t.userId, t.matchValue),
    userAccountIdx: index('idx_rules_user_account').on(t.userId, t.accountId),
    userCategoryAssignmentIdx: index('idx_rules_user_category_assignment').on(t.userId, t.categoryId, t.subCategoryId),
    // Unscoped fields are NULL; coalesce so two rules that differ only in
    // which fields are NULL still count as duplicates (Postgres used
    // NULLS NOT DISTINCT for this).
    normalizedScopeUnique: uniqueIndex('rules_user_normalized_scope_unique').on(
      t.userId,
      t.normalizedMatchValue,
      sql`coalesce(${t.accountId}, '')`,
      sql`coalesce(${t.sourceType}, '')`,
      sql`coalesce(${t.sourceCategory}, '')`,
      sql`coalesce(${t.sourceSubCategory}, '')`,
    ),
    tenantAccountFk: foreignKey({
      columns: [t.userId, t.accountId],
      foreignColumns: [accounts.userId, accounts.id],
      name: 'rules_user_account_fk',
    }).onDelete('cascade'),
    tenantCategoryFk: foreignKey({
      columns: [t.userId, t.categoryId],
      foreignColumns: [categories.userId, categories.id],
      name: 'rules_user_category_fk',
    }),
    tenantSubCategoryFk: foreignKey({
      columns: [t.userId, t.subCategoryId],
      foreignColumns: [subCategories.userId, subCategories.id],
      name: 'rules_user_sub_category_fk',
    }),
  }),
);

export type RuleRow = typeof rules.$inferSelect;
export type NewRuleRow = typeof rules.$inferInsert;
