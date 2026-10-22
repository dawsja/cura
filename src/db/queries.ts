/**
 * Data layer. Every function takes `userId` as the first argument and
 * filters by `user_id` on every read/write. The guard middleware on the
 * root app puts an authenticated user on the Hono context; routes call
 * `userId(c)` from `@/lib/tenant` and pass it in.
 *
 * Functions are organized by resource: accounts, categories, sub-categories,
 * transactions, goals, monthly_budgets, settings.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, sqlAll } from './client';
import { accounts } from './schema/accounts';
import { categories } from './schema/categories';
import { subCategories } from './schema/sub_categories';
import { transactions } from './schema/transactions';
import { transactionSplits } from './schema/transaction_splits';
import { simpleFinTransactionAliases } from './schema/simplefin_transaction_aliases';
import { simpleFinIgnoredTransactions } from './schema/simplefin_ignored_transactions';
import { monthlyBudgets } from './schema/monthly_budgets';
import { settings } from './schema/settings';
import { goals } from './schema/goals';
import { monthlyPaydown, monthlyPaydownSnapshots } from './schema/monthly_paydown';
import { rules } from './schema/rules';
import { account as authAccount, user as authUser } from './schema/auth';
import { oidcProviders } from './schema/oidc_providers';
import { setupState } from './schema/setup_state';
import { INITIAL_CATEGORIES } from './seed';
import { firstMonthPaydownPayments, type PaydownAccount, type PaydownMethod } from '@/lib/paydown';
import {
  normalizeMerchant,
  pickBestRuleMatch,
} from '@/lib/merchant-match';
import { centsToDollars, dollarsToCents } from '@/lib/money';
import { latestBudgetsUpTo } from './budget-repository';

// ---- Shared types ---------------------------------------------------------
export type AccountType = 'checking' | 'savings' | 'credit' | 'investment' | 'loan' | 'uncategorized';
export type AccountSource = 'manual' | 'simplefin';
// `transfer` covers credit card payments, account-to-account moves, and
// any other transaction where money moves between two of the user's own
// accounts. Transfers are excluded from income/expense totals because
// they don't change net worth — they just reallocate it.
export type TransactionType = 'income' | 'expense' | 'transfer';

export interface Account {
  id: string;
  source: AccountSource;
  name: string;
  type: AccountType;
  balance: number;
  institution?: string;
  // Pay-down fields — only meaningful for credit/loan accounts but live
  // on every account for simplicity.
  interestRate: number;
  minPayment: number;
  plannedPayment: number;
  includeInPaydown: boolean;
  // `hidden` removes the account from financial read views and pauses
  // SimpleFIN sync for that account. It survives sync because the sync
  // helper checks the existing row before writing.
  hidden: boolean;
  // User-set display alias. NULL means "use the canonical name". Never
  // touched by SimpleFIN sync, so the user's chosen name persists
  // across every re-sync. Resolved at read time in the Transactions
  // page so renaming flows through to historical transactions.
  alias?: string | null;
}
export interface SubCategory {
  id: string;
  name: string;
  planned: number;
  icon?: string;
}
export interface MainCategory {
  id: string;
  name: string;
  type: TransactionType;
  icon?: string;
  sortOrder: number;
  subCategories: SubCategory[];
}
export interface Transaction {
  id: string;
  date: string;
  merchant: string;
  sourceCategory: string;
  sourceSubCategory?: string;
  sourceType: TransactionType;
  sourceClassificationTrusted: boolean;
  category: string;
  subCategory?: string;
  categoryId?: string;
  subCategoryId?: string;
  account: string;
  accountId?: string;
  amount: number;
  type: TransactionType;
  notes?: string;
  splits: TransactionSplit[];
}
export interface TransactionSplit {
  id: string;
  amount: number;
  amountCents: number;
  category: string;
  subCategory: string;
  categoryId?: string;
  subCategoryId?: string;
  type: TransactionType;
  sortOrder: number;
}

export interface DashboardActivity {
  income: number;
  expense: number;
  transferCount: number;
  recent: Array<Pick<Transaction, 'id' | 'date' | 'merchant' | 'category' | 'subCategory' | 'account' | 'amount' | 'type'>>;
}

export interface BudgetActivityRow {
  category: string;
  subCategory: string;
  type: 'income' | 'expense';
  actual: number;
  transactions: Array<{
    id: string;
    date: string;
    merchant: string;
    account: string;
    amount: number;
    hasSplits: boolean;
    parentAmount: number;
  }>;
}

// ---- First-time user seeding ---------------------------------------------

export async function seedInitialCategoriesIfEmpty(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Defaults are a one-time onboarding action. The marker preserves user
    // deletions; missing default IDs must never be interpreted as corruption.
    const [seeded] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.userId, userId), eq(settings.key, 'initial_categories_seeded')))
      .limit(1);
    const existing = await tx
      .select({
        id: categories.id,
        name: categories.name,
        type: categories.type,
        icon: categories.icon,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .where(eq(categories.userId, userId));

    // The startup transfer backfill used to run before a new user's first
    // category read. That left exactly one canonical Transfer row, which the
    // old seeder mistook for a customized tree and marked complete. Repair only
    // that narrow signature; all other seeded/customized trees stay untouched.
    const [onlyCategory] = existing;
    const transferOnlyBootstrap = existing.length === 1
      && onlyCategory?.id === `${userId}__cat-transfer`
      && onlyCategory.name === 'Transfer'
      && onlyCategory.type === 'transfer'
      && onlyCategory.icon === 'ArrowLeftRight'
      && onlyCategory.sortOrder === 9999;
    if (seeded && !transferOnlyBootstrap) return;

    // Existing users predate the marker. Preserve their current tree exactly,
    // including categories they intentionally removed, and mark it complete.
    if (existing.length > 0 && !transferOnlyBootstrap) {
      await tx
        .insert(settings)
        .values({ userId, key: 'initial_categories_seeded', value: 'v2', updatedAt: new Date() })
        .onConflictDoNothing();
      return;
    }

    for (const cat of INITIAL_CATEGORIES) {
      // The seed-time IDs in `INITIAL_CATEGORIES` (e.g. "cat-income") are
      // stable for documentation but not unique across users — they collide on
      // the global primary key. Prefix with a per-user token so each user gets
      // a private copy of the default tree.
      const mainId = `${userId}__${cat.id}`;
      await tx
        .insert(categories)
        .values({
          id: mainId,
          userId,
          name: cat.name,
          type: cat.type,
        })
        .onConflictDoNothing();
      if (cat.subCategories.length > 0) {
        await tx
          .insert(subCategories)
          .values(
            cat.subCategories.map((sub) => ({
              id: `${userId}__${sub.id}`,
              userId,
              mainCategoryId: mainId,
              name: sub.name,
              planned: sub.planned,
            })),
          )
          .onConflictDoNothing();
      }
    }
    await tx
      .insert(settings)
      .values({ userId, key: 'initial_categories_seeded', value: 'v2', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [settings.userId, settings.key],
        set: { value: 'v2', updatedAt: new Date() },
      });
  });
}

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

/** Delete only imported ledger activity for one immutable account identity. */
export async function deleteImportedTransactionsForAccount(userId: string, accountId: string): Promise<number> {
  const result = await db
    .delete(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        isNotNull(transactions.externalId),
      ),
    )
    .returning({ id: transactions.id });
  return result.length;
}

/** Recover an account identity from transactions that SimpleFIN has already imported. */
export async function findSimpleFinAccountIdByExternalIds(
  userId: string,
  externalIds: string[],
): Promise<string | null> {
  if (externalIds.length === 0) return null;
  const rows = await db
    .selectDistinct({ accountId: transactions.accountId })
    .from(transactions)
    .where(and(
      eq(transactions.userId, userId),
      inArray(transactions.externalId, externalIds),
      isNotNull(transactions.accountId),
    ))
    .limit(2);
  return rows.length === 1 ? rows[0]!.accountId : null;
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

// ---- Categories + Sub-categories ----------------------------------------

export async function getAllCategories(userId: string): Promise<MainCategory[]> {
  await seedInitialCategoriesIfEmpty(userId);
  const [mainRows, subRows] = await Promise.all([
    // Stable order: user-defined `sortOrder` first (drag-to-reorder),
    // then `name` as a tiebreaker. Both Budget and the Categories page
    // render this list in the same order.
    db
      .select()
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
    // Sub-categories keep the order they were created in (the import from
    // Postgres inserted them in the order Postgres listed them).
    db.select().from(subCategories).where(eq(subCategories.userId, userId)).orderBy(sql`rowid`),
  ]);
  const subMap = new Map<string, SubCategory[]>();
  for (const s of subRows) {
    const list = subMap.get(s.mainCategoryId) ?? [];
    list.push({
      id: s.id,
      name: s.name,
      planned: s.planned,
      icon: s.icon ?? undefined,
    });
    subMap.set(s.mainCategoryId, list);
  }
  return mainRows.map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    icon: m.icon ?? undefined,
    sortOrder: m.sortOrder,
    subCategories: subMap.get(m.id) ?? [],
  }));
}

interface ResolvedCategoryAssignment {
  categoryId: string;
  subCategoryId: string;
  category: string;
  subCategory: string;
  type: TransactionType;
}

function uniqueAssignmentsByName<T extends { category: string; subCategory: string }>(rows: T[]): Map<string, T> {
  const unique = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = `${row.category}\0${row.subCategory}`;
    if (duplicates.has(key)) continue;
    if (unique.has(key)) {
      unique.delete(key);
      duplicates.add(key);
    } else {
      unique.set(key, row);
    }
  }
  return unique;
}

async function resolveCategoryAssignment(
  userId: string,
  category: string,
  subCategory: string,
): Promise<ResolvedCategoryAssignment | null> {
  const rows = await db
    .select({
      categoryId: categories.id,
      subCategoryId: subCategories.id,
      category: categories.name,
      subCategory: subCategories.name,
      type: categories.type,
    })
    .from(subCategories)
    .innerJoin(categories, and(eq(categories.id, subCategories.mainCategoryId), eq(categories.userId, subCategories.userId)))
    .where(and(
      eq(categories.userId, userId),
      eq(categories.name, category),
      eq(subCategories.userId, userId),
      eq(subCategories.name, subCategory),
    ))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** True when a leaf sub-category belongs to the named main category. */
export async function categoryAssignmentExists(
  userId: string,
  category: string,
  subCategory: string,
): Promise<boolean> {
  return await resolveCategoryAssignment(userId, category, subCategory) !== null;
}

/** Validate a leaf plus transaction type, with Pay down goals intentionally type-agnostic. */
export async function transactionAssignmentExists(
  userId: string,
  category: string,
  subCategory: string,
  type: TransactionType,
): Promise<boolean> {
  const assignment = await resolveCategoryAssignment(userId, category, subCategory);
  return assignment !== null && (assignment.type === type || category === 'Pay down goals');
}

export async function mainCategoryExists(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .limit(1);
  return rows.length === 1;
}

export async function subCategoryExists(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: subCategories.id })
    .from(subCategories)
    .where(and(eq(subCategories.userId, userId), eq(subCategories.id, id)))
    .limit(1);
  return rows.length === 1;
}

/**
 * Case-insensitive name match for duplicate checks. Done in JS because
 * SQLite's lower() only folds ASCII letters.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function addMainCategory(
  userId: string,
  name: string,
  type: TransactionType,
  icon = 'Folder',
): Promise<MainCategory> {
  if (name.trim().toLowerCase() === 'pay down goals') {
    throw Object.assign(new Error('Pay down goals is managed from the Pay down page'), { status: 400 });
  }
  return db.transaction(async (tx) => {
    const siblings = await tx.select({ name: categories.name }).from(categories).where(eq(categories.userId, userId));
    if (siblings.some((sibling) => sameName(sibling.name, name))) throw Object.assign(new Error('A category with this name already exists'), { status: 409 });
    const id = `cat-${nanoid(10)}`;
    const [top] = await tx
      .select({ sortOrder: categories.sortOrder })
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(sql`${categories.sortOrder} DESC`)
      .limit(1);
    const nextOrder = (top?.sortOrder ?? -1) + 1;
    await tx.insert(categories).values({ id, userId, name, type, icon, sortOrder: nextOrder });
    return { id, name, type, icon, sortOrder: nextOrder, subCategories: [] };
  });
}

export async function editMainCategory(userId: string, id: string, name: string): Promise<void> {
  if (name.trim().toLowerCase() === 'pay down goals') {
    throw Object.assign(new Error('Pay down goals is managed from the Pay down page'), { status: 400 });
  }
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ name: categories.name })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id)))
      .limit(1);
    if (!existing || existing.name === name) return;
    if (existing.name === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goals is managed from the Pay down page'), { status: 400 });
    }
    const siblings = await tx.select({ name: categories.name }).from(categories).where(and(
      eq(categories.userId, userId),
      sql`${categories.id} <> ${id}`,
    ));
    if (siblings.some((sibling) => sameName(sibling.name, name))) throw Object.assign(new Error('A category with this name already exists'), { status: 409 });

    await tx
      .update(categories)
      .set({ name })
      .where(and(eq(categories.userId, userId), eq(categories.id, id)));
    await tx
      .update(transactions)
      .set({ category: name })
      .where(and(eq(transactions.userId, userId), eq(transactions.categoryId, id)));
    await tx
      .update(transactionSplits)
      .set({ category: name })
      .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.categoryId, id)));
    await tx
      .update(rules)
      .set({ category: name, updatedAt: new Date(), version: sql`${rules.version} + 1` })
      .where(and(eq(rules.userId, userId), eq(rules.categoryId, id)));
  });
}

export async function deleteMainCategory(userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [category] = await tx
      .select({ name: categories.name })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id)))
      .limit(1);
    if (!category) return;
    if (category.name === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goals is managed from the Pay down page'), { status: 400 });
    }
    await tx.update(transactions).set({ categoryId: null, subCategoryId: null }).where(and(eq(transactions.userId, userId), eq(transactions.categoryId, id)));
    await tx.update(transactionSplits).set({ categoryId: null, subCategoryId: null }).where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.categoryId, id)));
    await tx
      .delete(rules)
      .where(
        and(
          eq(rules.userId, userId),
          eq(rules.categoryId, id),
        ),
      );
    await tx.delete(categories).where(and(eq(categories.userId, userId), eq(categories.id, id)));
  });
}

/**
 * Persist a new user-defined ordering for the user's main categories.
 * `orderedIds[0]` becomes sortOrder 0, `orderedIds[1]` becomes 1, etc.
 * Categories not in the list keep their existing order (we only touch
 * the ones the user moved, so a partial reorder is safe).
 *
 * We use one UPDATE per id rather than a CASE expression to keep the
 * SQL portable and the per-row order obvious in pg logs.
 */
export async function reorderMainCategories(userId: string, orderedIds: string[]): Promise<void> {
  // De-dupe + drop ids that don't belong to this user. The route layer
  // is the source of truth for membership; this is defense in depth.
  const unique = Array.from(new Set(orderedIds));
  for (let i = 0; i < unique.length; i++) {
    await db
      .update(categories)
      .set({ sortOrder: i })
      .where(and(eq(categories.userId, userId), eq(categories.id, unique[i]!)));
  }
}

export async function addSubCategory(
  userId: string,
  mainCategoryId: string,
  name: string,
  planned: number,
): Promise<SubCategory> {
  return db.transaction(async (tx) => {
    const parent = await tx.select({ id: categories.id, name: categories.name }).from(categories).where(and(
      eq(categories.userId, userId),
      eq(categories.id, mainCategoryId),
    )).limit(1);
    if (parent.length !== 1) throw new Error('Main category not found');
    if (parent[0]!.name === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goal categories follow their account names'), { status: 400 });
    }
    const siblings = await tx.select({ name: subCategories.name }).from(subCategories).where(and(
      eq(subCategories.userId, userId),
      eq(subCategories.mainCategoryId, mainCategoryId),
    ));
    if (siblings.some((sibling) => sameName(sibling.name, name))) throw Object.assign(new Error('A sub-category with this name already exists'), { status: 409 });
    const id = `sub-${nanoid(10)}`;
    await tx.insert(subCategories).values({ id, userId, mainCategoryId, name, planned });
    return { id, name, planned };
  });
}

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

