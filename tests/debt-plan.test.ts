import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { categories } from '@/db/schema/categories';
import { monthlyBudgets } from '@/db/schema/monthly_budgets';
import { monthlyPaydown } from '@/db/schema/monthly_paydown';
import { subCategories } from '@/db/schema/sub_categories';
import { getSavedPaydownScenario, savePaydownScenario } from '@/db/queries';
import { saveDebtPlanToBudget } from '@/services/budget';
import { createTestAccount, createTestUser } from './helpers';

describe('save debt plan to budget', () => {
  test('keeps monthly payments, budget categories, and scenario settings in agreement', async () => {
    const userId = await createTestUser();
    const accountId = await createTestAccount(userId, {
      name: 'Rewards card', type: 'credit', balance: 1_000, minPayment: 100, interestRate: 0,
    });

    const saved = await saveDebtPlanToBudget(userId, {
      yearMonth: '2026-02', method: 'avalanche', monthlyExtra: 50, oneTimeExtra: 100,
    });
    expect(saved.rowCount).toBe(1);

    const [payment] = await db.select().from(monthlyPaydown).where(and(
      eq(monthlyPaydown.userId, userId), eq(monthlyPaydown.accountId, accountId), eq(monthlyPaydown.yearMonth, '2026-02'),
    ));
    expect(payment?.planned).toBe(250);

    const [category] = await db.select().from(categories).where(and(
      eq(categories.userId, userId), eq(categories.name, 'Pay down goals'),
    ));
    const [subcategory] = await db.select().from(subCategories).where(and(
      eq(subCategories.userId, userId), eq(subCategories.mainCategoryId, category!.id),
    ));
    const [budget] = await db.select().from(monthlyBudgets).where(and(
      eq(monthlyBudgets.userId, userId), eq(monthlyBudgets.subCategoryId, subcategory!.id),
      eq(monthlyBudgets.yearMonth, '2026-02'),
    ));
    expect(budget?.planned).toBe(250);
    expect(await getSavedPaydownScenario(userId, '2026-02')).toEqual({
      method: 'avalanche', monthlyExtra: 50, oneTimeExtra: 100,
    });
  });

  test('rolls back every write when a later budget-category step fails', async () => {
    const userId = await createTestUser();
    const accountId = await createTestAccount(userId, {
      name: 'Loan', type: 'loan', balance: 1_000, minPayment: 100, interestRate: 0,
    });
    await db.insert(monthlyPaydown).values({ userId, accountId, yearMonth: '2026-03', planned: 42 });
    await savePaydownScenario(userId, '2026-03', { method: 'planned', monthlyExtra: 0, oneTimeExtra: 0 });
    await db.insert(categories).values([
      { id: `duplicate-a-${userId}`, userId, name: 'Pay down goals', type: 'transfer' },
      { id: `duplicate-b-${userId}`, userId, name: ' pay down goals ', type: 'transfer' },
    ]);

    expect(saveDebtPlanToBudget(userId, {
      yearMonth: '2026-03', method: 'avalanche', monthlyExtra: 25, oneTimeExtra: 0,
    })).rejects.toMatchObject({ status: 409 });

    const [payment] = await db.select().from(monthlyPaydown).where(and(
      eq(monthlyPaydown.userId, userId), eq(monthlyPaydown.accountId, accountId), eq(monthlyPaydown.yearMonth, '2026-03'),
    ));
    expect(payment?.planned).toBe(42);
    expect(await getSavedPaydownScenario(userId, '2026-03')).toEqual({
      method: 'planned', monthlyExtra: 0, oneTimeExtra: 0,
    });
  });
});
