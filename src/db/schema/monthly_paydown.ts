import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, primaryKey, check } from 'drizzle-orm/sqlite-core';
import { user } from './auth';
import { dollarsAsCents } from './cents';

/**
 * Monthly paydown snapshots — per-account planned debt payment keyed
 * by year-month. Populated when the user clicks "Save to Budget" on
 * the Pay down page; read by the Budget page's Pay down modal to show
 * planned per-account for the selected month.
 *
 * Same composite-PK shape as `monthly_budgets`. No FK on `account_id`
 * so the snapshot survives account deletion — the modal filters
 * hidden/deleted accounts at read time so the user can un-hide
 * without losing their plan.
 */
export const monthlyPaydown = sqliteTable(
  'monthly_paydown',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    yearMonth: text('year_month').notNull(),
    planned: dollarsAsCents('planned').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.accountId, t.yearMonth] }),
    userIdx: index('idx_monthly_paydown_user').on(t.userId),
    yearMonthFormat: check('monthly_paydown_year_month_format', sql`${t.yearMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(${t.yearMonth}, 6, 2) BETWEEN '01' AND '12'`),
    plannedRange: check(
      'monthly_paydown_planned_range',
      sql`${t.planned} BETWEEN 0 AND 9000000000000000`,
    ),
  }),
);

export type MonthlyPaydownRow = typeof monthlyPaydown.$inferSelect;
export type NewMonthlyPaydownRow = typeof monthlyPaydown.$inferInsert;

/**
 * "When did the user last bulk-sync the month" — one row per
 * (user, year_month). Updated alongside `monthly_paydown` by the
 * Save-to-Budget endpoint. Read by the Budget modal to render
 * "Last synced: 5m ago".
 *
 * Kept separate from `monthly_paydown.updated_at` so a per-account
 * edit doesn't masquerade as a bulk sync (which is what the UI's
 * "via Pay down page" wording is signalling).
 */
export const monthlyPaydownSnapshots = sqliteTable(
  'monthly_paydown_snapshots',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    yearMonth: text('year_month').notNull(),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
    rowCount: integer('row_count').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.yearMonth] }),
    userIdx: index('idx_monthly_paydown_snapshots_user').on(t.userId),
    yearMonthFormat: check(
      'monthly_paydown_snapshots_year_month_format',
      sql`${t.yearMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(${t.yearMonth}, 6, 2) BETWEEN '01' AND '12'`,
    ),
    rowCountRange: check('monthly_paydown_snapshots_row_count_range', sql`${t.rowCount} >= 0`),
  }),
);

export type MonthlyPaydownSnapshotRow = typeof monthlyPaydownSnapshots.$inferSelect;
export type NewMonthlyPaydownSnapshotRow = typeof monthlyPaydownSnapshots.$inferInsert;