export async function editSubCategory(
  userId: string,
  mainCategoryId: string,
  subCategoryId: string,
  name: string,
  planned?: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ name: subCategories.name, mainName: categories.name })
      .from(subCategories)
      .innerJoin(
        categories,
        and(eq(categories.id, subCategories.mainCategoryId), eq(categories.userId, subCategories.userId)),
      )
      .where(
        and(
          eq(subCategories.userId, userId),
          eq(subCategories.id, subCategoryId),
          eq(subCategories.mainCategoryId, mainCategoryId),
        ),
      )
      .limit(1);
    if (!existing) return;
    if (existing.mainName === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goal categories follow their account names'), { status: 400 });
    }
    const siblings = await tx.select({ name: subCategories.name }).from(subCategories).where(and(
      eq(subCategories.userId, userId),
      eq(subCategories.mainCategoryId, mainCategoryId),
      sql`${subCategories.id} <> ${subCategoryId}`,
    ));
    if (siblings.some((sibling) => sameName(sibling.name, name))) throw Object.assign(new Error('A sub-category with this name already exists'), { status: 409 });

    await tx
      .update(subCategories)
      .set(planned === undefined ? { name } : { name, planned })
      .where(
        and(
          eq(subCategories.userId, userId),
          eq(subCategories.id, subCategoryId),
          eq(subCategories.mainCategoryId, mainCategoryId),
        ),
      );
    if (existing.name === name) return;

    const oldAssignment = and(
      eq(transactions.userId, userId),
      eq(transactions.subCategoryId, subCategoryId),
    );
    await tx.update(transactions).set({ subCategory: name }).where(oldAssignment);
    await tx
      .update(transactionSplits)
      .set({ subCategory: name })
      .where(
        and(
          eq(transactionSplits.userId, userId),
          eq(transactionSplits.subCategoryId, subCategoryId),
        ),
      );
    await tx
      .update(rules)
      .set({ subCategory: name, updatedAt: new Date(), version: sql`${rules.version} + 1` })
      .where(
        and(eq(rules.userId, userId), eq(rules.subCategoryId, subCategoryId)),
      );
  });
}

export async function deleteSubCategory(userId: string, mainCategoryId: string, subCategoryId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [assignment] = await tx
      .select({ category: categories.name, subCategory: subCategories.name })
      .from(subCategories)
      .innerJoin(
        categories,
        and(eq(categories.userId, subCategories.userId), eq(categories.id, subCategories.mainCategoryId)),
      )
      .where(
        and(
          eq(subCategories.userId, userId),
          eq(subCategories.mainCategoryId, mainCategoryId),
          eq(subCategories.id, subCategoryId),
        ),
      )
      .limit(1);
    if (!assignment) return;
    if (assignment.category === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goal categories are removed with their accounts'), { status: 400 });
    }
    await tx.update(transactions).set({ subCategoryId: null }).where(and(eq(transactions.userId, userId), eq(transactions.subCategoryId, subCategoryId)));
    await tx.update(transactionSplits).set({ subCategoryId: null }).where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.subCategoryId, subCategoryId)));
    await tx
      .delete(rules)
      .where(
        and(
          eq(rules.userId, userId),
          eq(rules.subCategoryId, subCategoryId),
        ),
      );
    await tx
      .delete(subCategories)
      .where(
        and(
          eq(subCategories.userId, userId),
          eq(subCategories.mainCategoryId, mainCategoryId),
          eq(subCategories.id, subCategoryId),
        ),
      );
  });
}

// ---- Transactions -------------------------------------------------------

/**
 * Per-account display/visibility metadata used by every ledger read.
 * Investment accounts are balance-only. Uncategorized account activity is
 * retained but held out of the ledger until the user chooses a type.
 */
interface AccountLedgerMeta {
  id: string;
  name: string;
  hidden: boolean;
  type: AccountType;
  alias: string | null;
}

function isLedgerExcluded(m: AccountLedgerMeta | undefined): boolean {
  // Unknown account names (orphan txs) stay visible so data isn't
  // silently lost; only known hidden/investment/uncategorized accounts
  // are dropped.
  if (!m) return false;
  return m.hidden || m.type === 'investment' || m.type === 'uncategorized';
}

async function loadAccountLedgerMeta(userId: string): Promise<{
  meta: Map<string, AccountLedgerMeta>;
  byName: Map<string, AccountLedgerMeta>;
  excludedIds: string[];
  excludedNames: string[];
}> {
  const meta = new Map<string, AccountLedgerMeta>();
  const byName = new Map<string, AccountLedgerMeta>();
  const duplicateNames = new Set<string>();
  const excludedByName = new Map<string, boolean>();
  for (const r of await db
    .select({
      id: accounts.id,
      name: accounts.name,
      hidden: accounts.hidden,
      alias: accounts.alias,
      type: accounts.type,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))) {
    const value = {
      id: r.id,
      name: r.name,
      hidden: r.hidden,
      type: r.type as AccountType,
      alias: r.alias ?? null,
    };
    meta.set(r.id, value);
    excludedByName.set(r.name, (excludedByName.get(r.name) ?? true) && isLedgerExcluded(value));
    // Legacy rows have no account_id. Preserve name fallback only when the
    // name is unambiguous for this tenant.
    if (duplicateNames.has(r.name)) continue;
    if (byName.has(r.name)) {
      byName.delete(r.name);
      duplicateNames.add(r.name);
    } else {
      byName.set(r.name, value);
    }
  }
  const excluded = Array.from(meta.values()).filter(isLedgerExcluded);
  return {
    meta,
    byName,
    excludedIds: excluded.map((value) => value.id),
    // A legacy row cannot be distinguished from an orphan row that happens
    // to share a name with current excluded accounts. Exclude that ambiguous
    // row only when every current account with the name is ledger-excluded.
    excludedNames: Array.from(excludedByName)
      .filter(([, isExcluded]) => isExcluded)
      .map(([name]) => name),
  };
}

function transactionAccountMeta(
  row: { accountId: string | null; account: string },
  meta: Map<string, AccountLedgerMeta>,
  byName: Map<string, AccountLedgerMeta>,
): AccountLedgerMeta | undefined {
  return (row.accountId ? meta.get(row.accountId) : undefined) ?? byName.get(row.account);
}

function ledgerVisibilityCondition(excludedIds: string[], excludedNames: string[]) {
  const current =
    excludedIds.length > 0
      ? or(isNull(transactions.accountId), notInArray(transactions.accountId, excludedIds))
      : undefined;
  const legacy =
    excludedNames.length > 0
      ? or(isNotNull(transactions.accountId), notInArray(transactions.account, excludedNames))
      : undefined;
  return and(current, legacy);
}

async function resolveTransactionAccount(
  userId: string,
  label: string,
  accountId?: string,
): Promise<{ id: string; name: string }> {
  const condition = accountId
    ? and(eq(accounts.userId, userId), eq(accounts.id, accountId))
    : and(eq(accounts.userId, userId), or(eq(accounts.name, label), eq(accounts.alias, label)));
  const rows = await db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(condition).limit(2);
  if (rows.length !== 1) {
    throw Object.assign(
      new Error(rows.length === 0 ? 'Account not found' : 'Account name is ambiguous'),
      { status: 400 },
    );
  }
  return rows[0]!;
}

async function loadTransactionSplits(userId: string, transactionIds: string[]): Promise<Map<string, TransactionSplit[]>> {
  const byTransaction = new Map<string, TransactionSplit[]>();
  if (transactionIds.length === 0) return byTransaction;
  const rows = await db
    .select()
    .from(transactionSplits)
    .where(and(eq(transactionSplits.userId, userId), inArray(transactionSplits.transactionId, transactionIds)))
    .orderBy(asc(transactionSplits.sortOrder));
  for (const row of rows) {
    const list = byTransaction.get(row.transactionId) ?? [];
    list.push({
      id: row.id,
      amount: centsToDollars(row.amountCents),
      amountCents: row.amountCents,
      category: row.category,
      subCategory: row.subCategory,
      categoryId: row.categoryId ?? undefined,
      subCategoryId: row.subCategoryId ?? undefined,
      type: row.type,
      sortOrder: row.sortOrder,
    });
    byTransaction.set(row.transactionId, list);
  }
  return byTransaction;
}

function hasSplitSql() {
  return sql`EXISTS (
    SELECT 1 FROM ${transactionSplits}
    WHERE ${transactionSplits.userId} = ${transactions.userId}
      AND ${transactionSplits.transactionId} = ${transactions.id}
  )`;
}

function effectiveAllocationFilter(parentCondition: ReturnType<typeof sql>, splitCondition: ReturnType<typeof sql>) {
  return sql`(
    (NOT (${hasSplitSql()}) AND ${parentCondition})
    OR EXISTS (
      SELECT 1 FROM ${transactionSplits}
      WHERE ${transactionSplits.userId} = ${transactions.userId}
        AND ${transactionSplits.transactionId} = ${transactions.id}
        AND ${splitCondition}
    )
  )`;
}

export async function getAllTransactions(userId: string): Promise<Transaction[]> {
  // Transactions store the account as a name (not an id), so we
  // resolve display + visibility in one pass via an in-memory map of
  // { name → meta }. Per-user account lists are tiny (typically < 10
  // rows) so this is cheaper than a NOT EXISTS subquery, and it lets
  // the user's alias flow through to historical transactions without
  // rewriting the ledger.
  const { meta, byName } = await loadAccountLedgerMeta(userId);
  const rows = await db
    .select()
    .from(transactions)
    // This unpaginated feed powers Dashboard/Budget summaries. Pending
    // imports stay available through the paginated transaction and review APIs
    // but do not affect financial figures before the user accepts them.
    .where(and(eq(transactions.userId, userId), eq(transactions.needsReview, false)))
    .orderBy(desc(transactions.date), desc(transactions.id));
  const splitsByTransaction = await loadTransactionSplits(userId, rows.map((row) => row.id));
  return (
    rows
      // Drop hidden + investment account activity (balance-only).
      .filter((r) => !isLedgerExcluded(transactionAccountMeta(r, meta, byName)))
      .map((r) => ({
        id: r.id,
        date: r.date,
        merchant: r.merchant,
        sourceCategory: r.sourceCategory,
        sourceSubCategory: r.sourceSubCategory ?? undefined,
        sourceType: r.sourceType,
        sourceClassificationTrusted: r.sourceClassificationTrusted,
        category: r.category,
        subCategory: r.subCategory ?? undefined,
        categoryId: r.categoryId ?? undefined,
        subCategoryId: r.subCategoryId ?? undefined,
        // Resolve alias on read so renaming flows through to every
        // historical transaction. Falls back to the raw account name
        // when no alias is set or the account no longer exists.
        account:
          transactionAccountMeta(r, meta, byName)?.alias || transactionAccountMeta(r, meta, byName)?.name || r.account,
        accountId: transactionAccountMeta(r, meta, byName)?.id ?? r.accountId ?? undefined,
        amount: centsToDollars(r.amountCents),
        type: r.type,
        notes: r.notes ?? undefined,
        splits: splitsByTransaction.get(r.id) ?? [],
      }))
  );
}

export async function getDashboardActivity(userId: string, now = new Date()): Promise<DashboardActivity> {
  const { meta, byName, excludedIds, excludedNames } = await loadAccountLedgerMeta(userId);
  const visible = ledgerVisibilityCondition(excludedIds, excludedNames);
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [periodRows, recentRows] = await Promise.all([
    db.select().from(transactions).where(and(
      eq(transactions.userId, userId),
      eq(transactions.needsReview, false),
      gt(transactions.date, cutoff),
      visible,
    )),
    db.select().from(transactions).where(and(
      eq(transactions.userId, userId),
      eq(transactions.needsReview, false),
      visible,
    )).orderBy(desc(transactions.date), desc(transactions.id)).limit(4),
  ]);
  const splits = await loadTransactionSplits(userId, periodRows.map((row) => row.id));
  let incomeCents = 0;
  let expenseCents = 0;
  for (const row of periodRows) {
    const allocations = splits.get(row.id);
    if (allocations?.length) {
      for (const allocation of allocations) {
        if (allocation.type === 'income') incomeCents += allocation.amountCents;
        if (allocation.type === 'expense') expenseCents += allocation.amountCents;
      }
    } else {
      if (row.type === 'income') incomeCents += row.amountCents;
      if (row.type === 'expense') expenseCents += row.amountCents;
    }
  }
  return {
    income: centsToDollars(incomeCents),
    expense: centsToDollars(expenseCents),
    transferCount: periodRows.filter((row) => row.type === 'transfer').length,
    recent: recentRows.map((row) => ({
      id: row.id,
      date: row.date,
      merchant: row.merchant,
      category: row.category,
      subCategory: row.subCategory ?? undefined,
      account: transactionAccountMeta(row, meta, byName)?.alias || transactionAccountMeta(row, meta, byName)?.name || row.account,
      amount: centsToDollars(row.amountCents),
      type: row.type,
    })),
  };
}

export async function getBudgetActivity(userId: string, yearMonth: string): Promise<{ yearMonth: string; rows: BudgetActivityRow[] }> {
  const { meta, byName, excludedIds, excludedNames } = await loadAccountLedgerMeta(userId);
  const [year, month] = yearMonth.split('-').map(Number);
  const toDate = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
  const { parentRows, splits } = await db.transaction(async (tx) => {
    const parentRows = await tx.select().from(transactions).where(and(
      eq(transactions.userId, userId),
      eq(transactions.needsReview, false),
      gte(transactions.date, `${yearMonth}-01`),
      lte(transactions.date, toDate),
      ledgerVisibilityCondition(excludedIds, excludedNames),
    )).orderBy(desc(transactions.date), asc(transactions.merchant), desc(transactions.id));
    const splitRows = parentRows.length > 0
      ? await tx
        .select()
        .from(transactionSplits)
        .where(and(
          eq(transactionSplits.userId, userId),
          inArray(transactionSplits.transactionId, parentRows.map((row) => row.id)),
        ))
        .orderBy(asc(transactionSplits.sortOrder))
      : [];
    const splits = new Map<string, typeof splitRows>();
    for (const split of splitRows) {
      const rows = splits.get(split.transactionId) ?? [];
      rows.push(split);
      splits.set(split.transactionId, rows);
    }
    return { parentRows, splits };
  });
  const grouped = new Map<string, { row: BudgetActivityRow; cents: number }>();
  for (const parent of parentRows) {
    const parentSplits = splits.get(parent.id);
    const hasSplits = Boolean(parentSplits?.length);
    const allocations = hasSplits
      ? parentSplits!
      : [{ amountCents: parent.amountCents, category: parent.category, subCategory: parent.subCategory ?? parent.category, type: parent.type }];
    const transactionAmounts = new Map<string, { category: string; subCategory: string; type: 'income' | 'expense'; cents: number }>();
    for (const allocation of allocations) {
      if (allocation.type !== 'income' && allocation.type !== 'expense') continue;
      const subCategory = allocation.subCategory ?? allocation.category;
      const key = `${allocation.type}\0${allocation.category}\0${subCategory}`;
      const current = transactionAmounts.get(key);
      if (current) current.cents += allocation.amountCents;
      else transactionAmounts.set(key, { category: allocation.category, subCategory, type: allocation.type, cents: allocation.amountCents });
    }
    for (const [key, allocation] of transactionAmounts) {
      let group = grouped.get(key);
      if (!group) {
        group = { row: { category: allocation.category, subCategory: allocation.subCategory, type: allocation.type, actual: 0, transactions: [] }, cents: 0 };
        grouped.set(key, group);
      }
      group.cents += allocation.cents;
      group.row.transactions.push({
        id: parent.id,
        date: parent.date,
        merchant: parent.merchant,
        account: transactionAccountMeta(parent, meta, byName)?.alias || transactionAccountMeta(parent, meta, byName)?.name || parent.account,
        amount: centsToDollars(allocation.cents),
        hasSplits,
        parentAmount: centsToDollars(parent.amountCents),
      });
    }
  }
  return {
    yearMonth,
    rows: Array.from(grouped.values(), (group) => ({ ...group.row, actual: centsToDollars(group.cents) })),
  };
}

/**
 * Filters accepted by `listTransactions`. Every field is optional;
 * unset fields mean "no filter on this dimension". Designed for the
 * Transactions page filter popover.
 *
 *   - `types`         — multi-select (income / expense / transfer). Empty
 *                       array means "no type filter" (NOT "match nothing").
 *   - `accounts`      — multi-select of canonical account names.
 *   - `accountMode`   — `include` (only these) or `exclude` (all except
 *                       these). Ignored when `accounts` is empty.
 *   - `category`      — main category name. When `subCategory` is also
 *                       set, both must match.
 *   - `subCategory`   — sub-category name, paired with `category`.
 *   - `merchant`      — exact merchant name (the dropdown is populated
 *                       from `getDistinctMerchants`, which returns the
 *                       exact set the user has in their ledger).
 *   - `minAmountCents` /
 *     `maxAmountCents` — inclusive integer-cent range; either may be omitted.
 *   - `q`             — fuzzy free-text search against merchant,
 *                       category, sub-category, account (alias-aware),
 *                       notes, and amount. Multi-word queries require
 *                       every token to match somewhere; matching is
 *                       case-insensitive and ignores punctuation so
 *                       "mcdonalds" hits "McDonald's".
 */
export interface TransactionFilters {
  types?: TransactionType[];
  accountIds?: string[];
  accounts?: string[];
  accountMode?: 'include' | 'exclude';
  category?: string;
  subCategory?: string;
  merchant?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
  q?: string;
  /** Inclusive lower bound `YYYY-MM-DD`. */
  fromDate?: string;
  /** Inclusive upper bound `YYYY-MM-DD`. */
  toDate?: string;
  /** Whether the transaction has been reviewed (`needs_review = false`). */
  reviewed?: boolean;
}

/** Escape `\`, `%`, and `_` so user input is treated literally in LIKE. */
function escapeLikePattern(s: string): string {
  return s.replace(/([\\%_])/g, '\\$1');
}

