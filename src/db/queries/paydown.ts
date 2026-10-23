import { and, eq, gt, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../client';
import { accounts } from '../schema/accounts';
import { categories } from '../schema/categories';
import { subCategories } from '../schema/sub_categories';
import { monthlyBudgets } from '../schema/monthly_budgets';
import { monthlyPaydown, monthlyPaydownSnapshots } from '../schema/monthly_paydown';
import { firstMonthPaydownPayments, type PaydownAccount, type PaydownMethod } from '@/lib/paydown';
import { centsToDollars } from '@/lib/money';
import { getLiabilityAccounts } from './accounts';
import { endOfMonth } from './dates';
import { loadEffectiveLedgerAllocations } from './ledger';
import { getSetting, setSetting } from './settings';

/**
 * Ensure a single "Pay down goals" parent category exists with one
 * sub-category per debt account name. Optionally writes the month's
 * planned amounts into `monthly_budgets` so the Budget page carry-forward
 * reads match the paydown snapshot.
 *
 * Returns the sub-category id keyed by account name.
 */
export async function syncPaydownCategories(
  userId: string,
  accountNames: string[],
  options?: {
    yearMonth?: string;
    plannedByName?: Record<string, number>;
  },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (accountNames.length === 0) return result;

  await db.transaction(async (tx) => {
    const paydownCategories = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), sql`lower(trim(${categories.name})) = 'pay down goals'`))
      .limit(2);
    if (paydownCategories.length > 1) {
      throw Object.assign(new Error('Multiple Pay down goals categories must be resolved before saving a plan'), { status: 409 });
    }
    const paydownCategory = paydownCategories[0];
    let mainCategoryId = paydownCategory?.id;
    if (!mainCategoryId) {
      const [top] = await tx
        .select({ sortOrder: categories.sortOrder })
        .from(categories)
        .where(eq(categories.userId, userId))
        .orderBy(sql`${categories.sortOrder} DESC`)
        .limit(1);
      mainCategoryId = `cat-${nanoid(10)}`;
      await tx.insert(categories).values({
        id: mainCategoryId,
        userId,
        name: 'Pay down goals',
        type: 'transfer',
        icon: 'CreditCard',
        sortOrder: (top?.sortOrder ?? -1) + 1,
      });
    }

    const existing = await tx
      .select({ id: subCategories.id, name: subCategories.name })
      .from(subCategories)
      .where(and(eq(subCategories.userId, userId), eq(subCategories.mainCategoryId, mainCategoryId)));
    const existingByName = new Map<string, string>();
    for (const row of existing) {
      if (existingByName.has(row.name)) {
        throw Object.assign(new Error(`Duplicate paydown category for account: ${row.name}`), { status: 409 });
      }
      existingByName.set(row.name, row.id);
    }

    const missing = accountNames.filter((name) => !existingByName.has(name));
    if (missing.length > 0) {
      const inserted = missing.map((name) => ({
        id: `sub-${nanoid(10)}`,
        userId,
        mainCategoryId: mainCategoryId!,
        name,
        planned: 0,
      }));
      await tx.insert(subCategories).values(inserted);
      for (const row of inserted) existingByName.set(row.name, row.id);
    }

    for (const name of accountNames) {
      const id = existingByName.get(name);
      if (id) result.set(name, id);
    }

    // Persist planned amounts onto monthly_budgets when the caller has a
    // yearMonth + allocation map (Save to Budget path).
    const ym = options?.yearMonth;
    const plannedByName = options?.plannedByName;
    if (ym && plannedByName) {
      const now = new Date();
      for (const [name, planned] of Object.entries(plannedByName)) {
        const subId = existingByName.get(name);
        if (!subId) continue;
        await tx
          .delete(monthlyBudgets)
          .where(
            and(
              eq(monthlyBudgets.userId, userId),
              eq(monthlyBudgets.subCategoryId, subId),
              gt(monthlyBudgets.yearMonth, ym),
            ),
          );
        await tx
          .insert(monthlyBudgets)
          .values({
            userId,
            subCategoryId: subId,
            yearMonth: ym,
            planned,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [monthlyBudgets.userId, monthlyBudgets.subCategoryId, monthlyBudgets.yearMonth],
            set: { planned, updatedAt: now },
          });
      }
    }
  });
  return result;
}

// ---- Monthly paydown snapshots -----------------------------------------
//
// Populated by the Pay down page's "Save to Budget" button. Read by the
// Budget page's Pay down modal to render per-account planned for the
// selected month. Per-month so the user can plan different debt
// payments each month without overwriting the next.

