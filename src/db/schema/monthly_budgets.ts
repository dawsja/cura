import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, primaryKey, foreignKey, check } from 'drizzle-orm/sqlite-core';
import { user } from './auth';
import { subCategories } from './sub_categories';
import { dollarsAsCents } from './cents';

/**
 * Monthly budgets — per-sub-category planned amount, keyed by year-month.
 * Composite primary key on (user, sub_category, year_month). The "forward
 * propagation" cron job in src/jobs/budget-rollforward.ts carries the
 * previous month's value forward when no explicit override is set.
 */
export const monthlyBudgets = sqliteTable(
  'monthly_budgets',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    subCategoryId: text('sub_category_id').notNull(),
    yearMonth: text('year_month').notNull(), // 'YYYY-MM'
    planned: dollarsAsCents('planned').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
    // Optimistic-concurrency token for "apply to future months": a random
    // value on insert, replaced on every update by a trigger (see the
    // SQLite migrations), so any change to the row invalidates it.
    revision: text('revision').notNull().default(sql`(lower(hex(randomblob(8))))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.subCategoryId, t.yearMonth] }),
    yearMonthIdx: index('idx_monthly_budgets_year_month').on(t.yearMonth),
    tenantSubCategoryFk: foreignKey({
      columns: [t.userId, t.subCategoryId],
      foreignColumns: [subCategories.userId, subCategories.id],
      name: 'monthly_budgets_user_sub_category_fk',
    }).onDelete('cascade'),
    yearMonthFormat: check('monthly_budgets_year_month_format', sql`${t.yearMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(${t.yearMonth}, 6, 2) BETWEEN '01' AND '12'`),
    plannedRange: check(
      'monthly_budgets_planned_range',
      sql`${t.planned} BETWEEN 0 AND 9000000000000000`,
    ),
  }),
);

export type MonthlyBudgetRow = typeof monthlyBudgets.$inferSelect;
export type NewMonthlyBudgetRow = typeof monthlyBudgets.$inferInsert;
