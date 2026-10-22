/**
 * The Budget page as data: the same groups, lines, debt section, and
 * "Left to budget" math as `src/ui/src/pages/Budget.tsx` and
 * `BudgetSummaryBox.tsx`, computed in cents.
 */
import { latestBudgetsUpTo } from '@/db/budget-repository';
import { getAllAccounts, getAllCategories, getBudgetActivity, getPaydownModalData } from '@/db/queries';
import { centsToDollars, dollarsToCents } from '@/lib/money';

export interface BudgetLine {
  subCategoryId: string;
  category: string;
  subCategory: string;
  planned: number;
  actual: number;
  remaining: number;
  transactionCount: number;
  /** Nothing planned and nothing spent or earned; the page's "Hide unbudgeted" hides it. */
  unbudgeted: boolean;
}

export interface BudgetGroup {
  name: string;
  type: 'income' | 'expense';
  planned: number;
  actual: number;
  lines: BudgetLine[];
}

export interface BudgetView {
  month: string;
  totals: {
    plannedIncome: number;
    earnedIncome: number;
    plannedExpense: number;
    spentExpense: number;
    plannedDebtPayments: number;
    paidDebtPayments: number;
    /** Planned income minus planned expenses and planned debt payments. */
    leftToBudget: number;
  };
  groups: BudgetGroup[];
  debtPayments: {
    lastSavedFromPaydown: string | null;
    accounts: Array<{ accountId: string; account: string; type: 'credit' | 'loan'; apr: number; planned: number; paid: number; remaining: number }>;
  };
  hiddenUnbudgetedLines: number;
}

export async function buildBudgetView(
  userId: string,
  month: string,
  options: { hideUnbudgeted?: boolean } = {},
): Promise<BudgetView> {
  const [categories, overrides, activity, debt, accounts] = await Promise.all([
    getAllCategories(userId),
    latestBudgetsUpTo(userId, month),
    getBudgetActivity(userId, month),
    getPaydownModalData(userId, month),
    getAllAccounts(userId),
  ]);
  const activityByKey = new Map(activity.rows.map((r) => [`${r.type}\0${r.category}\0${r.subCategory}`, r]));

  const toGroup = (name: string, type: 'income' | 'expense', list: typeof categories) => {
    let plannedCents = 0;
    let actualCents = 0;
    const lines: BudgetLine[] = list.flatMap((c) => c.subCategories.map((s) => {
      const row = activityByKey.get(`${type}\0${c.name}\0${s.name}`);
      const planned = dollarsToCents(overrides.get(s.id) ?? s.planned);
      const actual = dollarsToCents(row?.actual ?? 0);
      plannedCents += planned;
      actualCents += actual;
      return {
        subCategoryId: s.id,
        category: c.name,
        subCategory: s.name,
        planned: centsToDollars(planned),
        actual: centsToDollars(actual),
        remaining: centsToDollars(planned - actual),
        transactionCount: row?.transactions.length ?? 0,
        unbudgeted: planned === 0 && actual === 0,
      };
    }));
    return { group: { name, type, planned: centsToDollars(plannedCents), actual: centsToDollars(actualCents), lines }, plannedCents, actualCents };
  };

  // All income categories form one group; each expense category is its own.
  // Transfer categories (including Pay down goals) are budget-neutral.
  const income = toGroup('Income', 'income', categories.filter((c) => c.type === 'income'));
  const expenses = categories.filter((c) => c.type === 'expense').map((c) => toGroup(c.name, 'expense', [c]));

  // Prefer the month's saved paydown snapshot; with no rows, fall back to
  // live included debts, planned payment or else minimum, skipping debts
  // already paid off.
  let plannedDebtCents = 0;
  const paidDebtCents = debt.rows.reduce((sum, r) => sum + dollarsToCents(r.actual), 0);
  if (debt.rows.length > 0) {
    plannedDebtCents = debt.rows.reduce((sum, r) => sum + dollarsToCents(r.planned), 0);
  } else {
    for (const a of accounts) {
      if (!a.includeInPaydown || (a.type !== 'credit' && a.type !== 'loan') || a.balance <= 0) continue;
      plannedDebtCents += dollarsToCents(a.plannedPayment > 0 ? a.plannedPayment : a.minPayment ?? 0);
    }
  }

  const plannedExpenseCents = expenses.reduce((sum, g) => sum + g.plannedCents, 0);
  const spentExpenseCents = expenses.reduce((sum, g) => sum + g.actualCents, 0);
  const allGroups = [income.group, ...expenses.map((g) => g.group)];
  const hiddenUnbudgetedLines = options.hideUnbudgeted
    ? allGroups.reduce((n, g) => n + g.lines.filter((l) => l.unbudgeted).length, 0)
    : 0;
  const groups = options.hideUnbudgeted
    ? allGroups
      .filter((g) => g.planned !== 0 || g.actual !== 0)
      .map((g) => ({ ...g, lines: g.lines.filter((l) => !l.unbudgeted) }))
    : allGroups;

  return {
    month,
    totals: {
      plannedIncome: centsToDollars(income.plannedCents),
      earnedIncome: centsToDollars(income.actualCents),
      plannedExpense: centsToDollars(plannedExpenseCents),
      spentExpense: centsToDollars(spentExpenseCents),
      plannedDebtPayments: centsToDollars(plannedDebtCents),
      paidDebtPayments: centsToDollars(paidDebtCents),
      leftToBudget: centsToDollars(income.plannedCents - plannedExpenseCents - plannedDebtCents),
    },
    groups,
    debtPayments: {
      lastSavedFromPaydown: debt.meta.syncedAt?.toISOString() ?? null,
      accounts: debt.rows.map((r) => ({
        accountId: r.accountId,
        account: r.accountName,
        type: r.type,
        apr: r.apr,
        planned: r.planned,
        paid: r.actual,
        remaining: r.remaining,
      })),
    },
    hiddenUnbudgetedLines,
  };
}
