import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { accounts } from '../schema/accounts';
import { transactions } from '../schema/transactions';
import { centsToDollars } from '@/lib/money';
import { resolveCategoryAssignment } from './category-assignments';
import { ledgerVisibilityCondition, loadAccountLedgerMeta, loadTransactionSplits, transactionAccountMeta } from './ledger';
import type { Transaction, TransactionType } from './types';

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

