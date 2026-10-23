import { randomUUID } from 'node:crypto';
import { db } from '@/db/client';
import { user } from '@/db/schema/auth';
import { accounts, type AccountRow } from '@/db/schema/accounts';
import { categories } from '@/db/schema/categories';
import { subCategories } from '@/db/schema/sub_categories';
import { transactions, type TransactionRow } from '@/db/schema/transactions';

export async function createTestUser(role: 'admin' | 'user' = 'user'): Promise<string> {
  const id = `user-${randomUUID()}`;
  const now = new Date();
  await db.insert(user).values({
    id,
    name: `Test ${id}`,
    email: `${id}@example.test`,
    emailVerified: true,
    role,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function createTestAccount(
  userId: string,
  overrides: Partial<Omit<AccountRow, 'id' | 'userId' | 'createdAt'>> = {},
): Promise<string> {
  const id = `acc-${randomUUID()}`;
  await db.insert(accounts).values({
    ...overrides,
    id,
    userId,
    name: overrides.name ?? 'Checking',
    type: overrides.type ?? 'checking',
    balance: overrides.balance ?? 1_000,
  });
  return id;
}

export async function createTestCategory(userId: string, type: 'income' | 'expense' | 'transfer' = 'expense') {
  const suffix = randomUUID();
  const categoryId = `cat-${suffix}`;
  const subCategoryId = `sub-${suffix}`;
  await db.insert(categories).values({ id: categoryId, userId, name: 'Food', type });
  await db.insert(subCategories).values({
    id: subCategoryId,
    userId,
    mainCategoryId: categoryId,
    name: 'Groceries',
    planned: 25,
  });
  return { categoryId, subCategoryId };
}

export async function createTestTransaction(
  userId: string,
  accountId: string,
  overrides: Partial<Omit<TransactionRow, 'id' | 'userId' | 'accountId' | 'createdAt'>> = {},
): Promise<string> {
  const id = `tx-${randomUUID()}`;
  await db.insert(transactions).values({
    ...overrides,
    id,
    userId,
    accountId,
    date: overrides.date ?? '2026-01-15',
    merchant: overrides.merchant ?? 'Market',
    sourceCategory: overrides.sourceCategory ?? overrides.category ?? 'Food',
    sourceSubCategory: overrides.sourceSubCategory ?? overrides.subCategory ?? 'Groceries',
    sourceType: overrides.sourceType ?? overrides.type ?? 'expense',
    category: overrides.category ?? 'Food',
    subCategory: overrides.subCategory ?? 'Groceries',
    account: overrides.account ?? 'Checking',
    amountCents: overrides.amountCents ?? 1_000,
    type: overrides.type ?? 'expense',
  });
  return id;
}
