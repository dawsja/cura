import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, unique, check } from 'drizzle-orm/sqlite-core';
import { user } from './auth';
import { dollarsAsCents } from './cents';

export const accountTypes = [
  'checking',
  'savings',
  'credit',
  'investment',
  'loan',
  'uncategorized',
] as const;

/**
 * Accounts — checking, savings, credit, investment, loan, or uncategorized.
 * The id is a string (we keep the current "acc-<timestamp>" convention so
 * historical data and SimpleFIN-prefixed ids survive).
 *
 * Pay-down fields (interestRate, minPayment, plannedPayment,
 * includeInPaydown) are only meaningful for `credit` and `loan` types but
 * live on the row for simplicity — the calculator ignores them for
 * non-debt accounts.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Account type. On first SimpleFIN insert this is the inferred type,
    // or `uncategorized` when no signal is strong enough. After that
    // `upsertAccount` never overwrites it, so a user
    // correction on the Accounts page survives every re-sync (same
    // pattern as alias / paydown fields).
    //
    // `investment` is balance-only: SimpleFIN still refreshes the
    // balance for net worth / growth, but never imports transactions,
    // and ledger reads (Transactions, reviews, budget, reports cash
    // flow) exclude investment account activity.
    type: text('type', { enum: accountTypes }).notNull(),
    balance: dollarsAsCents('balance').notNull().default(0),
    institution: text('institution'),
    // Annual percentage rate as a decimal (0.18 = 18% APR). 0 is valid
    // (e.g. 0% intro APR or paid-in-full credit card).
    interestRate: real('interest_rate').notNull().default(0),
    // Minimum monthly principal+interest payment the issuer requires.
    // Do NOT include tax/insurance — those aren't part of pay-down math.
    minPayment: dollarsAsCents('min_payment').notNull().default(0),
    // User-chosen "I plan to pay this much" override. If zero, the
    // calculator uses minPayment. Zero balances (paid off) get ignored.
    plannedPayment: dollarsAsCents('planned_payment').notNull().default(0),
    // Per-account opt-out. A "credit card you pay in full each month"
    // would set this to false to exclude it from the projection.
    includeInPaydown: integer('include_in_paydown', { mode: 'boolean' }).notNull().default(true),
    // User-set "hide this account" flag. Hidden accounts are excluded
    // from the accounts list, dashboard net-worth, transactions, budget,
    // and paydown views. For SimpleFIN-synced accounts the flag also
    // gates the sync: if the row exists with hidden=true, the next sync
    // skips the upsert AND its transactions, so the account won't come
    // back. Unhide to resume syncing.
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    // User-set display alias. NULL means "use the canonical name".
    // SimpleFIN sync never overwrites this — `upsertAccount` only
    // touches name/balance/institution on conflict — so the alias
    // survives every re-sync. The Transactions page resolves the alias
    // on read, so renaming flows through to historical transactions
    // without rewriting the ledger.
    alias: text('alias'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    userIdx: index('idx_accounts_user').on(t.userId),
    userIdUnique: unique('accounts_user_id_id_unique').on(t.userId, t.id),
    balanceRange: check(
      'accounts_balance_range',
      sql`${t.balance} BETWEEN 0 AND 9000000000000000`,
    ),
    interestRateRange: check(
      'accounts_interest_rate_range',
      sql`${t.interestRate} BETWEEN 0 AND 1`,
    ),
    minPaymentRange: check(
      'accounts_min_payment_range',
      sql`${t.minPayment} BETWEEN 0 AND 9000000000000000`,
    ),
    plannedPaymentRange: check(
      'accounts_planned_payment_range',
      sql`${t.plannedPayment} BETWEEN 0 AND 9000000000000000`,
    ),
  }),
);

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
