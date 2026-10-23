import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../client';
import { accounts } from '../schema/accounts';
import { categories } from '../schema/categories';
import { subCategories } from '../schema/sub_categories';
import { transactions } from '../schema/transactions';
import { transactionSplits } from '../schema/transaction_splits';
import { goals } from '../schema/goals';
import { monthlyPaydown } from '../schema/monthly_paydown';
import { rules } from '../schema/rules';
import type { Account, AccountSource, AccountType } from './types';

// ---- Accounts -----------------------------------------------------------

function accountSource(id: string): AccountSource {
  return id.startsWith('simplefin-') ? 'simplefin' : 'manual';
}

export async function getAllAccounts(userId: string, options?: { includeHidden?: boolean }): Promise<Account[]> {
  // Default hides hidden accounts — every consumer (dashboard, accounts
  // list, transactions filter, paydown) wants them out. The Accounts
  // page opts in with `includeHidden: true` to render a "Show hidden"
  // section so the user can un-hide.
  const where = options?.includeHidden
    ? eq(accounts.userId, userId)
    : and(eq(accounts.userId, userId), eq(accounts.hidden, false));
  const rows = await db.select().from(accounts).where(where).orderBy(asc(accounts.name));
  return rows.map((r) => ({
    id: r.id,
    source: accountSource(r.id),
    name: r.name,
    type: r.type,
    balance: Math.abs(r.balance),
    institution: r.institution ?? undefined,
    interestRate: r.interestRate,
    minPayment: r.minPayment,
    plannedPayment: r.plannedPayment,
    includeInPaydown: r.includeInPaydown,
    hidden: r.hidden,
    alias: r.alias ?? undefined,
  }));
}

/**
 * Fetch a single account by id, scoped to the user. Returns null if the
 * row doesn't exist (or belongs to a different user). Used by PATCH
 * handlers that need to know the existing type/balance before applying
 * a patch (e.g. the credit/loan min-payment validation in the accounts
 * and paydown routes).
 */
export async function getAccount(userId: string, id: string): Promise<Account | null> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    source: accountSource(row.id),
    name: row.name,
    type: row.type,
    balance: Math.abs(row.balance),
    institution: row.institution ?? undefined,
    interestRate: row.interestRate,
    minPayment: row.minPayment,
    plannedPayment: row.plannedPayment,
    includeInPaydown: row.includeInPaydown,
    hidden: row.hidden,
    alias: row.alias ?? undefined,
  };
}

export async function addAccount(userId: string, acc: Omit<Account, 'id' | 'source'>): Promise<Account> {
  const id = `acc-${nanoid(10)}`;
  await db.insert(accounts).values({
    id,
    userId,
    name: acc.name,
    type: acc.type,
    balance: Math.abs(acc.balance),
    institution: acc.institution ?? null,
    interestRate: acc.interestRate,
    minPayment: acc.minPayment,
    plannedPayment: acc.plannedPayment,
    includeInPaydown: acc.includeInPaydown,
    hidden: acc.hidden,
  });
  return { ...acc, id, source: 'manual', balance: Math.abs(acc.balance) };
}