/** Strip everything but letters/digits for punctuation-tolerant matching. */
function compactAlnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * SQL counterpart of compactAlnum for search. SQLite has no regex replace,
 * so this strips whitespace and the punctuation that shows up in merchant,
 * category and account names; other characters stay, and a compact needle
 * still matches as a substring around them.
 */
const COMPACT_STRIPPED = [' ', '\t', '-', '.', ',', "'", '"', '&', '*', '#', '/', '\\', '_', '(', ')', ':', ';', '!', '?', '@', '+'];
function compactSql(expression: SQL): SQL {
  return COMPACT_STRIPPED.reduce<SQL>((inner, char) => sql`replace(${inner}, ${char}, '')`, expression);
}

/**
 * True when `haystack` fuzzy-matches a single search token:
 *   - case-insensitive substring, or
 *   - alnum-only substring ("mcdonalds" ↔ "McDonald's", "401k" ↔ "401(k)").
 */
function fuzzyTokenIn(haystack: string | null | undefined, token: string): boolean {
  if (!haystack) return false;
  const h = haystack.toLowerCase();
  const t = token.toLowerCase();
  if (t.length === 0) return true;
  if (h.includes(t)) return true;
  const hc = compactAlnum(h);
  const tc = compactAlnum(t);
  return tc.length > 0 && hc.includes(tc);
}

/**
 * Build a SQL condition for fuzzy free-text search over a transaction
 * row. Multi-word queries are AND across tokens (every word must match
 * somewhere); each token ORs across merchant / category / sub /
 * account (canonical + alias) / notes / amount.
 *
 * Matching is case-insensitive and also compares an alnum-compacted
 * form so punctuation and spacing differences don't block hits.
 */
function buildFuzzySearchCondition(rawQ: string, meta: Map<string, AccountLedgerMeta>): ReturnType<typeof sql> | null {
  // Cap token count so a pasted essay can't explode the OR tree.
  const tokens = rawQ
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (tokens.length === 0) return null;

  const tokenConds = tokens.map((token) => {
    const lower = token.toLowerCase();
    const needle = `%${escapeLikePattern(lower)}%`;
    const compact = compactAlnum(token);
    const compactNeedle = compact.length > 0 ? `%${escapeLikePattern(compact)}%` : null;

    // ILIKE-style match on a text column + optional compact form.
    // Column type is intentionally loose — drizzle's PgColumn generics
    // don't share a useful common text-column type across fields.
    const fieldMatch = (col: unknown) => {
      const parts = [sql`LOWER(COALESCE(${col}, '')) LIKE ${needle} ESCAPE '\\'`];
      if (compactNeedle) {
        parts.push(
          sql`${compactSql(sql`LOWER(COALESCE(${col}, ''))`)} LIKE ${compactNeedle} ESCAPE '\\'`,
        );
      }
      return sql`(${sql.join(parts, sql` OR `)})`;
    };

    const orParts = [
      fieldMatch(transactions.merchant),
      fieldMatch(transactions.category),
      fieldMatch(transactions.subCategory),
      fieldMatch(transactions.account),
      fieldMatch(transactions.notes),
      sql`EXISTS (
        SELECT 1 FROM ${transactionSplits}
        WHERE ${transactionSplits.userId} = ${transactions.userId}
          AND ${transactionSplits.transactionId} = ${transactions.id}
          AND (${fieldMatch(transactionSplits.category)} OR ${fieldMatch(transactionSplits.subCategory)})
      )`,
    ];

    // Account aliases: resolve renamed labels back to canonical names.
    const accountHits = Array.from(meta.values())
      .filter((v) => fuzzyTokenIn(v.name, token) || fuzzyTokenIn(v.alias, token))
      .map((v) => v.id);
    if (accountHits.length > 0) {
      orParts.push(inArray(transactions.accountId, accountHits));
    }

    // Numeric token also matches amount (e.g. "12.99" or "50").
    if (/^\d+(\.\d+)?$/.test(token)) {
      orParts.push(sql`printf('%.2f', ${transactions.amountCents} / 100.0) LIKE ${needle} ESCAPE '\\'`);
      orParts.push(sql`EXISTS (
        SELECT 1 FROM ${transactionSplits}
        WHERE ${transactionSplits.userId} = ${transactions.userId}
          AND ${transactionSplits.transactionId} = ${transactions.id}
          AND printf('%.2f', ${transactionSplits.amountCents} / 100.0) LIKE ${needle} ESCAPE '\\'
      )`);
    }

    return sql`(${sql.join(orParts, sql` OR `)})`;
  });

  // Every token must match somewhere on the row.
  return sql`(${sql.join(tokenConds, sql` AND `)})`;
}

/**
 * Paginated transaction list for the Transactions page. Returns
 * `{ rows, total }` so the client can render "Page X of Y" without a
 * second round-trip.
 *
 * Pagination is applied AFTER the hidden-account + filter WHERE so the
 * `total` matches what the user actually sees. We use SQL `NOT IN
 * (hidden names)` rather than in-memory filtering because LIMIT/OFFSET
 * in SQL has to know the filtered count up front to land on the right
 * row.
 *
 * `limit` is clamped to [1, 100] and `offset` is clamped to [0, total]
 * so a malformed query param can't blow up the query or the page.
 */
export async function listTransactions(
  userId: string,
  options: {
    limit?: number;
    offset?: number;
    filters?: TransactionFilters;
  } = {},
): Promise<{ rows: Transaction[]; total: number }> {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 25)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const filters = options.filters ?? {};

  // Build the { name → meta } map once. Reused for the count + the
  // page query so the alias resolution stays identical to
  // `getAllTransactions`. Excludes hidden + investment (balance-only).
  const { meta, byName, excludedIds, excludedNames } = await loadAccountLedgerMeta(userId);

  // Build the filter WHERE clauses. Each push is a separate condition
  // joined with AND; empty arrays / empty strings are skipped (not
  // treated as "match nothing").
  const conds = [eq(transactions.userId, userId)];
  const visible = ledgerVisibilityCondition(excludedIds, excludedNames);
  if (visible) conds.push(visible);
  if (filters.reviewed !== undefined) conds.push(eq(transactions.needsReview, !filters.reviewed));
  if (filters.accountIds && filters.accountIds.length > 0) {
    const accountCondition = inArray(transactions.accountId, filters.accountIds);
    conds.push(filters.accountMode === 'exclude' ? sql`NOT (${accountCondition})` : accountCondition);
  } else if (filters.accounts && filters.accounts.length > 0) {
    const selectedIds = Array.from(meta.values())
      .filter(
        (value) => filters.accounts!.includes(value.name) || (value.alias && filters.accounts!.includes(value.alias)),
      )
      .map((value) => value.id);
    const accountCondition =
      selectedIds.length > 0
        ? or(
            inArray(transactions.accountId, selectedIds),
            and(isNull(transactions.accountId), inArray(transactions.account, filters.accounts)),
          )!
        : inArray(transactions.account, filters.accounts);
    if (filters.accountMode === 'exclude') {
      conds.push(sql`NOT (${accountCondition})`);
    } else {
      conds.push(accountCondition);
    }
  }
  if (filters.merchant) conds.push(eq(transactions.merchant, filters.merchant));
  const parentAllocationConds: ReturnType<typeof sql>[] = [];
  const splitAllocationConds: ReturnType<typeof sql>[] = [];
  if (filters.types && filters.types.length > 0) {
    parentAllocationConds.push(sql`${inArray(transactions.type, filters.types)}`);
    splitAllocationConds.push(sql`${inArray(transactionSplits.type, filters.types)}`);
  }
  if (filters.category) {
    parentAllocationConds.push(sql`${transactions.category} = ${filters.category}`);
    splitAllocationConds.push(sql`${transactionSplits.category} = ${filters.category}`);
  }
  if (filters.subCategory) {
    parentAllocationConds.push(sql`${transactions.subCategory} = ${filters.subCategory}`);
    splitAllocationConds.push(sql`${transactionSplits.subCategory} = ${filters.subCategory}`);
  }
  if (typeof filters.minAmountCents === 'number' && Number.isSafeInteger(filters.minAmountCents)) {
    parentAllocationConds.push(sql`${transactions.amountCents} >= ${filters.minAmountCents}`);
    splitAllocationConds.push(sql`${transactionSplits.amountCents} >= ${filters.minAmountCents}`);
  }
  if (typeof filters.maxAmountCents === 'number' && Number.isSafeInteger(filters.maxAmountCents)) {
    parentAllocationConds.push(sql`${transactions.amountCents} <= ${filters.maxAmountCents}`);
    splitAllocationConds.push(sql`${transactionSplits.amountCents} <= ${filters.maxAmountCents}`);
  }
  if (parentAllocationConds.length > 0) {
    conds.push(effectiveAllocationFilter(
      sql`(${sql.join(parentAllocationConds, sql` AND `)})`,
      sql`(${sql.join(splitAllocationConds, sql` AND `)})`,
    ));
  }
  if (filters.fromDate) conds.push(gte(transactions.date, filters.fromDate));
  if (filters.toDate) conds.push(lte(transactions.date, filters.toDate));
  // Fuzzy free-text search. See `buildFuzzySearchCondition`.
  const q = filters.q?.trim();
  if (q) {
    const fuzzy = buildFuzzySearchCondition(q, meta);
    if (fuzzy) conds.push(fuzzy);
  }
  const whereClause = and(...conds);

  // Total count first so we can clamp `offset` before issuing the
  // SELECT — avoids fetching an empty page when the user navigates
  // past the end after adding a transaction.
  const totalRows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(transactions)
    .where(whereClause);
  const total = totalRows[0]?.count ?? 0;
  const clampedOffset = Math.min(offset, total);

  const dbRows = await db
    .select()
    .from(transactions)
    .where(whereClause)
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(limit)
    .offset(clampedOffset);
  const splitsByTransaction = await loadTransactionSplits(userId, dbRows.map((row) => row.id));

  const rows: Transaction[] = dbRows.map((r) => ({
    id: r.id,
    date: r.date,
    merchant: r.merchant,
    sourceCategory: r.sourceCategory,
    sourceSubCategory: r.sourceSubCategory ?? undefined,
    sourceType: r.sourceType,
    sourceClassificationTrusted: r.sourceClassificationTrusted,
    category: r.category,
    subCategory: r.subCategory ?? undefined,
    categoryId: r.categoryId ?? undefined,
    subCategoryId: r.subCategoryId ?? undefined,
    account:
      transactionAccountMeta(r, meta, byName)?.alias || transactionAccountMeta(r, meta, byName)?.name || r.account,
    accountId: transactionAccountMeta(r, meta, byName)?.id ?? r.accountId ?? undefined,
    amount: centsToDollars(r.amountCents),
    type: r.type,
    notes: r.notes ?? undefined,
    splits: splitsByTransaction.get(r.id) ?? [],
  }));

  return { rows, total };
}

/**
 * Distinct merchant names from a user's ledger, alphabetically sorted.
 * Drives the merchant filter dropdown on the Transactions page so the
 * user can pick specific merchants instead of typing substrings (the
 * main search bar still handles free-text merchant search). Hidden and
 * investment account activity is excluded so brokerage tickers don't
 * pollute the cash-ledger filter.
 */
export async function getDistinctMerchants(userId: string): Promise<string[]> {
  const { excludedIds, excludedNames } = await loadAccountLedgerMeta(userId);
  const conds = [eq(transactions.userId, userId)];
  const visible = ledgerVisibilityCondition(excludedIds, excludedNames);
  if (visible) conds.push(visible);
  const rows = await db
    .selectDistinct({ merchant: transactions.merchant })
    .from(transactions)
    .where(and(...conds))
    .orderBy(asc(transactions.merchant));
  return rows.map((r) => r.merchant).filter((m): m is string => m.length > 0);
}

export async function addTransaction(
  userId: string,
  tx: Omit<
    Transaction,
    'id' | 'splits' | 'sourceCategory' | 'sourceSubCategory' | 'sourceType' | 'sourceClassificationTrusted'
  >
    & Partial<Pick<Transaction, 'sourceCategory' | 'sourceSubCategory' | 'sourceType'>>,
): Promise<Transaction> {
  const id = `tx-${Date.now()}-${nanoid(4)}`;
  const amountCents = dollarsToCents(tx.amount);
  if (amountCents < 0) throw new Error('transaction amount must not be negative');
  const account = await resolveTransactionAccount(userId, tx.account, tx.accountId);
  const sourceCategory = tx.sourceCategory ?? tx.category;
  const sourceSubCategory = tx.sourceSubCategory ?? tx.subCategory;
  const sourceType = tx.sourceType ?? tx.type;
  const category = tx.category;
  const subCategory = tx.subCategory;
  const type = tx.type;
  const assignment = subCategory ? await resolveCategoryAssignment(userId, category, subCategory) : null;
  if (!assignment || (assignment.type !== type && category !== 'Pay down goals')) {
    throw Object.assign(new Error('transaction must use a valid category, subCategory, and matching type'), {
      status: 400,
    });
  }
  await db.insert(transactions).values({
    id,
    userId,
    date: tx.date,
    merchant: tx.merchant,
    sourceCategory,
    sourceSubCategory: sourceSubCategory ?? null,
    sourceType,
    sourceClassificationTrusted: true,
    category,
    subCategory: subCategory ?? null,
    categoryId: assignment.categoryId,
    subCategoryId: assignment.subCategoryId,
    categoryUserModified: true,
    merchantUserModified: true,
    accountId: account.id,
    account: account.name,
    amountCents,
    type,
    notes: tx.notes ?? null,
    // Manual entry — the user already chose the category and merchant
    // themselves, so there's nothing to "review". Default per schema
    // is FALSE; explicit here for clarity.
    needsReview: false,
  });
  return {
    ...tx,
    id,
    sourceCategory,
    sourceSubCategory,
    sourceType,
    sourceClassificationTrusted: true,
    category,
    subCategory,
    categoryId: assignment.categoryId,
    subCategoryId: assignment.subCategoryId,
    type,
    accountId: account.id,
    account: account.name,
    amount: centsToDollars(amountCents),
    splits: [],
  };
}

export async function editTransaction(
  userId: string,
  id: string,
  patch: Partial<Transaction>,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .limit(1);
  if (!existing) return;
  const nextAccount =
    patch.account !== undefined || patch.accountId !== undefined
      ? await resolveTransactionAccount(userId, patch.account ?? existing.account, patch.accountId)
      : null;
  const nextAmountCents = patch.amount !== undefined ? dollarsToCents(patch.amount) : existing.amountCents;
  if (nextAmountCents < 0) throw new Error('transaction amount must not be negative');
  const dateUserModified = patch.date !== undefined && patch.date !== existing.date
    ? existing.sourceDate !== null && patch.date === existing.sourceDate
      ? false
      : true
    : existing.dateUserModified;
  const merchantUserModified = patch.merchant !== undefined && patch.merchant !== existing.merchant
    ? true
    : existing.merchantUserModified;
  // An inline edit on a row that was awaiting review is an
  // implicit acknowledgement — drop it from the queue. The PATCH
  // endpoint is the only path that touches an existing row, and
  // it can only be reached by an authenticated user (per guard.ts).
  const implicitReview = existing.needsReview;
  const finalCategory = patch.category ?? existing.category;
  const finalSubCategory = patch.subCategory !== undefined ? patch.subCategory : existing.subCategory;
  const finalType = patch.type ?? existing.type;
  const changesAssignment = patch.category !== undefined || patch.subCategory !== undefined || patch.type !== undefined;
  const assignment = changesAssignment && finalSubCategory
    ? await resolveCategoryAssignment(userId, finalCategory, finalSubCategory)
    : null;
  if (
    changesAssignment
    && (!assignment || (assignment.type !== finalType && finalCategory !== 'Pay down goals'))
  ) {
    throw Object.assign(new Error('transaction must use a valid category, subCategory, and matching type'), {
      status: 400,
    });
  }
  await db.transaction(async (tx) => {
    await tx
      .update(transactions)
      .set({
        date: patch.date ?? existing.date,
        dateUserModified,
        merchant: patch.merchant ?? existing.merchant,
        merchantUserModified,
        category: patch.category ?? existing.category,
        subCategory: patch.subCategory !== undefined ? (patch.subCategory ?? null) : existing.subCategory,
        categoryId: changesAssignment ? assignment!.categoryId : existing.categoryId,
        subCategoryId: changesAssignment ? assignment!.subCategoryId : existing.subCategoryId,
        ...(changesAssignment ? { categoryUserModified: true } : {}),
        accountId: nextAccount?.id ?? existing.accountId,
        account: nextAccount?.name ?? existing.account,
        amountCents: nextAmountCents,
        type: patch.type ?? existing.type,
        notes: patch.notes !== undefined ? (patch.notes ?? null) : existing.notes,
        ...(implicitReview ? { needsReview: false } : {}),
      })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
    if (nextAmountCents !== existing.amountCents) {
      await tx
        .delete(transactionSplits)
        .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.transactionId, id)));
    }
  });

  // Rule changes are always explicit. A transaction correction must never
  // mutate a shared rule as a side effect.
}

