import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { settings } from '@/db/schema/settings';
import {
  getRecurringCharges,
  getSetting,
  resolveRecurringTransactionMetadata,
  type RecurringCharge,
} from '@/db/queries';

export const DISMISSED_RECURRING_KEY = 'dismissed_recurring';
export const MARKED_RECURRING_KEY = 'marked_recurring';
export const MANUAL_RECURRING_KEY = 'manual_recurring';

export const recurringIdentitySchema = z.object({
  merchant: z.string().min(1),
  amount: z.number().finite(),
  account: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
});

export const markedRecurringSchema = recurringIdentitySchema.extend({
  account: z.string().min(1),
  frequency: z.enum(['weekly', 'monthly', 'yearly']),
  lastDate: z.string().date(),
  category: z.string().min(1),
});

const legacyMarkedRecurringSchema = z.object({
  merchant: z.string().min(1),
  amount: z.number().finite(),
  frequency: z.enum(['weekly', 'monthly', 'yearly']),
});
const transactionMarkRequestSchema = z.object({
  transactionId: z.string().min(1),
  frequency: z.enum(['weekly', 'monthly', 'yearly']),
});
const legacyMarkRequestSchema = legacyMarkedRecurringSchema.extend({
  account: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
});
export const markRecurringRequestSchema = z.union([transactionMarkRequestSchema, legacyMarkRequestSchema]);

const dismissedRecurringSchema = z.array(z.string());
const persistedMarkedRecurringSchema = z.union([markedRecurringSchema, legacyMarkedRecurringSchema]);
const markedRecurringListSchema = z.array(persistedMarkedRecurringSchema);

export type MarkedRecurring = z.infer<typeof markedRecurringSchema>;
type PersistedMarkedRecurring = z.infer<typeof persistedMarkedRecurringSchema>;

export type RecurringFrequency = 'weekly' | 'monthly' | 'yearly';

// ---- Manual recurring entries -------------------------------------------
//
// User-defined recurring charges that don't (yet) have matching
// transactions — e.g. a subscription that hasn't posted, or a bill on an
// account Cura doesn't sync. Stored as a JSON array in the settings KV
// under `manual_recurring`, keyed by a stable `id` so they can be edited
// and deleted individually. `amount` is in dollars (matching the detected
// RecurringCharge shape); `anchorDate` is any one real occurrence, from
// which the next due date is projected forward.

/** Fields the client sends when creating/updating a manual entry. */
export const manualRecurringInputSchema = z.object({
  merchant: z.string().trim().min(1).max(120),
  amount: z.number().finite().positive(),
  frequency: z.enum(['weekly', 'monthly', 'yearly']),
  account: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(120),
  anchorDate: z.string().date(),
});
export type ManualRecurringInput = z.infer<typeof manualRecurringInputSchema>;

const manualRecurringSchema = manualRecurringInputSchema.extend({ id: z.string().min(1) });
export type ManualRecurring = z.infer<typeof manualRecurringSchema>;
const manualRecurringListSchema = z.array(manualRecurringSchema);

const OVERDUE_NOTIFY_WINDOW_DAYS = 7;

export function recurringSchedule(
  lastDate: string,
  frequency: RecurringFrequency,
  now = new Date(),
): { nextDate: string; daysUntil: number; comingSoon: boolean } {
  const [year, month, day] = lastDate.split('-').map(Number) as [number, number, number];
  let nextDate: string;
  if (frequency === 'weekly') {
    nextDate = new Date(Date.UTC(year, month - 1, day + 7, 12)).toISOString().slice(0, 10);
  } else {
    const months = frequency === 'monthly' ? 1 : 12;
    const targetMonth = month - 1 + months;
    const targetYear = year + Math.floor(targetMonth / 12);
    const normalizedMonth = targetMonth % 12;
    const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
    nextDate = new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay), 12)).toISOString().slice(0, 10);
  }

  const [nextYear, nextMonth, nextDay] = nextDate.split('-').map(Number) as [number, number, number];
  const next = Date.UTC(nextYear, nextMonth - 1, nextDay);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntil = Math.round((next - today) / 86_400_000);
  const leadDays = frequency === 'weekly' ? 2 : frequency === 'monthly' ? 7 : 30;

  return {
    nextDate,
    daysUntil,
    comingSoon: daysUntil >= -OVERDUE_NOTIFY_WINDOW_DAYS && daysUntil <= leadDays,
  };
}