export async function editAccount(userId: string, id: string, patch: Partial<Account>): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
      .limit(1);
    if (!existing) return;
    const nextType = (patch.type ?? existing.type) as AccountType;
    const nextName = patch.name ?? existing.name;
    await tx
      .update(accounts)
      .set({
        name: nextName,
        type: nextType,
        balance: Math.abs(patch.balance ?? existing.balance),
        institution: patch.institution !== undefined ? (patch.institution ?? null) : existing.institution,
        interestRate: patch.interestRate ?? existing.interestRate,
        minPayment: patch.minPayment ?? existing.minPayment,
        plannedPayment: patch.plannedPayment ?? existing.plannedPayment,
        includeInPaydown: patch.includeInPaydown ?? existing.includeInPaydown,
        hidden: patch.hidden ?? existing.hidden,
        // `alias` uses the explicit `undefined` check (same shape as
        // `institution`) so a missing field is a no-op. `null` or an
        // empty string both clear the alias back to NULL. The UI sends
        // "" when the user blanks the input; the schema also accepts
        // `null` for callers that prefer to be explicit.
        alias:
          patch.alias === undefined ? existing.alias : patch.alias === null || patch.alias === '' ? null : patch.alias,
      })
      .where(and(eq(accounts.userId, userId), eq(accounts.id, id)));
    if (nextName !== existing.name) {
      const [paydownCategory] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.userId, userId), eq(categories.name, 'Pay down goals')))
        .limit(1);
      if (paydownCategory) {
        const paydownSubs = await tx
          .select({ id: subCategories.id })
          .from(subCategories)
          .where(and(
            eq(subCategories.userId, userId),
            eq(subCategories.mainCategoryId, paydownCategory.id),
            eq(subCategories.name, existing.name),
          ))
          .limit(2);
        const paydownSubId = paydownSubs.length === 1 ? paydownSubs[0]!.id : null;
        if (paydownSubId) {
          await tx
            .update(subCategories)
            .set({ name: nextName })
            .where(and(eq(subCategories.userId, userId), eq(subCategories.id, paydownSubId)));
          await tx
            .update(transactions)
            .set({ subCategory: nextName })
            .where(and(eq(transactions.userId, userId), eq(transactions.subCategoryId, paydownSubId)));
          await tx
            .update(transactionSplits)
            .set({ subCategory: nextName })
            .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.subCategoryId, paydownSubId)));
          await tx
            .update(rules)
            .set({ subCategory: nextName, updatedAt: new Date(), version: sql`${rules.version} + 1` })
            .where(and(eq(rules.userId, userId), eq(rules.subCategoryId, paydownSubId)));
        }
      }
    }
    if (nextType === 'investment') {
      // Only imported activity is cleanup-owned. Manual entries are never
      // removed merely because an account was reclassified or renamed.
      await tx
        .delete(transactions)
        .where(
          and(eq(transactions.userId, userId), eq(transactions.accountId, id), isNotNull(transactions.externalId)),
        );
    }
  });
}

/**
 * Patch just the pay-down fields for an account. Used by the paydown
 * calculator panel — keeps the patch shape focused so the route doesn't
 * have to accept every Account field.
 */
export async function editAccountPaydown(
  userId: string,
  id: string,
  patch: {
    interestRate?: number;
    minPayment?: number;
    plannedPayment?: number;
    includeInPaydown?: boolean;
  },
): Promise<void> {
  const [existing] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
    .limit(1);
  if (!existing) return;
  await db
    .update(accounts)
    .set({
      interestRate: patch.interestRate ?? existing.interestRate,
      minPayment: patch.minPayment ?? existing.minPayment,
      plannedPayment: patch.plannedPayment ?? existing.plannedPayment,
      includeInPaydown: patch.includeInPaydown ?? existing.includeInPaydown,
    })
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)));
}

/** All liability accounts (credit + loan), regardless of includeInPaydown. */
export async function getLiabilityAccounts(userId: string): Promise<Account[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        // IN ('credit', 'loan') via two or-chains. Drizzle's `inArray`
        // works too but we keep this portable.
        // We do the filter in JS to keep the query simple.
      ),
    )
    .orderBy(asc(accounts.name));
  return rows
    .filter((r) => (r.type === 'credit' || r.type === 'loan') && !r.hidden)
    .map((r) => ({
      id: r.id,
      source: accountSource(r.id),
      name: r.name,
      type: r.type,
      balance: Math.abs(r.balance),
      institution: r.institution ?? undefined,
      interestRate: r.interestRate,
      minPayment: r.minPayment,
      plannedPayment: r.plannedPayment,
      includeInPaydown: r.includeInPaydown,
      hidden: r.hidden,
      alias: r.alias ?? undefined,
    }));
}