export interface MonthlyPaydownRow {
  accountId: string;
  planned: number;
}

export async function getMonthlyPaydown(userId: string, yearMonth: string): Promise<MonthlyPaydownRow[]> {
  const rows = await db
    .select()
    .from(monthlyPaydown)
    .where(and(eq(monthlyPaydown.userId, userId), eq(monthlyPaydown.yearMonth, yearMonth)))
    .orderBy(sql`rowid`);
  return rows.map((r) => ({ accountId: r.accountId, planned: r.planned }));
}

export async function getPaydownSnapshotMeta(
  userId: string,
  yearMonth: string,
): Promise<{ syncedAt: Date; rowCount: number } | null> {
  const [row] = await db
    .select()
    .from(monthlyPaydownSnapshots)
    .where(and(eq(monthlyPaydownSnapshots.userId, userId), eq(monthlyPaydownSnapshots.yearMonth, yearMonth)))
    .limit(1);
  if (!row) return null;
  return { syncedAt: row.syncedAt, rowCount: row.rowCount };
}

/**
 * Snapshot every credit/loan account with `includeInPaydown=true` into
 * `monthly_paydown` for the given month, reading the planned value from
 * `accounts.plannedPayment`. Idempotent — re-running just upserts.
 *
 * Returns the number of accounts snapshotted so the route can surface
 * a useful toast.
 */
export async function syncMonthlyPaydown(
  userId: string,
  yearMonth: string,
): Promise<{ rowCount: number; syncedAt: Date }> {
  const rows = await db
    .select({
      id: accounts.id,
      type: accounts.type,
      balance: accounts.balance,
      plannedPayment: accounts.plannedPayment,
      minPayment: accounts.minPayment,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.includeInPaydown, true)));
  const snapshottable = rows.filter((r) => r.type === 'credit' || r.type === 'loan');

  const syncedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .delete(monthlyPaydown)
      .where(and(eq(monthlyPaydown.userId, userId), eq(monthlyPaydown.yearMonth, yearMonth)));
    for (const row of snapshottable) {
      // Zero-balance included debts still appear on Budget but need no
      // planned payment until a balance returns.
      const planned = row.balance <= 0 ? 0 : row.plannedPayment > 0 ? row.plannedPayment : row.minPayment;
      await tx
        .insert(monthlyPaydown)
        .values({
          userId,
          accountId: row.id,
          yearMonth,
          planned,
          updatedAt: syncedAt,
        })
        .onConflictDoUpdate({
          target: [monthlyPaydown.userId, monthlyPaydown.accountId, monthlyPaydown.yearMonth],
          set: { planned, updatedAt: syncedAt },
        });
    }
    await tx
      .insert(monthlyPaydownSnapshots)
      .values({ userId, yearMonth, syncedAt, rowCount: snapshottable.length })
      .onConflictDoUpdate({
        target: [monthlyPaydownSnapshots.userId, monthlyPaydownSnapshots.yearMonth],
        set: { syncedAt, rowCount: snapshottable.length },
      });
  });

  return { rowCount: snapshottable.length, syncedAt };
}

/**
 * Save-to-Budget under an active scenario. Same shape as
 * `syncMonthlyPaydown` but each account's planned value is computed
 * from the active calculator scenario:
 *
 * Uses the calculator's first-month allocation so minimums, freed cash,
 * monthly extra, and a cascading one-time payment exactly match the
 * projection. No migration is needed because `monthly_paydown` already
 * stores the planned amount per account.
 */
