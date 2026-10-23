import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../client';
import { accounts } from '../schema/accounts';
import { categories } from '../schema/categories';
import { subCategories } from '../schema/sub_categories';
import { transactions } from '../schema/transactions';
import { transactionSplits } from '../schema/transaction_splits';
import { simpleFinTransactionAliases } from '../schema/simplefin_transaction_aliases';
import { simpleFinIgnoredTransactions } from '../schema/simplefin_ignored_transactions';
import { normalizeMerchant } from '@/lib/merchant-match';
import { centsToDollars, dollarsToCents } from '@/lib/money';
import { resolveCategoryAssignment, uniqueAssignmentsByName } from './category-assignments';
import {
  hasSplitSql,
  isLedgerExcluded,
  ledgerVisibilityCondition,
  loadAccountLedgerMeta,
  loadTransactionSplits,
  resolveTransactionAccount,
  transactionAccountMeta,
  type AccountLedgerMeta,
} from './ledger';
import type { BudgetActivityRow, DashboardActivity, Transaction, TransactionSplit, TransactionType } from './types';

// ---- Transactions -------------------------------------------------------

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