function todayYmd(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12)).toISOString().slice(0, 10);
}

/** Advance a `YYYY-MM-DD` date by one period. Matches `recurringSchedule`
 *  month/day clamping so manual and detected schedules stay consistent. */
function addPeriodYmd(ymd: string, frequency: RecurringFrequency, direction: 1 | -1 = 1): string {
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  if (frequency === 'weekly') {
    return new Date(Date.UTC(year, month - 1, day + 7 * direction, 12)).toISOString().slice(0, 10);
  }
  const months = (frequency === 'monthly' ? 1 : 12) * direction;
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay), 12)).toISOString().slice(0, 10);
}

/**
 * Given any real occurrence (`anchorDate`), compute the `lastDate` such
 * that `recurringSchedule(lastDate)` yields the next occurrence that is
 * still on or after today. Rolls the anchor forward (or back) so the
 * shared schedule/notification logic treats manual entries exactly like
 * detected ones.
 */
function manualLastDate(anchorDate: string, frequency: RecurringFrequency, now = new Date()): string {
  const today = todayYmd(now);
  let next = anchorDate;
  // Roll forward until the occurrence is on/after today...
  while (next < today) next = addPeriodYmd(next, frequency, 1);
  // ...or back down to the first occurrence that is still on/after today,
  // so a future-dated anchor keeps its own date as the next due date.
  while (addPeriodYmd(next, frequency, -1) >= today) next = addPeriodYmd(next, frequency, -1);
  return addPeriodYmd(next, frequency, -1);
}

function parseManual(raw: string | null): ManualRecurring[] {
  return parseJson(raw, manualRecurringListSchema, []);
}

export async function listManualRecurring(userId: string): Promise<ManualRecurring[]> {
  return parseManual(await getSetting(userId, MANUAL_RECURRING_KEY));
}

async function mutateManualRecurring<T>(
  userId: string,
  mutate: (items: ManualRecurring[]) => { next: ManualRecurring[]; result: T },
): Promise<T> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.userId, userId), eq(settings.key, MANUAL_RECURRING_KEY)));
    const items = parseManual(rows[0]?.value ?? null);
    const { next, result } = mutate(items);
    await tx
      .insert(settings)
      .values({ userId, key: MANUAL_RECURRING_KEY, value: JSON.stringify(next), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [settings.userId, settings.key],
        set: { value: sql`excluded.value`, updatedAt: new Date() },
      });
    return result;
  });
}

export async function addManualRecurring(userId: string, input: ManualRecurringInput): Promise<ManualRecurring> {
  const entry: ManualRecurring = { id: crypto.randomUUID(), ...input };
  await mutateManualRecurring(userId, (items) => ({ next: [...items, entry], result: entry }));
  return entry;
}

export async function updateManualRecurring(
  userId: string,
  id: string,
  input: ManualRecurringInput,
): Promise<ManualRecurring | null> {
  return mutateManualRecurring(userId, (items) => {
    let updated: ManualRecurring | null = null;
    const next = items.map((item) => {
      if (item.id !== id) return item;
      updated = { id, ...input };
      return updated;
    });
    return { next, result: updated };
  });
}

export async function deleteManualRecurring(userId: string, id: string): Promise<boolean> {
  return mutateManualRecurring(userId, (items) => {
    const next = items.filter((item) => item.id !== id);
    return { next, result: next.length !== items.length };
  });
}