export async function deleteAccount(
  userId: string,
  id: string,
): Promise<'deleted' | 'not_found' | 'simplefin_forbidden'> {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
      .limit(1);
    if (!account) return 'not_found';
    if (accountSource(account.id) === 'simplefin') return 'simplefin_forbidden';

    const [paydownCategory] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.name, 'Pay down goals')))
      .limit(1);
    if (paydownCategory) {
      const paydownSubs = await tx
        .select({ id: subCategories.id })
        .from(subCategories)
        .where(and(
          eq(subCategories.userId, userId),
          eq(subCategories.mainCategoryId, paydownCategory.id),
          eq(subCategories.name, account.name),
        ))
        .limit(2);
      if (paydownSubs.length === 1) {
        const subCategoryId = paydownSubs[0]!.id;
        await tx.update(transactions).set({ subCategoryId: null }).where(and(eq(transactions.userId, userId), eq(transactions.subCategoryId, subCategoryId)));
        await tx.update(transactionSplits).set({ subCategoryId: null }).where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.subCategoryId, subCategoryId)));
        await tx.delete(rules).where(and(eq(rules.userId, userId), eq(rules.subCategoryId, subCategoryId)));
        await tx.delete(subCategories).where(and(eq(subCategories.userId, userId), eq(subCategories.id, subCategoryId)));
      }
    }
    await tx
      .update(goals)
      .set({ accountId: null })
      .where(and(eq(goals.userId, userId), eq(goals.accountId, id)));
    await tx.delete(monthlyPaydown).where(and(eq(monthlyPaydown.userId, userId), eq(monthlyPaydown.accountId, id)));
    await tx.delete(accounts).where(and(eq(accounts.userId, userId), eq(accounts.id, id)));
    return 'deleted';
  });
}

/**
 * Toggle the `hidden` flag for one account. Hidden accounts are excluded from
 * financial views and SimpleFIN sync, but remain available to the Accounts
 * page when it explicitly requests hidden rows so the user can unhide them.
 */
export async function setAccountHidden(userId: string, id: string, hidden: boolean): Promise<void> {
  await db
    .update(accounts)
    .set({ hidden })
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)));
}

export async function upsertAccount(
  userId: string,
  acc: {
    id: string;
    name: string;
    type: AccountType;
    balance: number;
    institution?: string;
  },
): Promise<Account> {
  // Insert uses the inferred type once. On conflict we only refresh
  // name/balance/institution — type, alias, hidden, and paydown fields
  // are user-owned overrides and must survive every SimpleFIN re-sync.
  await db
    .insert(accounts)
    .values({
      id: acc.id,
      userId,
      name: acc.name,
      type: acc.type,
      balance: Math.abs(acc.balance),
      institution: acc.institution ?? null,
      interestRate: 0,
      minPayment: 0,
      plannedPayment: 0,
      includeInPaydown: true,
      // Newly created SimpleFIN accounts are always visible. The sync
      // helper skips the upsert when the row already exists with
      // hidden=true (see `syncSimpleFinToDatabase`), so the user's hide
      // choice survives subsequent syncs.
      hidden: false,
    })
    .onConflictDoUpdate({
      target: accounts.id,
      set: {
        name: acc.name,
        balance: Math.abs(acc.balance),
        institution: acc.institution ?? null,
      },
    });
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, acc.id)))
    .limit(1);
  const effectiveType = (row?.type as AccountType) ?? acc.type;
  const effectiveBalance = Math.abs(row?.balance ?? acc.balance);
  return {
    id: acc.id,
    source: accountSource(acc.id),
    name: row?.name ?? acc.name,
    type: effectiveType,
    balance: effectiveBalance,
    institution: row?.institution ?? acc.institution,
    interestRate: row?.interestRate ?? 0,
    minPayment: row?.minPayment ?? 0,
    plannedPayment: row?.plannedPayment ?? 0,
    includeInPaydown: row?.includeInPaydown ?? true,
    hidden: row?.hidden ?? false,
    alias: row?.alias ?? undefined,
  };
}

