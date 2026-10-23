/**
 * Paydown — Monarch-style debt paydown dashboard.
 *
 *   - Summary cards (current principal, projected interest, total P&I,
 *     debt-free month).
 *   - Color-coded projection chart (see PayoffProjectionChart): one area
 *     per active account, or combined debt against a dashed "current
 *     plan" baseline while simulating.
 *   - Savings calculator: method (Planned / Avalanche / Snowball) +
 *     monthly extra + one-time extra. Recomputes live.
 *   - Per-account list: name, balance, APR, min/planned, include toggle.
 *   - "Manage" modal to bulk-toggle includeInPaydown.
 *
 *   The calculator runs server-side via /api/paydown/simulate (or
 *   /api/paydown/projection for the no-simulation case). We always
 *   re-fetch on calculator change rather than computing in the browser
 *   so the server is the single source of truth for the math.
 */
import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../lib/api';
import {
  currencySymbol,
  formatMoney,
  currentYearMonth,
  monthYearLong,
  monthYearShort,
  timeAgo,
} from '../lib/format';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { PayoffProjectionChart } from '../components/PayoffProjectionChart';
import {
  CreditCard,
  Banknote,
  TrendingDown,
  Calendar,
  X,
  Check,
  Pencil,
  AlertTriangle,
  Save,
} from 'lucide-react';
import { SummaryCard } from '../components/SummaryCard';
import { SavingsCalculatorPanel } from '../components/SavingsCalculatorPanel';
import { AsyncQueryState } from '../components/ui/AsyncQueryState';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../components/ui/input-group';
import { Spinner } from '../components/ui/spinner';

type Method = 'planned' | 'avalanche' | 'snowball';

interface PaydownAccount {
  id: string;
  name: string;
  type: 'checking' | 'savings' | 'credit' | 'investment' | 'loan' | 'uncategorized';
  balance: number;
  institution?: string;
  interestRate: number;
  minPayment: number;
  plannedPayment: number;
  includeInPaydown: boolean;
}

interface PaydownAccountResult {
  accountId: string;
  name: string;
  startingBalance: number;
  apr: number;
  payoffMonth: string | null;
  monthsToPayoff: number | null;
  totalInterest: number;
  totalPaid: number;
}

interface PaydownPoint {
  month: string;
  totalDebt: number;
  byAccount: Record<string, number>;
}

interface PaydownProjection {
  method: Method;
  params: { method: Method; monthlyExtra: number; oneTimeExtra: number };
  startingTotal: number;
  totalInterest: number;
  totalPaid: number;
  monthsToDebtFree: number | null;
  debtFreeMonth: string | null;
  nonAmortizingIds: string[];
  perAccount: PaydownAccountResult[];
  timeline: PaydownPoint[];
  baselineTimeline: PaydownPoint[];
  baselineTotalInterest: number;
  baselineMonthsToDebtFree: number | null;
  baselineDebtFreeMonth: string | null;
  baselineNonAmortizingIds: string[];
}

