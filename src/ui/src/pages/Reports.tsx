/**
 * Reports — the financial snapshot.
 *
 *   1. Cash Flow Over Time (stacked area: income vs expense)
 *   2. Net Worth Over Time (area)
 *   3. Spending by Category (donut, single month)
 *   4. Top Merchants (horizontal bar, range-driven)
 *   5. Spending Trends by Category (stacked bar, range-driven)
 *   6. Monthly Spending Pace (multi-line, single month)
 *
 * The math lives server-side in src/db/queries.ts; this page is a
 * pure renderer. A single global range selector at the top drives
 * charts 1, 2, 4, and 5. Charts 3 and 6 carry their own month
 * picker because they're inherently single-month views.
 *
 * Transfers and hidden accounts are filtered out at the server (Hard
 * Rule #14) so every chart agrees with the Dashboard's totals.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { formatMoney, currentYearMonth } from '../lib/format';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  formatShortMoney,
  type ChartConfig,
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from '../components/ui/chart';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { MonthPicker } from '../components/MonthPicker';
import { SummaryCard } from '../components/SummaryCard';
import { SortableWidgetList } from '../components/SortableWidgetList';
import clsx from 'clsx';
import { AlertCircle, Archive, Download, FileSpreadsheet, Wallet, TrendingUp, TrendingDown, Receipt, Check, Pencil, X, ChartNoAxesColumnIncreasing } from 'lucide-react';

type Range = '1m' | '3m' | '6m' | '1y' | 'all';
const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
];

interface CashFlowPoint { month: string; income: number; expense: number; net: number; }
interface NetWorthPoint { month: string; netWorth: number; }
interface CategorySpend { category: string; total: number; }
interface MerchantTotal { merchant: string; total: number; count: number; }
interface SpendingTrendResult {
  categories: Array<{ key: string; name: string }>;
  series: Array<Record<string, string | number>>;
}
interface SpendingPaceResult {
  month: string;
  previousMonth: string;
  budget: number;
  series: Array<{ day: number; current: number | null; previous: number; budgetPace: number }>;
}
interface RetentionPolicy {
  enabled: boolean;
  days: number;
  cutoffDate: string | null;
  description: string;
}

const DEFAULT_REPORT_ORDER = [
  'summary',
  'cash-flow',
  'spending-trends',
  'spending-pace',
  'net-worth',
  'spending-by-category',
  'top-merchants',
] as const;
type ReportWidgetId = (typeof DEFAULT_REPORT_ORDER)[number];
interface ReportLayout { order: ReportWidgetId[]; hidden: ReportWidgetId[]; }

const REPORT_WIDGET_LABELS: Record<ReportWidgetId, string> = {
  summary: 'Summary',
  'cash-flow': 'Cash flow over time',
  'net-worth': 'Net worth over time',
  'spending-by-category': 'Spending by category',
  'top-merchants': 'Top merchants',
  'spending-trends': 'Spending trends by category',
  'spending-pace': 'Monthly spending pace',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthShort(ym: string): string {
  const [, m] = ym.split('-');
  return MONTH_NAMES[Number(m) - 1] ?? '';
}
function monthYear(ym: string): string {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[Number(m) - 1] ?? ''} ${y}`;
}

function monthBounds(ym: string): { from: string; to: string } {
  const [year, month] = ym.split('-').map(Number);
  const to = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
  return { from: `${ym}-01`, to };
}

function reportRangeBounds(range: Range, firstMonth: string | undefined, cutoffDate: string | null | undefined) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const offsets: Record<Exclude<Range, 'all'>, number> = { '1m': 0, '3m': 2, '6m': 5, '1y': 11 };
  const from = range === 'all' && firstMonth
    ? `${firstMonth}-01`
    : new Date(Date.UTC(year, month - (range === 'all' ? 0 : offsets[range]), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { from: cutoffDate && cutoffDate > from ? cutoffDate : from, to };
}

function transactionUrl(filters: { from: string; to: string; types?: 'income' | 'expense'; category?: string; merchant?: string }) {
  const params = new URLSearchParams({ from: filters.from, to: filters.to, reviewed: 'true' });
  if (filters.types) params.set('types', filters.types);
  if (filters.category) params.set('category', filters.category);
  if (filters.merchant) params.set('merchant', filters.merchant);
  return `/transactions?${params.toString()}`;
}

/**
 * Pie slice palette — drawn from the project's semantic colors
 * (amber/emerald/rose/sky/violet) so the chart stays inside the
 * existing design language. Slate shades fill in past the first five
 * slices. Stable across re-renders so a slice's color doesn't shift
 * as data changes.
 */
