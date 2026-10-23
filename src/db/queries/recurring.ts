import { and, desc, eq } from 'drizzle-orm';
import { db } from '../client';
import { transactions } from '../schema/transactions';
import { centsToDollars } from '@/lib/money';
import { isLedgerExcluded, loadAccountLedgerMeta, transactionAccountMeta } from './ledger';
import type { TransactionType } from './types';

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