const EMPTY: PaydownProjection = {
  method: 'planned',
  params: { method: 'planned', monthlyExtra: 0, oneTimeExtra: 0 },
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

// Persist the savings-calculator scenario so leaving Pay down and
// coming back keeps the same extras / method / chart. Matches the
// theme + sidebar localStorage pattern (UI preference, not server data).
const SCENARIO_KEY = 'cura.paydown.scenario';

interface StoredScenario {
  method: Method;
  monthlyExtra: string;
  oneTimeExtra: string;
  showSim: boolean;
}

interface SavedScenario {
  method: Method;
  monthlyExtra: number;
  oneTimeExtra: number;
}

interface SavedPaydownSnapshot {
  rows: Array<{
    accountId: string;
    accountName: string;
    type: 'credit' | 'loan';
    apr: number;
    planned: number;
    actual: number;
    remaining: number;
  }>;
  meta: { syncedAt: string | null; rowCount: number };
}

interface SaveToBudgetResult {
  ok: boolean;
  rowCount: number;
  syncedAt: string;
  scenario: SavedScenario;
  snapshot: SavedPaydownSnapshot;
}

interface SaveToBudgetInput extends SavedScenario {
  yearMonth: string;
}

const DEFAULT_SCENARIO: StoredScenario = {
  method: 'avalanche',
  monthlyExtra: '',
  oneTimeExtra: '',
  showSim: false,
};

function loadScenario(): StoredScenario {
  try {
    const raw = localStorage.getItem(SCENARIO_KEY);
    if (!raw) return DEFAULT_SCENARIO;
    const parsed = JSON.parse(raw) as Partial<StoredScenario>;
    const method: Method =
      parsed.method === 'planned' || parsed.method === 'avalanche' || parsed.method === 'snowball'
        ? parsed.method
        : DEFAULT_SCENARIO.method;
    return {
      method,
      monthlyExtra: typeof parsed.monthlyExtra === 'string' ? parsed.monthlyExtra : '',
      oneTimeExtra: typeof parsed.oneTimeExtra === 'string' ? parsed.oneTimeExtra : '',
      showSim: Boolean(parsed.showSim),
    };
  } catch {
    return DEFAULT_SCENARIO;
  }
}

function saveScenario(scenario: StoredScenario): void {
  try {
    localStorage.setItem(SCENARIO_KEY, JSON.stringify(scenario));
  } catch {
    /* private mode — calculator still works for the session */
  }
}

function parseExtraPayment(value: string): number | null {
  if (value.trim() === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// Color-coded series palette. Index order matches the account list below
// the chart so the legend dot, the chart curve, and the row marker agree.
const ACCOUNT_PALETTE = [
  'var(--chart-category-1)',
  'var(--chart-category-2)',
  'var(--chart-category-3)',
  'var(--chart-category-4)',
  'var(--chart-category-5)',
  'var(--chart-category-6)',
  'var(--chart-category-7)',
  'var(--chart-category-8)',
];

function accountColor(index: number): string {
  return ACCOUNT_PALETTE[index % ACCOUNT_PALETTE.length]!;
}

export function Paydown() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  // Baseline projection — "Planned" with no extras. Drives the chart
  // when no simulation is active.
  // Projections start in the browser's month, not the server's.
  const startYm = currentYearMonth();
  const baseline = useQuery({
    queryKey: ['paydown', 'projection', startYm],
    queryFn: () => api.get<PaydownProjection>(`/api/paydown/projection?start=${startYm}`),
  });

  // Calculator state. Hydrated from localStorage so navigating away
  // (or a full reload) restores the last scenario — extra payments,
  // method, and whether the sim chart was active.
  const [scenario, setScenario] = useState<StoredScenario>(() => loadScenario());
  const scenarioEdited = useRef(false);
  const { method, monthlyExtra, oneTimeExtra, showSim } = scenario;
  const setMethod = (m: Method) => {
    scenarioEdited.current = true;
    setScenario((s) => ({ ...s, method: m }));
  };
  const setMonthlyExtra = (v: string) => {
    scenarioEdited.current = true;
    setScenario((s) => ({ ...s, monthlyExtra: v }));
  };
  const setOneTimeExtra = (v: string) => {
    scenarioEdited.current = true;
    setScenario((s) => ({ ...s, oneTimeExtra: v }));
  };
  const setShowSim = (v: boolean) => {
    scenarioEdited.current = true;
    setScenario((s) => ({ ...s, showSim: v }));
  };
  const monthlyExtraNum = parseExtraPayment(monthlyExtra) ?? 0;
  const oneTimeExtraNum = parseExtraPayment(oneTimeExtra) ?? 0;

  // Keep the stored scenario in sync with the live calculator.
  useEffect(() => {
    saveScenario(scenario);
  }, [scenario]);

  const simulation = useQuery({
    queryKey: ['paydown', 'simulate', method, monthlyExtraNum, oneTimeExtraNum, startYm],
    queryFn: () =>
      api.post<PaydownProjection>('/api/paydown/simulate', {
        method,
        monthlyExtra: monthlyExtraNum,
        oneTimeExtra: oneTimeExtraNum,
        start: startYm,
      }),
    enabled: showSim,
  });

  const accounts = useQuery({
    queryKey: ['paydown', 'accounts'],
    queryFn: () => api.get<PaydownAccount[]>('/api/paydown/accounts'),
  });

  const patchAccount = useMutation({
    mutationFn: (input: { id: string; patch: Partial<PaydownAccount> }) =>
      api.patch(`/api/paydown/account/${input.id}`, input.patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['paydown'] }),
  });

  const currentYm = currentYearMonth();
  const hasAnyLiabilityAccount = (accounts.data ?? []).some((a) => a.balance > 0);

  const savedScenario = useQuery<{ scenario: SavedScenario | null }>({
    queryKey: ['paydown', 'scenario', currentYm],
    queryFn: () => api.get<{ scenario: SavedScenario | null }>(`/api/paydown/scenario/${currentYm}`),
  });
  const hydratedSavedScenario = useRef(false);
  useEffect(() => {
    if (hydratedSavedScenario.current || !savedScenario.isSuccess) return;
    hydratedSavedScenario.current = true;
    if (scenarioEdited.current || !savedScenario.data.scenario) return;
    const saved = savedScenario.data.scenario;
    setScenario({
      method: saved.method,
      monthlyExtra: String(saved.monthlyExtra),
      oneTimeExtra: String(saved.oneTimeExtra),
      showSim: saved.monthlyExtra > 0 || saved.oneTimeExtra > 0 || saved.method !== 'planned',
    });
  }, [savedScenario.data, savedScenario.isSuccess]);

  // Snapshot metadata for the current month — drives the "Last synced" badge
  // below the H1 and the Budget page's Pay down modal.
  const snapshotMeta = useQuery<{ syncedAt: string | null; rowCount: number } | null>({
    queryKey: ['paydown', 'snapshot-meta', currentYm],
    queryFn: () =>
      api.get<{ rows: unknown[]; meta: { syncedAt: string | null; rowCount: number } }>(`/api/paydown/snapshot/${currentYm}`).then((d) => d.meta),
    enabled: hasAnyLiabilityAccount,
  });

  const syncToBudget = useMutation({
    mutationFn: async (input: SaveToBudgetInput) => {
      const result = await api.post<SaveToBudgetResult>('/api/paydown/sync', input);
      const expectedMonthly = input.method === 'planned' ? 0 : input.monthlyExtra;
      const expectedOneTime = input.method === 'planned' ? 0 : input.oneTimeExtra;
      if (
        result.scenario.method !== input.method
        || result.scenario.monthlyExtra !== expectedMonthly
        || result.scenario.oneTimeExtra !== expectedOneTime
      ) {
        throw new Error('The saved paydown scenario did not match the calculator values. Please try again.');
      }
      return result;
    },
    onSuccess: (result) => {
      scenarioEdited.current = false;
      setScenario({
        method: result.scenario.method,
        monthlyExtra: String(result.scenario.monthlyExtra),
        oneTimeExtra: String(result.scenario.oneTimeExtra),
        showSim: result.scenario.method !== 'planned',
      });
      qc.setQueryData(['paydown', 'scenario', currentYm], { scenario: result.scenario });
      qc.setQueryData(['paydown', 'snapshot', currentYm], result.snapshot);
      void qc.invalidateQueries({ queryKey: ['paydown'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['budget'] });
      void qc.invalidateQueries({ queryKey: ['categories'] });
      const message = result.rowCount === 0
        ? 'No accounts included — toggle Include on at least one card to snapshot.'
        : `Saved ${result.rowCount} ${result.rowCount === 1 ? 'account' : 'accounts'} to Budget for ${monthYearShort(currentYm)}.`;
      let description: string | undefined;
      if (result.rowCount > 0 && result.scenario.method !== 'planned') {
        description = [
          result.scenario.method === 'snowball' ? 'Debt snowball' : 'Debt avalanche',
          result.scenario.monthlyExtra > 0 ? `${formatMoney(result.scenario.monthlyExtra)}/month extra` : '',
          result.scenario.oneTimeExtra > 0 ? `${formatMoney(result.scenario.oneTimeExtra)} one-time` : '',
        ].filter(Boolean).join(' · ');
      }
      toast.success(message, {
        description,
        action: result.rowCount > 0
          ? { label: 'Open Budget', onClick: () => void navigate('/budget') }
          : undefined,
      });
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to save to budget. Please try again.');
    },
  });

  const saveToBudget = () => {
    const parsedMonthly = parseExtraPayment(monthlyExtra);
    const parsedOneTime = parseExtraPayment(oneTimeExtra);
    if (parsedMonthly === null || parsedOneTime === null) {
      toast.error('Extra payments must be valid amounts of zero or more.');
      return;
    }
    syncToBudget.mutate({
      yearMonth: currentYm,
      method,
      monthlyExtra: method === 'planned' ? 0 : parsedMonthly,
      oneTimeExtra: method === 'planned' ? 0 : parsedOneTime,
    });
  };

  if (accounts.isLoading || baseline.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-foreground">Pay down</h1>
        <AsyncQueryState status="loading" title="Loading your paydown plan…" message="Fetching debt accounts and the baseline projection." />
      </div>
    );
  }

  if (accounts.isError || baseline.isError) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-foreground">Pay down</h1>
        <AsyncQueryState
          status="error"
          title="Could not load your paydown plan"
          message="Debt accounts or the baseline projection are unavailable, so payoff amounts are hidden."
          onRetry={() => void Promise.all([accounts.refetch(), baseline.refetch()])}
          retrying={accounts.isFetching || baseline.isFetching}
        />
      </div>
    );
  }

  const editing = baseline.data ?? EMPTY;
  const active = !simulation.isError ? simulation.data ?? (showSim ? null : editing) : null;
  const projection = active ?? editing;
  const isSimulated = !!(showSim && simulation.data && !simulation.isError);

  // Single clear path so banner, modal, and chart Clear button all
  // reset to the same baseline state. The useEffect above writes the
  // cleared values to localStorage so a return visit stays cleared.
  const clearSimulation = () => {
    scenarioEdited.current = true;
    setScenario({
      method: 'planned',
      monthlyExtra: '',
      oneTimeExtra: '',
      showSim: false,
    });
  };

  const methodLabel = method === 'planned' ? 'Planned payments' : method === 'avalanche' ? 'Debt avalanche' : 'Debt snowball';

  // Per-account list — merged from DB accounts + projection results.
  // We need the projection's payoff month / interest, so we index by id.
  const byId = new Map<string, PaydownAccountResult>();
  for (const r of projection.perAccount) byId.set(r.accountId, r);

  const accList = accounts.data ?? [];
  const hasAnyDebt = accList.some((a) => a.balance > 0);
  // Chart series mirror the projection's active set: included and still
  // owed on. Colors come from the account's position in the full list so
  // a row's dot keeps matching its curve when a sibling gets excluded.
  const chartSeries = accList
    .map((a, i) => ({ id: a.id, name: a.name, color: accountColor(i), account: a }))
    .filter(({ account }) => account.includeInPaydown && account.balance > 0)
    .map(({ id, name, color }) => ({ id, name, color }));

  const hasIncludedDebt = chartSeries.length > 0;
  // The projection reports accounts whose balance stops falling: what
  // reaches them doesn't cover their interest. Its totals are then cut
  // short, so they're replaced by a warning rather than shown as a cost.
  const unpayableIds = new Set(projection.nonAmortizingIds ?? []);
  const unpayableAccounts = accList.filter((a) => unpayableIds.has(a.id));
  const hasUnpayable = unpayableAccounts.length > 0;
  // Otherwise a missing payoff month means the 40-year horizon ran out.
  const beyondHorizon = hasIncludedDebt && !hasUnpayable && projection.debtFreeMonth === null;
  const monthlyInterest = (a: PaydownAccount) => a.balance * (a.interestRate / 12);
  const hasNoPayment = (a: PaydownAccount) => (a.minPayment || 0) <= 0 && (a.plannedPayment || 0) <= 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div data-onboarding-target="paydown-summary" className="min-w-0">
          <h1 className="text-2xl font-bold text-foreground">Pay down</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Every credit card and loan is a goal. Set your interest rates
            and minimums, then experiment with payoff methods to see how
            much you can save.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Syncs your paydown plan to the Budget page for this month.
            {snapshotMeta.data?.syncedAt && (
              <> · Last synced: <span className="tabular-nums text-foreground">{timeAgo(snapshotMeta.data.syncedAt)}</span></>
            )}
          </p>
        </div>
        {hasAnyDebt && (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button
              type="button"
              onClick={saveToBudget}
              disabled={syncToBudget.isPending}
              title={`Snapshot every included credit/loan account's planned payment for ${monthYearShort(currentYm)} into the Budget page`}
            >
              {syncToBudget.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              {syncToBudget.isPending ? 'Saving…' : 'Save to Budget'}
            </Button>
          </div>
        )}
      </div>

      {showSim && simulation.isLoading && (
        <AsyncQueryState
          status="loading"
          title="Calculating this scenario…"
          message="The baseline plan remains visible until the simulation is ready."
        />
      )}

      {showSim && simulation.isError && (
        <AsyncQueryState
          status="error"
          title="Could not calculate this scenario"
          message="The values below are from your baseline plan, not the requested simulation."
          onRetry={() => void simulation.refetch()}
          retrying={simulation.isFetching}
        />
      )}

      {!hasAnyDebt && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>No debt accounts yet</EmptyTitle>
            <EmptyDescription>
              Add a credit card or loan on the <a href="/accounts">Accounts page</a>
              {' '}and it'll show up here automatically. The pay-down
              dashboard tracks every liability you owe on.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {hasAnyDebt && (
        <>
          {/* Method banner — only when a scenario is active. Matches the
             Monarch-style "Utilizing the X Method" strip. */}
          {isSimulated && (
            <Alert className="border-rose-800 bg-rose-900/30 text-rose-100">
              <AlertDescription className="text-rose-100">
                <span className="text-muted-foreground">Utilizing the </span>
                <span className="font-semibold capitalize">{methodLabel}</span>
                {monthlyExtraNum > 0 && (
                  <span className="text-muted-foreground"> with {formatMoney(monthlyExtraNum)} monthly extra</span>
                )}
                {oneTimeExtraNum > 0 && (
                  <span className="text-muted-foreground"> + {formatMoney(oneTimeExtraNum)} one-time</span>
                )}
              </AlertDescription>
              <AlertAction>
                <Button type="button" variant="ghost" size="sm" onClick={clearSimulation}>
                  <X data-icon="inline-start" />
                  Clear
                </Button>
              </AlertAction>
            </Alert>
          )}

          {/* Summary cards */}
          <div className="summary-scroll grid gap-3 md:grid-cols-4">
            <SummaryCard
              icon={<Banknote className="h-4 w-4" />}
              label="Current debt"
              sub="Across included accounts"
              value={formatMoney(projection.startingTotal)}
              tone="slate"
            />
            <SummaryCard
              icon={<TrendingDown className="h-4 w-4" />}
              label={beyondHorizon ? 'Interest (40 years)' : 'Projected interest'}
              sub={
                hasUnpayable
                  ? 'Keeps growing at these payments'
                  : beyondHorizon
                    ? 'Projection horizon only'
                    : isSimulated ? 'Under this scenario' : 'Total interest to pay'
              }
              value={hasUnpayable || !hasIncludedDebt ? '—' : formatMoney(projection.totalInterest)}
              tone="rose"
            />
            <SummaryCard
              icon={<Banknote className="h-4 w-4" />}
              label={beyondHorizon ? 'Paid (40 years)' : 'Total P + I'}
              sub={
                hasUnpayable
                  ? 'Keeps growing at these payments'
                  : beyondHorizon ? 'Projection horizon only' : 'Principal + interest'
              }
              value={hasUnpayable || !hasIncludedDebt ? '—' : formatMoney(projection.totalPaid)}
              tone="amber"
            />
            <SummaryCard
              icon={<Calendar className="h-4 w-4" />}
              label="Debt-free"
              sub={
                !hasIncludedDebt
                  ? 'Include an account to project a payoff'
                  : hasUnpayable
                    ? 'Never at these payments'
                    : beyondHorizon
                      ? 'Beyond 40 years at this rate'
                      : 'Month of the final payment'
              }
              value={
                hasUnpayable || beyondHorizon
                  ? '∞'
                  : projection.debtFreeMonth
                    ? monthYearLong(projection.debtFreeMonth)
                    : '—'
              }
              tone={hasUnpayable || beyondHorizon ? 'amber' : 'emerald'}
            />
          </div>

          {/* Chart */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle>Payoff projection</CardTitle>
              {isSimulated && (
                <span className="text-xs text-muted-foreground">
                  {methodLabel}
                  {monthlyExtraNum > 0 && ` · ${formatMoney(monthlyExtraNum)}/mo`}
                  {oneTimeExtraNum > 0 && ` + ${formatMoney(oneTimeExtraNum)} one-time`}
                </span>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
            {hasUnpayable && (
              <Alert>
                <AlertTriangle />
                <AlertTitle>
                  {unpayableAccounts.length === 1
                    ? `${unpayableAccounts[0]!.name} never gets paid off`
                    : `${unpayableAccounts.length} debts never get paid off`}
                </AlertTitle>
                <AlertDescription>
                  {unpayableAccounts.length === 1 && hasNoPayment(unpayableAccounts[0]!) ? (
                    <>It has no minimum or planned payment.</>
                  ) : unpayableAccounts.length === 1 ? (
                    <>
                      Interest adds about {formatMoney(monthlyInterest(unpayableAccounts[0]!))} a month, and the payment doesn't
                      cover it, so the balance keeps growing.
                    </>
                  ) : (
                    <>
                      The payments on {unpayableAccounts.map((a) => a.name).join(', ')} don't cover their interest, so
                      the balances keep growing.
                    </>
                  )}
                  {' '}
                  {unpayableAccounts.every(hasNoPayment)
                    ? 'Set a minimum payment to see a payoff date.'
                    : method === 'planned' || !isSimulated
                    ? 'Raise the planned payment above the monthly interest to see a payoff date.'
                    : 'Raise a planned payment or the monthly extra to see a payoff date.'}
                </AlertDescription>
              </Alert>
            )}
            <PayoffProjectionChart
              accounts={chartSeries}
              projection={projection}
              compare={isSimulated}
            />
            </CardContent>
          </Card>

          {/* Per-account list + calculator panel */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Your debt accounts</CardTitle>
                <span className="text-xs text-muted-foreground">
                  {accList.filter((a) => a.includeInPaydown).length} of {accList.length} included
                </span>
              </CardHeader>
              <CardContent>
              <ul className="divide-y">
                {accList.map((a, i) => {
                  const r = byId.get(a.id);
                  return (
                    <li key={a.id} className="py-3">
                      <div className="flex items-center gap-3">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: a.includeInPaydown ? accountColor(i) : 'var(--chart-excluded)' }}
                          title={a.includeInPaydown ? 'Included' : 'Excluded'}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                            {a.type === 'credit' ? <CreditCard className="h-3.5 w-3.5 text-muted-foreground" /> : <Banknote className="h-3.5 w-3.5 text-muted-foreground" />}
                            {a.name}
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            <span className="font-medium text-rose-400">−{formatMoney(a.balance)}</span> · {(a.interestRate * 100).toFixed(2)}% APR
                            {a.includeInPaydown && unpayableIds.has(a.id) && (
                              <>
                                {' · '}
                                <span className="font-medium text-sky-300">
                                  {hasNoPayment(a) ? 'no payment set' : 'never paid off'}
                                </span>
                              </>
                            )}
                            {r?.payoffMonth && a.includeInPaydown && (
                              <> · payoff {monthYearShort(r.payoffMonth)}</>
                            )}
                            {r?.payoffMonth && a.includeInPaydown && r.totalInterest > 0 && (
                              <> · {formatMoney(r.totalInterest)} interest</>
                            )}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant={a.includeInPaydown ? 'secondary' : 'outline'}
                          onClick={() => patchAccount.mutate({ id: a.id, patch: { includeInPaydown: !a.includeInPaydown } })}
                        >
                          {a.includeInPaydown ? 'Included' : 'Excluded'}
                        </Button>
                        <AccountEditModal
                          account={a}
                          onSave={async (patch) => {
                            await patchAccount.mutateAsync({ id: a.id, patch });
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
                {accList.length === 0 && (
                  <li className="py-6 text-center text-sm text-muted-foreground">
                    No credit cards or loans. Add one to start tracking paydown.
                  </li>
                )}
              </ul>
              </CardContent>
            </Card>

            <div className="lg:col-span-1">
              <SavingsCalculatorPanel
                method={method}
                setMethod={setMethod}
                monthlyExtra={monthlyExtra}
                setMonthlyExtra={setMonthlyExtra}
                oneTimeExtra={oneTimeExtra}
                setOneTimeExtra={setOneTimeExtra}
                setShowSim={setShowSim}
                isSimulated={isSimulated}
                projection={
                  isSimulated && simulation.data
                    ? {
                        baselineTotalInterest: simulation.data.baselineTotalInterest,
                        totalInterest: simulation.data.totalInterest,
                        baselineDebtFreeMonth: simulation.data.baselineDebtFreeMonth,
                        debtFreeMonth: simulation.data.debtFreeMonth,
                      }
                    : null
                }
                monthlyExtraNum={monthlyExtraNum}
                oneTimeExtraNum={oneTimeExtraNum}
                formatMoney={formatMoney}
                ymToMonths={ymToMonths}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Convert "YYYY-MM" to a month count from a fixed origin so we can diff
// two months safely (handles wrap-around year boundaries).
function ymToMonths(ym: string): number {
  const [y, m] = ym.split('-');
  return Number(y) * 12 + Number(m);
}

// ---- Account edit modal -------------------------------------------------

function AccountEditModal({
  account,
  onSave,
}: {
  account: PaydownAccount;
  onSave: (patch: { interestRate: number; minPayment: number; plannedPayment: number }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // Preserve up to 4 decimal places on the way in — the old toFixed(2)
  // was silently rounding 6.375% to 6.38% the moment the modal opened.
  const [apr, setApr] = useState(String(Number((account.interestRate * 100).toFixed(4))));
  const [min, setMin] = useState(String(account.minPayment));
  const [planned, setPlanned] = useState(String(account.plannedPayment));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Credit / loan accounts require a non-zero minimum payment or the
  // paydown chart never produces a payoff date. Disable Save until the
  // user enters something > 0 and surface the reason inline.
  const minNum = Number(min) || 0;
  const plannedNum = Number(planned) || 0;
  const requiresMin = account.type === 'credit' || account.type === 'loan';
  const plannedBelowMin = plannedNum > 0 && plannedNum < minNum;
  const canSave = (!requiresMin || minNum > 0) && !plannedBelowMin;
  const openEditor = () => {
    setApr(String(Number((account.interestRate * 100).toFixed(4))));
    setMin(String(account.minPayment));
    setPlanned(String(account.plannedPayment));
    setSaveError(null);
    setOpen(true);
  };
  const closeEditor = () => {
    if (!saving) setOpen(false);
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={openEditor}
        title="Edit account details"
      >
        <Pencil />
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (!next) closeEditor(); }}>
        <DialogContent
          className="sm:max-w-sm"
          showCloseButton={!saving}
          onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (saving) event.preventDefault(); }}
        >
          <DialogHeader>
            <DialogTitle>Edit {account.name}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => void (async () => {
              e.preventDefault();
              if (!canSave || saving) return;
              const aprNum = (Number(apr) || 0) / 100;
              setSaveError(null);
              setSaving(true);
              try {
                await onSave({ interestRate: aprNum, minPayment: minNum, plannedPayment: plannedNum });
                setOpen(false);
              } catch (error) {
                setSaveError(error instanceof Error && error.message ? error.message : 'Could not save account details. Please try again.');
              } finally {
                setSaving(false);
              }
            })()}
            className="flex flex-col gap-3"
          >
            <FieldGroup>
              <Field>
                <FieldLabel>Interest rate / APR (%)</FieldLabel>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  max="100"
                  value={apr}
                  onChange={(e) => setApr(e.target.value)}
                  disabled={saving}
                  className="tabular-nums"
                />
                <FieldDescription>Set to 0 for 0% APR (e.g. intro rate, paid-in-full card)</FieldDescription>
              </Field>
              <Field data-invalid={requiresMin && minNum <= 0 ? true : undefined}>
                <FieldLabel>Minimum monthly payment</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText>{currencySymbol()}</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    type="number"
                    step="0.01"
                    min="0"
                    value={min}
                    onChange={(e) => setMin(e.target.value)}
                    disabled={saving}
                    aria-invalid={requiresMin && minNum <= 0}
                    className="tabular-nums"
                  />
                </InputGroup>
                {requiresMin && minNum <= 0 ? (
                  <FieldError>Required — credit and loan accounts need a minimum payment to project a payoff.</FieldError>
                ) : (
                  <FieldDescription>Principal + interest only. Don't include tax/insurance.</FieldDescription>
                )}
              </Field>
              <Field data-invalid={plannedBelowMin ? true : undefined}>
                <FieldLabel>Planned monthly payment <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText>{currencySymbol()}</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    type="number"
                    step="0.01"
                    min="0"
                    value={planned}
                    onChange={(e) => setPlanned(e.target.value)}
                    disabled={saving}
                    placeholder="0"
                    aria-invalid={plannedBelowMin}
                    className="tabular-nums"
                  />
                </InputGroup>
                {plannedBelowMin ? (
                  <FieldError>Planned payment must be at least the minimum.</FieldError>
                ) : (
                  <FieldDescription>Leave 0 to use the minimum. Only set if you plan to pay more than the minimum.</FieldDescription>
                )}
              </Field>
            </FieldGroup>
            {saveError && (
              <Alert variant="destructive">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeEditor} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSave || saving}>
                {saving ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
