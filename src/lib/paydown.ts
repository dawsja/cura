/**
 * Paydown calculator — month-by-month debt simulation.
 *
 * Three methods (Monarch's "Pay down goals" terminology):
 *
 *   - Planned: pay the planned (or minimum) payment on each account, no
 *     rollover, no extra. Just project the schedule straight through.
 *
 *   - Avalanche: pay minimums on all accounts, then put the extra +
 *       any freed payments onto the highest-APR remaining balance. The
 *       classical "saves the most interest" strategy.
 *
 *   - Snowball: same logic but smallest-balance-first. Psychological
 *       "wins" as each account hits zero.
 *
 * All compounding is monthly. The interest accrued in a month is
 * `balance * (apr / 12)`, and we apply the payment after the interest
 * (standard US credit-card / loan convention).
 *
 * Returns a `Projection`:
 *   - per-account payoff months and total interest paid
 *   - aggregate timeline of (month, totalDebt) so the chart can plot
 *     one combined line, or we can render per-account lines
 *   - summary numbers for the dashboard cards
 *
 * Pure function: no DB, no IO. Caller passes in the accounts list and
 * the parameters (method, monthly extra, one-time extra). The HTTP
 * route is a thin wrapper around this.
 */

export type PaydownMethod = 'planned' | 'avalanche' | 'snowball';

export interface PaydownAccount {
  id: string;
  name: string;
  type: 'credit' | 'loan';
  balance: number;
  apr: number; // decimal, 0.18 = 18%
  minPayment: number;
  plannedPayment: number; // if 0, minPayment is used
  includeInPaydown: boolean;
}

export interface PaydownParams {
  method: PaydownMethod;
  monthlyExtra: number; // additional $/mo applied to the top-priority account (avalanche/snowball only)
  oneTimeExtra: number; // one-time lump sum applied in month 0 (avalanche/snowball only)
}

export interface PaydownAccountResult {
  accountId: string;
  name: string;
  startingBalance: number;
  apr: number;
  payoffMonth: string | null; // YYYY-MM of the final payment; null if excluded, already paid off, or never paid off
  monthsToPayoff: number | null; // payments until paid off; null under the same conditions
  totalInterest: number;
  totalPaid: number;
}

export interface PaydownPoint {
  month: string; // YYYY-MM
  totalDebt: number; // sum of remaining balances
  byAccount: Record<string, number>; // accountId -> remaining balance (excluded accounts not included)
}

export interface PaydownProjection {
  method: PaydownMethod;
  params: PaydownParams;
  startingTotal: number;
  totalInterest: number;
  totalPaid: number;
  monthsToDebtFree: number | null; // null if nothing is projected or any account never pays off
  debtFreeMonth: string | null; // YYYY-MM of the final payment
  // Accounts whose balance stops falling: the payments reaching them do
  // not cover their interest. Totals are then cut short and are not a
  // lifetime cost, so the UI shows a warning instead of them.
  nonAmortizingIds: string[];
  perAccount: PaydownAccountResult[];
  timeline: PaydownPoint[]; // monthly snapshots
  // Simulated vs. baseline. baseline is the planned-only projection so
  // the chart can show both (dotted vs. solid) per Monarch's calculator UI.
  baselineTimeline: PaydownPoint[];
  baselineTotalInterest: number;
  baselineMonthsToDebtFree: number | null;
  baselineDebtFreeMonth: string | null;
  baselineNonAmortizingIds: string[];
}

const MAX_MONTHS = 12 * 40; // 40-year safety cap — auto-stops earlier when debts pay off
const HUNDRED = 100;
// A debt that is no lower than it was this many months ago never pays off.
const STALL_WINDOW = 12;
const PAID_OFF = 0.005;

/**
 * Compute the priority order for avalanche/snowball. Single source of
 * truth shared by the simulator and by the Save-to-Budget scenario
 * allocation, so the budgeted amount lands on the same account the
 * projection targets.
 *
 * - Avalanche: highest APR first; tie-break by smaller balance.
 * - Snowball:  smallest current balance first; tie-break by higher APR.
 * - Planned:   empty array — every account just pays its own amount.
 */