export async function syncMonthlyPaydownWithScenario(
  userId: string,
  yearMonth: string,
  method: PaydownMethod,
  monthlyExtra: number,
  oneTimeExtra: number,
): Promise<{
  rowCount: number;
  syncedAt: Date;
  allocation: { accountId: string; planned: number }[];
}> {
  // Reuse the same liability filtering as the projection.
  const liabilityRows = await getLiabilityAccounts(userId);

  const included = liabilityRows.filter((a) => a.includeInPaydown);
  const paydownAccounts: PaydownAccount[] = included.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type === 'loan' ? 'loan' : 'credit',
    balance: a.balance,
    apr: a.interestRate,
    minPayment: a.minPayment,
    plannedPayment: a.plannedPayment,
    includeInPaydown: true,
  }));

  const syncedAt = new Date();

  const firstMonthPayments =
    included.length === 0
      ? {}
      : firstMonthPaydownPayments(paydownAccounts, {
          method,
          monthlyExtra,
          oneTimeExtra,
        });

  const allocation: { accountId: string; planned: number }[] = [];
  for (const a of included) {
    const planned = Math.round((firstMonthPayments[a.id] ?? 0) * 100) / 100;
    allocation.push({ accountId: a.id, planned });
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(monthlyPaydown)
      .where(and(eq(monthlyPaydown.userId, userId), eq(monthlyPaydown.yearMonth, yearMonth)));
    for (const row of allocation) {
      await tx
        .insert(monthlyPaydown)
        .values({
          userId,
          accountId: row.accountId,
          yearMonth,
          planned: row.planned,
          updatedAt: syncedAt,
        })
        .onConflictDoUpdate({
          target: [monthlyPaydown.userId, monthlyPaydown.accountId, monthlyPaydown.yearMonth],
          set: { planned: row.planned, updatedAt: syncedAt },
        });
    }
    await tx
      .insert(monthlyPaydownSnapshots)
      .values({ userId, yearMonth, syncedAt, rowCount: allocation.length })
      .onConflictDoUpdate({
        target: [monthlyPaydownSnapshots.userId, monthlyPaydownSnapshots.yearMonth],
        set: { syncedAt, rowCount: allocation.length },
      });
  });

  return { rowCount: allocation.length, syncedAt, allocation };
}

export interface SavedPaydownScenario {
  method: PaydownMethod;
  monthlyExtra: number;
  oneTimeExtra: number;
}

function paydownScenarioKey(yearMonth: string): string {
  return `paydown_scenario_${yearMonth}`;
}

export async function savePaydownScenario(
  userId: string,
  yearMonth: string,
  scenario: SavedPaydownScenario,
): Promise<void> {
  await setSetting(userId, paydownScenarioKey(yearMonth), JSON.stringify(scenario));
}

export async function getSavedPaydownScenario(userId: string, yearMonth: string): Promise<SavedPaydownScenario | null> {
  const raw = await getSetting(userId, paydownScenarioKey(yearMonth));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedPaydownScenario>;
    if (
      (parsed.method === 'planned' || parsed.method === 'avalanche' || parsed.method === 'snowball') &&
      typeof parsed.monthlyExtra === 'number' &&
      Number.isFinite(parsed.monthlyExtra) &&
      parsed.monthlyExtra >= 0 &&
      typeof parsed.oneTimeExtra === 'number' &&
      Number.isFinite(parsed.oneTimeExtra) &&
      parsed.oneTimeExtra >= 0
    ) {
      return {
        method: parsed.method,
        monthlyExtra: parsed.monthlyExtra,
        oneTimeExtra: parsed.oneTimeExtra,
      };
    }
  } catch {
    // Ignore malformed legacy settings and fall back to an empty scenario.
  }
  return null;
}

export interface PaydownModalRow {
  accountId: string;
  accountName: string;
  type: 'credit' | 'loan';
  apr: number;
  planned: number;
  actual: number;
  remaining: number;
}

export interface PaydownModalData {
  rows: PaydownModalRow[];
  meta: { syncedAt: Date | null; rowCount: number };
}

/**
 * Read everything the Budget page's Pay down section needs in one call:
 *   - per-account planned from the month's `monthly_paydown` snapshot
 *     (Save to Budget). Falls back to live includeInPaydown accounts when
 *     no snapshot exists yet.
 *   - per-account actual = sum of transactions categorized under
 *     "Pay down goals" › {account name} for the month (any type).
 *   - snapshot metadata (syncedAt + rowCount) for the "Last synced" UI.
 *
 * Preferring the snapshot (not live include toggles) is intentional: once
 * the user saves a plan for the month, the Budget page keeps showing those
 * accounts even if they later toggle Include off on Pay down.
 */