export interface BulkTransactionAssignmentInput {
  ids: string[];
  expected: {
    type: TransactionType;
    category: string;
    subCategory: string;
  };
  type: TransactionType;
  category: string;
  subCategory: string;
}

/** Atomically reassign unsplit, tenant-owned transactions without changing source classification or rules. */
export async function bulkAssignTransactions(
  userId: string,
  input: BulkTransactionAssignmentInput,
): Promise<number> {
  return db.transaction(async (tx) => {
    const assignments = await tx
      .select({
        categoryId: categories.id,
        subCategoryId: subCategories.id,
        category: categories.name,
        subCategory: subCategories.name,
        type: categories.type,
      })
      .from(subCategories)
      .innerJoin(
        categories,
        and(eq(categories.id, subCategories.mainCategoryId), eq(categories.userId, subCategories.userId)),
      )
      .where(and(
        eq(categories.userId, userId),
        eq(categories.name, input.category),
        eq(subCategories.userId, userId),
        eq(subCategories.name, input.subCategory),
      ))
      .limit(2);
    const assignment = assignments.length === 1 ? assignments[0]! : null;

    const ownedRows = await tx
      .select({
        id: transactions.id,
        type: transactions.type,
        category: transactions.category,
        subCategory: transactions.subCategory,
      })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), inArray(transactions.id, input.ids)));
    if (ownedRows.length !== input.ids.length) {
      throw Object.assign(new Error('One or more transactions not found'), { status: 404 });
    }
    if (ownedRows.some((row) =>
      row.type !== input.expected.type
      || row.category !== input.expected.category
      || row.subCategory !== input.expected.subCategory
    )) {
      throw Object.assign(new Error('One or more transaction assignments changed'), { status: 409 });
    }

    const splitRows = await tx
      .select({ transactionId: transactionSplits.transactionId })
      .from(transactionSplits)
      .where(and(
        eq(transactionSplits.userId, userId),
        inArray(transactionSplits.transactionId, input.ids),
      ))
      .limit(1);
    if (splitRows.length > 0) {
      throw Object.assign(new Error('Transactions with splits cannot be reassigned'), { status: 409 });
    }
    if (!assignment || (assignment.type !== input.type && input.category !== 'Pay down goals')) {
      throw Object.assign(new Error('transaction must use a valid category, subCategory, and matching type'), {
        status: 400,
      });
    }

    const updated = await tx
      .update(transactions)
      .set({
        type: input.type,
        category: assignment.category,
        subCategory: assignment.subCategory,
        categoryId: assignment.categoryId,
        subCategoryId: assignment.subCategoryId,
        categoryUserModified: true,
        needsReview: false,
      })
      .where(and(eq(transactions.userId, userId), inArray(transactions.id, input.ids)))
      .returning({ id: transactions.id });
    return updated.length;
  });
}

export async function deleteTransaction(userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ externalId: transactions.externalId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
      .limit(1);
    if (!row) return;

    const aliasRows = await tx
      .select({ externalId: simpleFinTransactionAliases.externalId })
      .from(simpleFinTransactionAliases)
      .where(
        and(
          eq(simpleFinTransactionAliases.userId, userId),
          eq(simpleFinTransactionAliases.transactionId, id),
        ),
      );
    const ignoredIds = [...new Set(
      [row.externalId, ...aliasRows.map((alias) => alias.externalId)].filter(
        (externalId): externalId is string => !!externalId,
      ),
    )];
    if (ignoredIds.length > 0) {
      await tx
        .insert(simpleFinIgnoredTransactions)
        .values(ignoredIds.map((externalId) => ({ userId, externalId })))
        .onConflictDoNothing();
    }
    await tx.delete(transactions).where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
  });
}

export interface TransactionSplitInput {
  amountCents: number;
  category: string;
  subCategory: string;
  type: TransactionType;
}

export interface FullTransactionUpdateInput {
  transaction: Partial<Omit<Transaction, 'id' | 'splits'>>;
  splits: TransactionSplitInput[];
}

/** Update a parent and replace its effective allocations under one parent row lock. */
export async function updateFullTransaction(
  userId: string,
  transactionId: string,
  input: FullTransactionUpdateInput,
): Promise<Transaction> {
  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.id, transactionId)))
      .limit(1);
    if (!parent) throw Object.assign(new Error('Transaction not found'), { status: 404 });

    const patch = input.transaction;
    const amountCents = patch.amount !== undefined ? dollarsToCents(patch.amount) : parent.amountCents;
    if (amountCents < 0) {
      throw Object.assign(new Error('transaction amount must not be negative'), { status: 400 });
    }
    if (input.splits.length !== 0 && input.splits.length < 2) {
      throw Object.assign(new Error('splits must be empty or contain at least two allocations'), { status: 400 });
    }
    if (input.splits.length > 100) {
      throw Object.assign(new Error('splits must contain at most 100 allocations'), { status: 400 });
    }

    let splitTotalCents = 0;
    for (const split of input.splits) {
      if (!Number.isSafeInteger(split.amountCents) || split.amountCents <= 0) {
        throw Object.assign(new Error('split amount must be a positive dollar value'), { status: 400 });
      }
      splitTotalCents += split.amountCents;
      if (!Number.isSafeInteger(splitTotalCents)) {
        throw Object.assign(new Error('split total exceeds the supported range'), { status: 400 });
      }
    }
    if (input.splits.length > 0 && splitTotalCents !== amountCents) {
      throw Object.assign(new Error('split allocations must exactly equal the transaction amount in cents'), {
        status: 400,
      });
    }

    const nextCategory = patch.category ?? parent.category;
    const nextSubCategory = patch.subCategory ?? parent.subCategory;
    const nextType = patch.type ?? parent.type;
    const changesAssignment = patch.category !== undefined
      || patch.subCategory !== undefined
      || patch.type !== undefined;
    if ((changesAssignment && !nextSubCategory) || input.splits.some((split) => !split.subCategory)) {
      throw Object.assign(new Error('category and subCategory are required when changing an assignment'), {
        status: 400,
      });
    }
    if (changesAssignment || input.splits.length > 0) {
      const assignments = await tx
        .select({ categoryId: categories.id, subCategoryId: subCategories.id, category: categories.name, subCategory: subCategories.name, type: categories.type })
        .from(subCategories)
        .innerJoin(
          categories,
          and(eq(categories.userId, subCategories.userId), eq(categories.id, subCategories.mainCategoryId)),
        )
        .where(and(eq(categories.userId, userId), eq(subCategories.userId, userId)));
      const uniqueAssignments = uniqueAssignmentsByName(assignments);
      const assignmentIsValid = (category: string, subCategory: string, type: TransactionType) => {
        const assignment = uniqueAssignments.get(`${category}\0${subCategory}`);
        return assignment !== undefined && (assignment.type === type || category === 'Pay down goals');
      };
      if (changesAssignment && !assignmentIsValid(nextCategory, nextSubCategory!, nextType)) {
        throw Object.assign(new Error('transaction must use a valid category, subCategory, and matching type'), {
          status: 400,
        });
      }
      for (const split of input.splits) {
        if (!assignmentIsValid(split.category, split.subCategory, split.type)) {
          throw Object.assign(new Error('each split must use a valid category, subCategory, and matching type'), {
            status: 400,
          });
        }
      }
    }

    const assignmentRows = await tx
      .select({ categoryId: categories.id, subCategoryId: subCategories.id, category: categories.name, subCategory: subCategories.name })
      .from(subCategories)
      .innerJoin(categories, and(eq(categories.userId, subCategories.userId), eq(categories.id, subCategories.mainCategoryId)))
      .where(and(eq(categories.userId, userId), eq(subCategories.userId, userId)));
    const assignmentByName = uniqueAssignmentsByName(assignmentRows);
    const parentAssignment = assignmentByName.get(`${nextCategory}\0${nextSubCategory}`);

    let account = { id: parent.accountId, name: parent.account, alias: null as string | null };
    if (patch.account !== undefined || patch.accountId !== undefined) {
      const condition = patch.accountId
        ? and(eq(accounts.userId, userId), eq(accounts.id, patch.accountId))
        : and(
            eq(accounts.userId, userId),
            or(eq(accounts.name, patch.account ?? parent.account), eq(accounts.alias, patch.account ?? parent.account)),
          );
      const rows = await tx
        .select({ id: accounts.id, name: accounts.name, alias: accounts.alias })
        .from(accounts)
        .where(condition)
        .limit(2);
      if (rows.length !== 1) {
        throw Object.assign(new Error(rows.length === 0 ? 'Account not found' : 'Account name is ambiguous'), {
          status: 400,
        });
      }
      account = rows[0]!;
    } else if (parent.accountId) {
      const [row] = await tx
        .select({ id: accounts.id, name: accounts.name, alias: accounts.alias })
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.id, parent.accountId)))
        .limit(1);
      if (row) account = row;
    }

    const date = patch.date ?? parent.date;
    const dateUserModified = patch.date !== undefined && patch.date !== parent.date
      ? parent.sourceDate !== null && patch.date === parent.sourceDate
        ? false
        : true
      : parent.dateUserModified;
    const merchantUserModified = patch.merchant !== undefined && patch.merchant !== parent.merchant
      ? true
      : parent.merchantUserModified;
    await tx
      .update(transactions)
      .set({
        date,
        dateUserModified,
        merchant: patch.merchant ?? parent.merchant,
        merchantUserModified,
        category: nextCategory,
        subCategory: nextSubCategory,
        categoryId: parentAssignment?.categoryId ?? parent.categoryId,
        subCategoryId: parentAssignment?.subCategoryId ?? parent.subCategoryId,
        categoryUserModified: parent.categoryUserModified || changesAssignment || input.splits.length > 0,
        accountId: account.id,
        account: account.name,
        amountCents,
        type: nextType,
        notes: patch.notes !== undefined ? patch.notes : parent.notes,
        needsReview: false,
      })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, transactionId)));
    await tx
      .delete(transactionSplits)
      .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.transactionId, transactionId)));

    const splitRows = input.splits.map((split, sortOrder) => {
      const assignment = assignmentByName.get(`${split.category}\0${split.subCategory}`)!;
      return ({
      id: `split-${nanoid(12)}`,
      userId,
      transactionId,
      amountCents: split.amountCents,
      category: split.category,
      subCategory: split.subCategory,
      categoryId: assignment.categoryId,
      subCategoryId: assignment.subCategoryId,
      type: split.type,
      sortOrder,
    });
    });
    if (splitRows.length > 0) await tx.insert(transactionSplits).values(splitRows);

    return {
      id: transactionId,
      date,
      merchant: patch.merchant ?? parent.merchant,
      sourceCategory: parent.sourceCategory,
      sourceSubCategory: parent.sourceSubCategory ?? undefined,
      sourceType: parent.sourceType,
      sourceClassificationTrusted: parent.sourceClassificationTrusted,
      category: nextCategory,
      subCategory: nextSubCategory ?? undefined,
      account: account.alias || account.name,
      accountId: account.id ?? undefined,
      amount: centsToDollars(amountCents),
      type: nextType,
      notes: patch.notes !== undefined ? patch.notes : (parent.notes ?? undefined),
      splits: splitRows.map((split) => ({
        id: split.id,
        amount: centsToDollars(split.amountCents),
        amountCents: split.amountCents,
        category: split.category,
        subCategory: split.subCategory,
        categoryId: split.categoryId,
        subCategoryId: split.subCategoryId,
        type: split.type,
        sortOrder: split.sortOrder,
      })),
    };
  });
}

/** Atomically replace all effective allocations while retaining the imported parent record. */
export async function replaceTransactionSplits(
  userId: string,
  transactionId: string,
  input: TransactionSplitInput[],
): Promise<TransactionSplit[]> {
  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ id: transactions.id, amountCents: transactions.amountCents })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.id, transactionId)))
      .limit(1);
    if (!parent) throw Object.assign(new Error('Transaction not found'), { status: 404 });

    if (input.length !== 0 && input.length < 2) {
      throw Object.assign(new Error('splits must be empty or contain at least two allocations'), { status: 400 });
    }
    let totalCents = 0;
    for (const split of input) {
      if (!Number.isSafeInteger(split.amountCents) || split.amountCents <= 0) {
        throw Object.assign(new Error('split amountCents must be a positive safe integer'), { status: 400 });
      }
      totalCents += split.amountCents;
      if (!Number.isSafeInteger(totalCents)) {
        throw Object.assign(new Error('split total exceeds the supported range'), { status: 400 });
      }
    }
    if (input.length > 0 && totalCents !== parent.amountCents) {
      throw Object.assign(new Error('split allocations must exactly equal the transaction amount in cents'), {
        status: 400,
      });
    }

    let assignmentByName = new Map<string, { categoryId: string; subCategoryId: string; type: TransactionType }>();
    if (input.length > 0) {
      const assignments = await tx
        .select({
          categoryId: categories.id,
          subCategoryId: subCategories.id,
          category: categories.name,
          subCategory: subCategories.name,
          type: categories.type,
        })
        .from(subCategories)
        .innerJoin(
          categories,
          and(eq(categories.userId, subCategories.userId), eq(categories.id, subCategories.mainCategoryId)),
        )
        .where(and(eq(categories.userId, userId), eq(subCategories.userId, userId)));
      assignmentByName = uniqueAssignmentsByName(assignments);
      const assignmentIsValid = (category: string, subCategory: string, type: TransactionType) => {
        const assignment = assignmentByName.get(`${category}\0${subCategory}`);
        return assignment !== undefined && (assignment.type === type || category === 'Pay down goals');
      };
      for (const split of input) {
        if (!assignmentIsValid(split.category, split.subCategory, split.type)) {
          throw Object.assign(new Error('each split must use a valid category, subCategory, and matching type'), {
            status: 400,
          });
        }
      }
    }

    await tx
      .delete(transactionSplits)
      .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.transactionId, transactionId)));
    if (input.length === 0) {
      await tx
        .update(transactions)
        .set({ needsReview: false })
        .where(and(eq(transactions.userId, userId), eq(transactions.id, transactionId)));
      return [];
    }

    const rows = input.map((split, sortOrder) => ({
      id: `split-${nanoid(12)}`,
      userId,
      transactionId,
      amountCents: split.amountCents,
      category: split.category,
      subCategory: split.subCategory,
      categoryId: assignmentByName.get(`${split.category}\0${split.subCategory}`)!.categoryId,
      subCategoryId: assignmentByName.get(`${split.category}\0${split.subCategory}`)!.subCategoryId,
      type: split.type,
      sortOrder,
    }));
    await tx.insert(transactionSplits).values(rows);
    await tx
      .update(transactions)
      .set({ needsReview: false, categoryUserModified: true })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, transactionId)));
    return rows.map((row) => ({
      id: row.id,
      amount: centsToDollars(row.amountCents),
      amountCents: row.amountCents,
      category: row.category,
      subCategory: row.subCategory,
      categoryId: row.categoryId,
      subCategoryId: row.subCategoryId,
      type: row.type,
      sortOrder: row.sortOrder,
    }));
  });
}