/** Manual entries rendered in the same shape as detected charges. */
function manualToCharge(entry: ManualRecurring, now = new Date()): RecurringCharge & { manual: true; id: string } {
  return {
    merchant: entry.merchant,
    amount: entry.amount,
    frequency: entry.frequency,
    occurrences: 0,
    lastDate: manualLastDate(entry.anchorDate, entry.frequency, now),
    category: entry.category,
    account: entry.account,
    manual: true,
    id: entry.id,
  };
}

interface RecurringPreferences {
  dismissed: Set<string>;
  marked: PersistedMarkedRecurring[];
}

export function recurringKey(merchant: string, amount: number, account?: string): string {
  const base = `${merchant.toLowerCase()}|${Math.round(amount * 100) / 100}`;
  return account ? `${base}|${account.toLowerCase()}` : base;
}

function recurringMerchantKey(merchant: string, account?: string): string {
  const m = merchant.toLowerCase();
  return account ? `${m}|${account.toLowerCase()}` : m;
}

function roundedAmount(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function markedAccount(marked: PersistedMarkedRecurring): string | undefined {
  return 'account' in marked ? (marked.accountId ?? marked.account) : undefined;
}

function chargeAccount(charge: RecurringCharge & { accountId?: string }): string {
  return charge.accountId ?? charge.account;
}

function parseDismissedKey(key: string): { merchant: string; amount?: number; account?: string } | null {
  const parts = key.split('|');
  if (parts.length === 2) {
    const amount = Number(parts[1]);
    if (Number.isFinite(amount)) return { merchant: parts[0]!, amount };
    return { merchant: parts[0]!, account: parts[1] };
  }
  if (parts.length >= 3) {
    const amount = Number(parts[1]);
    const account = parts.slice(2).join('|');
    if (Number.isFinite(amount)) return { merchant: parts[0]!, amount, account };
    return { merchant: parts[0]!, account: parts.slice(1).join('|') };
  }
  if (parts.length === 1 && parts[0]) return { merchant: parts[0] };
  return null;
}

function dismissKeyMatches(key: string, merchant: string, amount: number, account: string): boolean {
  const parsed = parseDismissedKey(key);
  if (!parsed || parsed.merchant !== merchant.toLowerCase()) return false;
  if (parsed.account) return parsed.account === account.toLowerCase();
  return parsed.amount === roundedAmount(amount);
}

function isDismissed(preferences: RecurringPreferences, merchant: string, amount: number, account: string): boolean {
  for (const key of preferences.dismissed) {
    if (dismissKeyMatches(key, merchant, amount, account)) return true;
  }
  return false;
}

function removeMatchingDismissed(
  dismissed: Set<string>,
  merchant: string,
  amount: number,
  account?: string,
): boolean {
  let removed = false;
  for (const key of [...dismissed]) {
    if (account) {
      if (dismissKeyMatches(key, merchant, amount, account)) {
        dismissed.delete(key);
        removed = true;
      }
    } else if (parseDismissedKey(key)?.merchant === merchant.toLowerCase()) {
      dismissed.delete(key);
      removed = true;
    }
  }
  return removed;
}

function sameRecurring(
  item: PersistedMarkedRecurring,
  merchant: string,
  _amount: number,
  account?: string,
): boolean {
  if (item.merchant.toLowerCase() !== merchant.toLowerCase()) return false;
  const itemAccount = markedAccount(item);
  if (!itemAccount || !account) return true;
  return itemAccount.toLowerCase() === account.toLowerCase();
}

function parseJson<T>(raw: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

function parsePreferences(dismissedRaw: string | null, markedRaw: string | null): RecurringPreferences {
  return {
    dismissed: new Set(parseJson(dismissedRaw, dismissedRecurringSchema, [])),
    marked: parseJson(markedRaw, markedRecurringListSchema, []),
  };
}

export async function getRecurringPreferences(userId: string): Promise<RecurringPreferences> {
  const [dismissedRaw, markedRaw] = await Promise.all([
    getSetting(userId, DISMISSED_RECURRING_KEY),
    getSetting(userId, MARKED_RECURRING_KEY),
  ]);
  return parsePreferences(dismissedRaw, markedRaw);
}

function persistedMarkKey(marked: PersistedMarkedRecurring): string {
  return recurringMerchantKey(marked.merchant, markedAccount(marked));
}

function dedupeMarked(items: PersistedMarkedRecurring[]): PersistedMarkedRecurring[] {
  const seen = new Set<string>();
  const out: PersistedMarkedRecurring[] = [];
  for (const item of items) {
    const key = persistedMarkKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function refreshMarkedRecurring(
  userId: string,
  marked: PersistedMarkedRecurring[],
): Promise<PersistedMarkedRecurring[]> {
  // This also upgrades account-less legacy marks before auto-detection has
  // enough occurrences to produce its own row. Lookup is merchant+account
  // so a price change updates the stored amount.
  const refreshed = await Promise.all(marked.map(async (item) => {
    const metadata = await resolveRecurringTransactionMetadata(userId, {
      merchant: item.merchant,
      account: 'account' in item ? item.account : undefined,
      accountId: 'accountId' in item ? item.accountId : undefined,
      type: 'expense',
    });
    return metadata ? { ...metadata, frequency: item.frequency } satisfies MarkedRecurring : item;
  }));

  const dedupedRefresh = dedupeMarked(refreshed);
  if (JSON.stringify(refreshed) !== JSON.stringify(marked) || dedupedRefresh.length !== marked.length) {
    const byOriginalKey = new Map(marked.map((item, index) => [persistedMarkKey(item), refreshed[index]!]));
    await mutateRecurringPreferences(userId, (current) => {
      let changed = false;
      const nextMarked = current.marked.map((item) => {
        const replacement = byOriginalKey.get(persistedMarkKey(item));
        if (!replacement) return item;
        const next = { ...replacement, frequency: item.frequency };
        if (JSON.stringify(next) !== JSON.stringify(item)) changed = true;
        return next;
      });
      const deduped = dedupeMarked(nextMarked);
      if (deduped.length !== nextMarked.length) changed = true;
      current.marked = deduped;
      return { writeDismissed: false, writeMarked: changed };
    });
  }
  return dedupedRefresh;
}

export async function loadActiveRecurringCharges(
  userId: string,
): Promise<(RecurringCharge & { accountId?: string; manual?: boolean; id?: string })[]> {
  const [charges, preferences, manualEntries] = await Promise.all([
    getRecurringCharges(userId),
    getRecurringPreferences(userId),
    listManualRecurring(userId),
  ]);
  const markedItems = await refreshMarkedRecurring(userId, preferences.marked);
  const merged: (RecurringCharge & { accountId?: string; manual?: boolean; id?: string })[] = charges.filter(
    (charge) => !isDismissed(preferences, charge.merchant, charge.amount, chargeAccount(charge)),
  );

  for (const marked of markedItems) {
    const account = markedAccount(marked);
    if (account && isDismissed(preferences, marked.merchant, marked.amount, account)) continue;
    const existing = merged.filter((charge) => {
      if (charge.merchant.toLowerCase() !== marked.merchant.toLowerCase()) return false;
      if (!account) return true;
      return account === chargeAccount(charge)
        || ('account' in marked && marked.account.toLowerCase() === charge.account.toLowerCase());
    });
    if (existing.length > 0) {
      for (const charge of existing) {
        charge.frequency = marked.frequency;
        if ('account' in marked) {
          if (marked.lastDate >= charge.lastDate) {
            charge.lastDate = marked.lastDate;
            charge.category = marked.category;
            charge.amount = marked.amount;
          }
          if (marked.accountId) charge.accountId = marked.accountId;
        }
      }
    } else if ('account' in marked) {
      merged.push({
        merchant: marked.merchant,
        amount: marked.amount,
        frequency: marked.frequency,
        occurrences: 1,
        lastDate: marked.lastDate,
        category: marked.category,
        account: marked.account,
        accountId: marked.accountId,
      });
    }
  }

  // Manual entries are always shown (they represent user intent), but skip
  // any whose merchant+account already appears as a detected/marked charge
  // to avoid a duplicate row once real transactions start posting.
  for (const entry of manualEntries) {
    const duplicate = merged.some(
      (charge) => !charge.manual
        && charge.merchant.toLowerCase() === entry.merchant.toLowerCase()
        && charge.account.toLowerCase() === entry.account.toLowerCase(),
    );
    if (!duplicate) merged.push(manualToCharge(entry));
  }
  return merged;
}

type PreferenceMutation = (preferences: RecurringPreferences) => {
  writeDismissed: boolean;
  writeMarked: boolean;
};

async function mutateRecurringPreferences(userId: string, mutate: PreferenceMutation): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.userId, userId),
          inArray(settings.key, [DISMISSED_RECURRING_KEY, MARKED_RECURRING_KEY]),
        ),
      );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const preferences = parsePreferences(
      values.get(DISMISSED_RECURRING_KEY) ?? null,
      values.get(MARKED_RECURRING_KEY) ?? null,
    );
    const writes = mutate(preferences);
    const now = new Date();
    const updates: { userId: string; key: string; value: string; updatedAt: Date }[] = [];
    if (writes.writeDismissed) {
      updates.push({
        userId,
        key: DISMISSED_RECURRING_KEY,
        value: JSON.stringify([...preferences.dismissed]),
        updatedAt: now,
      });
    }
    if (writes.writeMarked) {
      updates.push({ userId, key: MARKED_RECURRING_KEY, value: JSON.stringify(preferences.marked), updatedAt: now });
    }
    if (updates.length === 0) return;
    await tx
      .insert(settings)
      .values(updates)
      .onConflictDoUpdate({
        target: [settings.userId, settings.key],
        set: { value: sql`excluded.value`, updatedAt: now },
      });
  });
}