function priorityOrder(
  method: PaydownMethod,
  activeAccounts: PaydownAccount[],
  currentBalances: Record<string, number>,
): string[] {
  if (method === 'planned') return [];
  if (method === 'avalanche') {
    return [...activeAccounts]
      .sort((a, b) => {
        if (a.apr !== b.apr) return b.apr - a.apr;
        return (currentBalances[a.id] ?? a.balance) - (currentBalances[b.id] ?? b.balance);
      })
      .map((a) => a.id);
  }
  // snowball
  return [...activeAccounts]
    .sort((a, b) => {
      const ba = currentBalances[a.id] ?? a.balance;
      const bb = currentBalances[b.id] ?? b.balance;
      if (ba !== bb) return ba - bb;
      return b.apr - a.apr;
    })
    .map((a) => a.id);
}

/**
 * Format a Date as YYYY-MM in the user's local zone.
 * Months are 1-indexed: January = "2026-01".
 */
function ymOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return out;
}

function totalDebtOf(remaining: Record<string, number>): number {
  let s = 0;
  for (const v of Object.values(remaining)) s += v;
  return s;
}

/**
 * Run a single month of the simulation. Mutates `remaining` and `interestAccrued`
 * in place. Returns the month label.
 *
 * Avalanche / Snowball order is passed in as `order` — the caller decides
 * the priority ranking (avalanche = highest APR first, snowball = smallest
 * balance first). Planned ignores `order` and just pays every account.
 */
function simulateMonth(
  remaining: Record<string, number>,
  interestAccrued: Record<string, number>,
  order: string[],
  method: PaydownMethod,
  monthlyBudget: number,
  payments: Record<string, PayInfo>,
): { monthInterest: number; cashPaid: number; paidByAccount: Record<string, number> } {
  let monthInterest = 0;
  let cashPaid = 0;
  const paidByAccount: Record<string, number> = {};
  const applyPayment = (id: string, amount: number) => {
    if (amount <= 0) return;
    remaining[id]! -= amount;
    cashPaid += amount;
    paidByAccount[id] = (paidByAccount[id] ?? 0) + amount;
  };
  // 1) Accrue interest on every still-positive balance.
  for (const id of Object.keys(remaining)) {
    if (remaining[id]! <= 0) continue;
    const acc = payments[id];
    if (!acc) continue;
    const i = remaining[id]! * (acc.apr / 12);
    remaining[id]! += i;
    interestAccrued[id] = (interestAccrued[id] ?? 0) + i;
    monthInterest += i;
  }
  // 2) Apply payments. Track actual cash paid this month so the
  // aggregate totalPaid equals the sum of cash that left the user's
  // account — not a capped projection of planned payments (which
  // would overcount when an account hits zero mid-stream and would
  // miss the user's monthlyExtra under avalanche/snowball).
  if (method === 'planned') {
    // Pay each account its planned (or minimum) amount. No rollover.
    for (const id of Object.keys(remaining)) {
      if (remaining[id]! <= 0) continue;
      const acc = payments[id]!;
      const pay = Math.min(remaining[id]!, acc.effectivePayment);
      applyPayment(id, pay);
    }
  } else {
    // Avalanche / Snowball: use the fixed monthly budget to pay minimums,
    // then pour every remaining dollar through the priority order. Capping
    // a nearly-paid debt returns its unused minimum to the same pool.
    let pool = monthlyBudget;
    // First pass: minimums.
    for (const id of order) {
      if (remaining[id]! <= 0) continue;
      const acc = payments[id]!;
      const minPay = Math.min(remaining[id]!, acc.minPayment, pool);
      applyPayment(id, minPay);
      pool -= minPay;
    }
    // Second pass: pour pool into the top-priority still-positive.
    for (const id of order) {
      if (pool <= 0) break;
      if (remaining[id]! <= 0) continue;
      const pay = Math.min(remaining[id]!, pool);
      applyPayment(id, pay);
      pool -= pay;
    }
  }
  return { monthInterest, cashPaid, paidByAccount };
}