export async function addTransactionWithExternalId(
  userId: string,
  tx: Omit<Transaction, 'id' | 'amount' | 'splits'> & {
    amountCents: number;
    externalId?: string;
    legacyExternalId?: string;
    needsReview?: boolean;
    sourcePending?: boolean;
    sourceTransactedAt?: number;
    sourceLastSeenAt?: Date;
    preserveSourceDate?: boolean;
  },
): Promise<{
  transaction: Transaction;
  action: 'inserted' | 'updated' | 'reconciled';
  reconciliationAmbiguous?: boolean;
} | null> {
  if (!Number.isSafeInteger(tx.amountCents) || tx.amountCents < 0) {
    throw new Error('amount cents must be a non-negative safe integer');
  }
  const account = await resolveTransactionAccount(
    userId,
    tx.account,
    tx.accountId,
  );
  const assignment = tx.subCategory
    ? await resolveCategoryAssignment(userId, tx.category, tx.subCategory)
    : null;
  if (!assignment || (assignment.type !== tx.type && tx.category !== 'Pay down goals')) {
    throw Object.assign(new Error('transaction must use a valid category, subCategory, and matching type'), { status: 400 });
  }

  const candidateExternalIds = [...new Set(
    [tx.externalId, tx.legacyExternalId].filter((value): value is string => !!value),
  )];
  if (candidateExternalIds.length > 0) {
    const [ignored] = await db
      .select({ externalId: simpleFinIgnoredTransactions.externalId })
      .from(simpleFinIgnoredTransactions)
      .where(
        and(
          eq(simpleFinIgnoredTransactions.userId, userId),
          inArray(simpleFinIgnoredTransactions.externalId, candidateExternalIds),
        ),
      )
      .limit(1);
    if (ignored) return null;
  }

  // SimpleFIN transaction IDs are only unique within an account. New imports
  // use an account-scoped ID; migrate a matching legacy ID in place so an
  // upgrade does not duplicate already-imported transactions.
  let reconciliationAmbiguous = false;
  let reconciled = false;
  let [existing] = tx.externalId
    ? await db
        .select({ transaction: transactions })
        .from(simpleFinTransactionAliases)
        .innerJoin(
          transactions,
          and(
            eq(transactions.userId, simpleFinTransactionAliases.userId),
            eq(transactions.id, simpleFinTransactionAliases.transactionId),
          ),
        )
        .where(
          and(
            eq(simpleFinTransactionAliases.userId, userId),
            eq(simpleFinTransactionAliases.externalId, tx.externalId),
          ),
        )
        .limit(1)
        .then((rows) => rows.map((row) => row.transaction))
    : [];
  if (!existing && tx.externalId) {
    [existing] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, tx.externalId)))
      .limit(1);
  }
  if (!existing && tx.legacyExternalId) {
    [existing] = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.externalId, tx.legacyExternalId),
          or(
            eq(transactions.accountId, account.id),
            and(isNull(transactions.accountId), eq(transactions.account, tx.account)),
          ),
        ),
      )
      .limit(1);
  }

  if (existing && tx.sourcePending === true && existing.sourcePending === false) {
    if (tx.externalId) {
      await db
        .insert(simpleFinTransactionAliases)
        .values({ userId, externalId: tx.externalId, transactionId: existing.id, lastSeenAt: tx.sourceLastSeenAt })
        .onConflictDoUpdate({
          target: [simpleFinTransactionAliases.userId, simpleFinTransactionAliases.externalId],
          set: { lastSeenAt: tx.sourceLastSeenAt ?? new Date() },
        });
    }
    return {
      action: 'updated',
      transaction: {
        id: existing.id,
        date: existing.date,
        merchant: existing.merchant,
        sourceCategory: existing.sourceCategory,
        sourceSubCategory: existing.sourceSubCategory ?? undefined,
        sourceType: existing.sourceType,
        sourceClassificationTrusted: existing.sourceClassificationTrusted,
        category: existing.category,
        subCategory: existing.subCategory ?? undefined,
        categoryId: existing.categoryId ?? undefined,
        subCategoryId: existing.subCategoryId ?? undefined,
        accountId: existing.accountId ?? undefined,
        account: existing.account,
        amount: centsToDollars(existing.amountCents),
        type: existing.type,
        notes: existing.notes ?? undefined,
        splits: [],
      },
    };
  }

  const exactPendingUpdate = existing?.sourcePending === true && existing.externalId === tx.externalId;
  if (tx.externalId && tx.sourcePending === false && tx.sourceType === 'expense' && !exactPendingUpdate) {
    const candidates = await db
      .select({ transaction: transactions })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, account.id),
          eq(transactions.sourcePending, true),
          eq(transactions.sourceType, tx.sourceType),
          sql`abs(${tx.amountCents} - ${transactions.amountCents}) <= 10000`,
          or(
            tx.sourceTransactedAt == null
              ? sql`false`
              : and(
                  eq(transactions.sourceTransactedAt, tx.sourceTransactedAt),
                  sql`${tx.amountCents} * 2 <= ${transactions.amountCents} * 3`,
                  sql`${tx.amountCents} * 2 >= ${transactions.amountCents}`,
                ),
            and(
              tx.sourceTransactedAt == null ? sql`true` : isNull(transactions.sourceTransactedAt),
              lte(transactions.amountCents, tx.amountCents),
              sql`${tx.amountCents} * 10 <= ${transactions.amountCents} * 13`,
              sql`${tx.date} BETWEEN date(coalesce(${transactions.sourceDate}, ${transactions.date}), '-1 day') AND date(coalesce(${transactions.sourceDate}, ${transactions.date}), '+1 day')`,
            ),
          ),
        ),
      );
    const usableCandidates: typeof candidates = [];
    // Merchant names are compared in JS: SQLite has no regex replace and
    // its lower() folds ASCII only.
    const merchant = normalizeMerchant(tx.merchant);
    for (const candidate of candidates) {
      if (normalizeMerchant(candidate.transaction.merchant) !== merchant) continue;
      if (existing && candidate.transaction.id === existing.id) {
        usableCandidates.push(candidate);
        continue;
      }
      const candidateDateOverridden = candidate.transaction.dateUserModified
        && candidate.transaction.sourceDate != null
        && candidate.transaction.date !== candidate.transaction.sourceDate;
      const existingDateOverridden = existing?.dateUserModified === true
        && existing.sourceDate != null
        && existing.date !== existing.sourceDate;
      const categoryConflict = existing?.categoryUserModified === true
        && candidate.transaction.categoryUserModified
        && (
          existing.categoryId !== candidate.transaction.categoryId
          || existing.subCategoryId !== candidate.transaction.subCategoryId
          || existing.type !== candidate.transaction.type
        );
      const dateConflict = existingDateOverridden
        && candidateDateOverridden
        && existing!.date !== candidate.transaction.date;
      const candidateNote = candidate.transaction.notes === 'Pending Transaction'
        ? null
        : candidate.transaction.notes;
      const existingNote = existing?.notes === 'Pending Transaction' ? null : existing?.notes;
      const noteConflict = !!candidateNote && !!existingNote && candidateNote !== existingNote;
      if (categoryConflict || dateConflict || noteConflict) continue;
      const splitOwners = existing
        ? [candidate.transaction.id, existing.id]
        : [candidate.transaction.id];
      const [split] = await db
        .select({ id: transactionSplits.id })
        .from(transactionSplits)
        .where(
          and(
            eq(transactionSplits.userId, userId),
            inArray(transactionSplits.transactionId, splitOwners),
          ),
        )
        .limit(1);
      if (!split) usableCandidates.push(candidate);
    }
    if (usableCandidates.length === 1) {
      const candidate = usableCandidates[0]!.transaction;
      if (!existing || existing.id !== candidate.id) {
        const existingId = existing?.id;
        const merged = await db.transaction(async (databaseTx) => {
          const lockedRows = await databaseTx
            .select()
            .from(transactions)
            .where(
              and(
                eq(transactions.userId, userId),
                inArray(transactions.id, existingId ? [candidate.id, existingId] : [candidate.id]),
              ),
            )
            .orderBy(asc(transactions.id));
          const lockedCandidate = lockedRows.find((row) => row.id === candidate.id);
          const lockedExisting = existingId ? lockedRows.find((row) => row.id === existingId) : undefined;
          if (!lockedCandidate || (existingId && !lockedExisting)) return false;

          if (lockedExisting) {
            const candidateDateOverridden = lockedCandidate.dateUserModified
              && lockedCandidate.sourceDate != null
              && lockedCandidate.date !== lockedCandidate.sourceDate;
            const existingDateOverridden = lockedExisting.dateUserModified
              && lockedExisting.sourceDate != null
              && lockedExisting.date !== lockedExisting.sourceDate;
            const categoryConflict = lockedExisting.categoryUserModified
              && lockedCandidate.categoryUserModified
              && (
                lockedExisting.categoryId !== lockedCandidate.categoryId
                || lockedExisting.subCategoryId !== lockedCandidate.subCategoryId
                || lockedExisting.type !== lockedCandidate.type
              );
            const candidateNote = lockedCandidate.notes === 'Pending Transaction' ? null : lockedCandidate.notes;
            const existingNote = lockedExisting.notes === 'Pending Transaction' ? null : lockedExisting.notes;
            if (
              categoryConflict
              || (candidateDateOverridden && existingDateOverridden && lockedCandidate.date !== lockedExisting.date)
              || (!!candidateNote && !!existingNote && candidateNote !== existingNote)
            ) {
              return false;
            }
            const [split] = await databaseTx
              .select({ id: transactionSplits.id })
              .from(transactionSplits)
              .where(
                and(
                  eq(transactionSplits.userId, userId),
                  inArray(transactionSplits.transactionId, [lockedCandidate.id, lockedExisting.id]),
                ),
              )
              .limit(1);
            if (split) return false;

            if (lockedExisting.categoryUserModified && !lockedCandidate.categoryUserModified) {
              await databaseTx
                .update(transactions)
                .set({
                  category: lockedExisting.category,
                  subCategory: lockedExisting.subCategory,
                  categoryId: lockedExisting.categoryId,
                  subCategoryId: lockedExisting.subCategoryId,
                  categoryUserModified: true,
                  type: lockedExisting.type,
                })
                .where(and(eq(transactions.userId, userId), eq(transactions.id, lockedCandidate.id)));
            }
            if (lockedExisting.merchantUserModified && !lockedCandidate.merchantUserModified) {
              await databaseTx
                .update(transactions)
                .set({
                  merchant: lockedExisting.merchant,
                  merchantUserModified: true,
                })
                .where(and(eq(transactions.userId, userId), eq(transactions.id, lockedCandidate.id)));
            }
            await databaseTx
              .update(transactions)
              .set({
                ...(existingDateOverridden && !candidateDateOverridden
                  ? { date: lockedExisting.date, dateUserModified: true }
                  : {}),
                ...(existingNote && lockedCandidate.notes === 'Pending Transaction' ? { notes: existingNote } : {}),
                needsReview: lockedCandidate.needsReview && lockedExisting.needsReview,
              })
              .where(and(eq(transactions.userId, userId), eq(transactions.id, lockedCandidate.id)));
            await databaseTx
              .update(simpleFinTransactionAliases)
              .set({ transactionId: lockedCandidate.id, lastSeenAt: tx.sourceLastSeenAt ?? new Date() })
              .where(
                and(
                  eq(simpleFinTransactionAliases.userId, userId),
                  eq(simpleFinTransactionAliases.transactionId, lockedExisting.id),
                ),
              );
            await databaseTx
              .update(transactions)
              .set({ externalId: null })
              .where(and(eq(transactions.userId, userId), eq(transactions.id, lockedExisting.id)));
            await databaseTx
              .delete(transactions)
              .where(and(eq(transactions.userId, userId), eq(transactions.id, lockedExisting.id)));
          }
          await databaseTx
            .insert(simpleFinTransactionAliases)
            .values({
              userId,
              externalId: tx.externalId!,
              transactionId: candidate.id,
              lastSeenAt: tx.sourceLastSeenAt,
            })
            .onConflictDoUpdate({
              target: [simpleFinTransactionAliases.userId, simpleFinTransactionAliases.externalId],
              set: { transactionId: candidate.id, lastSeenAt: tx.sourceLastSeenAt ?? new Date() },
            });
          return true;
        });
        if (merged) {
          [existing] = await db
            .select()
            .from(transactions)
            .where(and(eq(transactions.userId, userId), eq(transactions.id, candidate.id)))
            .limit(1);
          reconciled = true;
        }
      }
    } else if (usableCandidates.length > 1) {
      reconciliationAmbiguous = true;
    }
  }

  if (existing) {
    return db.transaction(async (databaseTx) => {
      const [current] = await databaseTx
        .select()
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.id, existing.id)))
        .limit(1);
      if (!current) return null;

      const splitRows = await databaseTx
        .select()
        .from(transactionSplits)
        .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.transactionId, current.id)))
        .orderBy(asc(transactionSplits.sortOrder));
      const incomingSourceDate = tx.preserveSourceDate && current.sourceDate ? current.sourceDate : tx.date;
      const effectiveDate = current.dateUserModified ? current.date : incomingSourceDate;
      const effectiveMerchant = current.merchantUserModified ? current.merchant : tx.merchant;
      const effectiveNotes = current.notes === 'Pending Transaction' ? (tx.notes ?? null) : current.notes;
      const amountChanged = current.amountCents !== tx.amountCents;
      await databaseTx
        .update(transactions)
        .set({
          date: effectiveDate,
          sourceDate: incomingSourceDate,
           merchant: effectiveMerchant,
           sourceCategory: tx.sourceCategory,
           sourceSubCategory: tx.sourceSubCategory ?? null,
           sourceType: tx.sourceType,
           sourceClassificationTrusted: true,
           accountId: account.id,
          account: account.name,
          amountCents: tx.amountCents,
          externalId: tx.externalId ?? current.externalId,
          sourcePending: tx.sourcePending ?? current.sourcePending,
          sourceTransactedAt: tx.sourceTransactedAt ?? current.sourceTransactedAt,
          sourceLastSeenAt: tx.sourceLastSeenAt ?? current.sourceLastSeenAt,
           // Existing assignments and merchant labels are user-owned. Sync
           // refreshes source metadata, but historical categorization changes
           // require Run.
          // A changed source amount invalidates explicit allocations. Return
          // the parent to review instead of silently counting its old assignment.
          ...(amountChanged && splitRows.length > 0 ? { needsReview: true } : {}),
          // Clear the importer's pending marker when the bank reports the
          // transaction as posted, but preserve user-written notes.
          notes: effectiveNotes,
        })
        .where(and(eq(transactions.userId, userId), eq(transactions.id, current.id)));
      if (amountChanged) {
        await databaseTx
          .delete(transactionSplits)
          .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.transactionId, current.id)));
      }
      if (tx.externalId) {
        await databaseTx
          .insert(simpleFinTransactionAliases)
          .values({
            userId,
            externalId: tx.externalId,
            transactionId: current.id,
            lastSeenAt: tx.sourceLastSeenAt,
          })
          .onConflictDoUpdate({
            target: [simpleFinTransactionAliases.userId, simpleFinTransactionAliases.externalId],
            set: { transactionId: current.id, lastSeenAt: tx.sourceLastSeenAt ?? new Date() },
          });
      }
      return {
        action: reconciled ? 'reconciled' as const : 'updated' as const,
        reconciliationAmbiguous,
        transaction: {
           id: current.id,
           date: effectiveDate,
           merchant: effectiveMerchant,
           sourceCategory: tx.sourceCategory,
           sourceSubCategory: tx.sourceSubCategory,
           sourceType: tx.sourceType,
           sourceClassificationTrusted: true,
            category: current.category,
            subCategory: current.subCategory ?? undefined,
            categoryId: current.categoryId ?? undefined,
            subCategoryId: current.subCategoryId ?? undefined,
          accountId: account.id,
          account: account.name,
          amount: centsToDollars(tx.amountCents),
           type: current.type,
          notes: effectiveNotes ?? undefined,
          splits: amountChanged
            ? []
            : splitRows.map((split) => ({
                id: split.id,
                amount: centsToDollars(split.amountCents),
                amountCents: split.amountCents,
                category: split.category,
                subCategory: split.subCategory,
                categoryId: split.categoryId ?? undefined,
                subCategoryId: split.subCategoryId ?? undefined,
                type: split.type,
                sortOrder: split.sortOrder,
              })),
        },
      };
    });
  }

  const id = `tx-${Date.now()}-${nanoid(4)}`;
  const inserted = await db
    .insert(transactions)
    .values({
      id,
      userId,
      date: tx.date,
      sourceDate: tx.date,
      dateUserModified: false,
      merchant: tx.merchant,
      merchantUserModified: false,
      sourceCategory: tx.sourceCategory,
      sourceSubCategory: tx.sourceSubCategory ?? null,
      sourceType: tx.sourceType,
      sourceClassificationTrusted: true,
      category: tx.category,
      subCategory: tx.subCategory ?? null,
      categoryId: assignment.categoryId,
      subCategoryId: assignment.subCategoryId,
      accountId: account.id,
      account: account.name,
      amountCents: tx.amountCents,
      type: tx.type,
      notes: tx.notes ?? null,
      externalId: tx.externalId ?? null,
      sourcePending: tx.sourcePending ?? null,
      sourceTransactedAt: tx.sourceTransactedAt ?? null,
      sourceLastSeenAt: tx.sourceLastSeenAt ?? null,
      // SimpleFIN imports land in the review queue by default so the
      // user can confirm the smart categoriser. When a user rule already
      // covers the merchant, the importer passes needsReview: false so
      // trained merchants skip the queue.
      needsReview: tx.needsReview ?? true,
    })
    .onConflictDoNothing({
      target: [transactions.userId, transactions.externalId],
    })
    .returning({ id: transactions.id });
  if (inserted.length === 0) return null;
  if (tx.externalId) {
    await db
      .insert(simpleFinTransactionAliases)
      .values({ userId, externalId: tx.externalId, transactionId: id, lastSeenAt: tx.sourceLastSeenAt })
      .onConflictDoNothing();
  }
  return {
    action: 'inserted',
    reconciliationAmbiguous,
    transaction: {
      id,
      date: tx.date,
      merchant: tx.merchant,
      sourceCategory: tx.sourceCategory,
      sourceSubCategory: tx.sourceSubCategory,
      sourceType: tx.sourceType,
      sourceClassificationTrusted: true,
      category: tx.category,
      subCategory: tx.subCategory,
      categoryId: assignment.categoryId,
      subCategoryId: assignment.subCategoryId,
      accountId: account.id,
      account: account.name,
      amount: centsToDollars(tx.amountCents),
      type: tx.type,
      notes: tx.notes,
      splits: [],
    },
  };
}

// ---- Review queue -------------------------------------------------------
//
// The bell badge and the Transactions banner drive off these helpers.
// Counts and rows are filtered to `needs_review = TRUE` for the
// current user. Hidden-account transactions are excluded (the bell
// queue mirrors what the user would see on the Transactions page).

/**
 * Count of this user's transactions awaiting review. Hot path — the
 * bell runs this every 30s via React Query polling. Hidden and
 * investment account rows are excluded so the queue mirrors what the
 * user can see on the Transactions page.
 */
