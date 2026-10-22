/**
 * Budget page writes shared by the REST routes and the MCP server, so an
 * agent changing a budget goes through exactly the same rules as the UI.
 *
 *   - `setMonthlyBudget`        → one sub-category's planned amount for a
 *                                 month (later months keep their value).
 *   - `applyBudgetToFutureMonths` → the "Apply to future months" follow-up,
 *                                 guarded by the revision the save returned.
 *   - `setPlannedDebtPayment`   → a Pay down row on the Budget page.
 *   - `saveDebtPlanToBudget`    → Pay down page "Save to Budget".
 */
import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { monthlyBudgets } from '@/db/schema/monthly_budgets';
import { subCategories } from '@/db/schema/sub_categories';
import {
  getAccount,
  getLiabilityAccounts,
  getPaydownModalData,
  savePaydownScenario,
  subCategoryExists,
  syncMonthlyPaydownWithScenario,
  syncPaydownCategories,
  updatePaydownPlannedForMonth,
  type PaydownModalData,
} from '@/db/queries';
import type { PaydownMethod } from '@/lib/paydown';

function nextMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month!, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function badInput(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Set the planned amount for one month. The month after keeps the value it
 * had before, so a one-month edit never leaks forward; returns the row's
 * revision for `applyBudgetToFutureMonths`.
 */
export async function setMonthlyBudget(
  userId: string,
  input: { subCategoryId: string; yearMonth: string; planned: number },
): Promise<{ revision: string }> {
  const { subCategoryId, yearMonth, planned } = input;
  if (!(await subCategoryExists(userId, subCategoryId))) {
    throw badInput('subCategoryId must belong to the current user');
  }
  const saved = await db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ planned: monthlyBudgets.planned })
      .from(monthlyBudgets)
      .where(and(
        eq(monthlyBudgets.userId, userId),
        eq(monthlyBudgets.subCategoryId, subCategoryId),
        lte(monthlyBudgets.yearMonth, yearMonth),
      ))
      .orderBy(desc(monthlyBudgets.yearMonth))
      .limit(1);
    const [subcategory] = await tx
      .select({ planned: subCategories.planned })
      .from(subCategories)
      .where(and(eq(subCategories.userId, userId), eq(subCategories.id, subCategoryId)))
      .limit(1);
    const priorEffective = previous?.planned ?? subcategory?.planned ?? 0;

    await tx
      .insert(monthlyBudgets)
      .values({ userId, subCategoryId, yearMonth, planned, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [monthlyBudgets.userId, monthlyBudgets.subCategoryId, monthlyBudgets.yearMonth],
        set: { planned, updatedAt: new Date() },
      });

    // Preserve the value future months had before this one-month edit.
    await tx
      .insert(monthlyBudgets)
      .values({ userId, subCategoryId, yearMonth: nextMonth(yearMonth), planned: priorEffective, updatedAt: new Date() })
      .onConflictDoNothing();

    const [row] = await tx
      .select({ revision: monthlyBudgets.revision })
      .from(monthlyBudgets)
      .where(and(
        eq(monthlyBudgets.userId, userId),
        eq(monthlyBudgets.subCategoryId, subCategoryId),
        eq(monthlyBudgets.yearMonth, yearMonth),
      ))
      .limit(1);
    return row;
  });
  return { revision: saved?.revision ?? '' };
}

/**
 * Carry a month's amount forward by removing later overrides. Returns false
 * when the month changed since `revision` was issued.
 */
export async function applyBudgetToFutureMonths(
  userId: string,
  input: { subCategoryId: string; yearMonth: string; revision: string },
): Promise<boolean> {
  const { subCategoryId, yearMonth, revision } = input;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ revision: monthlyBudgets.revision })
      .from(monthlyBudgets)
      .where(and(
        eq(monthlyBudgets.userId, userId),
        eq(monthlyBudgets.subCategoryId, subCategoryId),
        eq(monthlyBudgets.yearMonth, yearMonth),
      ))
      .limit(1);
    if (!current || current.revision !== revision) return false;
    await tx.delete(monthlyBudgets).where(and(
      eq(monthlyBudgets.userId, userId),
      eq(monthlyBudgets.subCategoryId, subCategoryId),
      gt(monthlyBudgets.yearMonth, yearMonth),
    ));
    return true;
  });
}

/**
 * Edit a debt's planned payment for a month from the Budget page. The Pay
 * down projection never pays less than the minimum, so Budget must not plan
 * less either — unless the balance itself is smaller, which is what Save to
 * Budget plans for a nearly paid-off debt.
 */
export async function setPlannedDebtPayment(
  userId: string,
  input: { accountId: string; yearMonth: string; planned: number },
): Promise<void> {
  const existing = await getAccount(userId, input.accountId);
  const floor = existing ? Math.min(existing.minPayment, existing.balance) : 0;
  if (existing && existing.balance > 0 && input.planned < floor) {
    const what = floor < existing.minPayment ? 'the balance owed' : 'the minimum payment';
    throw badInput(`Planned payment must be at least ${floor.toFixed(2)} (${what})`);
  }
  const ok = await updatePaydownPlannedForMonth(userId, input.yearMonth, input.accountId, input.planned);
  if (!ok) throw badInput('account not found or not a liability');
}

export interface SavedDebtPlan {
  rowCount: number;
  syncedAt: Date;
  scenario: { method: PaydownMethod; monthlyExtra: number; oneTimeExtra: number };
  snapshot: PaydownModalData;
}

/**
 * Pay down "Save to Budget". Avalanche/Snowball allocate extras to the
 * priority account, capped at its remaining balance. Planned normalizes
 * extras to zero.
 */
export async function saveDebtPlanToBudget(
  userId: string,
  input: { yearMonth: string; method: PaydownMethod; monthlyExtra: number; oneTimeExtra: number },
): Promise<SavedDebtPlan> {
  const { yearMonth, method } = input;
  const liabilityAccounts = await getLiabilityAccounts(userId);
  const included = liabilityAccounts.filter(
    (account) => account.includeInPaydown && (account.type === 'credit' || account.type === 'loan'),
  );
  const accountById = new Map(included.map((a) => [a.id, a]));

  // Planned payments intentionally ignore calculator extras. Normalize
  // them here so the saved scenario always matches the Budget result.
  const monthlyExtra = method === 'planned' ? 0 : input.monthlyExtra;
  const oneTimeExtra = method === 'planned' ? 0 : input.oneTimeExtra;
  const result = await syncMonthlyPaydownWithScenario(userId, yearMonth, method, monthlyExtra, oneTimeExtra);
  const plannedByName: Record<string, number> = {};
  for (const row of result.allocation) {
    const acct = accountById.get(row.accountId);
    if (acct) plannedByName[acct.name] = row.planned;
  }
  await syncPaydownCategories(userId, Object.keys(plannedByName), { yearMonth, plannedByName });
  await savePaydownScenario(userId, yearMonth, { method, monthlyExtra, oneTimeExtra });
  return {
    rowCount: result.rowCount,
    syncedAt: result.syncedAt,
    scenario: { method, monthlyExtra, oneTimeExtra },
    snapshot: await getPaydownModalData(userId, yearMonth),
  };
}