const SLICE_PALETTE = [
  'var(--chart-category-1)',
  'var(--chart-category-2)',
  'var(--chart-category-3)',
  'var(--chart-category-4)',
  'var(--chart-category-5)',
  'var(--chart-category-6)',
  'var(--chart-category-7)',
  'var(--chart-category-8)',
];

export function Reports() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>('6m');
  const [spendingMonth, setSpendingMonth] = useState(currentYearMonth());
  const [editing, setEditing] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [draftOrder, setDraftOrder] = useState<ReportWidgetId[]>([...DEFAULT_REPORT_ORDER]);
  const [draftHidden, setDraftHidden] = useState<ReportWidgetId[]>([]);

  const cashFlow = useQuery({
    queryKey: ['reports', 'cash-flow', range],
    queryFn: () => api.get<CashFlowPoint[]>(`/api/reports/cash-flow?range=${range}`),
  });
  const netWorth = useQuery({
    queryKey: ['reports', 'net-worth', range],
    queryFn: () => api.get<NetWorthPoint[]>(`/api/reports/net-worth?range=${range}`),
  });
  const spending = useQuery({
    queryKey: ['reports', 'spending-by-category', spendingMonth],
    queryFn: () => api.get<CategorySpend[]>(`/api/reports/spending-by-category?month=${spendingMonth}`),
  });
  const topMerchants = useQuery({
    queryKey: ['reports', 'top-merchants', range],
    queryFn: () => api.get<MerchantTotal[]>(`/api/reports/top-merchants?range=${range}`),
  });
  const spendingTrends = useQuery({
    queryKey: ['reports', 'spending-trends', range],
    queryFn: () => api.get<SpendingTrendResult>(`/api/reports/spending-trends?range=${range}`),
  });
  const spendingPace = useQuery({
    queryKey: ['reports', 'spending-pace', spendingMonth],
    queryFn: () => api.get<SpendingPaceResult>(`/api/reports/spending-pace?month=${spendingMonth}`),
  });
  const retention = useQuery({
    queryKey: ['data', 'retention'],
    queryFn: () => api.get<RetentionPolicy>('/api/data/retention'),
  });
  const layout = useQuery({
    queryKey: ['reports', 'layout'],
    queryFn: () => api.get<ReportLayout>('/api/reports/layout'),
  });
  const saveLayout = useMutation({
    mutationFn: (next: ReportLayout) => api.put<ReportLayout>('/api/reports/layout', next),
    onSuccess: (saved) => {
      queryClient.setQueryData(['reports', 'layout'], saved);
      setEditing(false);
    },
  });
  const savedOrder = layout.data?.order ?? [...DEFAULT_REPORT_ORDER];
  const savedHidden = layout.data?.hidden ?? [];
  const startEditing = () => {
    if (!layout.data) return;
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
  const toggleHidden = (widget: ReportWidgetId) => {
    setDraftHidden((current) => current.includes(widget) ? current.filter((id) => id !== widget) : [...current, widget]);
  };

  const totalIncome = (cashFlow.data ?? []).reduce((s, p) => s + p.income, 0);
  const totalExpense = (cashFlow.data ?? []).reduce((s, p) => s + p.expense, 0);
  const totalNet = totalIncome - totalExpense;
  const latestNetWorth = netWorth.data && netWorth.data.length > 0 ? netWorth.data[netWorth.data.length - 1]!.netWorth : 0;
  const firstNetWorth = netWorth.data && netWorth.data.length > 0 ? netWorth.data[0]!.netWorth : 0;
  const netWorthDelta = latestNetWorth - firstNetWorth;
  const spendingTotal = (spending.data ?? []).reduce((s, c) => s + c.total, 0);
  const firstRangeMonth = cashFlow.data?.[0]?.month
    ?? (spendingTrends.data?.series[0]?.month ? String(spendingTrends.data.series[0].month) : undefined)
    ?? netWorth.data?.[0]?.month;
  const rangeBounds = reportRangeBounds(range, firstRangeMonth, retention.data?.cutoffDate);
  const drilldown = (filters: Parameters<typeof transactionUrl>[0]) => navigate(transactionUrl(filters));
  const renderWidget = (widget: ReportWidgetId) => {
    if (widget === 'summary') {
      if (cashFlow.isPending || netWorth.isPending) return <SummarySkeleton />;
      if (cashFlow.isError || netWorth.isError) {
        return <WidgetError message="Could not load the report summary." onRetry={() => void Promise.all([cashFlow.refetch(), netWorth.refetch()])} />;
      }
      return (
        <section>
          <div className="mb-3 flex items-center gap-2">
            <ChartNoAxesColumnIncreasing className="h-4 w-4 text-amber-300" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold fg-primary">Financial snapshot</h2>
              <p className="text-xs fg-muted">Key totals for the selected report range</p>
            </div>
          </div>
          <div className="summary-scroll grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard icon={<TrendingUp className="h-4 w-4" />} label="Income" sub="Over this range" tone="emerald" value={formatMoney(totalIncome)} />
            <SummaryCard icon={<TrendingDown className="h-4 w-4" />} label="Spending" sub="Out-of-pocket" tone="rose" value={formatMoney(totalExpense)} />
            <SummaryCard icon={<Receipt className="h-4 w-4" />} label="Net cash flow" sub={totalNet >= 0 ? 'Saved' : 'Overspent'} tone={totalNet >= 0 ? 'emerald' : 'rose'} value={`${totalNet >= 0 ? '+' : '−'}${formatMoney(Math.abs(totalNet))}`} />
            <SummaryCard icon={<Wallet className="h-4 w-4" />} label="Estimated net worth" sub={`${netWorthDelta >= 0 ? '+' : '−'}${formatMoney(Math.abs(netWorthDelta))} reconstructed change`} value={formatMoney(latestNetWorth)} tone={latestNetWorth >= 0 ? 'slate' : 'rose'} />
          </div>
        </section>
      );
    }
    if (widget === 'cash-flow') {
      return (
        <Card className="flex-1">
          <ChartHeader eyebrow="Overview" title="Cash flow over time" subtitle="Income vs. expense, by month" />
          <CardContent>
            <CashFlowChart data={cashFlow.data ?? []} loading={cashFlow.isPending} error={cashFlow.isError} onRetry={() => void cashFlow.refetch()} onDrilldown={drilldown} />
          </CardContent>
        </Card>
      );
    }
    if (widget === 'net-worth') {
      return (
        <Card className="flex-1">
          <ChartHeader eyebrow="Wealth" title="Estimated net worth over time" subtitle="Reconstructed from today’s account balances by reversing monthly income and spending; not historical balance snapshots" />
          <CardContent>
            <NetWorthChart data={netWorth.data ?? []} loading={netWorth.isPending} error={netWorth.isError} onRetry={() => void netWorth.refetch()} />
          </CardContent>
        </Card>
      );
    }
    if (widget === 'spending-by-category') {
      return (
        <Card className="flex-1">
          <ChartHeader eyebrow="Spending" title="Spending by category" subtitle={spending.data ? `${monthYear(spendingMonth)} — ${formatMoney(spendingTotal)} total` : monthYear(spendingMonth)} right={<MonthPicker value={spendingMonth} onChange={setSpendingMonth} />} />
          <CardContent>
            <SpendingDonut data={spending.data ?? []} loading={spending.isPending} error={spending.isError} onRetry={() => void spending.refetch()} month={spendingMonth} onDrilldown={drilldown} />
          </CardContent>
        </Card>
      );
    }
    if (widget === 'top-merchants') {
      return (
        <Card className="flex-1">
          <ChartHeader eyebrow="Spending" title="Top merchants" subtitle="Where the most money went" />
          <CardContent>
            <TopMerchantsChart data={topMerchants.data ?? []} loading={topMerchants.isPending} error={topMerchants.isError} onRetry={() => void topMerchants.refetch()} bounds={rangeBounds} onDrilldown={drilldown} />
          </CardContent>
        </Card>
      );
    }
    if (widget === 'spending-trends') {
      return (
        <Card className="flex-1">
          <ChartHeader eyebrow="Spending" title="Spending trends by category" subtitle="How your largest expense categories change over time" />
          <CardContent>
            <SpendingTrendsChart data={spendingTrends.data} loading={spendingTrends.isPending} error={spendingTrends.isError} onRetry={() => void spendingTrends.refetch()} onDrilldown={drilldown} />
          </CardContent>
        </Card>
      );
    }
    return (
      <Card className="flex-1">
        <ChartHeader eyebrow="Spending" title="Monthly spending pace" subtitle={`${monthYear(spendingMonth)} compared with ${spendingPace.data ? monthYear(spendingPace.data.previousMonth) : 'the prior month'}`} right={<MonthPicker value={spendingMonth} onChange={setSpendingMonth} />} />
        <CardContent>
          <SpendingPaceChart data={spendingPace.data} loading={spendingPace.isPending} error={spendingPace.isError} onRetry={() => void spendingPace.refetch()} onDrilldown={drilldown} />
        </CardContent>
      </Card>
    );
  };

  const displayedOrder = editing ? draftOrder : savedOrder;
  const displayedHidden = new Set(editing ? draftHidden : savedHidden);
  const visibleDisplayedOrder = displayedOrder.filter((widget) => !displayedHidden.has(widget));
  // `min-w-0`: grid items default to their min-content width, so the
  // horizontally scrolling snapshot strip would otherwise widen the whole
  // single-column mobile grid past the viewport and clip every card.
  const reportItemClass = (widget: ReportWidgetId) => {
    if (widget !== 'spending-by-category' && widget !== 'top-merchants') return 'flex min-w-0 flex-col lg:col-span-2';
    const index = visibleDisplayedOrder.indexOf(widget);
    const neighbor = widget === 'spending-by-category' ? 'top-merchants' : 'spending-by-category';
    return visibleDisplayedOrder[index - 1] === neighbor || visibleDisplayedOrder[index + 1] === neighbor
      ? 'flex min-w-0 flex-col'
      : 'flex min-w-0 flex-col lg:col-span-2';
  };

  return (
    <div className="flex flex-col gap-6">
      <div data-onboarding-target="reports-header">
        <div>
          <h1 className="text-2xl font-bold">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">Trends, breakdowns, and comparisons across your money. Transfers are excluded from every chart.</p>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 flex-1">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Report range</p>
            <RangeSelector value={range} onChange={setRange} />
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {!editing && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setExportOpen(true)}
            >
              <Download data-icon="inline-start" /> Export data
            </Button>
          )}
          {!editing && (
            <Button
              type="button"
              variant="outline"
              onClick={startEditing}
              disabled={!layout.data}
            >
              <Pencil data-icon="inline-start" /> Customize reports
            </Button>
          )}
          {editing && (
            <>
              <Button type="button" variant="outline" onClick={cancelEditing} disabled={saveLayout.isPending}>
                <X data-icon="inline-start" /> Cancel
              </Button>
              <Button type="button" onClick={() => layout.data && saveLayout.mutate({ order: draftOrder, hidden: draftHidden })} disabled={saveLayout.isPending || !layout.data}>
                {saveLayout.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                {saveLayout.isPending ? 'Saving…' : 'Save'}
              </Button>
            </>
          )}
          </div>
        </CardContent>
        {range === 'all' && <CardContent className="pt-0 text-xs text-muted-foreground">All-range drilldowns begin at the first displayed report month because reports do not expose the exact first transaction date.</CardContent>}
      </Card>
      {layout.isError && (
        <Alert variant="destructive">
          <AlertDescription>Could not load the reports layout.</AlertDescription>
          <AlertAction>
            <Button type="button" size="sm" variant="outline" onClick={() => void layout.refetch()}>Retry</Button>
          </AlertAction>
        </Alert>
      )}
      {saveLayout.isError && (
        <Alert variant="destructive">
          <AlertDescription>Could not save the reports layout. Please try again.</AlertDescription>
        </Alert>
      )}

      <SortableWidgetList
        order={displayedOrder}
        labels={REPORT_WIDGET_LABELS}
        editing={editing}
        onReorder={setDraftOrder}
        renderWidget={renderWidget}
        className="grid gap-6 lg:grid-cols-2"
        itemClassName={reportItemClass}
        hidden={displayedHidden}
        onToggleHidden={editing ? toggleHidden : undefined}
      />
      <ExportModal
        open={exportOpen}
        retention={retention.data}
        retentionLoading={retention.isPending}
        retentionError={retention.isError}
        onRetryRetention={() => void retention.refetch()}
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
}