export async function pendingReviewCount(userId: string): Promise<number> {
  const { excludedIds, excludedNames } = await loadAccountLedgerMeta(userId);
  const conds = [eq(transactions.userId, userId), eq(transactions.needsReview, true)];
  const visible = ledgerVisibilityCondition(excludedIds, excludedNames);
  if (visible) conds.push(visible);
  const countRows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(transactions)
    .where(and(...conds));
  return countRows[0]?.count ?? 0;
}

export interface PendingReviewNotificationState {
  count: number;
  latestIdentity?: string;
}

/**
 * Count pending reviews and identify the most recently created pending row.
 * Import time, rather than posting date, ensures a newly arriving backdated
 * transaction makes a previously cleared notification visible again.
 */
export async function pendingReviewNotificationState(userId: string): Promise<PendingReviewNotificationState> {
  const { excludedIds, excludedNames } = await loadAccountLedgerMeta(userId);
  const conds = [eq(transactions.userId, userId), eq(transactions.needsReview, true)];
  const visible = ledgerVisibilityCondition(excludedIds, excludedNames);
  if (visible) conds.push(visible);
  const rows = await db
    .select({
      id: transactions.id,
      createdAt: transactions.createdAt,
      count: sql<number>`COUNT(*) OVER()`,
    })
    .from(transactions)
    .where(and(...conds))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(1);
  const latest = rows[0];
  return latest
    ? { count: latest.count, latestIdentity: `${latest.createdAt.toISOString()}|${latest.id}` }
    : { count: 0 };
}

/**
 * List of the user's transactions awaiting review. Same row shape as
 * `getAllTransactions` (alias-aware account display). Ordered newest
 * first so the carousel starts at the most recent item.
 *
 * `limit` clamps to [1, 200]. The UI defaults to 100 to bound the
 * carousel; the bell doesn't use this — it only needs the count.
 * Exclusion of hidden/investment happens in SQL (before LIMIT) so a
 * flood of balance-only leftovers can't starve the visible queue.
 */
export async function listReviewQueue(userId: string, opts: { limit?: number } = {}): Promise<Transaction[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const { meta, byName, excludedIds, excludedNames } = await loadAccountLedgerMeta(userId);
  const conds = [eq(transactions.userId, userId), eq(transactions.needsReview, true)];
  const visible = ledgerVisibilityCondition(excludedIds, excludedNames);
  if (visible) conds.push(visible);
  const rows = await db
    .select()
    .from(transactions)
    .where(and(...conds))
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(limit);
  const splitsByTransaction = await loadTransactionSplits(userId, rows.map((row) => row.id));
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    merchant: r.merchant,
    sourceCategory: r.sourceCategory,
    sourceSubCategory: r.sourceSubCategory ?? undefined,
    sourceType: r.sourceType,
    sourceClassificationTrusted: r.sourceClassificationTrusted,
    category: r.category,
    subCategory: r.subCategory ?? undefined,
    categoryId: r.categoryId ?? undefined,
    subCategoryId: r.subCategoryId ?? undefined,
    account:
      transactionAccountMeta(r, meta, byName)?.alias || transactionAccountMeta(r, meta, byName)?.name || r.account,
    accountId: transactionAccountMeta(r, meta, byName)?.id ?? r.accountId ?? undefined,
    amount: centsToDollars(r.amountCents),
    type: r.type,
    notes: r.notes ?? undefined,
    splits: splitsByTransaction.get(r.id) ?? [],
  }));
}

export interface TransactionAssignment {
  id: string;
  merchant: string;
  account: string;
  type: TransactionType;
  category: string;
  subCategory: string | null;
  needsReview: boolean;
  splitCount: number;
}

/** One transaction's current assignment, for callers that edit it in place. */
export async function getTransactionAssignment(userId: string, id: string): Promise<TransactionAssignment | null> {
  const [row] = await db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      account: transactions.account,
      type: transactions.type,
      category: transactions.category,
      subCategory: transactions.subCategory,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .limit(1);
  if (!row) return null;
  const splits = await db
    .select({ id: transactionSplits.id })
    .from(transactionSplits)
    .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.transactionId, id)));
  return { ...row, type: row.type as TransactionType, splitCount: splits.length };
}

/**
 * Mark a transaction as reviewed. Optionally patch its category,
 * sub-category, and type in the same call — the carousel's "Categorize"
 * button sends the user's pick here in one round-trip; "Skip" sends
 * an empty patch.
 *
 * Atomic SQL UPDATE with `user_id` predicate so a malicious caller
 * can't mark someone else's transaction reviewed. Returns the
 * refreshed row in the same shape as `getAllTransactions`, or null
 * if the row didn't exist, didn't belong to the user, or was already reviewed.
 */
export async function markTransactionReviewed(
  userId: string,
  id: string,
  patch: {
    category?: string;
    subCategory?: string | null;
    type?: TransactionType;
  } = {},
): Promise<Transaction | null> {
  const [existing] = await db
    .select()
    .from(transactions)
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.id, id),
      eq(transactions.needsReview, true),
    ))
    .limit(1);
  if (!existing) return null;

  const finalCategory = patch.category ?? existing.category;
  const finalSubCategory = patch.subCategory !== undefined ? patch.subCategory : existing.subCategory;
  const finalType = patch.type ?? existing.type;
  const changesAssignment = patch.category !== undefined || patch.subCategory !== undefined || patch.type !== undefined;
  const assignment = changesAssignment && finalSubCategory
    ? await resolveCategoryAssignment(userId, finalCategory, finalSubCategory)
    : null;
  if (
    changesAssignment
    && (!assignment || (assignment.type !== finalType && finalCategory !== 'Pay down goals'))
  ) {
    throw Object.assign(new Error('transaction must use a valid category, subCategory, and matching type'), {
      status: 400,
    });
  }

  const accountMeta = await db
    .select({ name: accounts.name, alias: accounts.alias })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        existing.accountId ? eq(accounts.id, existing.accountId) : eq(accounts.name, existing.account),
      ),
    )
    .limit(1);
  const updated = await db
    .update(transactions)
    .set({
      needsReview: false,
      category: patch.category ?? existing.category,
      subCategory: patch.subCategory !== undefined ? (patch.subCategory ?? null) : existing.subCategory,
      categoryId: changesAssignment ? assignment!.categoryId : existing.categoryId,
      subCategoryId: changesAssignment ? assignment!.subCategoryId : existing.subCategoryId,
      ...(changesAssignment ? { categoryUserModified: true } : {}),
      type: patch.type ?? existing.type,
    })
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.id, id),
      eq(transactions.needsReview, true),
    ))
    .returning({ id: transactions.id });
  if (updated.length === 0) return null;
  return {
    id: existing.id,
    date: existing.date,
    merchant: existing.merchant,
    sourceCategory: existing.sourceCategory,
    sourceSubCategory: existing.sourceSubCategory ?? undefined,
    sourceType: existing.sourceType,
    sourceClassificationTrusted: existing.sourceClassificationTrusted,
    category: patch.category ?? existing.category,
    subCategory:
      patch.subCategory !== undefined ? (patch.subCategory ?? undefined) : (existing.subCategory ?? undefined),
    categoryId: changesAssignment ? assignment!.categoryId : (existing.categoryId ?? undefined),
    subCategoryId: changesAssignment ? assignment!.subCategoryId : (existing.subCategoryId ?? undefined),
    account: accountMeta[0]?.alias || accountMeta[0]?.name || existing.account,
    accountId: existing.accountId ?? undefined,
    amount: centsToDollars(existing.amountCents),
    type: patch.type ?? existing.type,
    notes: existing.notes ?? undefined,
    splits: (await loadTransactionSplits(userId, [existing.id])).get(existing.id) ?? [],
  };
}

/**
 * Bulk-skip every pending review for the user (clear needs_review without
 * changing category). Hidden-account rows are included in the update so
 * they don't reappear if un-hidden later while still flagged.
 */
export async function skipAllPendingReviews(userId: string): Promise<number> {
  const result = await db
    .update(transactions)
    .set({ needsReview: false })
    .where(and(eq(transactions.userId, userId), eq(transactions.needsReview, true)))
    .returning({ id: transactions.id });
  return result.length;
}

// ---- Settings (key-value) -----------------------------------------------

export async function getSetting(userId: string, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, key)))
    .limit(1);
  return row?.value ?? null;
}

export async function setSetting(userId: string, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ userId, key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [settings.userId, settings.key],
      set: { value, updatedAt: new Date() },
    });
}

export async function deleteSetting(userId: string, key: string): Promise<void> {
  await db.delete(settings).where(and(eq(settings.userId, userId), eq(settings.key, key)));
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

// ---- Goals -------------------------------------------------------------

export interface Goal {
  id: string;
  name: string;
  target: number;
  startingValue: number;
  accountId: string | null;
  // The live balance of the watched account, looked up at read time so
  // the progress bar always reflects the freshest figure. Null when
  // the account was deleted/hidden — the UI renders a notice instead
  // of a progress bar in that case.
  accountBalance: number | null;
  accountName: string | null;
}

/**
 * Fetch every goal for the user, with the watched account's current
 * balance joined in. We do the join in code rather than SQL because:
 *   1. The account might be hidden — we still want to return the goal
 *      (with a NULL balance) so the user can re-attach via edit.
 *   2. The account might be deleted — same story.
 *   3. The set is small (goals are personal; ~5-20 rows typical).
 */
export async function getAllGoals(userId: string): Promise<Goal[]> {
  const [goalRows, accountRows] = await Promise.all([
    // rowid breaks createdAt ties in creation order.
    db.select().from(goals).where(eq(goals.userId, userId)).orderBy(asc(goals.createdAt), sql`rowid`),
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        balance: accounts.balance,
      })
      .from(accounts)
      .where(eq(accounts.userId, userId)),
  ]);
  const byId = new Map<string, { name: string; balance: number }>();
  for (const a of accountRows) byId.set(a.id, { name: a.name, balance: a.balance });
  return goalRows.map((g) => {
    const acc = g.accountId ? byId.get(g.accountId) : undefined;
    return {
      id: g.id,
      name: g.name,
      target: g.target,
      startingValue: g.startingValue,
      accountId: g.accountId,
      accountBalance: acc ? acc.balance : null,
      accountName: acc ? acc.name : null,
    };
  });
}

export async function addGoal(
  userId: string,
  input: {
    name: string;
    target: number;
    startingValue: number;
    accountId: string | null;
  },
): Promise<Goal> {
  if (input.accountId && !(await getAccount(userId, input.accountId))) throw new Error('Account not found');
  const id = `goal-${nanoid(10)}`;
  await db.insert(goals).values({
    id,
    userId,
    name: input.name,
    target: input.target,
    startingValue: input.startingValue,
    accountId: input.accountId,
  });
  return {
    id,
    name: input.name,
    target: input.target,
    startingValue: input.startingValue,
    accountId: input.accountId,
    // New goal — balance comes from the joined read, not the add.
    accountBalance: null,
    accountName: null,
  };
}

export async function editGoal(
  userId: string,
  id: string,
  patch: {
    name?: string;
    target?: number;
    startingValue?: number;
    accountId?: string | null;
  },
): Promise<void> {
  if (patch.accountId && !(await getAccount(userId, patch.accountId))) throw new Error('Account not found');
  const [existing] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.id, id)))
    .limit(1);
  if (!existing) return;
  await db
    .update(goals)
    .set({
      name: patch.name ?? existing.name,
      target: patch.target ?? existing.target,
      startingValue: patch.startingValue ?? existing.startingValue,
      // `accountId` uses the explicit `null` check so the user can
      // detach the goal from its watched account. `undefined` means
      // "don't touch"; `null` means "clear".
      accountId: patch.accountId === undefined ? existing.accountId : patch.accountId === null ? null : patch.accountId,
    })
    .where(and(eq(goals.userId, userId), eq(goals.id, id)));
}

export async function deleteGoal(userId: string, id: string): Promise<void> {
  await db.delete(goals).where(and(eq(goals.userId, userId), eq(goals.id, id)));
}

// ---- Rules -------------------------------------------------------------
//
// User-defined source conditions and category/type assignments. Matching is
// exact-or-prefix for merchant text plus optional account/type/category scope.