interface PayInfo {
  apr: number;
  minPayment: number;
  effectivePayment: number; // planned if > 0, else min
}

function payInfoFor(a: PaydownAccount): PayInfo {
  return {
    apr: a.apr,
    minPayment: a.minPayment,
    // Existing data may predate validation that planned must be at least
    // the minimum. Never project a contractual underpayment.
    effectivePayment: a.plannedPayment > 0
      ? Math.max(a.plannedPayment, a.minPayment)
      : a.minPayment,
  };
}

function applyWaterfall(
  remaining: Record<string, number>,
  order: string[],
  amount: number,
): { cashPaid: number; paidByAccount: Record<string, number> } {
  let pool = Math.max(0, amount);
  let cashPaid = 0;
  const paidByAccount: Record<string, number> = {};
  for (const id of order) {
    if (pool <= 0) break;
    const pay = Math.min(remaining[id] ?? 0, pool);
    if (pay <= 0) continue;
    remaining[id]! -= pay;
    pool -= pay;
    cashPaid += pay;
    paidByAccount[id] = pay;
  }
  return { cashPaid, paidByAccount };
}

function addPayments(target: Record<string, number>, source: Record<string, number>): void {
  for (const [id, amount] of Object.entries(source)) {
    target[id] = (target[id] ?? 0) + amount;
  }
}

/** Return the actual first-month cash allocation used by a projection. */
export function firstMonthPaydownPayments(
  accounts: PaydownAccount[],
  params: PaydownParams,
): Record<string, number> {
  const active = accounts.filter((a) => a.includeInPaydown && a.balance > 0);
  const remaining: Record<string, number> = {};
  const interestAccrued: Record<string, number> = {};
  const payments: Record<string, PayInfo> = {};
  for (const a of active) {
    remaining[a.id] = a.balance;
    interestAccrued[a.id] = 0;
    payments[a.id] = payInfoFor(a);
  }

  const paidByAccount: Record<string, number> = {};
  let order = priorityOrder(params.method, active, remaining);
  if (params.method !== 'planned' && params.oneTimeExtra > 0) {
    const lump = applyWaterfall(remaining, order, params.oneTimeExtra);
    addPayments(paidByAccount, lump.paidByAccount);
    order = priorityOrder(params.method, active, remaining);
  }
  const monthlyBudget = active.reduce((sum, a) => sum + payments[a.id]!.effectivePayment, 0)
    + (params.method === 'planned' ? 0 : Math.max(0, params.monthlyExtra));
  const month = simulateMonth(
    remaining,
    interestAccrued,
    order,
    params.method,
    monthlyBudget,
    payments,
  );
  addPayments(paidByAccount, month.paidByAccount);
  return paidByAccount;
}

/**
 * Run a full simulation and return the structured result.
 *
 * @param accounts The user's liability accounts. Anything with
 *                 `includeInPaydown: false` or `balance <= 0` is excluded
 *                 from the active set but listed in the per-account result
 *                 for completeness (so the UI can still render them).
 * @param params   Method + extra payment overrides.
 * @param startAt  The month the simulation starts (default: today). The
 *                 first month's payments are assumed not to have posted yet.
 */