// ---- Sub-components -------------------------------------------------------

function ExportModal({
  open,
  retention,
  retentionLoading,
  retentionError,
  onRetryRetention,
  onClose,
}: {
  open: boolean;
  retention: RetentionPolicy | undefined;
  retentionLoading: boolean;
  retentionError: boolean;
  onRetryRetention: () => void;
  onClose: () => void;
}) {
  const download = () => window.setTimeout(onClose, 0);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export your data</DialogTitle>
          <DialogDescription>Choose what you want to download.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <a
            href="/api/data/transactions.csv"
            download
            onClick={download}
            className="group rounded-xl border border-border bg-muted/50 p-4 transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FileSpreadsheet className="size-6 text-emerald-400" />
            <span className="mt-3 block text-sm font-semibold group-hover:text-primary">Transactions CSV</span>
            <span className="mt-1 block text-xs text-muted-foreground">A spreadsheet-ready ledger of all transactions.</span>
          </a>
          <a
            href="/api/data/export.json"
            download
            onClick={download}
            className="group rounded-xl border border-border bg-muted/50 p-4 transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Archive className="size-6 text-sky-300" />
            <span className="mt-3 block text-sm font-semibold group-hover:text-primary">Full JSON archive</span>
            <span className="mt-1 block text-xs text-muted-foreground">Accounts, transactions, budgets, goals, rules, and settings.</span>
          </a>
        </div>

        <Alert aria-live="polite">
          {retentionLoading && <AlertDescription>Checking data retention policy…</AlertDescription>}
          {retentionError && (
            <>
              <AlertDescription>Retention policy unavailable.</AlertDescription>
              <AlertAction>
                <Button type="button" size="sm" variant="outline" onClick={onRetryRetention}>Retry</Button>
              </AlertAction>
            </>
          )}
          {retention && <AlertDescription>{retention.description}</AlertDescription>}
        </Alert>
      </DialogContent>
    </Dialog>
  );
}