export interface Rule {
  id: string;
  matchType: 'exact';
  matchValue: string;
  accountId?: string;
  sourceType?: TransactionType;
  sourceCategory?: string;
  sourceSubCategory?: string;
  category: string;
  subCategory?: string;
  categoryId?: string;
  subCategoryId?: string;
  type?: TransactionType;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

function rowToRule(r: typeof rules.$inferSelect): Rule {
  return {
    id: r.id,
    matchType: 'exact',
    matchValue: r.matchValue,
    accountId: r.accountId ?? undefined,
    sourceType: (r.sourceType as TransactionType | null) ?? undefined,
    sourceCategory: r.sourceCategory ?? undefined,
    sourceSubCategory: r.sourceSubCategory ?? undefined,
    category: r.category,
    subCategory: r.subCategory ?? undefined,
    categoryId: r.categoryId ?? undefined,
    subCategoryId: r.subCategoryId ?? undefined,
    type: (r.type as TransactionType | null) ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
  };
}

/** All rules for the user, ordered by match value. */
export async function listRules(userId: string): Promise<Rule[]> {
  const rows = await db.select().from(rules).where(eq(rules.userId, userId)).orderBy(asc(rules.matchValue));
  return rows.map(rowToRule);
}

/** Load every rule row for matching (import hot path). */
export async function listRulesForMatching(
  userId: string,
): Promise<Rule[]> {
  const rows = await db
    .select()
    .from(rules)
    .where(eq(rules.userId, userId));
  const assignments = await db
    .select({ categoryId: categories.id, subCategoryId: subCategories.id, category: categories.name, subCategory: subCategories.name, type: categories.type })
    .from(subCategories)
    .innerJoin(
      categories,
      and(eq(categories.userId, subCategories.userId), eq(categories.id, subCategories.mainCategoryId)),
    )
    .where(eq(categories.userId, userId));
  const valid = uniqueAssignmentsByName(assignments);
  return rows.flatMap((row) => {
    if (row.subCategory == null) return [];
    const assignment = valid.get(`${row.category}\0${row.subCategory}`);
    const validType = assignment
      && ((row.type != null && (row.type === assignment.type || row.category === 'Pay down goals'))
        || (row.type == null && row.category === 'Pay down goals'));
    if (!assignment || !validType) return [];
    return [{
      ...rowToRule(row),
      categoryId: assignment.categoryId,
      subCategoryId: assignment.subCategoryId,
    }];
  });
}

interface RuleWriteInput {
  matchType?: 'exact';
  matchValue: string;
  accountId?: string | null;
  sourceType?: TransactionType | null;
  sourceCategory?: string | null;
  sourceSubCategory?: string | null;
  category: string;
  subCategory?: string;
  type?: TransactionType | null;
}

interface RuleScope {
  matchValue: string;
  accountId?: string | null;
  sourceType?: TransactionType | null;
  sourceCategory?: string | null;
  sourceSubCategory?: string | null;
}

function sameRuleScope(row: typeof rules.$inferSelect, scope: RuleScope): boolean {
  return normalizeMerchant(row.matchValue) === normalizeMerchant(scope.matchValue)
    && (row.accountId ?? null) === (scope.accountId ?? null)
    && (row.sourceType ?? null) === (scope.sourceType ?? null)
    && (row.sourceCategory ?? null) === (scope.sourceCategory ?? null)
    && (row.sourceSubCategory ?? null) === (scope.sourceSubCategory ?? null);
}

function isBroadRule(row: typeof rules.$inferSelect): boolean {
  return row.accountId == null
    && row.sourceType == null
    && row.sourceCategory == null
    && row.sourceSubCategory == null;
}

async function findRuleByScope(userId: string, scope: RuleScope): Promise<typeof rules.$inferSelect | null> {
  const rows = await db.select().from(rules).where(eq(rules.userId, userId));
  return rows.find((row) => sameRuleScope(row, scope)) ?? null;
}

export async function createRule(
  userId: string,
  input: RuleWriteInput,
): Promise<Rule> {
  const id = `rule-${nanoid(10)}`;
  const matchType = input.matchType ?? 'exact';
  const trimmed = input.matchValue.trim();
  if (!trimmed) throw new Error('matchValue must not be empty');
  const assignment = input.subCategory ? await resolveCategoryAssignment(userId, input.category, input.subCategory) : null;
  if (!assignment || !input.type || (assignment.type !== input.type && input.category !== 'Pay down goals')) {
    throw Object.assign(new Error('Rule must set a valid category, subCategory, and matching type'), { status: 400 });
  }
  const inserted = await db
    .insert(rules)
    .values({
      id,
      userId,
      matchType,
      matchValue: trimmed,
      accountId: input.accountId ?? null,
      sourceType: input.sourceType ?? null,
      sourceCategory: input.sourceCategory ?? null,
      sourceSubCategory: input.sourceSubCategory ?? null,
      category: input.category,
      subCategory: input.subCategory ?? null,
      categoryId: assignment.categoryId,
      subCategoryId: assignment.subCategoryId,
      type: input.type ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    throw Object.assign(new Error('A rule with the same match conditions already exists'), { status: 409 });
  }
  return rowToRule(inserted[0]!);
}

export async function editRule(
  userId: string,
  id: string,
  patch: {
    matchValue?: string;
    accountId?: string | null;
    sourceType?: TransactionType | null;
    sourceCategory?: string | null;
    sourceSubCategory?: string | null;
    category?: string;
    subCategory?: string | null;
    type?: TransactionType | null;
  },
  expectedVersion?: number,
  ): Promise<Rule> {
  const [existing] = await db
    .select()
    .from(rules)
    .where(and(eq(rules.userId, userId), eq(rules.id, id)))
    .limit(1);
  if (!existing) throw Object.assign(new Error('Rule not found'), { status: 404 });
  const nextMatchValue = patch.matchValue?.trim() ?? existing.matchValue;
  if (!nextMatchValue) throw new Error('matchValue must not be empty');
  const nextSourceCategory = patch.sourceCategory === undefined ? existing.sourceCategory : patch.sourceCategory;
  const nextScope: RuleScope = {
    matchValue: nextMatchValue,
    accountId: patch.accountId === undefined ? existing.accountId : patch.accountId,
    sourceType: patch.sourceType === undefined ? existing.sourceType : patch.sourceType,
    sourceCategory: nextSourceCategory,
    sourceSubCategory: nextSourceCategory == null
      ? null
      : patch.sourceSubCategory === undefined ? existing.sourceSubCategory : patch.sourceSubCategory,
  };
  if ((nextScope.sourceCategory == null) !== (nextScope.sourceSubCategory == null)) {
    throw Object.assign(new Error('sourceCategory and sourceSubCategory must be set together'), { status: 400 });
  }
  const duplicate = await findRuleByScope(userId, nextScope);
  if (duplicate && duplicate.id !== id) {
    throw Object.assign(new Error('A rule with the same match conditions already exists'), { status: 409 });
  }
  const nextCategory = patch.category ?? existing.category;
  const nextSubCategory = patch.subCategory === undefined ? existing.subCategory : patch.subCategory;
  const nextType = patch.type === undefined ? existing.type : patch.type;
  const targetIsValid = nextSubCategory
    && (nextType
      ? await transactionAssignmentExists(userId, nextCategory, nextSubCategory, nextType)
      : nextCategory === 'Pay down goals'
        && await categoryAssignmentExists(userId, nextCategory, nextSubCategory));
  if (!targetIsValid) {
    throw Object.assign(new Error('Rule must set a valid category, subCategory, and matching type'), { status: 400 });
  }
  const assignment = await resolveCategoryAssignment(userId, nextCategory, nextSubCategory!);
  if (!assignment) throw Object.assign(new Error('Rule target is ambiguous or no longer exists'), { status: 400 });
  const updated = await db
    .update(rules)
    .set({
      matchValue: nextMatchValue,
      accountId: nextScope.accountId ?? null,
      sourceType: nextScope.sourceType ?? null,
      sourceCategory: nextScope.sourceCategory ?? null,
      sourceSubCategory: nextScope.sourceSubCategory ?? null,
      category: patch.category ?? existing.category,
      // `subCategory` / `type` use explicit `null` so the user can clear
      // them. `undefined` means "don't touch".
      subCategory:
        patch.subCategory === undefined ? existing.subCategory : patch.subCategory === null ? null : patch.subCategory,
      categoryId: assignment.categoryId,
      subCategoryId: assignment.subCategoryId,
      type: patch.type === undefined ? existing.type : patch.type === null ? null : patch.type,
      updatedAt: new Date(),
      version: sql`${rules.version} + 1`,
    })
    .where(and(
      eq(rules.userId, userId),
      eq(rules.id, id),
      expectedVersion !== undefined ? eq(rules.version, expectedVersion) : undefined,
    ))
    .returning();
  if (updated.length === 0) {
    throw Object.assign(new Error('The rule changed before confirmation; review it and try again'), { status: 409 });
  }
  return rowToRule(updated[0]!);
}

export async function deleteRule(userId: string, id: string): Promise<void> {
  await db.delete(rules).where(and(eq(rules.userId, userId), eq(rules.id, id)));
}

export type RuleFromTransactionResult =
  | { status: 'created' | 'narrowed' | 'updated' | 'unchanged'; rule: Rule }
  | { status: 'confirmation_required'; rule: Rule };

/** Build a fully-scoped rule from immutable source values and current assignment. */
export async function createRuleFromTransaction(
  userId: string,
  transactionId: string,
  replaceRuleId?: string,
  expectedVersion?: number,
): Promise<RuleFromTransactionResult> {
  const [transaction] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, transactionId)))
    .limit(1);
  if (!transaction) throw Object.assign(new Error('Transaction not found'), { status: 404 });
  if (
    !transaction.subCategory
    || !(await transactionAssignmentExists(userId, transaction.category, transaction.subCategory, transaction.type))
  ) {
    throw Object.assign(new Error('Transaction must have a valid category assignment'), { status: 400 });
  }
  const account = transaction.accountId
    ? { id: transaction.accountId }
    : await resolveTransactionAccount(userId, transaction.account);
  const input: RuleWriteInput = {
    matchValue: transaction.merchant,
    accountId: account.id,
    sourceType: transaction.sourceClassificationTrusted ? transaction.sourceType : null,
    sourceCategory: transaction.sourceClassificationTrusted && transaction.sourceSubCategory
      ? transaction.sourceCategory
      : null,
    sourceSubCategory: transaction.sourceClassificationTrusted ? transaction.sourceSubCategory : null,
    category: transaction.category,
    subCategory: transaction.subCategory,
    type: transaction.type,
  };
  const userRules = await db.select().from(rules).where(eq(rules.userId, userId));
  const scoped = userRules.find((row) => sameRuleScope(row, input));
  const broad = pickBestRuleMatch({
    merchant: transaction.merchant,
    accountId: account.id,
    sourceType: transaction.sourceType,
    sourceCategory: transaction.sourceCategory,
    sourceSubCategory: transaction.sourceSubCategory ?? undefined,
  }, userRules.filter(isBroadRule));
  const conflict = scoped ?? broad;
  if (conflict) {
    const narrowingBroad = broad?.id === conflict.id;
    const assignmentMatches = conflict.category === input.category
      && (conflict.subCategory ?? null) === (input.subCategory ?? null)
      && (conflict.type ?? null) === (input.type ?? null);
    if (scoped && assignmentMatches) return { status: 'unchanged', rule: rowToRule(conflict) };
    if (replaceRuleId !== conflict.id) {
      return { status: 'confirmation_required', rule: rowToRule(conflict) };
    }
    if (expectedVersion === undefined || conflict.version !== expectedVersion) {
      return { status: 'confirmation_required', rule: rowToRule(conflict) };
    }
    const updated = await editRule(userId, conflict.id, {
      matchValue: narrowingBroad ? conflict.matchValue : input.matchValue,
      accountId: input.accountId,
      sourceType: input.sourceType,
      sourceCategory: input.sourceCategory,
      sourceSubCategory: input.sourceSubCategory,
      category: input.category,
      subCategory: input.subCategory,
      type: input.type,
    }, conflict.version);
    return { status: narrowingBroad ? 'narrowed' : 'updated', rule: updated };
  }
  if (replaceRuleId) {
    throw Object.assign(new Error('The rule changed before confirmation; review it and try again'), { status: 409 });
  }
  try {
    return { status: 'created', rule: await createRule(userId, input) };
  } catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
    const raced = await findRuleByScope(userId, input);
    if (
      raced
      && raced.category === input.category
      && (raced.subCategory ?? null) === (input.subCategory ?? null)
      && (raced.type ?? null) === (input.type ?? null)
    ) {
      return { status: 'unchanged', rule: rowToRule(raced) };
    }
    throw error;
  }
}

/**
 * Re-apply a single rule to every matching transaction in the user's
 * ledger. The "Run" (▶) button on the Rules page. Returns the number
 * of rows whose category/subCategory/type was actually changed so the
 * route can show an accurate "Updated N transactions" toast.
 *
 * Matching uses the same exact-or-prefix rules as import. Type is
 * only written when the rule has a non-null type.
 */
export async function applyRuleToAllMatchingTransactions(userId: string, ruleId: string): Promise<{ updated: number }> {
  const [rule] = await db
    .select()
    .from(rules)
    .where(and(eq(rules.userId, userId), eq(rules.id, ruleId)))
    .limit(1);
  if (!rule) throw new Error('Rule not found');
  const allRules = await listRulesForMatching(userId);
  const resolvedRule = allRules.find((candidate) => candidate.id === rule.id);
  if (!resolvedRule) {
    throw new Error('Rule must assign a valid sub-category and matching type before it can run');
  }

  const candidates = await db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      accountId: transactions.accountId,
      sourceCategory: transactions.sourceCategory,
      sourceSubCategory: transactions.sourceSubCategory,
      sourceType: transactions.sourceType,
      sourceClassificationTrusted: transactions.sourceClassificationTrusted,
      category: transactions.category,
      subCategory: transactions.subCategory,
      type: transactions.type,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.categoryUserModified, false),
      sql`NOT (${hasSplitSql()})`,
    ));

  const idsToUpdate: string[] = [];
  for (const row of candidates) {
    const best = pickBestRuleMatch({
      merchant: row.merchant,
      accountId: row.accountId ?? undefined,
      sourceCategory: row.sourceCategory,
      sourceSubCategory: row.sourceSubCategory ?? undefined,
      sourceType: row.sourceType,
      sourceClassificationTrusted: row.sourceClassificationTrusted,
    }, allRules);
    if (best?.id !== rule.id) continue;
    const catDiff = row.category !== resolvedRule.category;
    const subDiff = (row.subCategory ?? null) !== (resolvedRule.subCategory ?? null);
    const typeDiff = resolvedRule.type != null && row.type !== resolvedRule.type;
    if (catDiff || subDiff || typeDiff || row.needsReview) idsToUpdate.push(row.id);
  }

  if (idsToUpdate.length === 0) return { updated: 0 };

  await db
    .update(transactions)
    .set({
      category: resolvedRule.category,
      subCategory: resolvedRule.subCategory,
      categoryId: resolvedRule.categoryId,
      subCategoryId: resolvedRule.subCategoryId,
      ...(resolvedRule.type != null ? { type: resolvedRule.type } : {}),
      needsReview: false,
    })
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.categoryUserModified, false),
      inArray(transactions.id, idsToUpdate),
    ));

  return { updated: idsToUpdate.length };
}

/**
 * Re-apply every rule to the user's ledger in one pass. For each
 * transaction, picks the best matching rule (longest matchValue, same
 * as import) and updates category/subCategory/type when they differ.
 * Grouped by rule so each category set is one bulk UPDATE.
 *
 * Used by the "Run all rules" button on the Rules page.
 */
export async function applyAllRulesToMatchingTransactions(userId: string): Promise<{ updated: number }> {
  const ruleRows = await listRulesForMatching(userId);
  if (ruleRows.length === 0) return { updated: 0 };

  const candidates = await db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      accountId: transactions.accountId,
      sourceCategory: transactions.sourceCategory,
      sourceSubCategory: transactions.sourceSubCategory,
      sourceType: transactions.sourceType,
      sourceClassificationTrusted: transactions.sourceClassificationTrusted,
      category: transactions.category,
      subCategory: transactions.subCategory,
      type: transactions.type,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.categoryUserModified, false),
      sql`NOT (${hasSplitSql()})`,
    ));

  // ruleId → transaction ids that need that rule's category applied
  const byRule = new Map<string, string[]>();
  for (const row of candidates) {
    const best = pickBestRuleMatch({
      merchant: row.merchant,
      accountId: row.accountId ?? undefined,
      sourceCategory: row.sourceCategory,
      sourceSubCategory: row.sourceSubCategory ?? undefined,
      sourceType: row.sourceType,
      sourceClassificationTrusted: row.sourceClassificationTrusted,
    }, ruleRows);
    if (!best) continue;
    const catDiff = row.category !== best.category;
    const subDiff = (row.subCategory ?? null) !== (best.subCategory ?? null);
    const typeDiff = best.type != null && row.type !== best.type;
    if (!catDiff && !subDiff && !typeDiff && !row.needsReview) continue;
    const list = byRule.get(best.id) ?? [];
    list.push(row.id);
    byRule.set(best.id, list);
  }

  let updated = 0;
  for (const rule of ruleRows) {
    const ids = byRule.get(rule.id);
    if (!ids?.length) continue;
    await db
      .update(transactions)
      .set({
        category: rule.category,
        subCategory: rule.subCategory,
        categoryId: rule.categoryId,
        subCategoryId: rule.subCategoryId,
        ...(rule.type != null ? { type: rule.type } : {}),
        needsReview: false,
      })
      .where(and(
        eq(transactions.userId, userId),
        eq(transactions.categoryUserModified, false),
        inArray(transactions.id, ids),
      ));
    updated += ids.length;
  }

  return { updated };
}

// ---- Users (admin) ------------------------------------------------------

/** True if this user has a credential (email/password) account row. */
export async function userHasCredential(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')))
    .limit(1);
  return rows.length > 0;
}

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: string | null;
  createdAt: Date;
  hasCredential: boolean;
  hasOidc: boolean;
  /** Comma-separated list of provider IDs (e.g. "pocketid,credential"). */
  providers: string;
  /** True when demoting/deleting this admin would lock the operator out. */
  isProtected: boolean;
  /** Why this admin is locked (used for the UI tooltip). */
  protectionReason: AdminProtectionReason | null;
}

export type AdminProtectionReason = 'last_admin' | 'last_local_admin' | 'last_oidc_admin_when_local_disabled';

/**
 * Single source of truth for the "can this admin be removed?" question.
 * Used by the role-change + delete guards and by the admin UI's lock icon,
 * so the UI and the server can't disagree about who is protected.
 *
 * Rules:
 *   - Non-admin users are never protected.
 *   - The last remaining admin overall is always protected (would leave
 *     the instance with zero admins).
 *   - A local admin is protected when they are the only local admin AND
 *     local auth is still enabled (they are the only recovery path).
 *   - An OIDC admin is protected when they are the only OIDC admin AND
 *     local auth is disabled (they are the only sign-in path).
 */
export function computeIsProtected(
  user: {
    id: string;
    role: string | null;
    hasCredential: boolean;
    hasOidc?: boolean;
  },
  allUsers: Array<{
    id: string;
    role: string | null;
    hasCredential: boolean;
    hasOidc?: boolean;
  }>,
  localAuthDisabled: boolean,
): { isProtected: boolean; reason: AdminProtectionReason | null } {
  if (user.role !== 'admin') return { isProtected: false, reason: null };

  const admins = allUsers.filter((u) => u.role === 'admin');
  const localAdmins = admins.filter((u) => u.hasCredential);
  const oidcAdmins = admins.filter((u) => u.hasOidc);

  const remainingTotal = admins.length - 1;
  if (remainingTotal === 0) return { isProtected: true, reason: 'last_admin' };

  if (user.hasCredential) {
    const remainingLocal = localAdmins.length - 1;
    if (remainingLocal === 0 && !localAuthDisabled) {
      return { isProtected: true, reason: 'last_local_admin' };
    }
  }

  if (user.hasOidc) {
    const remainingOidc = oidcAdmins.length - 1;
    if (remainingOidc === 0 && localAuthDisabled) {
      return {
        isProtected: true,
        reason: 'last_oidc_admin_when_local_disabled',
      };
    }
  }

  return { isProtected: false, reason: null };
}

/**
 * List every user with their provider(s) and computed protection state.
 * The protection calculation needs `localAuthDisabled` because OIDC admins
 * become the only recovery path once local auth is off.
 */
export async function getAllUsers(localAuthDisabled: boolean): Promise<AdminUserRow[]> {
  const rows = await db
    .select({
      id: authUser.id,
      name: authUser.name,
      email: authUser.email,
      role: authUser.role,
      createdAt: authUser.createdAt,
      providerId: authAccount.providerId,
      activeOidcProviderId: oidcProviders.providerId,
    })
    .from(authUser)
    .leftJoin(authAccount, eq(authAccount.userId, authUser.id))
    .leftJoin(oidcProviders, and(
      eq(oidcProviders.providerId, authAccount.providerId),
      eq(oidcProviders.isActive, true),
    ))
    .orderBy(asc(authUser.createdAt));

  // Group providers per user.
  const byId = new Map<string, AdminUserRow>();
  for (const r of rows) {
    let row = byId.get(r.id);
    if (!row) {
      row = {
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        createdAt: r.createdAt,
        hasCredential: false,
        hasOidc: false,
        providers: '',
        isProtected: false,
        protectionReason: null,
      };
      byId.set(r.id, row);
    }
    if (r.providerId) {
      if (r.providerId === 'credential') row.hasCredential = true;
      else if (r.activeOidcProviderId) row.hasOidc = true;
      const list = row.providers ? row.providers.split(',') : [];
      if (!list.includes(r.providerId)) list.push(r.providerId);
      row.providers = list.join(',');
    }
  }
  const allUsers = Array.from(byId.values());
  // Compute protection per row in a second pass so each call sees the
  // full roster (the helper needs the full list to count "other admins").
  for (const u of allUsers) {
    const { isProtected, reason } = computeIsProtected(u, allUsers, localAuthDisabled);
    u.isProtected = isProtected;
    u.protectionReason = reason;
  }
  return allUsers;
}

