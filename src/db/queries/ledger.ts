import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../client';
import { accounts } from '../schema/accounts';
import { transactions } from '../schema/transactions';
import { transactionSplits } from '../schema/transaction_splits';
import { centsToDollars } from '@/lib/money';
import type { AccountType, TransactionSplit, TransactionType } from './types';

/**
 * Per-account display/visibility metadata used by every ledger read.
 * Investment accounts are balance-only. Uncategorized account activity is
 * retained but held out of the ledger until the user chooses a type.
 */
export interface AccountLedgerMeta {
  id: string;
  name: string;
  hidden: boolean;
  type: AccountType;
  alias: string | null;
}

export function isLedgerExcluded(m: AccountLedgerMeta | undefined): boolean {
  // Unknown account names (orphan txs) stay visible so data isn't
  // silently lost; only known hidden/investment/uncategorized accounts
  // are dropped.
  if (!m) return false;
  return m.hidden || m.type === 'investment' || m.type === 'uncategorized';
}

export async function loadAccountLedgerMeta(userId: string): Promise<{
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

export function transactionAccountMeta(
  row: { accountId: string | null; account: string },
  meta: Map<string, AccountLedgerMeta>,
  byName: Map<string, AccountLedgerMeta>,
): AccountLedgerMeta | undefined {
  return (row.accountId ? meta.get(row.accountId) : undefined) ?? byName.get(row.account);
}

export function ledgerVisibilityCondition(excludedIds: string[], excludedNames: string[]) {
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

export async function resolveTransactionAccount(
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

export async function loadTransactionSplits(userId: string, transactionIds: string[]): Promise<Map<string, TransactionSplit[]>> {
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

export function hasSplitSql() {
  return sql`EXISTS (
    SELECT 1 FROM ${transactionSplits}
    WHERE ${transactionSplits.userId} = ${transactions.userId}
      AND ${transactionSplits.transactionId} = ${transactions.id}
  )`;
}
export interface EffectiveLedgerAllocation {
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
export async function loadEffectiveLedgerAllocations(
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
