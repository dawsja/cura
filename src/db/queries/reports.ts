import { and, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { accounts } from '../schema/accounts';
import { categories } from '../schema/categories';
import { subCategories } from '../schema/sub_categories';
import { transactions } from '../schema/transactions';
import { centsToDollars } from '@/lib/money';
import { latestBudgetsUpTo } from '../budget-repository';
import { endOfMonth } from './dates';
import { loadEffectiveLedgerAllocations } from './ledger';

// ---- Reports aggregates ---------------------------------------------------
//
// Report series helpers are read-only, userId-scoped, and use the same
// account exclusion policy as Transactions, Dashboard, and Budget. The page
// calls a matching endpoint per chart so the client never re-aggregates.

/**
 * Enumerate every YYYY-MM between `start` and `end` inclusive. Used to
 * pad reports so months with zero activity still appear on the axis.
 */
function eachMonth(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  let y = sy ?? 1970;
  let m = sm ?? 1;
  while (y < (ey ?? 9999) || (y === (ey ?? 9999) && m <= (em ?? 12))) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// ---- 1. Cash Flow -------------------------------------------------------

export interface CashFlowPoint {
  month: string;
  income: number;
  expense: number;
  net: number;
}

/**
 * Monthly income vs. expense for the requested range. Transfers are excluded
 * because they don't change net worth. Known hidden, investment, and
 * uncategorized accounts are excluded; deleted-account history is retained.
 *
 * Returns a dense monthly series (zero-filled) so the chart's x-axis
 * doesn't have gaps for months with no activity.
 */
export async function getCashFlowSeries(userId: string, fromDate: string, toDate: string): Promise<CashFlowPoint[]> {
  const rows = await loadEffectiveLedgerAllocations(userId, fromDate, toDate);

  const byMonth = new Map<string, { incomeCents: number; expenseCents: number }>();
  for (const r of rows) {
    if (r.type === 'transfer') continue;
    const month = r.date.slice(0, 7);
    const cur = byMonth.get(month) ?? { incomeCents: 0, expenseCents: 0 };
    if (r.type === 'income') cur.incomeCents += r.amountCents;
    else cur.expenseCents += r.amountCents;
    byMonth.set(month, cur);
  }

  return eachMonth(fromDate.slice(0, 7), toDate.slice(0, 7)).map((month) => {
    const point = byMonth.get(month) ?? { incomeCents: 0, expenseCents: 0 };
    return {
      month,
      income: centsToDollars(point.incomeCents),
      expense: centsToDollars(point.expenseCents),
      net: centsToDollars(point.incomeCents - point.expenseCents),
    };
  });
}

/** Earliest accepted ledger date available to report range resolution. */
export async function getEarliestReportDate(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ date: sql<string | null>`MIN(${transactions.date})` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.needsReview, false)));
  return row?.date ?? null;
}

// ---- 2. Net Worth -------------------------------------------------------

export interface NetWorthPoint {
  month: string;
  netWorth: number;
}

/**
 * Sign convention for net-worth contribution. Mirrors
 * `lib/accounting.ts → netWorthContribution` so the time-series
 * endpoint agrees with the Dashboard's headline number.
 */
export function netWorthContributionForAccount(type: string, balance: number): number {
  if (type === 'uncategorized') return 0;
  if (type === 'credit' || type === 'loan') return -Math.abs(balance);
  return Math.abs(balance);
}

/**
 * Monthly net worth for the requested range. Computed by walking
 * transactions forward from the earliest month, adding income and
 * subtracting expenses in each month. The opening balance is
 * "current net worth minus the sum of all transactions in the range",
 * which assumes the user has been using the app continuously; if an
 * account was added mid-range the historical line will have a step
 * change at the month the account first appeared. Acceptable for v1 —
 * capturing periodic balance snapshots would require a new table.
 *
 * Hidden accounts are excluded from the current-net-worth figure.
 * Transfers are excluded from the deltas (they reallocate within own
 * accounts and don't change net worth).
 */
export async function getNetWorthSeries(userId: string, fromDate: string, toDate: string): Promise<NetWorthPoint[]> {
  const accountRows = await db
    .select({ type: accounts.type, balance: accounts.balance })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.hidden, false)));
  const currentNetWorthCents = accountRows.reduce(
    (sum, account) => sum + Math.round(netWorthContributionForAccount(account.type, account.balance) * 100),
    0,
  );

  // Sum of income/expense transactions in the range, grouped by month.
  const txRows = await loadEffectiveLedgerAllocations(userId, fromDate, toDate);

  const monthDelta = new Map<string, number>();
  for (const r of txRows) {
    if (r.type === 'transfer') continue;
    const month = r.date.slice(0, 7);
    const cur = monthDelta.get(month) ?? 0;
    const delta = r.type === 'income' ? r.amountCents : -r.amountCents;
    monthDelta.set(month, cur + delta);
  }

  // Opening net worth = current_net_worth - sum(all tx deltas in range).
  const totalDelta = Array.from(monthDelta.values()).reduce((s, v) => s + v, 0);
  let openingCents = currentNetWorthCents - totalDelta;

  const months = eachMonth(fromDate.slice(0, 7), toDate.slice(0, 7));
  const series: NetWorthPoint[] = [];
  for (const month of months) {
    openingCents += monthDelta.get(month) ?? 0;
    series.push({ month, netWorth: centsToDollars(openingCents) });
  }
  return series;
}

