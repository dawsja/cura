/**
 * Account / money accounting helpers.
 *
 * Sign convention (server-side enforced — see `upsertAccount` in
 * `src/db/queries.ts` and `Math.abs(parsedBalance)` in `src/lib/simplefin.ts`):
 *
 *   - All account balances are stored as POSITIVE numbers in the DB.
 *   - The account's `type` decides whether it contributes to net worth as
 *     an asset (+) or a liability (−):
 *
 *       assets     : checking, savings, investment
 *       liabilities: credit, loan
 *       pending    : uncategorized (excluded until reviewed)
 *
 *   - When you need net worth, sum the *signed* contribution of each
 *     account. When you need to display a balance to the user, prefix
 *     liabilities with a `−` and color them rose so the UI doesn't
 *     mislead the user into thinking their debt is an asset.
 *
 * This file exists so the convention is encoded in ONE place — every
 * page that does net-worth math or shows a balance to the user should
 * import from here.
 */

export type AccountType = 'checking' | 'savings' | 'credit' | 'investment' | 'loan' | 'uncategorized';

export interface AccountLike {
  type: AccountType | string;
  balance: number;
}

/** True if the account type represents money the user owes (debt). */
export function isLiability(type: string | undefined | null): boolean {
  return type === 'credit' || type === 'loan';
}

/**
 * Net-worth contribution of an account. Positive for assets, negative
 * for liabilities. Use this for ANY net-worth sum, never the raw
 * `balance` field, otherwise debt shows up as an asset.
 *
 * @example
 *   const total = accounts.reduce((s, a) => s + netWorthContribution(a), 0);
 */
export function netWorthContribution(acc: AccountLike): number {
  if (acc.type === 'uncategorized') return 0;
  return isLiability(acc.type) ? -Math.abs(acc.balance) : Math.abs(acc.balance);
}

/**
 * Display string for a single account balance, with the right sign and
 * a `text-rose-600` (light) / `text-rose-400` (dark) color class for
 * liabilities so the UI doesn't show "$5,000 owed" in slate-grey.
 *
 * In the muted-pastels palette the rose scale is a soft coral that
 * still reads as "warning" without the original palette's harsh red.
 */
export function formatAccountBalance(
  acc: AccountLike,
  format: (n: number) => string,
): { text: string; colorClass: string; isLiability: boolean } {
  const owed = isLiability(acc.type);
  return {
    text: owed ? `−${format(Math.abs(acc.balance))}` : format(Math.abs(acc.balance)),
    colorClass: owed ? 'text-rose-400' : 'fg-primary',
    isLiability: owed,
  };
}
