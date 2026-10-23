import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { monthlyBudgets } from '@/db/schema/monthly_budgets';
import { transactionSplits } from '@/db/schema/transaction_splits';
import { getDashboardActivity, listTransactions } from '@/db/queries';
import { applyBudgetToFutureMonths, setMonthlyBudget } from '@/services/budget';
import { createTestAccount, createTestCategory, createTestTransaction, createTestUser } from './helpers';

describe('ledger reads', () => {
  test('scopes tenants, resolves aliases, filters balance-only accounts, and paginates', async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const visible = await createTestAccount(userA, { alias: 'Everyday' });
    const hidden = await createTestAccount(userA, { name: 'Hidden', hidden: true });
    const investment = await createTestAccount(userA, { name: 'Brokerage', type: 'investment' });
    const other = await createTestAccount(userB, { name: 'Other' });

    const first = await createTestTransaction(userA, visible, { date: '2026-01-03', merchant: 'Third' });
    await createTestTransaction(userA, visible, { date: '2026-01-02', merchant: 'Second' });
    await createTestTransaction(userA, visible, { date: '2026-01-01', merchant: 'First' });
    await createTestTransaction(userA, hidden);
    await createTestTransaction(userA, investment);
    await createTestTransaction(userB, other);
    await db.insert(transactionSplits).values([
      {
        id: `split-${first}-1`, userId: userA, transactionId: first, amountCents: 600,
        category: 'Food', subCategory: 'Groceries', type: 'expense', sortOrder: 0,
      },
      {
        id: `split-${first}-2`, userId: userA, transactionId: first, amountCents: 400,
        category: 'Food', subCategory: 'Dining', type: 'expense', sortOrder: 1,
      },
    ]);

    const page = await listTransactions(userA, { limit: 2 });
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]?.id).toBe(first);
    expect(page.rows[0]?.account).toBe('Everyday');
    expect(page.rows[0]?.splits.map((split) => split.amountCents)).toEqual([600, 400]);

    const lastPage = await listTransactions(userA, { limit: 2, offset: 2 });
    expect(lastPage.rows).toHaveLength(1);
    expect((await listTransactions(userB)).total).toBe(1);
  });

  test('excludes transfers from dashboard income and expense totals', async () => {
    const userId = await createTestUser();
    const accountId = await createTestAccount(userId);
    await createTestTransaction(userId, accountId, { type: 'income', amountCents: 10_000 });
    await createTestTransaction(userId, accountId, { type: 'expense', amountCents: 4_000 });
    await createTestTransaction(userId, accountId, { type: 'transfer', amountCents: 2_000 });

    const activity = await getDashboardActivity(userId, new Date('2026-01-31T12:00:00Z'));
    expect(activity.income).toBe(100);
    expect(activity.expense).toBe(40);
    expect(activity.transferCount).toBe(1);
  });
});

describe('monthly budgets', () => {
  test('preserves later values and rejects stale apply-to-future revisions', async () => {
    const userId = await createTestUser();
    const { subCategoryId } = await createTestCategory(userId);
    const march = await setMonthlyBudget(userId, { subCategoryId, yearMonth: '2026-03', planned: 100 });

    const plannedFor = async (yearMonth: string) => {
      const [row] = await db.select().from(monthlyBudgets).where(and(
        eq(monthlyBudgets.userId, userId),
        eq(monthlyBudgets.subCategoryId, subCategoryId),
        eq(monthlyBudgets.yearMonth, yearMonth),
      ));
      return row?.planned;
    };

    expect(await plannedFor('2026-04')).toBe(25);
    await setMonthlyBudget(userId, { subCategoryId, yearMonth: '2026-04', planned: 80 });
    expect(await applyBudgetToFutureMonths(userId, { subCategoryId, yearMonth: '2026-03', revision: march.revision })).toBe(true);
    expect(await plannedFor('2026-04')).toBeUndefined();

    await setMonthlyBudget(userId, { subCategoryId, yearMonth: '2026-04', planned: 70 });
    const updatedMarch = await setMonthlyBudget(userId, { subCategoryId, yearMonth: '2026-03', planned: 120 });
    expect(await applyBudgetToFutureMonths(userId, { subCategoryId, yearMonth: '2026-03', revision: march.revision })).toBe(false);
    expect(await plannedFor('2026-04')).toBe(70);
    expect(await applyBudgetToFutureMonths(userId, { subCategoryId, yearMonth: '2026-03', revision: updatedMarch.revision })).toBe(true);
  });
});