// ---- 3. Spending by Category --------------------------------------------

export interface CategorySpend {
  category: string;
  total: number;
}

/**
 * Total spending per main category for a single month. Includes
 * sub-totals to the main category (the budget UI works at the
 * sub-category level, but the pie chart needs the main category so
 * it doesn't explode into 30 slices). Empty list if no data.
 */
export async function getSpendingByCategory(userId: string, yearMonth: string): Promise<CategorySpend[]> {
  const monthStart = `${yearMonth}-01`;
  const monthEnd = endOfMonth(yearMonth);

  const rows = await loadEffectiveLedgerAllocations(userId, monthStart, monthEnd);
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== 'expense') continue;
    totals.set(row.category, (totals.get(row.category) ?? 0) + row.amountCents);
  }
  return [...totals]
    .map(([category, totalCents]) => ({ category, total: centsToDollars(totalCents) }))
    .sort((a, b) => b.total - a.total);
}

export interface SpendingTrendResult {
  categories: Array<{ key: string; name: string }>;
  series: Array<Record<string, string | number>>;
}

/** Monthly expense totals for the five largest categories in a range. */
export async function getSpendingCategoryTrends(
  userId: string,
  fromDate: string,
  toDate: string,
): Promise<SpendingTrendResult> {
  const months = eachMonth(fromDate.slice(0, 7), toDate.slice(0, 7));
  const allocations = await loadEffectiveLedgerAllocations(userId, fromDate, toDate);
  const grouped = new Map<string, { month: string; category: string; totalCents: number }>();
  for (const row of allocations) {
    if (row.type !== 'expense') continue;
    const month = row.date.slice(0, 7);
    const key = `${month}\u0000${row.category}`;
    const current = grouped.get(key);
    if (current) current.totalCents += row.amountCents;
    else grouped.set(key, { month, category: row.category, totalCents: row.amountCents });
  }
  const rows = [...grouped.values()];

  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.category, (totals.get(row.category) ?? 0) + row.totalCents);
  const topNames = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
  const hasOther = totals.size > topNames.length;
  const categories = topNames.map((name, index) => ({
    key: `category${index}`,
    name,
  }));
  if (hasOther) categories.push({ key: 'other', name: 'Other' });

  const byMonth = new Map(months.map((month) => [month, { month } as Record<string, string | number>]));
  for (const point of byMonth.values()) for (const category of categories) point[category.key] = 0;
  for (const row of rows) {
    const point = byMonth.get(row.month);
    if (!point) continue;
    const index = topNames.indexOf(row.category);
    const key = index >= 0 ? `category${index}` : 'other';
    point[key] = Number(point[key] ?? 0) + row.totalCents;
  }
  for (const point of byMonth.values()) {
    for (const category of categories) point[category.key] = centsToDollars(Number(point[category.key]));
  }
  return { categories, series: months.map((month) => byMonth.get(month)!) };
}

export interface SpendingPacePoint {
  day: number;
  current: number | null;
  previous: number;
  budgetPace: number;
}

export interface SpendingPaceResult {
  month: string;
  previousMonth: string;
  budget: number;
  series: SpendingPacePoint[];
}