export async function dismissRecurring(
  userId: string,
  merchant: string,
  amount: number,
  account?: string,
  accountId?: string,
): Promise<void> {
  const accountIdentity = accountId ?? account;
  const key = recurringKey(merchant, amount, accountIdentity);
  await mutateRecurringPreferences(userId, (preferences) => {
    preferences.dismissed.add(key);
    const markedLength = preferences.marked.length;
    preferences.marked = preferences.marked.filter((item) => !sameRecurring(item, merchant, amount, accountIdentity));
    return { writeDismissed: true, writeMarked: preferences.marked.length !== markedLength };
  });
}

export async function restoreRecurring(
  userId: string,
  merchant: string,
  amount: number,
  account?: string,
  accountId?: string,
): Promise<void> {
  await mutateRecurringPreferences(userId, (preferences) => {
    const removed = removeMatchingDismissed(preferences.dismissed, merchant, amount, accountId ?? account);
    return { writeDismissed: removed, writeMarked: false };
  });
}

export async function markRecurring(userId: string, marked: MarkedRecurring): Promise<void> {
  const account = marked.accountId ?? marked.account;
  await mutateRecurringPreferences(userId, (preferences) => {
    preferences.marked = preferences.marked.filter((item) => !sameRecurring(item, marked.merchant, marked.amount, account));
    preferences.marked.push(marked);
    const wasDismissed = removeMatchingDismissed(preferences.dismissed, marked.merchant, marked.amount, account);
    return { writeDismissed: wasDismissed, writeMarked: true };
  });
}

export async function unmarkRecurring(
  userId: string,
  merchant: string,
  amount: number,
  account?: string,
  accountId?: string,
): Promise<void> {
  const accountIdentity = accountId ?? account;
  const key = recurringKey(merchant, amount, accountIdentity);
  await mutateRecurringPreferences(userId, (preferences) => {
    preferences.marked = preferences.marked.filter((item) => !sameRecurring(item, merchant, amount, accountIdentity));
    preferences.dismissed.add(key);
    return { writeDismissed: true, writeMarked: true };
  });
}
