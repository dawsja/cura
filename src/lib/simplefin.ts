/**
 * SimpleFIN client + sync. Uses `fetch`, takes `userId` everywhere, and
 * stores the access URL in the per-user `settings` table.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { accounts } from '@/db/schema/accounts';
import { settings } from '@/db/schema/settings';
import {
  getSetting,
  setSetting,
  upsertAccount,
  addTransactionWithExternalId,
  countStaleSimpleFinPending,
  deleteImportedTransactionsForAccount,
  findSimpleFinAccountIdByExternalIds,
  getAllCategories,
  listRulesForMatching,
} from '@/db/queries';
import type { InferredAccountType } from './categorize';
import { inferAccountType, smartCategorizeMerchant } from './categorize';
import { pickBestRuleMatch } from './merchant-match';
import { secureFetch, SecureFetchError, validatePublicHttpsUrl } from './secure-fetch';
import { openSecretWithMetadata, sealSecret } from './secret-box';
import { simpleFinAmountToCents } from './simplefin-amount';
import { env } from './env';

// ---- Types --------------------------------------------------------------

export interface SimpleFinTransaction {
  id: string;
  posted: number; // Unix epoch seconds
  transacted_at?: number;
  amount: string | number;
  description?: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
}
export interface SimpleFinAccount {
  id: string;
  name: string;
  currency?: string;
  balance: string | number;
  'balance-date'?: number;
  org?: { id?: string; name?: string; url?: string };
  // SimpleFIN protocol v2 fields — kept untyped on purpose. The `extra`
  // object is explicitly server-opaque per the spec; some bridges
  // populate it with `account_type`, `account_class`, etc., others
  // don't. We sniff opportunistically and ignore anything we don't
  // understand. `conn_id` and `available-balance` are documented v2
  // fields we capture but currently don't use downstream.
  conn_id?: string;
  'available-balance'?: string | number;
  extra?: Record<string, unknown>;
  transactions?: SimpleFinTransaction[];
}
export interface SimpleFinResponse {
  errors?: string[];
  errlist?: unknown[];
  connections?: unknown[];
  accounts?: SimpleFinAccount[];
}

interface SimpleFinConnection {
  conn_id: string;
  name: string;
  org_name?: string;
}

const NumericSchema = z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]);
const SimpleFinTransactionSchema = z.object({
  id: z.string().min(1),
  posted: z.number().finite().nonnegative(),
  transacted_at: z.number().finite().nonnegative().optional(),
  amount: NumericSchema,
  description: z.string().optional(),
  payee: z.string().optional(),
  memo: z.string().optional(),
  pending: z.boolean().optional(),
}).passthrough();
const SimpleFinAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  currency: z.string().optional(),
  balance: NumericSchema,
  'balance-date': z.number().finite().nonnegative().optional(),
  org: z.object({ id: z.string().optional(), name: z.string().optional(), url: z.string().optional() }).optional(),
  conn_id: z.string().optional(),
  'available-balance': NumericSchema.optional(),
  extra: z.record(z.unknown()).optional(),
  transactions: z.array(SimpleFinTransactionSchema).optional(),
}).passthrough();
const SimpleFinErrorSchema = z.object({
  code: z.string().min(1).max(100),
  msg: z.string().min(1).max(1000),
  conn_id: z.string().max(200).optional(),
  account_id: z.string().max(200).optional(),
}).passthrough();
const SimpleFinConnectionSchema = z.object({
  conn_id: z.string().min(1),
  name: z.string().min(1),
  org_name: z.string().optional(),
}).passthrough();
const SimpleFinResponseSchema = z.object({
  errors: z.array(z.string().max(1000)).optional(),
  errlist: z.array(SimpleFinErrorSchema).optional(),
  connections: z.array(SimpleFinConnectionSchema).optional(),
  accounts: z.array(SimpleFinAccountSchema).optional(),
});

// ---- Client -------------------------------------------------------------

const SetupTokenSchema = z.string().min(8);
const AccessUrlSchema = z.string().url().refine((u) => u.startsWith('https://'), {
  message: 'SimpleFIN URLs must use HTTPS',
});
const MAX_ABSOLUTE_DOLLARS = 1_000_000_000;
const activeSyncUsers = new Set<string>();

export function sealSimpleFinAccessUrl(accessUrl: string): string {
  return sealSecret(accessUrl);
}

export async function rememberSimpleFinFeedIdentity(userId: string): Promise<void> {
  const accessUrl = await getSimpleFinAccessUrl(userId);
  if (accessUrl) {
    await setSetting(userId, 'simplefin_previous_feed_key', stableSimpleFinId([accessUrl]));
    await setSetting(userId, 'simplefin_previous_endpoint_key', simpleFinEndpointKey(accessUrl));
  }
}

async function getSimpleFinAccessUrl(userId: string): Promise<string | null> {
  const stored = await getSetting(userId, 'simplefin_access_url');
  if (!stored) return null;
  const opened = openSecretWithMetadata(stored);
  if (opened.needsReseal) {
    await db
      .update(settings)
      .set({ value: sealSecret(opened.value) })
      .where(and(
        eq(settings.userId, userId),
        eq(settings.key, 'simplefin_access_url'),
        eq(settings.value, stored),
      ));
  }
  return opened.value;
}

export class SimpleFinError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SimpleFinError';
  }
}

export function publicSimpleFinError(error: unknown): { message: string; code: string } {
  if (error instanceof SimpleFinError || error instanceof SecureFetchError) {
    return { message: error.message, code: error.code };
  }
  return { message: 'SimpleFIN sync failed. Please try again later.', code: 'simplefin_failed' };
}

/**
 * Claim a SimpleFIN setup token → returns the permanent access URL.
 */