interface AdminRosterRow {
  id: string;
  role: string | null;
  hasCredential: boolean;
  hasOidc: boolean;
}

/** Every user with the sign-in methods that decide admin protection. */
async function adminRoster(): Promise<AdminRosterRow[]> {
  const rows = await sqlAll<{ id: string; role: string | null; hasCredential: number; hasOidc: number }>(sql`
    SELECT u.id, u.role,
      EXISTS (SELECT 1 FROM "account" a WHERE a.user_id = u.id AND a.provider_id = 'credential') AS "hasCredential",
      EXISTS (
        SELECT 1 FROM "account" a
        JOIN oidc_providers p ON p.provider_id = a.provider_id AND p.is_active = 1
        WHERE a.user_id = u.id
      ) AS "hasOidc"
    FROM "user" u
  `);
  return rows.map((row) => ({ ...row, hasCredential: row.hasCredential === 1, hasOidc: row.hasOidc === 1 }));
}

/**
 * Delete a user and all of their data. The financial tables
 * (transactions, accounts, categories, sub_categories, monthly_budgets,
 * settings) have no ON DELETE CASCADE on `user_id`, so we delete them
 * manually first. The auth `user` row cascades to `session` and
 * `account` automatically.
 *
 * Returns the number of rows deleted (summed across all the data
 * tables) so the admin UI can show "deleted 47 rows of data".
 *
 * Throws if `userId` is a protected admin — uses the same
 * `computeIsProtected` helper that the UI shows the lock icon from, so
 * the server can never reach a zero-admin state through delete.
 */
export async function deleteUserWithData(userId: string): Promise<{ deletedRows: number }> {
  const deletedRows = await db.transaction(async (tx) => {
    const [state] = await tx
      .select({ localAuthDisabled: setupState.localAuthDisabled })
      .from(setupState)
      .where(eq(setupState.id, 1))
      .limit(1);
    const roster = await adminRoster();
    const target = roster.find((row) => row.id === userId);
    if (!target) throw new Error('User not found');
    const { isProtected, reason } = computeIsProtected(target, roster, state?.localAuthDisabled ?? false);
    if (isProtected) throw new Error(protectionMessage(reason));

    let n = 0;
    for (const tbl of [
      transactions,
      monthlyBudgets,
      monthlyPaydown,
      monthlyPaydownSnapshots,
      goals,
      rules,
      subCategories,
      categories,
      accounts,
      settings,
    ]) {
      const r = await tx.delete(tbl).where(eq(tbl.userId, userId)).returning({ userId: tbl.userId });
      n += r.length;
    }
    // Delete the user last. Cascades to session + account (auth).
    const r = await tx.delete(authUser).where(eq(authUser.id, userId)).returning({ id: authUser.id });
    n += r.length;
    return n;
  });

  return { deletedRows };
}

/**
 * Update a user's role. Used by the admin UI to promote OIDC users to
 * admin (or demote them). Better Auth's admin plugin stores the role on
 * the `user` row as a free-form text column with two meaningful values:
 * `'admin'` and `'user'` (null also means a regular user).
 *
 * Throws if the target user is the last remaining local admin and the
 * caller is trying to demote them — same guard as delete. When local
 * auth is disabled, the final admin linked to an active OIDC provider
 * is protected instead.
 */
export async function updateUserRole(
  userId: string,
  role: 'admin' | 'user',
): Promise<{ id: string; role: string | null }> {
  if (role !== 'admin' && role !== 'user') {
    throw new Error('role must be "admin" or "user"');
  }
  const nextRole = role === 'admin' ? 'admin' : null;
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select({ localAuthDisabled: setupState.localAuthDisabled })
      .from(setupState)
      .where(eq(setupState.id, 1))
      .limit(1);
    const roster = await adminRoster();
    const target = roster.find((row) => row.id === userId);
    if (!target) throw new Error('User not found');
    if (target.role === 'admin' && role !== 'admin') {
      const { isProtected, reason } = computeIsProtected(target, roster, state?.localAuthDisabled ?? false);
      if (isProtected) throw new Error(protectionMessage(reason));
    }
    await tx.update(authUser).set({ role: nextRole, updatedAt: new Date() }).where(eq(authUser.id, userId));
    return { id: userId, role: nextRole };
  });
}

/**
 * Human-readable message for a protection reason. Used by the route
 * layer's error path so the toast/error text matches what the UI's
 * lock-icon tooltip says.
 */
function protectionMessage(reason: AdminProtectionReason | null): string {
  switch (reason) {
    case 'last_admin':
      return 'Cannot demote or delete the only admin — promote another user to admin first.';
    case 'last_local_admin':
      return 'Cannot demote or delete the last local admin — promote another user to admin first.';
    case 'last_oidc_admin_when_local_disabled':
      return 'Cannot demote or delete the last OIDC admin while local auth is disabled — promote another OIDC user to admin first.';
    default:
      return 'This user is protected.';
  }
}

// ---- Reports aggregates ---------------------------------------------------
//
// Report series helpers are read-only, userId-scoped, and use the same
// account exclusion policy as Transactions, Dashboard, and Budget. The page
// calls a matching endpoint per chart so the client never re-aggregates.

/**
 * Returns 'YYYY-MM-DD' for the last day of `yearMonth`. Uses date math
 * (day 0 of next month) so it handles month-length correctly without a
 * lookup table — leap-year-safe.
 */
function endOfMonth(yearMonth: string): string {
  const [yStr, mStr] = yearMonth.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this month
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

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

interface EffectiveLedgerAllocation {
  transactionId: string;
  date: string;
  merchant: string;
  accountId: string | null;
  account: string;
  amountCents: number;
  category: string;
  subCategory: string | null;
  type: TransactionType;
}

/** One row per effective allocation: children replace, rather than supplement, a split parent. */
async function loadEffectiveLedgerAllocations(
  userId: string,
  fromDate: string,
  toDate: string,
): Promise<EffectiveLedgerAllocation[]> {
  const { excludedIds, excludedNames } = await loadAccountLedgerMeta(userId);
  const conditions = [
    eq(transactions.userId, userId),
    eq(transactions.needsReview, false),
    gte(transactions.date, fromDate),
    lte(transactions.date, toDate),
  ];
  const visibility = ledgerVisibilityCondition(excludedIds, excludedNames);
  if (visibility) conditions.push(visibility);
  const rows = await db
    .select({
      transactionId: transactions.id,
      date: transactions.date,
      merchant: transactions.merchant,
      accountId: transactions.accountId,
      account: transactions.account,
      parentAmountCents: transactions.amountCents,
      parentCategory: transactions.category,
      parentSubCategory: transactions.subCategory,
      parentType: transactions.type,
      splitId: transactionSplits.id,
      splitAmountCents: transactionSplits.amountCents,
      splitCategory: transactionSplits.category,
      splitSubCategory: transactionSplits.subCategory,
      splitType: transactionSplits.type,
    })
    .from(transactions)
    .leftJoin(
      transactionSplits,
      and(
        eq(transactionSplits.userId, transactions.userId),
        eq(transactionSplits.transactionId, transactions.id),
      ),
    )
    .where(and(...conditions));
  return rows.map((row) => ({
    transactionId: row.transactionId,
    date: row.date,
    merchant: row.merchant,
    accountId: row.accountId,
    account: row.account,
    amountCents: row.splitId ? row.splitAmountCents! : row.parentAmountCents,
    category: row.splitId ? row.splitCategory! : row.parentCategory,
    subCategory: row.splitId ? row.splitSubCategory! : row.parentSubCategory,
    type: row.splitId ? row.splitType! : row.parentType,
  }));
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

export async function countStaleSimpleFinPending(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.sourcePending, true),
        lte(transactions.sourceLastSeenAt, cutoff),
      ),
    );
  return row?.count ?? 0;
}

// ---- Recurring charges detection ----------------------------------------

export interface RecurringCharge {
  merchant: string;
  amount: number;
  frequency: 'weekly' | 'monthly' | 'yearly';
  occurrences: number;
  lastDate: string;
  category: string;
  account: string;
  accountId?: string;
}

export interface RecurringTransactionMetadata {
  merchant: string;
  amount: number;
  account: string;
  accountId?: string;
  lastDate: string;
  category: string;
}

interface RecurringTransactionIdentity {
  merchant: string;
  amount?: number;
  account?: string;
  accountId?: string;
  type?: TransactionType;
}

/** Resolve the latest matching occurrence and its stable account identity. */
export async function resolveRecurringTransactionMetadata(
  userId: string,
  identity: RecurringTransactionIdentity,
): Promise<RecurringTransactionMetadata | null> {
  const { meta, byName } = await loadAccountLedgerMeta(userId);
  const conditions = [eq(transactions.userId, userId)];
  if (identity.type) conditions.push(eq(transactions.type, identity.type));

  // Merchant names are matched case-insensitively in JS: SQLite's lower()
  // only folds ASCII letters.
  const merchant = identity.merchant.toLowerCase();
  const rows = (await db
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.date), desc(transactions.createdAt), desc(transactions.id)))
    .filter((row) => row.merchant.toLowerCase() === merchant);

  const accountLabel = identity.account?.toLowerCase();
  for (const row of rows) {
    const accountMeta = transactionAccountMeta(row, meta, byName);
    const stableAccountId = accountMeta?.id ?? row.accountId ?? undefined;
    if (identity.accountId && stableAccountId !== identity.accountId) continue;
    if (!identity.accountId && accountLabel) {
      const labels = [row.account, accountMeta?.name, accountMeta?.alias]
        .filter((label): label is string => !!label)
        .map((label) => label.toLowerCase());
      if (!labels.includes(accountLabel)) continue;
    }
    return {
      merchant: row.merchant,
      amount: centsToDollars(row.amountCents),
      account: accountMeta?.alias || accountMeta?.name || row.account,
      accountId: stableAccountId,
      lastDate: row.date,
      category: row.category,
    };
  }
  return null;
}

/** Resolve a transaction-based mark without trusting UI-supplied metadata. */
export async function getRecurringTransactionMetadata(
  userId: string,
  transactionId: string,
): Promise<RecurringTransactionMetadata | null> {
  const [source] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, transactionId)))
    .limit(1);
  if (!source) return null;

  const { meta, byName } = await loadAccountLedgerMeta(userId);
  const accountMeta = transactionAccountMeta(source, meta, byName);
  return resolveRecurringTransactionMetadata(userId, {
    merchant: source.merchant,
    account: accountMeta?.alias || accountMeta?.name || source.account,
    accountId: accountMeta?.id ?? source.accountId ?? undefined,
    type: source.type,
  });
}

const CADENCE_PERIODS: {
  frequency: 'weekly' | 'monthly' | 'yearly';
  period: number;
}[] = [
  { frequency: 'weekly', period: 7 },
  { frequency: 'monthly', period: 30.44 },
  { frequency: 'yearly', period: 365.25 },
];

/** Whole UTC days between two `YYYY-MM-DD` strings (timezone-safe). */
function daysBetweenYmd(a: string, b: string): number {
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(a);
  const pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b);
  if (!pa || !pb) return NaN;
  const ta = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const tb = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return (tb - ta) / 86_400_000;
}

function todayYmdUtc(): string {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-${String(n.getUTCDate()).padStart(2, '0')}`;
}

interface CadenceFit {
  frequency: 'weekly' | 'monthly' | 'yearly';
  score: number;
  lastDate: string;
  occurrences: number;
}

/** Fit a sorted unique date series to weekly/monthly/yearly. */
function fitCadence(dates: string[], today: string): CadenceFit | null {
  const sortedDates = [...new Set(dates)].sort();
  if (sortedDates.length < 3) return null;

  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const gap = daysBetweenYmd(sortedDates[i - 1]!, sortedDates[i]!);
    if (!Number.isFinite(gap) || gap <= 0) continue;
    gaps.push(gap);
  }
  if (gaps.length < 2) return null;

  const avgGap = gaps.reduce((s, x) => s + x, 0) / gaps.length;
  if (avgGap <= 0) return null;
  const variance = gaps.reduce((s, x) => s + (x - avgGap) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / avgGap;
  if (cv > 0.35) return null;

  const first = sortedDates[0]!;
  const last = sortedDates[sortedDates.length - 1]!;
  const span = daysBetweenYmd(first, last);
  const age = daysBetweenYmd(last, today);

  let best: { frequency: CadenceFit['frequency']; score: number } | null = null;
  for (const { frequency, period } of CADENCE_PERIODS) {
    const relErr = Math.abs(avgGap - period) / period;
    if (relErr > 0.25) continue;
    if (span < 1.5 * period) continue;
    if (age > 2 * period) continue;
    if (!best || relErr < best.score) best = { frequency, score: relErr };
  }
  if (!best) return null;

  return {
    frequency: best.frequency,
    score: best.score,
    lastDate: last,
    occurrences: sortedDates.length,
  };
}

/**
 * Detect recurring charges: same merchant + account, with a regular
 * cadence. Amount is the latest charge so a price change (Netflix
 * $15.99 → $19.99) updates the existing row instead of opening a new
 * one. Gates (all must pass for a candidate frequency):
 *   - ≥ 3 distinct posting dates
 *   - mean gap within 25% of the period (weekly 7d / monthly 30.44d /
 *     yearly 365.25d)
 *   - coefficient of variation of gaps ≤ 0.35
 *   - span (last − first) ≥ 1.5 × period
 *   - last charge within 2 × period of today (drops stale patterns)
 * If the full merchant series does not fit (mixed one-offs + a sub),
 * fall back to the best same-amount cluster on that merchant+account.
 * Best-fitting frequency wins; groups that fit none are dropped.
 */
export async function getRecurringCharges(userId: string): Promise<RecurringCharge[]> {
  const { meta, byName } = await loadAccountLedgerMeta(userId);

  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.type, 'expense'),
        eq(transactions.needsReview, false),
      ),
    )
    .orderBy(desc(transactions.date), desc(transactions.createdAt), desc(transactions.id));

  const groups = new Map<
    string,
    {
      merchant: string;
      amountCents: number;
      category: string;
      account: string;
      accountId?: string;
      items: { date: string; amountCents: number; category: string }[];
    }
  >();

  for (const r of rows) {
    const accountMeta = transactionAccountMeta(r, meta, byName);
    if (isLedgerExcluded(accountMeta)) continue;
    const stableAccountId = accountMeta?.id ?? r.accountId ?? undefined;
    const accountIdentity = stableAccountId ?? r.account.toLowerCase();
    const key = `${r.merchant.toLowerCase()}|${accountIdentity}`;
    const existing = groups.get(key);
    const item = { date: r.date, amountCents: r.amountCents, category: r.category };
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, {
        merchant: r.merchant,
        amountCents: r.amountCents,
        category: r.category,
        account: accountMeta?.alias || accountMeta?.name || r.account,
        accountId: stableAccountId,
        items: [item],
      });
    }
  }

  const today = todayYmdUtc();
  const results: RecurringCharge[] = [];

  for (const g of groups.values()) {
    const merchantFit = fitCadence(g.items.map((item) => item.date), today);
    if (merchantFit) {
      results.push({
        merchant: g.merchant,
        amount: centsToDollars(g.amountCents),
        frequency: merchantFit.frequency,
        occurrences: merchantFit.occurrences,
        lastDate: merchantFit.lastDate,
        category: g.category,
        account: g.account,
        accountId: g.accountId,
      });
      continue;
    }

    const byAmount = new Map<number, { dates: string[]; category: string }>();
    for (const item of g.items) {
      const cluster = byAmount.get(item.amountCents);
      if (cluster) {
        cluster.dates.push(item.date);
      } else {
        byAmount.set(item.amountCents, { dates: [item.date], category: item.category });
      }
    }

    let bestCluster: { amountCents: number; fit: CadenceFit; category: string } | null = null;
    for (const [amountCents, cluster] of byAmount) {
      const fit = fitCadence(cluster.dates, today);
      if (!fit) continue;
      if (
        !bestCluster
        || fit.occurrences > bestCluster.fit.occurrences
        || (fit.occurrences === bestCluster.fit.occurrences && fit.lastDate > bestCluster.fit.lastDate)
        || (
          fit.occurrences === bestCluster.fit.occurrences
          && fit.lastDate === bestCluster.fit.lastDate
          && amountCents > bestCluster.amountCents
        )
      ) {
        bestCluster = { amountCents, fit, category: cluster.category };
      }
    }
    if (!bestCluster) continue;

    results.push({
      merchant: g.merchant,
      amount: centsToDollars(bestCluster.amountCents),
      frequency: bestCluster.fit.frequency,
      occurrences: bestCluster.fit.occurrences,
      lastDate: bestCluster.fit.lastDate,
      category: bestCluster.category,
      account: g.account,
      accountId: g.accountId,
    });
  }

  results.sort((a, b) => b.lastDate.localeCompare(a.lastDate) || b.amount - a.amount);
  return results;
}
