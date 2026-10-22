import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, foreignKey, check } from 'drizzle-orm/sqlite-core';
import { accounts } from './accounts';
import { user } from './auth';
import { dollarsAsCents } from './cents';

/**
 * Savings goals — "save up for X" targets watched against an account.
 *
 * `current` is the user's starting value at goal-creation time (or after
 * they edit it); the live progress is the watched account's current
 * `balance`. We don't store a snapshot of the account balance — the
 * account row is the source of truth for live balance, and the goal row
 * carries the user's intent (target amount + starting offset).
 */
export const goals = sqliteTable(
  'goals',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    target: dollarsAsCents('target').notNull(),
    // Starting value entered by the user at goal creation. We don't
    // reference it in the progress bar (the account balance drives
    // progress), but we keep it so the user can see "you've saved $X
    // since you created this goal" if they want.
    startingValue: dollarsAsCents('starting_value').notNull().default(0),
    // The account whose balance the progress bar tracks. Set when the
    // goal is created; nullable so a deleted account doesn't blow up
    // reads — callers should treat null as "account gone, hide progress".
    accountId: text('account_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    userIdx: index('idx_goals_user').on(t.userId),
    tenantAccountFk: foreignKey({
      columns: [t.userId, t.accountId],
      foreignColumns: [accounts.userId, accounts.id],
      name: 'goals_user_account_fk',
    }),
    targetRange: check(
      'goals_target_range',
      sql`${t.target} > 0 AND ${t.target} <= 9000000000000000`,
    ),
    startingValueRange: check(
      'goals_starting_value_range',
      sql`${t.startingValue} BETWEEN 0 AND 9000000000000000`,
    ),
  }),
);

export type GoalRow = typeof goals.$inferSelect;
export type NewGoalRow = typeof goals.$inferInsert;