export async function claimSetupToken(setupToken: string): Promise<string> {
  const trimmed = SetupTokenSchema.parse(setupToken.trim());

  let claimUrl: string;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf-8').trim();
    if (decoded.startsWith('https://')) {
      claimUrl = decoded;
    } else {
      throw new Error('decoded token is not a URL');
    }
  } catch {
    throw new SimpleFinError('The SimpleFIN setup token is invalid.', 'invalid_setup_token');
  }

  await validatePublicHttpsUrl(claimUrl);
  const { response: res, body } = await secureFetch(claimUrl, {
    method: 'POST',
    headers: { 'Content-Length': '0' },
    timeoutMs: 10_000,
    totalDeadlineMs: 10_000,
    maxBodyBytes: 4096,
    retry: false,
    allowRedirects: false,
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new SimpleFinError('SimpleFIN rejected this one-time token. It may already have been claimed.', 'claim_rejected');
    }
    throw new SimpleFinError(`SimpleFIN rejected the setup token (HTTP ${res.status}).`, 'claim_rejected');
  }
  const accessUrl = new TextDecoder().decode(body).trim();
  const parsedAccessUrl = AccessUrlSchema.parse(accessUrl);
  await validatePublicHttpsUrl(parsedAccessUrl);
  return parsedAccessUrl;
}

/**
 * Fetch account + transaction data from SimpleFIN.
 *
 * `startDate` and `endDate` are Unix epoch SECONDS. Per the SimpleFIN
 * Bridge guidance recommends a maximum range of 45 days per request.
 */
