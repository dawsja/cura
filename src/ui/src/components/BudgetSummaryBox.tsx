import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Cell, Pie, PieChart } from 'recharts';
import { cn } from 'cn';
import { Progress } from './ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from './ui/chart';
import { formatMoney } from '../lib/format';
import { subMoney, sumMoney } from './budget/BudgetTableParts';

/** One slice of planned spending (an expense group, or the "Smaller groups" remainder). */
export interface PlannedSpendingSlice {
  name: string;
  color: string;
  planned: number;
  actual: number;
}

export interface BudgetSummaryBoxProps {
  plannedIncome: number;
  earnedIncome: number;
  plannedExpense: number;
  spentExpense: number;
  plannedDebt: number;
  actualDebt: number;
  slices: PlannedSpendingSlice[];
  loading?: boolean;
  onJumpToPaydown?: () => void;
}

export function BudgetSummaryBox({
  plannedIncome,
  earnedIncome,
  plannedExpense,
  spentExpense,
  plannedDebt,
  actualDebt,
  slices,
  loading,
  onJumpToPaydown,
}: BudgetSummaryBoxProps) {
  const assigned = sumMoney([plannedExpense, plannedDebt]);
  const leftToBudget = Math.round(subMoney(plannedIncome, assigned));
  const overAssigned = leftToBudget < 0;
  const balanced = leftToBudget === 0;
  const incomeToCome = subMoney(plannedIncome, earnedIncome);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-col gap-1 px-5 pt-5 pb-5 sm:px-6 sm:pt-6">
        <CardTitle className="text-sm font-normal text-muted-foreground">Left to budget</CardTitle>
        <div
          className={cn(
            'text-4xl leading-tight font-bold tracking-tight tabular-nums',
            overAssigned ? 'text-rose-400' : balanced ? 'text-foreground' : 'text-emerald-400',
          )}
        >
          {overAssigned ? '−' : ''}{formatMoney(Math.abs(leftToBudget), true)}
        </div>
        <p className="text-sm text-muted-foreground">
          {overAssigned
            ? `${formatMoney(Math.abs(leftToBudget), true)} more assigned than planned income`
            : balanced
              ? 'Every dollar of planned income is assigned'
              : `${formatMoney(assigned, true)} of ${formatMoney(plannedIncome, true)} income is assigned`}
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 px-5 pb-6 sm:px-6">
        <Separator />
        <SummaryRow
          label="Income"
          planned={plannedIncome}
          actual={earnedIncome}
          verb="Earned"
          tone="emerald"
          trailing={incomeToCome > 0
            ? <span className="tabular-nums">{formatMoney(incomeToCome, true)} to come</span>
            : <span>{plannedIncome > 0 ? 'Fully earned' : 'Nothing planned'}</span>}
        />
        <SummaryRow
          label="Expenses"
          planned={plannedExpense}
          actual={spentExpense}
          verb="Spent"
          tone="rose"
          trailing={<LeftText value={subMoney(plannedExpense, spentExpense)} />}
        />
        <Button
          type="button"
          variant="ghost"
          onClick={onJumpToPaydown}
          disabled={!onJumpToPaydown}
          className="group -m-2 h-auto w-[calc(100%+1rem)] justify-start rounded-lg p-2 font-normal whitespace-normal md:h-auto"
        >
          <SummaryRow
            label={(
              <span className="flex items-center gap-1">
                Pay down
                {onJumpToPaydown && (
                  <ArrowUpRight data-icon="inline-end" className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                )}
              </span>
            )}
            planned={plannedDebt}
            actual={actualDebt}
            verb="Assigned"
            tone={actualDebt > plannedDebt ? 'rose' : actualDebt >= plannedDebt * 0.7 ? 'amber' : 'emerald'}
            trailing={plannedDebt > 0 ? <LeftText value={subMoney(plannedDebt, actualDebt)} /> : null}
          />
        </Button>
        <Separator />
        <PlannedSpending slices={slices} total={plannedExpense} />
        {loading && <p className="text-center text-xs text-muted-foreground" role="status">Loading…</p>}
      </CardContent>
    </Card>
  );
}

function LeftText({ value }: { value: number }) {
  return (
    <span className={cn('tabular-nums', value < 0 ? 'text-rose-400' : value > 0 ? 'text-emerald-400' : 'text-muted-foreground')}>
      {value < 0 ? `${formatMoney(Math.abs(value), true)} over` : `${formatMoney(value, true)} left`}
    </span>
  );
}

function SummaryRow({
  label,
  planned,
  actual,
  verb,
  tone,
  trailing,
}: {
  label: ReactNode;
  planned: number;
  actual: number;
  verb: string;
  tone: 'emerald' | 'rose' | 'amber';
  trailing: ReactNode;
}) {
  const pct = planned > 0 ? Math.min(100, (actual / planned) * 100) : 0;
  return (
    <div className="flex w-full flex-col gap-2 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        <span className="text-sm text-muted-foreground tabular-nums">
          <span className="font-semibold text-foreground">{formatMoney(actual, true)}</span> of {formatMoney(planned, true)}
        </span>
      </div>
      <Progress value={pct} tone={tone} className="h-1.5" aria-label={`${verb} ${formatMoney(actual, true)} of ${formatMoney(planned, true)}`} />
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span>{verb}</span>
        {trailing}
      </div>
    </div>
  );
}

function PlannedSpending({ slices, total }: { slices: PlannedSpendingSlice[]; total: number }) {
  const visible = slices.filter((s) => s.planned > 0);
  const config: ChartConfig = {};
  const data = visible.map((s, i) => {
    const key = `g${i}`;
    config[key] = { label: s.name, color: s.color };
    return { key, name: s.name, planned: s.planned };
  });

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-foreground">Planned spending</h3>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is budgeted for expenses this month.</p>
      ) : (
        <>
          <div className="relative mx-auto size-36">
            <ChartContainer config={config} framed={false} className="aspect-square size-36" aria-hidden={true}>
              <PieChart>
                <ChartTooltip
                  content={<ChartTooltipContent config={config} hideLabel nameKey="key" valueFormatter={(v) => formatMoney(v)} />}
                />
                <Pie
                  data={data}
                  dataKey="planned"
                  nameKey="key"
                  innerRadius={50}
                  outerRadius={66}
                  paddingAngle={2}
                  strokeWidth={0}
                  isAnimationActive={false}
                >
                  {visible.map((s, i) => <Cell key={data[i]!.key} fill={s.color} />)}
                </Pie>
              </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-lg font-bold text-foreground tabular-nums">{formatMoney(total, true)}</span>
              <span className="text-xs text-muted-foreground">planned</span>
            </div>
          </div>
          <table className="w-full text-sm">
            <caption className="sr-only">Planned spending by category group</caption>
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th scope="col" className="pb-1 pl-[18px] text-left font-normal">Group</th>
                <th scope="col" className="pb-1 text-right font-normal">Spent</th>
                <th scope="col" className="w-16 pb-1 text-right font-normal">Budget</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.name}>
                  <th scope="row" className="py-1 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                      <span className="truncate fg-tertiary">{s.name}</span>
                    </span>
                  </th>
                  <td className="py-1 pl-3 text-right whitespace-nowrap text-muted-foreground tabular-nums">{formatMoney(s.actual, true)}</td>
                  <td className="py-1 pl-3 text-right whitespace-nowrap text-foreground tabular-nums">{formatMoney(s.planned, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