export function projectPaydown(
  accounts: PaydownAccount[],
  params: PaydownParams,
  startAt: Date = new Date(),
): PaydownProjection {
  const start = new Date(startAt.getFullYear(), startAt.getMonth(), 1);

  // Split into active (eligible) and excluded.
  const active = accounts.filter((a) => a.includeInPaydown && a.balance > 0);
  const excluded = accounts.filter((a) => !a.includeInPaydown || a.balance <= 0);

  // Compute the priority order for avalanche / snowball.
  const orderFor = (method: PaydownMethod, currentBalances: Record<string, number>): string[] => {
    if (method === 'planned') return []; // unused
    return priorityOrder(method, active, currentBalances);
  };

  /**
   * Run a full simulation under a given method, returning a parallel
   * array indexed by month (0 = start month).
   */
  function run(method: PaydownMethod, monthlyExtra: number, oneTimeExtra: number) {
    const remaining: Record<string, number> = {};
    const interestAccrued: Record<string, number> = {};
    const payments: Record<string, PayInfo> = {};
    for (const a of active) {
      remaining[a.id] = a.balance;
      interestAccrued[a.id] = 0;
      payments[a.id] = payInfoFor(a);
    }
    const timeline: PaydownPoint[] = [];
    let totalInterest = 0;
    let totalPaid = 0;
    let monthsToDebtFree: number | null = null;
    let debtFreeMonth: string | null = null;
    let nonAmortizingIds: string[] = [];
    // Without rollover, an account whose payment doesn't beat its first
    // month's interest only grows. Project the others to their payoff,
    // then stop.
    const stuck = method === 'planned'
      ? active.filter((a) => payments[a.id]!.effectivePayment <= a.balance * (a.apr / 12) + PAID_OFF).map((a) => a.id)
      : [];
    const othersPaidOff = () =>
      active.every((a) => stuck.includes(a.id) || remaining[a.id]! <= PAID_OFF);
    const paidByAccount: Record<string, number> = {};
    const payoffByAccount: Record<string, { months: number; month: string } | undefined> = {};
    const monthlyBudget = active.reduce((sum, a) => sum + payments[a.id]!.effectivePayment, 0)
      + (method === 'planned' ? 0 : Math.max(0, monthlyExtra));

    for (let m = 0; m < MAX_MONTHS; m++) {
      // Snapshot before this month's payments so the chart shows
      // the user's balance AT the start of each month.
      const snapshotBalances: Record<string, number> = { ...remaining };
      const snapMonth = addMonths(start, m);
      timeline.push({
        month: ymOf(snapMonth),
        totalDebt: totalDebtOf(snapshotBalances),
        byAccount: snapshotBalances,
      });
      if (totalDebtOf(remaining) <= PAID_OFF) break;
      if (stuck.length > 0 && othersPaidOff()) {
        nonAmortizingIds = stuck;
        break;
      }
      // Stop as soon as the debt stops shrinking instead of compounding
      // a growing balance to the 40-year cap.
      const yearAgo = timeline[m - STALL_WINDOW];
      if (yearAgo && totalDebtOf(remaining) >= yearAgo.totalDebt - PAID_OFF) {
        nonAmortizingIds = active
          .filter((a) => {
            const now = remaining[a.id]!;
            return now > PAID_OFF && now >= (yearAgo.byAccount[a.id] ?? 0) - PAID_OFF;
          })
          .map((a) => a.id);
        break;
      }
      let order = orderFor(method, remaining);
      // A one-time payment is immediate, before this month's interest,
      // and cascades through the full priority order.
      if (m === 0 && method !== 'planned' && oneTimeExtra > 0) {
        const lump = applyWaterfall(remaining, order, oneTimeExtra);
        totalPaid += lump.cashPaid;
        addPayments(paidByAccount, lump.paidByAccount);
        order = orderFor(method, remaining);
      }
      const { monthInterest, cashPaid, paidByAccount: monthPayments } = simulateMonth(
        remaining,
        interestAccrued,
        order,
        method,
        monthlyBudget,
        payments,
      );
      totalInterest += monthInterest;
      totalPaid += cashPaid;
      addPayments(paidByAccount, monthPayments);

      const paymentMonth = ymOf(snapMonth);
      for (const a of active) {
        if (!payoffByAccount[a.id] && remaining[a.id]! <= PAID_OFF) {
          payoffByAccount[a.id] = { months: m + 1, month: paymentMonth };
        }
      }
      if (monthsToDebtFree === null && totalDebtOf(remaining) <= PAID_OFF) {
        monthsToDebtFree = m + 1;
        debtFreeMonth = paymentMonth;
      }
    }
    if (stuck.length > 0 && nonAmortizingIds.length === 0) nonAmortizingIds = stuck;
    // A payoff on the very last allowed month still ends the curve at zero.
    const last = timeline[timeline.length - 1];
    if (monthsToDebtFree !== null && last && last.totalDebt > PAID_OFF) {
      timeline.push({
        month: ymOf(addMonths(start, timeline.length)),
        totalDebt: totalDebtOf(remaining),
        byAccount: { ...remaining },
      });
    }
    // Per-account results.
    const perAccount: PaydownAccountResult[] = active.map((a) => {
      const payoff = payoffByAccount[a.id];
      return {
        accountId: a.id,
        name: a.name,
        startingBalance: a.balance,
        apr: a.apr,
        payoffMonth: payoff?.month ?? null,
        monthsToPayoff: payoff?.months ?? null,
        totalInterest: interestAccrued[a.id] ?? 0,
        totalPaid: paidByAccount[a.id] ?? 0,
      };
    });
    // Excluded accounts are listed with no payoff / no interest.
    for (const a of excluded) {
      perAccount.push({
        accountId: a.id,
        name: a.name,
        startingBalance: a.balance,
        apr: a.apr,
        payoffMonth: null,
        monthsToPayoff: null,
        totalInterest: 0,
        totalPaid: 0,
      });
    }
    return {
      perAccount,
      timeline,
      totalInterest,
      totalPaid,
      monthsToDebtFree,
      debtFreeMonth,
      nonAmortizingIds,
    };
  }

  // Run the user's chosen scenario.
  const scenario = run(params.method, params.monthlyExtra, params.oneTimeExtra);

  // Always also compute the "planned payments, no extras" baseline so the
  // UI can show the dotted "where you'd be without this scenario" line.
  const baseline = run('planned', 0, 0);

  const startingTotal = active.reduce((s, a) => s + a.balance, 0);

  return {
    method: params.method,
    params,
    startingTotal,
    totalInterest: scenario.totalInterest,
    totalPaid: scenario.totalPaid,
    monthsToDebtFree: scenario.monthsToDebtFree,
    debtFreeMonth: scenario.debtFreeMonth,
    nonAmortizingIds: scenario.nonAmortizingIds,
    perAccount: scenario.perAccount,
    timeline: scenario.timeline,
    baselineTimeline: baseline.timeline,
    baselineTotalInterest: baseline.totalInterest,
    baselineMonthsToDebtFree: baseline.monthsToDebtFree,
    baselineDebtFreeMonth: baseline.debtFreeMonth,
    baselineNonAmortizingIds: baseline.nonAmortizingIds,
  };
}