/** Cumulative daily expense pace for a month, its predecessor, and budget. */
export async function getSpendingPace(userId: string, yearMonth: string): Promise<SpendingPaceResult> {
  const [year, month] = yearMonth.split('-').map(Number) as [number, number];
  const previousDate = new Date(Date.UTC(year, month - 2, 1));
  const previousMonth = previousDate.toISOString().slice(0, 7);
  const currentEnd = endOfMonth(yearMonth);
  const previousEnd = endOfMonth(previousMonth);
  const allocations = await loadEffectiveLedgerAllocations(userId, `${previousMonth}-01`, currentEnd);
  const expenseByDate = new Map<string, number>();
  for (const row of allocations) {
    if (row.type !== 'expense') continue;
    expenseByDate.set(row.date, (expenseByDate.get(row.date) ?? 0) + row.amountCents);
  }

  const [effectiveBudgets, expenseSubRows] = await Promise.all([
    latestBudgetsUpTo(userId, yearMonth),
    db
      .select({ id: subCategories.id })
      .from(subCategories)
      .innerJoin(categories, eq(subCategories.mainCategoryId, categories.id))
      .where(and(eq(subCategories.userId, userId), eq(categories.userId, userId), eq(categories.type, 'expense'))),
  ]);

  const currentDaily = new Map<number, number>();
  const previousDaily = new Map<number, number>();
  for (const [date, totalCents] of expenseByDate) {
    const day = Number(date.slice(8, 10));
    const target = date.startsWith(yearMonth) ? currentDaily : previousDaily;
    target.set(day, totalCents);
  }

  const days = Number(currentEnd.slice(8, 10));
  const previousDays = Number(previousEnd.slice(8, 10));
  const budget = expenseSubRows.reduce((sum, row) => sum + (effectiveBudgets.get(row.id) ?? 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const currentCutoff =
    yearMonth === today.slice(0, 7) ? Number(today.slice(8, 10)) : yearMonth < today.slice(0, 7) ? days : 0;
  let current = 0;
  let previous = 0;
  const series: SpendingPacePoint[] = [];
  for (let day = 1; day <= days; day++) {
    current += currentDaily.get(day) ?? 0;
    if (day <= previousDays) previous += previousDaily.get(day) ?? 0;
    series.push({
      day,
      current: day <= currentCutoff ? centsToDollars(current) : null,
      previous: centsToDollars(previous),
      budgetPace: (budget * day) / days,
    });
  }
  return { month: yearMonth, previousMonth, budget, series };
}

// ---- 4. Top Merchants ----------------------------------------------------

export interface MerchantTotal {
  merchant: string;
  total: number;
  count: number;
}

/**
 * Top merchants by total spend in the requested range. Expense allocations
 * inherently exclude transfers; account visibility follows the shared ledger
 * exclusion policy. Defaults to top 10 to keep the bar chart readable.
 */
export async function getTopMerchants(
  userId: string,
  fromDate: string,
  toDate: string,
  limit = 10,
): Promise<MerchantTotal[]> {
  const allocations = await loadEffectiveLedgerAllocations(userId, fromDate, toDate);
  const totals = new Map<string, { totalCents: number; transactionIds: Set<string> }>();
  for (const row of allocations) {
    if (row.type !== 'expense') continue;
    const current = totals.get(row.merchant) ?? { totalCents: 0, transactionIds: new Set<string>() };
    current.totalCents += row.amountCents;
    current.transactionIds.add(row.transactionId);
    totals.set(row.merchant, current);
  }
  return [...totals]
    .map(([merchant, value]) => ({
      merchant,
      total: centsToDollars(value.totalCents),
      count: value.transactionIds.size,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// ---- 5. Budget vs Actual -----------------------------------------------

export interface BudgetVsActualRow {
  category: string;
  planned: number;
  actual: number;
}

/**
 * Per-main-category planned vs. actual for a single month. Joins
 * `monthlyBudgets` (planned per sub-category) up to the main
 * category via `subCategories`, and sums the user's expense
 * transactions for the month by sub-category, then aggregates to the
 * main category.

 * Categories with no planned budget and no actual spend are skipped
 * to keep the chart focused on what the user is actually tracking.
 */
export async function getBudgetVsActual(userId: string, yearMonth: string): Promise<BudgetVsActualRow[]> {
  const monthStart = `${yearMonth}-01`;
  const monthEnd = endOfMonth(yearMonth);

  // Map sub-category ID → main category name (filter to expense
  // categories only — income/transfer categories don't get budgets).
  const subRows = await db
    .select({
      subId: subCategories.id,
      mainName: categories.name,
      categoryType: categories.type,
    })
    .from(subCategories)
    .innerJoin(categories, eq(subCategories.mainCategoryId, categories.id))
    .where(and(eq(subCategories.userId, userId), eq(categories.userId, userId), eq(categories.type, 'expense')));
  const subToMain = new Map<string, string>();
  for (const r of subRows) subToMain.set(r.subId, r.mainName);

  // Planned per sub-category for the month.
  const plannedRows = await latestBudgetsUpTo(userId, yearMonth);

  // Actual per main category for the month. The `category` column on a
  // transaction holds the MAIN category name (not the sub — see schema),
  // so we can group by it directly and skip the sub→main join.
  const allocations = await loadEffectiveLedgerAllocations(userId, monthStart, monthEnd);
  const actualByCategory = new Map<string, number>();
  for (const row of allocations) {
    if (row.type !== 'expense') continue;
    actualByCategory.set(row.category, (actualByCategory.get(row.category) ?? 0) + row.amountCents);
  }

  // Aggregate to main category.
  const byCategory = new Map<string, { planned: number; actualCents: number }>();

  for (const [subCategoryId, planned] of plannedRows) {
    const main = subToMain.get(subCategoryId);
    if (!main) continue;
    const cur = byCategory.get(main) ?? { planned: 0, actualCents: 0 };
    cur.planned += planned;
    byCategory.set(main, cur);
  }

  for (const [category, totalCents] of actualByCategory) {
    const cur = byCategory.get(category) ?? { planned: 0, actualCents: 0 };
    cur.actualCents += totalCents;
    byCategory.set(category, cur);
  }

  // Drop entries where both planned and actual are zero.
  const out: BudgetVsActualRow[] = [];
  for (const [category, v] of byCategory) {
    if (v.planned === 0 && v.actualCents === 0) continue;
    out.push({
      category,
      planned: v.planned,
      actual: centsToDollars(v.actualCents),
    });
  }
  out.sort((a, b) => Math.max(b.planned, b.actual) - Math.max(a.planned, a.actual));
  return out;
}