function RangeSelector({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => { if (next) onChange(next as Range); }}
      variant="outline"
      className="w-full md:w-auto"
    >
      {RANGE_OPTIONS.map((opt) => (
        <ToggleGroupItem key={opt.value} value={opt.value} className="flex-1 md:flex-none">
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function ChartHeader({
  eyebrow,
  title,
  subtitle,
  right,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <CardHeader>
      {eyebrow && <p className="text-[10px] font-semibold uppercase tracking-wide text-primary">{eyebrow}</p>}
      <CardTitle>{title}</CardTitle>
      {subtitle && <CardDescription>{subtitle}</CardDescription>}
      {right ? <CardAction>{right}</CardAction> : null}
    </CardHeader>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertCircle />
        </EmptyMedia>
        <EmptyTitle>{message}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function WidgetError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{message}</AlertTitle>
      <AlertAction>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </AlertAction>
    </Alert>
  );
}

function SummarySkeleton() {
  return <div className="summary-scroll grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <ChartSkeleton key={index} height={112} />)}</div>;
}

function DrilldownDetails({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-3 border-t border-default pt-3">
      <summary className="cursor-pointer text-xs font-medium fg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">View matching transactions</summary>
      <div className="mt-2 flex max-h-40 flex-wrap gap-2 overflow-y-auto">{children}</div>
    </details>
  );
}

function ChartDataDetails({
  summary,
  caption,
  headers,
  rows,
}: {
  summary: string;
  caption: string;
  headers: string[];
  rows: Array<{ key: string; cells: React.ReactNode[] }>;
}) {
  return (
    <details className="mt-3 border-t border-default pt-3">
      <summary className="focus-ring cursor-pointer text-xs font-medium fg-secondary">{summary}</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        {/* Mobile: stacked rows — a `min-w-max` table forces sideways
            scrolling and shrinks to unreadable text on phones. */}
        <dl className="divide-y divide-default md:hidden">
          {rows.map((row) => (
            <div key={row.key} className="flex flex-col gap-1 py-2.5 text-sm">
              <dt className="font-medium fg-primary">{row.cells[0]}</dt>
              <dd className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs fg-secondary">
                {row.cells.slice(1).map((cell, index) => (
                  <span key={index} className="tabular-nums">
                    <span className="fg-muted">{headers[index + 1]}: </span>{cell}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <table className="hidden w-full min-w-max text-left text-xs md:table">
          <caption className="sr-only">{caption}</caption>
          <thead className="fg-muted">
            <tr className="border-b border-default">
              {headers.map((header, index) => <th key={header} scope="col" className={clsx('py-2 font-medium', index === 0 ? 'pr-3' : 'px-3 text-right')}>{header}</th>)}
            </tr>
          </thead>
          <tbody className="fg-secondary">
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-default last:border-0">
                {row.cells.map((cell, index) => index === 0
                  ? <th key={index} scope="row" className="py-2 pr-3 font-medium fg-primary">{cell}</th>
                  : <td key={index} className="px-3 py-2 text-right tabular-nums">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function DrilldownButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      {label}
    </Button>
  );
}

function ChartSkeleton({ height = 280 }: { height?: number }) {
  return <Skeleton className="w-full rounded-lg" style={{ height }} />;
}

// ---- 1. Cash Flow Chart --------------------------------------------------

function CashFlowChart({ data, loading, error, onRetry, onDrilldown }: { data: CashFlowPoint[]; loading: boolean; error: boolean; onRetry: () => void; onDrilldown: (filters: Parameters<typeof transactionUrl>[0]) => void }) {
  if (loading) return <ChartSkeleton />;
  if (error) return <WidgetError message="Could not load cash flow." onRetry={onRetry} />;
  if (data.length === 0) return <EmptyState message="No transactions yet. Add some to see your cash flow." />;
  const hasAnyActivity = data.some((p) => p.income > 0 || p.expense > 0);
  if (!hasAnyActivity) return <EmptyState message="No income or expenses in this range." />;

  const config: ChartConfig = {
    income: { label: 'Income', color: 'var(--chart-income)' },
    expense: { label: 'Expense', color: 'var(--chart-expense)' },
    net: { label: 'Net', color: 'var(--chart-net)' },
  };

  return (
    <>
    <ChartContainer config={config} className="h-[280px]" aria-hidden={true}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="cf-income-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-income)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--chart-income)" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="cf-expense-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-expense)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--chart-expense)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="month"
          tickFormatter={monthShort}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={formatShortMoney}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              config={config}
              labelFormatter={(l) => monthYear(String(l))}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="income"
          stroke="var(--chart-income)"
          strokeWidth={2}
          fill="url(#cf-income-grad)"
          stackId="1"
        />
        <Area
          type="monotone"
          dataKey="expense"
          stroke="var(--chart-expense)"
          strokeWidth={2}
          fill="url(#cf-expense-grad)"
          stackId="2"
        />
      </AreaChart>
    </ChartContainer>
    <ChartDataDetails
      summary="View cash flow data"
      caption="Monthly income, expenses, and signed net cash flow"
      headers={['Month', 'Income', 'Expense', 'Net cash flow']}
      rows={data.map((point) => ({ key: point.month, cells: [monthYear(point.month), formatMoney(point.income), formatMoney(point.expense), formatMoney(point.net)] }))}
    />
    <DrilldownDetails>
      {data.flatMap((point) => {
        const bounds = monthBounds(point.month);
        return ([['income', point.income], ['expense', point.expense]] as const).map(([type, amount]) => (
          <DrilldownButton key={`${point.month}-${type}`} label={`${monthYear(point.month)} ${type} (${formatMoney(amount)})`} onClick={() => onDrilldown({ ...bounds, types: type })} />
        ));
      })}
    </DrilldownDetails>
    </>
  );
}

// ---- 2. Net Worth Chart --------------------------------------------------

function NetWorthChart({ data, loading, error, onRetry }: { data: NetWorthPoint[]; loading: boolean; error: boolean; onRetry: () => void }) {
  if (loading) return <ChartSkeleton />;
  if (error) return <WidgetError message="Could not load the net worth estimate." onRetry={onRetry} />;
  if (data.length === 0) return <EmptyState message="No accounts yet. Add an account to track net worth." />;

  const config: ChartConfig = {
    netWorth: { label: 'Net worth', color: 'var(--chart-net-worth-positive)' },
  };

  const minimum = Math.min(...data.map((point) => point.netWorth));
  const maximum = Math.max(...data.map((point) => point.netWorth));
  const hasNegative = minimum < 0;
  const hasPositive = maximum > 0;
  const zeroOffset = hasNegative && hasPositive ? (maximum / (maximum - minimum)) * 100 : hasNegative ? 0 : 100;

  return (
    <>
      <div aria-hidden="true">
          <ChartContainer config={config} className="h-[280px]" aria-hidden={true}>
          <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset={`${zeroOffset}%`} stopColor="var(--chart-net-worth-positive)" stopOpacity={0.4} />
                <stop offset={`${zeroOffset}%`} stopColor="var(--chart-net-worth-negative)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="var(--chart-net-worth-negative)" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="nw-stroke" x1="0" y1="0" x2="0" y2="1">
                <stop offset={`${zeroOffset}%`} stopColor="var(--chart-net-worth-positive)" />
                <stop offset={`${zeroOffset}%`} stopColor="var(--chart-net-worth-negative)" />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
            <YAxis tickFormatter={formatShortMoney} tickLine={false} axisLine={false} width={56} />
            <ChartTooltip content={<ChartTooltipContent config={config} labelFormatter={(l) => monthYear(String(l))} />} />
            <Area type="monotone" dataKey="netWorth" stroke="url(#nw-stroke)" strokeWidth={2} fill="url(#nw-fill)" />
          </AreaChart>
        </ChartContainer>
      </div>
      <ChartDataDetails
        summary="View net worth data"
        caption="Estimated net worth by month"
        headers={['Month', 'Estimated net worth']}
        rows={data.map((point) => ({
          key: point.month,
          cells: [
            monthYear(point.month),
            <span key="value" className={clsx('tabular-nums', point.netWorth < 0 && 'text-rose-400')}>{formatMoney(point.netWorth)}</span>,
          ],
        }))}
      />
    </>
  );
}

function SpendingTrendsChart({ data, loading, error, onRetry, onDrilldown }: { data: SpendingTrendResult | undefined; loading: boolean; error: boolean; onRetry: () => void; onDrilldown: (filters: Parameters<typeof transactionUrl>[0]) => void }) {
  if (loading) return <ChartSkeleton />;
  if (error) return <WidgetError message="Could not load spending trends." onRetry={onRetry} />;
  if (!data || data.categories.length === 0) return <EmptyState message="No category spending in this range." />;

  const config: ChartConfig = {};
  data.categories.forEach((category, index) => {
    config[category.key] = { label: category.name, color: SLICE_PALETTE[index % SLICE_PALETTE.length]! };
  });
  return (
    <div className="flex flex-col gap-3">
       <ChartContainer config={config} className="h-[300px]" aria-hidden={true}>
        <BarChart data={data.series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
          <YAxis tickFormatter={formatShortMoney} tickLine={false} axisLine={false} width={56} />
          <ChartTooltip content={<ChartTooltipContent config={config} labelFormatter={(label) => monthYear(String(label))} />} />
          {data.categories.map((category, index) => (
            <Bar key={category.key} dataKey={category.key} stackId="spending" fill={SLICE_PALETTE[index % SLICE_PALETTE.length]} />
          ))}
        </BarChart>
       </ChartContainer>
       <ChartDataDetails
         summary="View spending trend data"
         caption="Monthly spending by category"
         headers={['Month', ...data.categories.map((category) => category.name)]}
         rows={data.series.map((point) => {
           const month = String(point.month);
           return { key: month, cells: [monthYear(month), ...data.categories.map((category) => formatMoney(Number(point[category.key] ?? 0)))] };
         })}
       />
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {data.categories.map((category, index) => (
          <li key={category.key} className="flex items-center gap-1.5 text-xs fg-secondary">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SLICE_PALETTE[index % SLICE_PALETTE.length] }} />
            {category.name}
          </li>
        ))}
      </ul>
      <DrilldownDetails>
        {data.series.flatMap((point) => data.categories
          .filter((category) => category.name.toLowerCase() !== 'other')
          .map((category) => {
            const month = String(point.month);
            return <DrilldownButton key={`${month}-${category.key}`} label={`${monthYear(month)} · ${category.name}`} onClick={() => onDrilldown({ ...monthBounds(month), types: 'expense', category: category.name })} />;
          }))}
      </DrilldownDetails>
    </div>
  );
}

function SpendingPaceChart({ data, loading, error, onRetry, onDrilldown }: { data: SpendingPaceResult | undefined; loading: boolean; error: boolean; onRetry: () => void; onDrilldown: (filters: Parameters<typeof transactionUrl>[0]) => void }) {
  if (loading) return <ChartSkeleton />;
  if (error) return <WidgetError message="Could not load spending pace." onRetry={onRetry} />;
  if (!data || (!data.series.some((point) => Number(point.current) > 0 || point.previous > 0) && data.budget === 0)) {
    return <EmptyState message="No spending or budget is available for this month." />;
  }
  const config: ChartConfig = {
    current: { label: monthYear(data.month), color: 'var(--chart-expense)' },
    previous: { label: monthYear(data.previousMonth), color: 'var(--chart-comparison)' },
    budgetPace: { label: 'Budget pace', color: 'var(--chart-income)' },
  };
  return (
    <>
    <ChartContainer config={config} className="h-[280px]" aria-hidden={true}>
      <LineChart data={data.series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickFormatter={(day) => `Day ${day}`} tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
        <YAxis tickFormatter={formatShortMoney} tickLine={false} axisLine={false} width={56} />
        <ChartTooltip content={<ChartTooltipContent config={config} labelFormatter={(day) => `Day ${day}`} />} />
        <Line dataKey="previous" type="monotone" stroke="var(--color-previous)" strokeWidth={2} dot={false} />
        <Line dataKey="budgetPace" type="monotone" stroke="var(--color-budgetPace)" strokeWidth={2} strokeDasharray="5 5" dot={false} />
        <Line dataKey="current" type="monotone" stroke="var(--color-current)" strokeWidth={2.5} dot={false} />
      </LineChart>
    </ChartContainer>
    <ChartDataDetails
      summary="View spending pace data"
      caption={`Daily cumulative spending pace for ${monthYear(data.month)} and ${monthYear(data.previousMonth)}`}
      headers={['Day', monthYear(data.month), monthYear(data.previousMonth), 'Budget pace']}
      rows={data.series.map((point) => ({
        key: String(point.day),
        cells: [`Day ${point.day}`, point.current === null ? 'Not available' : formatMoney(point.current), formatMoney(point.previous), formatMoney(point.budgetPace)],
      }))}
    />
    <DrilldownDetails>
      <DrilldownButton label={monthYear(data.month)} onClick={() => onDrilldown({ ...monthBounds(data.month), types: 'expense' })} />
      <DrilldownButton label={monthYear(data.previousMonth)} onClick={() => onDrilldown({ ...monthBounds(data.previousMonth), types: 'expense' })} />
    </DrilldownDetails>
    </>
  );
}

// ---- 4. Spending Donut ---------------------------------------------------

function SpendingDonut({ data, loading, error, onRetry, month, onDrilldown }: { data: CategorySpend[]; loading: boolean; error: boolean; onRetry: () => void; month: string; onDrilldown: (filters: Parameters<typeof transactionUrl>[0]) => void }) {
  if (loading) return <ChartSkeleton height={280} />;
  if (error) return <WidgetError message="Could not load category spending." onRetry={onRetry} />;
  if (data.length === 0) return <EmptyState message="No spending recorded for this month." />;

  const config: ChartConfig = {};
  data.forEach((c, i) => {
    config[c.category] = { label: c.category, color: SLICE_PALETTE[i % SLICE_PALETTE.length]! };
  });
  const total = data.reduce((s, c) => s + c.total, 0);

  return (
    <>
    <div className="flex flex-col lg:flex-row gap-4 items-center">
      <ChartContainer config={config} className="h-[240px] flex-1 min-w-0" aria-hidden={true}>
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                config={config}
                hideLabel
                valueFormatter={(v) => `${formatMoney(v)} (${((v / total) * 100).toFixed(0)}%)`}
              />
            }
          />
          <Pie
            data={data}
            dataKey="total"
            nameKey="category"
            innerRadius={55}
            outerRadius={90}
            paddingAngle={2}
            strokeWidth={0}
          >
            {data.map((c, i) => (
              <Cell key={c.category} fill={SLICE_PALETTE[i % SLICE_PALETTE.length]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="flex w-full shrink-0 flex-col gap-1.5 lg:w-[180px]">
        {data.slice(0, 6).map((c, i) => (
          <li key={c.category} className="flex items-center gap-2 text-xs">
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: SLICE_PALETTE[i % SLICE_PALETTE.length] }}
            />
            <span className="flex-1 truncate fg-secondary">{c.category}</span>
            <span className="tabular-nums fg-primary font-medium">{formatMoney(c.total)}</span>
          </li>
        ))}
        {data.length > 6 && (
          <li className="text-xs fg-muted pl-4.5">+{data.length - 6} more</li>
        )}
      </ul>
    </div>
    <ChartDataDetails
      summary="View category spending data"
      caption={`Spending by category for ${monthYear(month)}`}
      headers={['Category', 'Spend', 'Share']}
      rows={data.map((category) => ({
        key: category.category,
        cells: [category.category, formatMoney(category.total), `${((category.total / total) * 100).toFixed(1)}%`],
      }))}
    />
    <DrilldownDetails>
      {data.map((category) => <DrilldownButton key={category.category} label={category.category} onClick={() => onDrilldown({ ...monthBounds(month), types: 'expense', category: category.category })} />)}
    </DrilldownDetails>
    </>
  );
}

// ---- 4. Top Merchants ----------------------------------------------------

function TopMerchantsChart({ data, loading, error, onRetry, bounds, onDrilldown }: { data: MerchantTotal[]; loading: boolean; error: boolean; onRetry: () => void; bounds: { from: string; to: string }; onDrilldown: (filters: Parameters<typeof transactionUrl>[0]) => void }) {
  if (loading) return <ChartSkeleton height={Math.max(280, data.length * 32)} />;
  if (error) return <WidgetError message="Could not load top merchants." onRetry={onRetry} />;
  if (data.length === 0) return <EmptyState message="No merchant spending in this range." />;

  const config: ChartConfig = {
    total: { label: 'Spend', color: 'var(--chart-merchant)' },
  };
  // Reverse so the largest sits at the top of the horizontal bar chart.
  const reversed = [...data].reverse();
  const height = Math.max(280, data.length * 36);

  return (
    <>
    <ChartContainer config={config} style={{ height }} aria-hidden={true}>
      <BarChart
        data={reversed}
        layout="vertical"
        margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
      >
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis
          type="number"
          tickFormatter={formatShortMoney}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="merchant"
          tickLine={false}
          axisLine={false}
          width={100}
          tick={{ fontSize: 11 }}
          interval={0}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              config={config}
              hideLabel
              valueFormatter={(v) => formatMoney(v)}
            />
          }
        />
        <Bar dataKey="total" fill="var(--chart-merchant)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartContainer>
    <ChartDataDetails
      summary="View merchant spending data"
      caption="Top merchant spending and transaction counts"
      headers={['Merchant', 'Spend', 'Transactions']}
      rows={data.map((merchant) => ({ key: merchant.merchant, cells: [merchant.merchant, formatMoney(merchant.total), merchant.count] }))}
    />
    <DrilldownDetails>
      {data.map((merchant) => <DrilldownButton key={merchant.merchant} label={merchant.merchant} onClick={() => onDrilldown({ ...bounds, types: 'expense', merchant: merchant.merchant })} />)}
    </DrilldownDetails>
    </>
  );
}