export async function fetchSimpleFinData(
  accessUrl: string,
  startDate?: number,
  endDate?: number,
): Promise<{ accounts: SimpleFinAccount[]; connections: SimpleFinConnection[]; errors: string[] }> {
  const url = await validatePublicHttpsUrl(AccessUrlSchema.parse(accessUrl));
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';

  let endpoint = `${url.toString().replace(/\/$/, '')}/accounts?version=2&pending=1`;
  if (startDate) endpoint += `&start-date=${startDate}`;
  if (endDate) endpoint += `&end-date=${endDate}`;

  const headers: Record<string, string> = {};
  if (username || password) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  const { response: res, body } = await secureFetch(endpoint, {
    method: 'GET',
    headers,
    timeoutMs: 15_000,
    totalDeadlineMs: 45_000,
    maxBodyBytes: 10 * 1024 * 1024,
    // Each attempt consumes quota. The next scheduled sync is our retry.
    retry: false,
    allowRedirects: true,
  });
  if (!res.ok) {
    if (res.status === 402) {
      throw new SimpleFinError('SimpleFIN payment is required (HTTP 402). Check the bridge subscription.', 'payment_required');
    }
    if (res.status === 403) {
      throw new SimpleFinError('SimpleFIN access was rejected (HTTP 403). Reconnect with a new setup token.', 'access_rejected');
    }
    if (res.status === 429) {
      throw new SimpleFinError('SimpleFIN rate limit reached (HTTP 429). Please wait before syncing again.', 'rate_limited');
    }
    throw new SimpleFinError(`SimpleFIN request failed (HTTP ${res.status}).`, 'api_rejected');
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new SimpleFinError('SimpleFIN returned an invalid response.', 'invalid_response');
  }
  const parsed = SimpleFinResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new SimpleFinError('SimpleFIN returned invalid data.', 'invalid_response');
  }
  const data = parsed.data;
  const sanitizeErrorText = (value: string, maxLength: number) => value
    .split('')
    .map((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  const structuredErrors = (data.errlist ?? []).map((error) => {
    const code = error.code.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100) || 'unknown';
    const message = sanitizeErrorText(error.msg, 1000) || 'No additional details were provided.';
    return `SimpleFIN (${code}): ${message}`;
  });
  const legacyErrors = (data.errors ?? []).map((error) => {
    const message = sanitizeErrorText(error, 1000) || 'No additional details were provided.';
    return `SimpleFIN: ${message}`;
  });
  return {
    accounts: data.accounts ?? [],
    connections: data.connections ?? [],
    errors: [...new Set([...legacyErrors, ...structuredErrors])],
  };
}

// ---- Sync ---------------------------------------------------------------

// HARDCODED — operators cannot tune these. Rationale: stay strictly inside
// SimpleFIN Bridge's documented limits (https://docs.simplefin.org/):
//   - <= 45 days per /accounts request
//   - <= 24 requests/day per access token (we use 12/day cron + 4-call
//     first-sync backfill, comfortably under quota)
const SIMPLEFIN_LOOKBACK_MONTHS = 6;
const SIMPLEFIN_LOOKBACK_MS = SIMPLEFIN_LOOKBACK_MONTHS * 30 * 24 * 60 * 60 * 1000;
const SIMPLEFIN_CHUNK_MS = 45 * 24 * 60 * 60 * 1000;
// Re-pull from last_sync minus this buffer so we don't miss a transaction
// that posted in the gap between the last sync and the new one.
const SIMPLEFIN_INCREMENTAL_BUFFER_MS = 5 * 24 * 60 * 60 * 1000;
const SIMPLEFIN_DATE_TIME_ZONE_SETTING = 'simplefin_date_time_zone';

const simpleFinDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: env.TZ,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatSimpleFinDate(timestampMs: number): string {
  const parts = simpleFinDateFormatter.formatToParts(new Date(timestampMs));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Unable to format SimpleFIN transaction date.');
  return `${year}-${month}-${day}`;
}

function addSyncWindows(windows: Array<[number, number]>, startMs: number, endMs: number): void {
  for (let start = startMs; start < endMs; start += SIMPLEFIN_CHUNK_MS) {
    windows.push([
      Math.floor(start / 1000),
      Math.floor(Math.min(start + SIMPLEFIN_CHUNK_MS, endMs) / 1000),
    ]);
  }
}

