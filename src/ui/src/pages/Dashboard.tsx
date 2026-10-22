import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { currentYearMonth, formatMoney } from '../lib/format';
import { formatAccountBalance, netWorthContribution, isLiability } from '../lib/accounting';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  ArrowLeftRight,
  ChevronRight,
  Check,
  Pencil,
  X,
} from 'lucide-react';
import { SortableWidgetList } from '../components/SortableWidgetList';
import { Alert, AlertDescription } from '../components/ui/alert';
import { AsyncQueryState } from '../components/ui/AsyncQueryState';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Spinner } from '../components/ui/spinner';
import { GoalProgressBar } from '../components/GoalProgressBar';
import clsx from 'clsx';
import { useReviews } from '../components/ReviewsProvider';

interface Account { id: string; name: string; type: string; balance: number; institution?: string; }
interface DashboardTransaction {
  id: string;
  date: string;
  merchant: string;
  category: string;
  subCategory?: string;
  account: string;
  amount: number;
  type: 'income' | 'expense' | 'transfer';
}
interface DashboardActivity {
  income: number;
  expense: number;
  transferCount: number;
  recent: DashboardTransaction[];
}

interface RecurringCharge {
  merchant: string;
  amount: number;
  frequency: 'weekly' | 'monthly' | 'yearly';
  nextDate: string;
  daysUntil: number;
  comingSoon: boolean;
  account: string;
  accountId?: string;
}

interface Goal {
  id: string;
  name: string;
  target: number;
  startingValue: number;
  accountId: string | null;
  accountBalance: number | null;
  accountName: string | null;
}

interface MainCategory {
  id: string;
  name: string;
  type: 'income' | 'expense' | 'transfer';
  subCategories: { id: string; name: string; planned: number }[];
}

interface BudgetRow { subCategoryId: string; planned: number; }
interface BudgetActivityRow {
  category: string;
  subCategory: string;
  type: 'income' | 'expense';
  actual: number;
}

const DEFAULT_WIDGET_ORDER = [
  'budget',
  'coming-up',
  'save-up',
  'summary',
  'assets-liabilities',
  'recent-transactions',
  'accounts',
] as const;
type WidgetId = (typeof DEFAULT_WIDGET_ORDER)[number];
const DEFAULT_HIDDEN: WidgetId[] = ['accounts'];
interface DashboardLayout { order: WidgetId[]; hidden: WidgetId[]; }

const WIDGET_LABELS: Record<WidgetId, string> = {
  summary: 'Summary',
  budget: 'Budget lines to watch',
  'coming-up': 'Coming up',
  'save-up': 'Save up',
  'assets-liabilities': 'Assets and liabilities',
  accounts: 'Accounts',
  'recent-transactions': 'Recent transactions',
};

const actualKey = (category: string, subCategory?: string) => `${category}\0${subCategory ?? category}`;

function withAllWidgets(order: WidgetId[]): WidgetId[] {
  const next = order.filter((id) => (DEFAULT_WIDGET_ORDER as readonly string[]).includes(id));
  for (const id of DEFAULT_WIDGET_ORDER) {
    if (next.includes(id)) continue;
    const defaultIdx = DEFAULT_WIDGET_ORDER.indexOf(id);
    let insertAt = next.length;
    for (let i = defaultIdx - 1; i >= 0; i--) {
      const prevPos = next.indexOf(DEFAULT_WIDGET_ORDER[i]!);
      if (prevPos !== -1) {
        insertAt = prevPos + 1;
        break;
      }
    }
    next.splice(insertAt, 0, id);
  }
  return next;
}

/** Visual styling for a transaction type — kept in one place so the
 *  Dashboard "Recent" list, the Transactions table, and anywhere else
 *  we render a tx all agree. */
function txTypeStyle(type: DashboardTransaction['type']): { sign: string; amount: string } {
  if (type === 'income') return { sign: '+', amount: 'text-emerald-400' };
  if (type === 'expense') return { sign: '−', amount: 'text-rose-400' };
  return { sign: '⇄', amount: 'text-slate-400' };
}

function daysLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

function monthName(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, 1).toLocaleString('en-US', { month: 'long' });
}

/** Widgets that sit two-up on wide screens when they appear next to each other. */
const HALF_WIDTH_WIDGETS = new Set<WidgetId>(['budget', 'coming-up', 'save-up', 'accounts', 'recent-transactions']);