/** Map a liability account row (as returned by getLiabilityAccounts) to calculator input. */
export function toPaydownAccount(row: {
  id: string;
  name: string;
  type: string;
  balance: number;
  interestRate: number;
  minPayment: number;
  plannedPayment: number;
  includeInPaydown: boolean;
}): PaydownAccount {
  return {
    id: row.id,
    name: row.name,
    type: row.type === 'loan' ? 'loan' : 'credit',
    balance: row.balance,
    apr: row.interestRate,
    minPayment: row.minPayment,
    plannedPayment: row.plannedPayment,
    includeInPaydown: row.includeInPaydown,
  };
}

/** Projection returned when the user has no liability accounts. */
export function emptyProjection(method: PaydownMethod, params: PaydownParams): PaydownProjection {
  return {
    method,
    params,
    startingTotal: 0,
    totalInterest: 0,
    totalPaid: 0,
    monthsToDebtFree: null,
    debtFreeMonth: null,
    nonAmortizingIds: [],
    perAccount: [],
    timeline: [],
    baselineTimeline: [],
    baselineTotalInterest: 0,
    baselineMonthsToDebtFree: null,
    baselineDebtFreeMonth: null,
    baselineNonAmortizingIds: [],
  };
}

export { ymOf, addMonths, MAX_MONTHS, HUNDRED };