function stableSimpleFinId(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

function simpleFinEndpointKey(accessUrl: string): string {
  const url = new URL(accessUrl);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return stableSimpleFinId([`${url.origin}${path}`]);
}

export interface ImportedAccount {
  // Stable, tenant-and-connection-scoped DB primary key. Legacy rows keep
  // their original `simplefin-<accountId>` key during migration.
  id: string;
  name: string;
  institution?: string;
  inferredType: InferredAccountType;
}

export interface SimpleFinSyncResult {
  accountsSynced: number;
  transactionsSynced: number;
  transactionsInserted: number;
  transactionsUpdated: number;
  transactionsReconciled: number;
  reconciliationAmbiguous: number;
  pendingTransactions: number;
  pendingWithoutTimestamp: number;
  stalePendingTransactions: number;
  errors: string[];
  // Newly-upserted accounts with their inferred types. The UI uses
  // this to open a post-sync review carousel so the user can correct
  // any mis-classifications before they pollute the dashboard,
  // budget, and paydown views.
  imported: ImportedAccount[];
}

async function performSimpleFinSync(
  userId: string,
  options?: { fullSync?: boolean },
): Promise<SimpleFinSyncResult> {
  const accessUrl = await getSimpleFinAccessUrl(userId);
  if (!accessUrl) {
    throw new Error('SimpleFIN is not connected. Please provide a Setup Token first.');
  }

  // Build the list of (start, end) windows to ask the bridge for.
  // First sync (no simplefin_last_sync yet) or explicit fullSync: backfill
  // SIMPLEFIN_LOOKBACK_MONTHS in <= SIMPLEFIN_CHUNK_MS chunks. After that,
  // incremental from the watermark minus a 5-day safety buffer.
  // addTransactionWithExternalId atomically dedupes on (user_id, external_id).
  const lastDateTimeZone = await getSetting(userId, SIMPLEFIN_DATE_TIME_ZONE_SETTING);
  const refreshTransactionDates = lastDateTimeZone !== env.TZ;
  const lastSyncRaw = options?.fullSync || refreshTransactionDates
    ? null
    : await getSetting(userId, 'simplefin_last_sync');
  const now = Date.now();
  const windows: Array<[number, number]> = [];

  if (!lastSyncRaw) {
    const backfillStart = now - SIMPLEFIN_LOOKBACK_MS;
    addSyncWindows(windows, backfillStart, now);
  } else {
    const lastSyncMs = Date.parse(lastSyncRaw);
    const startMs = Number.isFinite(lastSyncMs)
      ? lastSyncMs - SIMPLEFIN_INCREMENTAL_BUFFER_MS
      : now - SIMPLEFIN_INCREMENTAL_BUFFER_MS;
    addSyncWindows(windows, startMs, now);
  }

  // Sequential, not parallel: respect the SimpleFIN quota and keep error
  // handling simple. Each window returns the same account shells with
  // only that window's transactions — merge them so the 6-month backfill
  // keeps every chunk's txs instead of letting the last window overwrite
  // the earlier ones (which previously left users with only one chunk).
  const rawAccountsById = new Map<string, SimpleFinAccount>();
  const connectionsById = new Map<string, SimpleFinConnection>();
  const errors = new Set<string>();
  for (const [startSec, endSec] of windows) {
    const { accounts, connections, errors: chunkErrors } = await fetchSimpleFinData(accessUrl, startSec, endSec);
    for (const connection of connections) connectionsById.set(connection.conn_id, connection);
    for (const acc of accounts) {
      const accountKey = `${acc.conn_id ?? ''}\0${acc.id}`;
      const existing = rawAccountsById.get(accountKey);
      if (!existing) {
        rawAccountsById.set(accountKey, {
          ...acc,
          transactions: [...(acc.transactions ?? [])],
        });
        continue;
      }
      // Later window wins on balance/name/org metadata (most recent).
      const mergedTxs = new Map<string, SimpleFinTransaction>();
      for (const tx of existing.transactions ?? []) mergedTxs.set(tx.id, tx);
      for (const tx of acc.transactions ?? []) mergedTxs.set(tx.id, tx);
      rawAccountsById.set(accountKey, {
        ...existing,
        ...acc,
        transactions: [...mergedTxs.values()],
      });
    }
    for (const error of chunkErrors) errors.add(error);
    // Error responses are generally repeated for every date window. Preserve
    // any partial data but do not spend more quota repeating the same failure.
    if (chunkErrors.length > 0) break;
  }
  const rawAccounts = [...rawAccountsById.values()];
  // Cura currently stores and reports one currency. Validate the complete
  // response before any sync state, account, or transaction write so a mixed
  // feed cannot leave a partially imported ledger.
  const unsupportedCurrencies = [...new Set(
    rawAccounts
      .map((account) => account.currency?.trim().toUpperCase() || 'MISSING')
      .filter((currency) => currency !== 'USD'),
  )];
  if (unsupportedCurrencies.length > 0) {
    throw new SimpleFinError(
      `SimpleFIN returned unsupported account currency: ${unsupportedCurrencies.join(', ')}. Only USD accounts can be synced.`,
      'unsupported_currency',
    );
  }
  await setSetting(userId, 'simplefin_last_attempt', new Date(now).toISOString());
  const endpointKey = simpleFinEndpointKey(accessUrl);
  const legacyFeedKey = stableSimpleFinId([accessUrl]);

  // Load the user's rules once and match per-transaction with
  // exact-or-prefix (longest wins). Rules win over the smart
  // categoriser — the user explicitly asked for that mapping.
  const categoryRows = await getAllCategories(userId);
  const ruleRows = await listRulesForMatching(userId);
  const validAssignments = new Set(
    categoryRows.flatMap((category) =>
      category.subCategories.map((subCategory) => `${category.name}\u0000${subCategory.name}`),
    ),
  );
  const fallbackByType = new Map<string, { category: string; subCategory: string }>();
  for (const category of categoryRows) {
    const subCategory = category.subCategories[0];
    if (!subCategory || category.name === 'Pay down goals' || fallbackByType.has(category.type)) continue;
    fallbackByType.set(category.type, { category: category.name, subCategory: subCategory.name });
  }

  let accountsSynced = 0;
  let transactionsSynced = 0;
  let transactionsInserted = 0;
  let transactionsUpdated = 0;
  let transactionsReconciled = 0;
  let reconciliationAmbiguous = 0;
  let pendingTransactions = 0;
  let pendingWithoutTimestamp = 0;
  const imported: ImportedAccount[] = [];
  const storedAccountMap = await getSetting(userId, 'simplefin_account_id_map');
  const previousFeedKey = await getSetting(userId, 'simplefin_previous_feed_key');
  const previousEndpointKey = await getSetting(userId, 'simplefin_previous_endpoint_key');
  const legacyMigrationComplete = await getSetting(userId, 'simplefin_legacy_account_migration_complete') === 'true';
  let accountIdMap: Record<string, string> = {};
  if (storedAccountMap) {
    try {
      const parsed: unknown = JSON.parse(storedAccountMap);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        accountIdMap = Object.fromEntries(
          Object.entries(parsed)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .slice(0, 10_000),
        );
      }
    } catch {
      accountIdMap = {};
    }
  }
  const claimedAccountIds = new Set(Object.values(accountIdMap));

  for (const sAcc of rawAccounts) {
    const parsedBalance = typeof sAcc.balance === 'number' ? sAcc.balance : parseFloat(sAcc.balance || '0');
    if (!Number.isFinite(parsedBalance) || Math.abs(parsedBalance) > MAX_ABSOLUTE_DOLLARS) {
      throw new SimpleFinError('SimpleFIN returned an account balance outside the supported range.', 'invalid_balance');
    }
    // Pass the org name + opaque `extra` block so `inferAccountType`
    // can use the institution signal and any bank-supplied type
    // metadata. Many servers (the SimpleFIN Bridge included) populate
    // `extra.account_type` for retirement and brokerage accounts.
    const connection = sAcc.conn_id ? connectionsById.get(sAcc.conn_id) : undefined;
    const institution = connection?.org_name ?? connection?.name ?? sAcc.org?.name ?? 'SimpleFIN Bank';
    const accType = inferAccountType(sAcc.name, parsedBalance, {
      institution,
      extra: sAcc.extra,
    });
    const legacyAccId = `simplefin-${sAcc.id}`;
    const previousScopedAccId = `simplefin-${stableSimpleFinId([userId, sAcc.conn_id ?? '', sAcc.id])}`;
    const scopedAccId = `simplefin-${stableSimpleFinId([userId, endpointKey, sAcc.conn_id ?? '', sAcc.id])}`;
    const sourceKey = stableSimpleFinId([endpointKey, sAcc.conn_id ?? '', sAcc.id]);
    const legacyTokenSourceKey = stableSimpleFinId([legacyFeedKey, sAcc.conn_id ?? '', sAcc.id]);
    const previousTokenSourceKey = previousFeedKey && previousEndpointKey === endpointKey
      ? stableSimpleFinId([previousFeedKey, sAcc.conn_id ?? '', sAcc.id])
      : null;
    const previousSourceKey = stableSimpleFinId([sAcc.conn_id ?? '', sAcc.id]);
    const mappedAccId = accountIdMap[sourceKey]
      ?? accountIdMap[legacyTokenSourceKey]
      ?? (previousTokenSourceKey ? accountIdMap[previousTokenSourceKey] : undefined)
      ?? (!legacyMigrationComplete ? accountIdMap[previousSourceKey] : undefined);

    // Older disconnects deleted the source map. Exact transaction identities
    // can still reconnect an account without relying on mutable names.
    const transactionExternalIds = (sAcc.transactions ?? [])
      .slice(0, 100)
      .map((tx) => `sf-${stableSimpleFinId([sAcc.conn_id ?? '', sAcc.id, tx.id])}`);
    const recoveredAccId = mappedAccId
      ? null
      : await findSimpleFinAccountIdByExternalIds(userId, transactionExternalIds);

    // If the user previously hid this account, skip the upsert AND the
    // transaction import. Without this check, deleting (or hiding) an
    // account would be undone by the next sync — the whole reason the
    // Hide button exists. The row stays in the DB so the user can
    // un-hide later and resume syncing.
    // Prefer the stored type over a fresh inference so a user
    // correction (e.g. "Concord Credit 401(K)" → investment) drives
    // the balance-only skip below.
    const legacyRows = await db
      .select({ hidden: accounts.hidden, type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, legacyAccId)))
      .limit(1);
    const previousScopedRows = !mappedAccId && !legacyMigrationComplete
      ? await db
        .select({ hidden: accounts.hidden, type: accounts.type })
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.id, previousScopedAccId)))
        .limit(1)
      : [];
    const canClaimLegacy = !legacyMigrationComplete && legacyRows.length > 0 && !claimedAccountIds.has(legacyAccId);
    const canClaimPreviousScoped = previousScopedRows.length > 0 && !claimedAccountIds.has(previousScopedAccId);
    const accId = mappedAccId
      ?? recoveredAccId
      ?? (canClaimLegacy ? legacyAccId : canClaimPreviousScoped ? previousScopedAccId : scopedAccId);
    const [existing] = accId === legacyAccId && legacyRows.length > 0
      ? legacyRows
      : accId === previousScopedAccId && previousScopedRows.length > 0
        ? previousScopedRows
      : await db
        .select({ hidden: accounts.hidden, type: accounts.type })
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.id, accId)))
        .limit(1);
    if (accountIdMap[sourceKey] !== accId) {
      accountIdMap[sourceKey] = accId;
      if (legacyTokenSourceKey !== sourceKey) delete accountIdMap[legacyTokenSourceKey];
      if (previousTokenSourceKey) delete accountIdMap[previousTokenSourceKey];
      claimedAccountIds.add(accId);
      await setSetting(userId, 'simplefin_account_id_map', JSON.stringify(accountIdMap));
    }
    if (existing?.hidden) continue;

    await upsertAccount(userId, {
      id: accId,
      name: sAcc.name,
      type: accType,
      balance: Math.abs(parsedBalance),
      institution,
    });
    accountsSynced++;
    imported.push({
      id: accId,
      name: sAcc.name,
      institution,
      inferredType: accType,
    });

    // Investment accounts are balance-only: keep the value for net
    // worth / growth, but never import brokerage activity into the
    // cash ledger (Transactions, reviews, budget, reports). Also
    // purge any leftover rows from before this rule or from a prior
    // misclassification the user has since corrected.
    const effectiveType = existing?.type ?? accType;
    if (effectiveType === 'investment') {
      await deleteImportedTransactionsForAccount(userId, accId);
      continue;
    }

    if (sAcc.transactions && Array.isArray(sAcc.transactions)) {
      const orderedTransactions = [...sAcc.transactions].sort((a, b) => {
        const aPending = a.pending === true || a.posted === 0;
        const bPending = b.pending === true || b.posted === 0;
        return Number(bPending) - Number(aPending);
      });
      for (const sTx of orderedTransactions) {
        let signedAmountCents: number;
        try {
          signedAmountCents = simpleFinAmountToCents(sTx.amount);
        } catch {
          throw new SimpleFinError('SimpleFIN returned an invalid transaction amount.', 'invalid_amount');
        }
        const merchant = sTx.payee || sTx.description || 'Unknown Merchant';
        const sourcePending = sTx.pending === true || sTx.posted === 0;
        if (sourcePending) pendingTransactions++;
        if (sourcePending && !sTx.transacted_at && !sTx.posted) pendingWithoutTimestamp++;
        // The purchase date is stable across pending and posted versions.
        // Preserve the first-seen date when the provider supplies no timestamp.
        const transactionTimestamp = sTx.transacted_at || sTx.posted;
        const transactionTimestampMs = transactionTimestamp ? transactionTimestamp * 1000 : now;
        const dateStr = formatSimpleFinDate(transactionTimestampMs);
        const isIncome = signedAmountCents > 0;
        const absAmountCents = Math.abs(signedAmountCents);
        // User rules win on category/sub/type. Smart categoriser fills
        // gaps (including transfer detection for payment-shaped payees
        // when no rule type is set). Trained merchants skip the review
        // queue entirely.
        const smart = smartCategorizeMerchant(merchant, signedAmountCents);
        const sourceType = smart.type ?? (isIncome ? 'income' : 'expense');
        const smartAssignmentValid = smart.subCategory != null
          && validAssignments.has(`${smart.category}\u0000${smart.subCategory}`);
        const fallback = fallbackByType.get(sourceType);
        const suggestedCategory = smartAssignmentValid ? smart.category : fallback?.category ?? smart.category;
        const suggestedSubCategory = smartAssignmentValid ? smart.subCategory : fallback?.subCategory ?? smart.subCategory;
        const ruleMatch = pickBestRuleMatch({
          merchant,
          accountId: accId,
          sourceCategory: smart.category,
          sourceSubCategory: smart.subCategory,
          sourceType,
        }, ruleRows);
        // Legacy rules without a leaf cannot safely override the smart
        // category: pairing their parent with an unrelated smart leaf
        // would create an invalid assignment.
        const category = ruleMatch?.subCategory ? ruleMatch.category : suggestedCategory;
        const subCategory = ruleMatch?.subCategory ?? suggestedSubCategory;
        const txType =
          ruleMatch?.type
          ?? sourceType;

        const externalId = `sf-${stableSimpleFinId([sAcc.conn_id ?? '', sAcc.id, sTx.id])}`;
        const result = await addTransactionWithExternalId(userId, {
          date: dateStr,
          merchant,
          sourceCategory: smart.category,
          sourceSubCategory: smart.subCategory,
          sourceType,
          sourceClassificationTrusted: true,
          category,
          subCategory,
          accountId: accId,
          account: sAcc.name,
          amountCents: absAmountCents,
          type: txType,
          notes: sTx.memo || (sourcePending ? 'Pending Transaction' : undefined),
          externalId,
          legacyExternalId: `sf-${sTx.id}`,
          needsReview: !ruleMatch?.subCategory,
          sourcePending,
          sourceTransactedAt: sTx.transacted_at,
          sourceLastSeenAt: new Date(now),
          preserveSourceDate: !transactionTimestamp,
        });
        if (result) {
          transactionsSynced++;
          if (result.action === 'inserted') transactionsInserted++;
          else if (result.action === 'reconciled') transactionsReconciled++;
          else transactionsUpdated++;
          if (result.reconciliationAmbiguous) reconciliationAmbiguous++;
        }
      }
    }
  }

  const errorList = [...errors];
  const stalePendingTransactions = await countStaleSimpleFinPending(userId);
  await setSetting(userId, 'simplefin_last_error', errorList.join('\n'));
  await setSetting(userId, 'simplefin_legacy_account_migration_complete', 'true');
  if (errorList.length === 0) {
    await setSetting(userId, 'simplefin_last_sync', new Date().toISOString());
    await setSetting(userId, SIMPLEFIN_DATE_TIME_ZONE_SETTING, env.TZ);
  }
  return {
    accountsSynced,
    transactionsSynced,
    transactionsInserted,
    transactionsUpdated,
    transactionsReconciled,
    reconciliationAmbiguous,
    pendingTransactions,
    pendingWithoutTimestamp,
    stalePendingTransactions,
    errors: errorList,
    imported,
  };
}

export async function syncSimpleFinToDatabase(
  userId: string,
  options?: { fullSync?: boolean },
): Promise<SimpleFinSyncResult> {
  if (activeSyncUsers.has(userId)) {
    throw new SimpleFinError('A SimpleFIN sync is already in progress for this user.', 'sync_in_progress');
  }
  activeSyncUsers.add(userId);
  try {
    return await performSimpleFinSync(userId, options);
  } finally {
    activeSyncUsers.delete(userId);
  }
}