export async function getPaydownModalData(userId: string, yearMonth: string): Promise<PaydownModalData> {
  const monthStart = `${yearMonth}-01`;
  const monthEnd = endOfMonth(yearMonth);
  const meta = await getPaydownSnapshotMeta(userId, yearMonth);

  const liabilityRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      alias: accounts.alias,
      type: accounts.type,
      balance: accounts.balance,
      interestRate: accounts.interestRate,
      plannedPayment: accounts.plannedPayment,
      minPayment: accounts.minPayment,
      includeInPaydown: accounts.includeInPaydown,
      hidden: accounts.hidden,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));

  const liabilityById = new Map(
    liabilityRows.filter((r) => (r.type === 'credit' || r.type === 'loan') && !r.hidden).map((r) => [r.id, r]),
  );

  const snapshotRows = await db
    .select()
    .from(monthlyPaydown)
    .where(and(eq(monthlyPaydown.userId, userId), eq(monthlyPaydown.yearMonth, yearMonth)));
  const snapshotByAccount = new Map(snapshotRows.map((r) => [r.accountId, r.planned]));

  // Prefer snapshotted accounts for the month. Fall back to currently
  // included liabilities when the user hasn't saved yet.
  let sourceAccounts = snapshotRows
    .map((s) => liabilityById.get(s.accountId))
    .filter((a): a is NonNullable<typeof a> => !!a);

  if (sourceAccounts.length === 0) {
    sourceAccounts = [...liabilityById.values()].filter((r) => r.includeInPaydown);
  }

  if (sourceAccounts.length === 0) {
    return {
      rows: [],
      meta: meta ? { syncedAt: meta.syncedAt, rowCount: meta.rowCount } : { syncedAt: null, rowCount: 0 },
    };
  }

  // Actuals come from transactions tagged "Pay down goals" › account name.
  // Payments usually post on the funding account (checking), so match by
  // subcategory name — not transactions.account.
  const actualByName = new Map<string, number>();
  const actualRows = await loadEffectiveLedgerAllocations(userId, monthStart, monthEnd);
  for (const row of actualRows) {
    if (row.category !== 'Pay down goals' || !row.subCategory) continue;
    actualByName.set(row.subCategory, (actualByName.get(row.subCategory) ?? 0) + row.amountCents);
  }

  const rows: PaydownModalRow[] = sourceAccounts.map((a) => {
    // Live zero balance always forces planned 0 so paid-off debts don't
    // consume left-to-budget; account plannedPayment is preserved for
    // when a balance returns.
    const planned =
      a.balance <= 0
        ? 0
        : (snapshotByAccount.get(a.id) ?? (a.plannedPayment > 0 ? Math.max(a.plannedPayment, a.minPayment) : a.minPayment));
    const actualCents = actualByName.get(a.name) ?? (a.alias ? actualByName.get(a.alias) : undefined) ?? 0;
    const actual = centsToDollars(actualCents);
    const remaining = centsToDollars(Math.round(planned * 100) - actualCents);
    return {
      accountId: a.id,
      accountName: a.alias ?? a.name,
      type: a.type === 'loan' ? 'loan' : 'credit',
      apr: a.interestRate,
      planned,
      actual,
      remaining,
    };
  });

  return {
    rows,
    meta: meta ? { syncedAt: meta.syncedAt, rowCount: meta.rowCount } : { syncedAt: null, rowCount: 0 },
  };
}

/**
 * Update planned payment from the Budget paydown section. Writes both
 * `accounts.planned_payment` (Paydown page source of truth) and the
 * month's `monthly_paydown` snapshot so both pages stay in sync.
 * Zero-balance accounts keep a live planned of 0 on read even if the
 * account default is updated here for when balance returns.
 */
export async function updatePaydownPlannedForMonth(
  userId: string,
  yearMonth: string,
  accountId: string,
  planned: number,
): Promise<boolean> {
  const [acct] = await db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .limit(1);
  if (!acct || (acct.type !== 'credit' && acct.type !== 'loan')) return false;

  const now = new Date();
  const rounded = Math.max(0, Math.round(planned * 100) / 100);

  await db.transaction(async (tx) => {
    await tx
      .update(accounts)
      .set({ plannedPayment: rounded })
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)));

    await tx
      .insert(monthlyPaydown)
      .values({
        userId,
        accountId,
        yearMonth,
        planned: rounded,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [monthlyPaydown.userId, monthlyPaydown.accountId, monthlyPaydown.yearMonth],
        set: { planned: rounded, updatedAt: now },
      });

    // Ensure snapshot meta exists so Budget treats this month as saved.
    const [meta] = await tx
      .select({ rowCount: monthlyPaydownSnapshots.rowCount })
      .from(monthlyPaydownSnapshots)
      .where(and(eq(monthlyPaydownSnapshots.userId, userId), eq(monthlyPaydownSnapshots.yearMonth, yearMonth)))
      .limit(1);
    if (!meta) {
      await tx.insert(monthlyPaydownSnapshots).values({
        userId,
        yearMonth,
        syncedAt: now,
        rowCount: 1,
      });
    } else {
      await tx
        .update(monthlyPaydownSnapshots)
        .set({ syncedAt: now })
        .where(and(eq(monthlyPaydownSnapshots.userId, userId), eq(monthlyPaydownSnapshots.yearMonth, yearMonth)));
    }
  });

  return true;
}