export function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reviews = useReviews();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [draftOrder, setDraftOrder] = useState<WidgetId[]>([...DEFAULT_WIDGET_ORDER]);
  const [draftHidden, setDraftHidden] = useState<WidgetId[]>([]);
  const toggleSection = (key: string) =>
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const activity = useQuery({
    queryKey: ['dashboard', 'activity'],
    queryFn: () => api.get<DashboardActivity>('/api/dashboard/activity'),
  });
  const layout = useQuery({
    queryKey: ['dashboard', 'layout'],
    queryFn: () => api.get<DashboardLayout>('/api/dashboard/layout'),
  });
  const ym = currentYearMonth();
  const recurring = useQuery({
    queryKey: ['recurring'],
    queryFn: () => api.get<RecurringCharge[]>('/api/recurring'),
  });
  const goals = useQuery({
    queryKey: ['goals'],
    queryFn: () => api.get<Goal[]>('/api/goals'),
  });
  const cats = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<MainCategory[]>('/api/categories'),
  });
  const budgets = useQuery({
    queryKey: ['budget', ym],
    queryFn: () => api.get<BudgetRow[]>(`/api/budget/${ym}`),
  });
  const budgetActivity = useQuery({
    queryKey: ['budget', 'activity', ym],
    queryFn: () => api.get<{ yearMonth: string; rows: BudgetActivityRow[] }>(`/api/budget/${ym}/activity`),
  });
  const saveLayout = useMutation({
    mutationFn: (next: DashboardLayout) => api.put<DashboardLayout>('/api/dashboard/layout', next),
    onSuccess: (saved) => {
      queryClient.setQueryData(['dashboard', 'layout'], saved);
      setEditing(false);
    },
  });

  const savedOrder = withAllWidgets(layout.data?.order ?? [...DEFAULT_WIDGET_ORDER]);
  const savedHidden = (layout.data?.hidden ?? DEFAULT_HIDDEN).filter((id) => (DEFAULT_WIDGET_ORDER as readonly string[]).includes(id));
  const startEditing = () => {
    setDraftOrder([...savedOrder]);
    setDraftHidden([...savedHidden]);
    saveLayout.reset();
    setEditing(true);
  };
  const cancelEditing = () => {
    setDraftOrder([...savedOrder]);
    setDraftHidden([...savedHidden]);
    saveLayout.reset();
    setEditing(false);
  };
  const toggleHidden = (widget: WidgetId) => {
    setDraftHidden((current) => current.includes(widget) ? current.filter((id) => id !== widget) : [...current, widget]);
  };

  const monthBudget = useMemo(() => {
    const plannedBySub = new Map<string, number>();
    for (const c of cats.data ?? []) {
      for (const s of c.subCategories) plannedBySub.set(s.id, s.planned);
    }
    for (const b of budgets.data ?? []) plannedBySub.set(b.subCategoryId, b.planned);

    const spentByKey = new Map<string, number>();
    for (const row of budgetActivity.data?.rows ?? []) {
      if (row.type !== 'expense') continue;
      spentByKey.set(actualKey(row.category, row.subCategory), row.actual);
    }

    let plannedExpense = 0;
    let spentExpense = 0;
    const categories: { key: string; name: string; planned: number; spent: number }[] = [];
    for (const c of cats.data ?? []) {
      if (c.type !== 'expense') continue;
      for (const s of c.subCategories) {
        const planned = plannedBySub.get(s.id) ?? s.planned;
        const spent = spentByKey.get(actualKey(c.name, s.name)) ?? 0;
        plannedExpense += planned;
        spentExpense += spent;
        if (planned > 0) categories.push({ key: s.id, name: s.name, planned, spent });
      }
    }
    categories.sort((a, b) => (b.spent / b.planned) - (a.spent / a.planned) || b.spent - a.spent);
    return {
      plannedExpense,
      spentExpense,
      remaining: plannedExpense - spentExpense,
      hotspots: categories.slice(0, 3),
    };
  }, [cats.data, budgets.data, budgetActivity.data]);

  const upcomingCharges = useMemo(() => {
    const charges = recurring.data ?? [];
    const soon = charges.filter((c) => c.comingSoon).sort((a, b) => a.daysUntil - b.daysUntil);
    if (soon.length > 0) return soon.slice(0, 4);
    return [...charges].sort((a, b) => a.daysUntil - b.daysUntil).slice(0, 4);
  }, [recurring.data]);

  const goalRows = useMemo(() => {
    const list = goals.data ?? [];
    const active = list.filter((goal) => goal.accountBalance === null || goal.accountBalance < goal.target);
    return (active.length > 0 ? active : list).slice(0, 3);
  }, [goals.data]);

  if (accounts.isLoading || activity.isLoading || layout.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold">Home</h1>
        <AsyncQueryState status="loading" title="Loading Home…" message="Fetching accounts and recent transactions." />
      </div>
    );
  }

  if (accounts.isError || activity.isError) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold">Home</h1>
        <AsyncQueryState
          status="error"
          title="Could not load Home"
          message="Account and transaction data is unavailable, so financial totals are hidden."
          onRetry={() => void Promise.all([accounts.refetch(), activity.refetch()])}
          retrying={accounts.isFetching || activity.isFetching}
        />
      </div>
    );
  }

  // Sum *signed* contributions so credit cards + loans subtract from
  // net worth. `a.balance` is always stored positive — see
  // `netWorthContribution` in `lib/accounting.ts` for the convention.
  const totalBalance = accounts.data?.reduce((s, a) => s + netWorthContribution(a), 0) ?? 0;
  const income = activity.data?.income ?? 0;
  const expense = activity.data?.expense ?? 0;
  const transferCount = activity.data?.transferCount ?? 0;

  // Assets vs Liabilities breakdown
  const assetAccounts = accounts.data?.filter((a) => a.type !== 'uncategorized' && !isLiability(a.type)) ?? [];
  const liabilityAccounts = accounts.data?.filter((a) => isLiability(a.type)) ?? [];
  const totalAssets = assetAccounts.reduce((s, a) => s + Math.abs(a.balance), 0);
  const totalLiabilities = liabilityAccounts.reduce((s, a) => s + Math.abs(a.balance), 0);
  const cashAccounts = assetAccounts.filter((a) => a.type === 'checking' || a.type === 'savings');
  const investmentAccounts = assetAccounts.filter((a) => a.type === 'investment');
  const creditAccounts = liabilityAccounts.filter((a) => a.type === 'credit');
  const loanAccounts = liabilityAccounts.filter((a) => a.type === 'loan');
  const cashTotal = cashAccounts.reduce((s, a) => s + Math.abs(a.balance), 0);
  const investmentTotal = investmentAccounts.reduce((s, a) => s + Math.abs(a.balance), 0);
  const creditTotal = creditAccounts.reduce((s, a) => s + Math.abs(a.balance), 0);
  const loanTotal = loanAccounts.reduce((s, a) => s + Math.abs(a.balance), 0);

  const renderWidget = (widget: WidgetId) => {
    if (widget === 'summary') {
      const budgetLoading = cats.isLoading || budgets.isLoading || budgetActivity.isLoading;
      const budgetError = cats.isError || budgets.isError || budgetActivity.isError;
      const hasBudget = monthBudget.plannedExpense > 0;
      const over = monthBudget.remaining < 0;
      let leftValue: ReactNode;
      let leftSub: ReactNode;
      if (budgetLoading) {
        leftValue = <span className="text-muted-foreground">…</span>;
        leftSub = 'Loading budget';
      } else if (budgetError) {
        leftValue = <span className="text-muted-foreground">—</span>;
        leftSub = 'Could not load the budget';
      } else if (!hasBudget) {
        leftValue = <span className="text-muted-foreground">—</span>;
        leftSub = (
          <Button type="button" variant="link" className="h-auto p-0 md:h-auto" onClick={() => navigate('/budget')}>
            Set a budget
          </Button>
        );
      } else {
        leftValue = (
          <span className={over ? 'text-rose-400' : 'text-emerald-400'}>
            {over ? '−' : ''}{formatMoney(Math.abs(monthBudget.remaining))}
          </span>
        );
        leftSub = over
          ? `Over the ${formatMoney(monthBudget.plannedExpense)} budgeted`
          : `of ${formatMoney(monthBudget.plannedExpense)} budgeted`;
      }
      return (
        <section aria-label="Summary" className="@container rounded-xl bg-card ring-1 ring-border">
          <dl className="grid grid-cols-2 @3xl:grid-cols-4">
            <LedgerCell
              label="Net worth"
              value={<span className={totalBalance < 0 ? 'text-rose-400' : undefined}>{totalBalance < 0 ? '−' : ''}{formatMoney(Math.abs(totalBalance))}</span>}
              sub={`${formatMoney(totalAssets)} owned, ${formatMoney(totalLiabilities)} owed`}
            />
            <LedgerCell
              className="border-l border-border"
              label={`Left to spend in ${monthName(ym)}`}
              value={leftValue}
              sub={leftSub}
            />
            <LedgerCell
              className="border-t border-border @3xl:border-t-0 @3xl:border-l"
              label="Income, last 30 days"
              value={formatMoney(income)}
              sub="Transfers excluded"
            />
            <LedgerCell
              className="border-t border-l border-border @3xl:border-t-0"
              label="Spending, last 30 days"
              value={formatMoney(expense)}
              sub="Out of pocket"
            />
          </dl>
        </section>
      );
    }

    if (widget === 'budget') {
      const budgetLoading = cats.isLoading || budgets.isLoading || budgetActivity.isLoading;
      const budgetError = cats.isError || budgets.isError || budgetActivity.isError;
      return (
        <Card className="h-full">
          <CardHeader>
            <CardTitle>Budget lines to watch</CardTitle>
            <CardAction>
              <Button type="button" variant="link" onClick={() => navigate('/budget')}>
                Open budget <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
          {budgetLoading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading this month's budget…</p>
          ) : budgetError ? (
            <p className="py-4 text-center text-sm text-destructive">Could not load this month's budget.</p>
          ) : monthBudget.hotspots.length === 0 ? (
            <EmptyAction message="No expense budget this month." action="Set a budget" onClick={() => navigate('/budget')} />
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {monthBudget.hotspots.map((row) => {
                const rowOver = row.spent > row.planned;
                const left = row.planned - row.spent;
                return (
                  <li key={row.key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <div className="truncate">{row.name}</div>
                      <div className={clsx('text-xs tabular-nums', rowOver ? 'text-rose-400' : 'text-muted-foreground')}>
                        {rowOver ? `Over by ${formatMoney(-left)}` : left === 0 ? 'Fully spent' : `${formatMoney(left)} left`}
                      </div>
                    </div>
                    <div className="shrink-0 text-right tabular-nums">
                      <span className={clsx('font-semibold', rowOver && 'text-rose-400')}>{formatMoney(row.spent)}</span>
                      <span className="text-muted-foreground"> of {formatMoney(row.planned)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          </CardContent>
        </Card>
      );
    }

    if (widget === 'coming-up') {
      return (
        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle>Coming up</CardTitle>
            <CardAction>
              <Button type="button" variant="link" onClick={() => navigate('/recurring')}>
                All recurring <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
          {recurring.isLoading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading upcoming charges…</p>
          ) : recurring.isError ? (
            <p className="py-4 text-center text-sm text-destructive">Could not load upcoming charges.</p>
          ) : upcomingCharges.length === 0 ? (
            <EmptyAction message="No upcoming charges." action="See recurring" onClick={() => navigate('/recurring')} />
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {upcomingCharges.map((charge) => (
                <li key={`${charge.merchant}|${charge.accountId ?? charge.account}|${charge.nextDate}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">{charge.merchant}</div>
                    <div className={clsx('text-xs', charge.daysUntil < 0 ? 'text-sky-300' : 'text-muted-foreground')}>
                      {daysLabel(charge.daysUntil)}
                    </div>
                  </div>
                  <div className="shrink-0 text-right font-semibold tabular-nums">
                    {formatMoney(charge.amount)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          </CardContent>
        </Card>
      );
    }

    if (widget === 'save-up') {
      return (
        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle>Save up</CardTitle>
            <CardAction>
              <Button type="button" variant="link" onClick={() => navigate('/saveup')}>
                Goals <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
          {goals.isLoading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading savings goals…</p>
          ) : goals.isError ? (
            <p className="py-4 text-center text-sm text-destructive">Could not load savings goals.</p>
          ) : goalRows.length === 0 ? (
            <EmptyAction message="No savings goals yet." action="Add a goal" onClick={() => navigate('/saveup')} />
          ) : (
            <ul className="flex flex-col gap-3">
              {goalRows.map((goal) => {
                const current = goal.accountBalance ?? 0;
                const hasAccount = goal.accountBalance !== null;
                const pct = hasAccount && goal.target > 0 ? Math.min(100, (Math.max(0, current) / goal.target) * 100) : 0;
                const reached = hasAccount && current >= goal.target;
                return (
                  <li key={goal.id}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate">{goal.name}</span>
                      <span className={clsx('shrink-0 tabular-nums', reached ? 'text-emerald-400' : 'text-muted-foreground')}>
                        {hasAccount ? `${formatMoney(current)} of ${formatMoney(goal.target)}` : 'No account'}
                      </span>
                    </div>
                    <GoalProgressBar className="mt-1.5" value={pct} />
                  </li>
                );
              })}
            </ul>
          )}
          </CardContent>
        </Card>
      );
    }

    if (widget === 'assets-liabilities') {
      return (
        <Card>
          <CardHeader>
            <CardTitle>Assets and liabilities</CardTitle>
          </CardHeader>
          <CardContent>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold">Assets</span>
                <span className="text-sm font-semibold tabular-nums text-emerald-400">{formatMoney(totalAssets)}</span>
              </div>
              <ul className="flex flex-col gap-1">
                <ExpandableSubcategory label="Cash" total={cashTotal} accounts={cashAccounts} expanded={expandedSections.has('cash')} onToggle={() => toggleSection('cash')} />
                <ExpandableSubcategory label="Investments" total={investmentTotal} accounts={investmentAccounts} expanded={expandedSections.has('investments')} onToggle={() => toggleSection('investments')} />
              </ul>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold">Liabilities</span>
                <span className="text-sm font-semibold tabular-nums text-rose-400">{totalLiabilities > 0 ? '−' : ''}{formatMoney(totalLiabilities)}</span>
              </div>
              <ul className="flex flex-col gap-1">
                <ExpandableSubcategory label="Credit cards" owed total={creditTotal} accounts={creditAccounts} expanded={expandedSections.has('credit')} onToggle={() => toggleSection('credit')} />
                <ExpandableSubcategory label="Loans" owed total={loanTotal} accounts={loanAccounts} expanded={expandedSections.has('loans')} onToggle={() => toggleSection('loans')} />
              </ul>
            </div>
          </div>
          </CardContent>
        </Card>
      );
    }

    if (widget === 'accounts') {
      return (
        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle>Accounts</CardTitle>
            <CardAction>
              <Button type="button" variant="link" onClick={() => navigate('/accounts')}>
                Manage <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
          <ul className="divide-y divide-border">
            {accounts.data?.slice(0, 4).map((a) => {
              const balance = formatAccountBalance(a, formatMoney);
              return (
                <li key={a.id} className="flex justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{a.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{a.institution ?? a.type}</div>
                  </div>
                  <div className={clsx('shrink-0 font-semibold tabular-nums', balance.colorClass)}>{balance.text}</div>
                </li>
              );
            })}
            {accounts.data?.length === 0 && (
              <li>
                <EmptyAction message="No accounts yet." action="Add an account" onClick={() => navigate('/accounts')} />
              </li>
            )}
          </ul>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card className="flex h-full flex-col">
        <CardHeader>
          <CardTitle>Recent transactions</CardTitle>
          {transferCount > 0 && (
            <CardDescription className="flex items-center gap-1 text-xs">
              <ArrowLeftRight className="size-3 shrink-0" /> {transferCount} transfer{transferCount === 1 ? '' : 's'}, excluded from totals
            </CardDescription>
          )}
          <CardAction>
            <Button type="button" variant="link" onClick={() => navigate('/transactions')}>
              View all <ArrowRight data-icon="inline-end" />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
        <ul className="divide-y divide-border">
          {activity.data?.recent.map((t) => {
            const style = txTypeStyle(t.type);
            return (
              <li key={t.id} className="flex justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-medium">
                    {t.type === 'transfer' && <ArrowLeftRight className="size-3 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{t.merchant}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{t.date} · {t.category}{t.subCategory ? ` › ${t.subCategory}` : ''} · {t.account}</div>
                </div>
                <div className={clsx('shrink-0 font-semibold tabular-nums', style.amount)}>{style.sign}{formatMoney(t.amount)}</div>
              </li>
            );
          })}
          {activity.data?.recent.length === 0 && (
            <li>
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No transactions yet.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            </li>
          )}
        </ul>
        </CardContent>
      </Card>
    );
  };

  const displayedOrder = editing ? draftOrder : savedOrder;
  const displayedHidden = new Set(editing ? draftHidden : savedHidden);
  const visibleDisplayedOrder = displayedOrder.filter((widget) => !displayedHidden.has(widget));
  // Consecutive half-width widgets pair up two per row; an unpaired one
  // at the end of a run spans the full width so no row is left half empty.
  const halfWidth = new Set<WidgetId>();
  let run: WidgetId[] = [];
  const flushRun = () => {
    const pairable = run.length - (run.length % 2);
    for (let i = 0; i < pairable; i++) halfWidth.add(run[i]!);
    run = [];
  };
  for (const widget of visibleDisplayedOrder) {
    if (HALF_WIDTH_WIDGETS.has(widget)) run.push(widget);
    else flushRun();
  }
  flushRun();
  const dashboardItemClass = (widget: WidgetId) =>
    halfWidth.has(widget) ? 'flex flex-col min-w-0 min-h-0' : 'flex flex-col min-w-0 md:col-span-2';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
        <div className={clsx('flex items-center max-md:order-last', !editing && 'max-md:ml-auto')}>
          <h1 className="text-2xl font-bold">Home</h1>
          {!editing && (
            // On mobile the page h1 is hidden (the app bar owns the title),
            // so the pencil moves to the right edge like a native Edit action.
            <Button type="button" variant="ghost" size="icon" onClick={startEditing} disabled={layout.isLoading} className="edit-icon-button max-md:ml-auto" aria-label="Edit home layout" title="Edit home layout">
              <Pencil />
            </Button>
          )}
        </div>
        {!editing && reviews.count > 0 && (
          <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground max-md:min-w-0 max-md:flex-1">
            <span className="max-md:min-w-0 max-md:flex-1">
              {reviews.count} imported transaction{reviews.count === 1 ? ' isn’t' : 's aren’t'} counted until you review {reviews.count === 1 ? 'it' : 'them'}.
            </span>
            <Button type="button" variant="outline" className="shrink-0" onClick={reviews.openModal}>
              Review {reviews.count}
            </Button>
          </div>
        )}
        {editing && (
          <div className="flex items-center gap-2 max-md:ml-auto">
            <Button type="button" variant="outline" onClick={cancelEditing} disabled={saveLayout.isPending}>
              <X data-icon="inline-start" /> Cancel
            </Button>
            <Button type="button" onClick={() => saveLayout.mutate({ order: draftOrder, hidden: draftHidden })} disabled={saveLayout.isPending}>
              {saveLayout.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              {saveLayout.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>
      {saveLayout.isError && (
        <Alert variant="destructive">
          <AlertDescription>Could not save the home layout. Please try again.</AlertDescription>
        </Alert>
      )}

      <SortableWidgetList
        order={displayedOrder}
        labels={WIDGET_LABELS}
        editing={editing}
        onReorder={setDraftOrder}
        renderWidget={renderWidget}
        className="grid grid-cols-1 gap-6 md:grid-cols-2"
        itemClassName={dashboardItemClass}
        hidden={displayedHidden}
        onToggleHidden={editing ? toggleHidden : undefined}
      />
    </div>
  );
}

function LedgerCell({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  className?: string;
}) {
  return (
    // Each cell spans three rows of the parent grid via subgrid, so labels,
    // amounts and notes line up across a row even when a label wraps.
    <div className={clsx('row-span-3 grid min-w-0 grid-rows-subgrid px-4 py-4 @3xl:px-6 @3xl:py-5', className)}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-xl font-bold tracking-tight tabular-nums @3xl:text-[1.75rem] @3xl:leading-tight">{value}</dd>
      <dd className="mt-1 text-sm text-muted-foreground">{sub}</dd>
    </div>
  );
}

function EmptyAction({
  message,
  action,
  onClick,
}: {
  message: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{message}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button type="button" variant="link" onClick={onClick}>
          {action}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function ExpandableSubcategory({
  label,
  owed = false,
  total,
  accounts,
  expanded,
  onToggle,
}: {
  label: string;
  owed?: boolean;
  total: number;
  accounts: Account[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        onClick={onToggle}
        className="-mx-2 h-auto w-[calc(100%+1rem)] justify-between px-2 py-1.5 md:h-auto"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1.5 font-medium">
          <ChevronRight
            className={clsx(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          {label}
        </span>
        <span className="font-medium tabular-nums">{owed && total > 0 ? '−' : ''}{formatMoney(total)}</span>
      </Button>
      {expanded && accounts.length > 0 && (
        <ul className="flex flex-col gap-1 pb-1 pl-5">
          {accounts.map((a) => {
            const balance = formatAccountBalance(a, formatMoney);
            return (
              <li key={a.id} className="flex items-center justify-between py-0.5 text-xs">
                <span className="mr-2 truncate text-muted-foreground">{a.name}</span>
                <span className={clsx('shrink-0 tabular-nums', balance.colorClass)}>{balance.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {expanded && accounts.length === 0 && (
        <p className="pb-1 pl-5 text-xs text-muted-foreground">No accounts</p>
      )}
    </li>
  );
}
