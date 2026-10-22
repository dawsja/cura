/**
 * Payoff projection chart — the Pay down page's headline visual.
 *
 * Idle: one curve per debt, each running from today's balance down to
 * the axis at its own payoff month. The curves are not stacked, so the Y
 * axis stays scaled to the largest single balance and every debt keeps a
 * readable slope.
 *
 * Simulating (`compare`): two series — this scenario (filled) against a
 * dashed current-plan baseline — so extra payments are visible as an
 * earlier intercept, not as overlapping account strokes.
 *
 * The projection timeline is a start-of-month snapshot: index 0 is
 * today's balance, and the entry after the final payment is exactly
 * zero. Each series is therefore drawn through its first zero snapshot
 * and cut off (null) beyond it, so the curve meets the axis the month
 * after the final payment and has no flat trail along the axis. The
 * markers sit on the final-payment month, which is the month the page
 * reports as debt-free.
 *
 * The chart uses the longer of the scenario and baseline horizons.
 * Axis ticks are generated rather than sampled: the first and last
 * months always get one so the axis states the span it covers, and the
 * interior ticks fall on January of evenly spaced years (or on evenly
 * spaced months for horizons under ~3 years). The Y axis uses round
 * steps ending on a round maximum.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from 'recharts';
import { Button } from './ui/button';
import { ChartContainer, ChartTooltip, formatShortMoney, type ChartConfig } from './ui/chart';
import { Empty, EmptyHeader, EmptyTitle } from './ui/empty';
import { formatMoney, monthYearLong, monthYearShort } from '../lib/format';

export interface PayoffChartSeries {
  id: string;
  name: string;
  color: string;
}

export interface PayoffChartPoint {
  month: string;
  totalDebt: number;
  byAccount: Record<string, number>;
}

export interface PayoffChartProjection {
  timeline: PayoffChartPoint[];
  startingTotal: number;
  debtFreeMonth: string | null;
  baselineTimeline?: PayoffChartPoint[];
  baselineDebtFreeMonth?: string | null;
}

const SCENARIO_KEY = 'scenario';
const BASELINE_KEY = 'baseline';
const SCENARIO_SERIES: PayoffChartSeries = {
  id: SCENARIO_KEY,
  name: 'This scenario',
  color: 'var(--chart-total)',
};
const BASELINE_SERIES: PayoffChartSeries = {
  id: BASELINE_KEY,
  name: 'Current plan',
  color: 'var(--chart-comparison)',
};

// Balances are dollars with fractional cents, so treat anything under
// half a cent as paid off — the same threshold the server simulator uses.
const PAID_OFF = 0.005;
const DESKTOP_QUERY = '(min-width: 768px)';

export function PayoffProjectionChart({
  accounts,
  projection,
  compare,
}: {
  accounts: PayoffChartSeries[];
  projection: PayoffChartProjection;
  /** Draw this scenario against the current plan instead of one curve per debt. */
  compare: boolean;
}) {
  const gradientPrefix = useId().replace(/:/g, '');
  const isDesktop = useIsDesktop();
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const seriesKey = accounts
    .map((account) => `${account.id}\u0000${account.name}\u0000${account.color}`)
    .join('\u0001');
  const model = useMemo(
    () => compare
      ? buildComparisonModel(projection.timeline, projection.baselineTimeline ?? [])
      : buildChartModel(accounts, projection),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seriesKey, projection, compare],
  );
  const series = model.series;

  if (projection.timeline.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No data yet.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  if (series.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No accounts included in paydown. Toggle one in the list below.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  const filledId = compare ? SCENARIO_KEY : (series.length === 1 ? series[0]!.id : null);
  const filledColor = compare ? SCENARIO_SERIES.color : (series.length === 1 ? series[0]!.color : null);
  const config: ChartConfig = {
    ...Object.fromEntries(series.map((s) => [s.id, { label: s.name, color: s.color }])),
  };
  const chartRows = model.rows;
  const chartMonths = chartRows.map((row) => row.month);
  const yTicks = niceTicks(model.maxAccountBalance, isDesktop ? 5 : 4);
  const xTicks = buildMonthTicks(chartMonths, isDesktop ? 6 : 4);
  const yearTicks = chartMonths.length > 36;
  const formatMonthTick = (value: string) =>
    value === chartMonths[0]
      ? 'Today'
      : yearTicks
        ? monthYearLong(value)
        : monthYearShort(value);

  const markers = debtFreeMarkers(projection, compare).filter((marker) => chartMonths.includes(marker.month));
  const dimmed = (id: string) => focusKey !== null && focusKey !== id;

  return (
    <>
      <p className="mb-3 text-xs fg-muted">
        {compare
          ? 'This scenario vs your current plan.'
          : 'Each debt from today down to its payoff month.'}
      </p>

      <div aria-hidden="true">
        <ChartContainer config={config} className="h-[280px] sm:h-[340px]" framed={false} aria-hidden={true}>
          <ComposedChart data={chartRows} margin={{ top: markers.length ? 22 : 8, right: 16, left: 0, bottom: 0 }}>
            <defs>
              {filledColor && (
                <linearGradient id={`${gradientPrefix}-fill`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={filledColor} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={filledColor} stopOpacity={0.02} />
                </linearGradient>
              )}
            </defs>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="month"
              ticks={xTicks}
              tick={
                <MonthTick
                  format={formatMonthTick}
                  firstMonth={chartMonths[0]!}
                  lastMonth={chartMonths[chartMonths.length - 1]!}
                />
              }
              tickLine={false}
              axisLine={{ stroke: 'var(--chart-axis)' }}
              tickMargin={10}
              interval={0}
              minTickGap={0}
            />
            <YAxis
              domain={[0, yTicks[yTicks.length - 1] ?? 0]}
              ticks={yTicks}
              tickFormatter={formatShortMoney}
              tick={{ fill: 'var(--chart-axis)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--chart-axis)' }}
              width={56}
            />
            <ChartTooltip
              cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1, strokeDasharray: '3 3' }}
              content={<PayoffTooltip config={config} showCombined={!compare} />}
            />
            {markers.map((marker) => (
              <ReferenceLine
                key={`${marker.month}-${marker.label}`}
                x={marker.month}
                stroke={marker.color}
                strokeDasharray="3 3"
                label={{
                  value: marker.label,
                  position: marker.position,
                  fill: marker.color,
                  fontSize: 10,
                }}
              />
            ))}
            {series.map((s) => (
              s.id === BASELINE_KEY ? (
                <Line
                  key={s.id}
                  type="monotone"
                  dataKey={s.id}
                  stroke={s.color}
                  strokeWidth={dimmed(s.id) ? 1.5 : 2}
                  strokeOpacity={dimmed(s.id) ? 0.25 : 1}
                  strokeDasharray="5 4"
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  connectNulls={false}
                />
              ) : (
                <Area
                  key={s.id}
                  type="monotone"
                  dataKey={s.id}
                  stroke={s.color}
                  strokeWidth={dimmed(s.id) ? 1.5 : 2}
                  strokeOpacity={dimmed(s.id) ? 0.25 : 1}
                  fill={filledId === s.id ? `url(#${gradientPrefix}-fill)` : s.color}
                  fillOpacity={filledId === s.id ? (dimmed(s.id) ? 0.2 : 1) : 0}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  connectNulls={false}
                />
              )
            ))}
          </ComposedChart>
        </ChartContainer>
      </div>

      <ul className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
        {series.map((item) => (
          <li key={item.id}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onPointerEnter={() => setFocusKey(item.id)}
              onPointerLeave={() => setFocusKey(null)}
              onFocus={() => setFocusKey(item.id)}
              onBlur={() => setFocusKey(null)}
              aria-label={`Highlight ${item.name}`}
            >
              {item.id === BASELINE_KEY ? (
                <span className="inline-block w-3 shrink-0 border-t-2 border-dashed" style={{ borderColor: item.color }} />
              ) : (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              )}
              {item.name}
            </Button>
          </li>
        ))}
      </ul>

      <details className="mt-3 border-t border-default pt-3">
        <summary className="cursor-pointer text-xs font-medium fg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
          View projection data
        </summary>
        <p className="mt-2 text-xs fg-muted">
          {formatMoney(projection.startingTotal)} total debt
          {projection.debtFreeMonth
            ? `, projected debt-free ${monthYearLong(projection.debtFreeMonth)}`
            : ', with no payoff date in this projection'}
          {compare && projection.baselineDebtFreeMonth && projection.baselineDebtFreeMonth !== projection.debtFreeMonth
            ? `; current plan ${monthYearLong(projection.baselineDebtFreeMonth)}`
            : ''}
          .
        </p>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full min-w-max text-left text-xs">
            <caption className="sr-only">
              {compare ? 'Monthly total debt for this scenario and the current plan' : 'Monthly total debt and account balances'}
            </caption>
            <thead className="fg-muted">
              <tr className="border-b border-default">
                <th scope="col" className="py-2 pr-3 font-medium">Month</th>
                {compare ? (
                  series.map((s) => (
                    <th key={s.id} scope="col" className="py-2 px-3 text-right font-medium">{s.name}</th>
                  ))
                ) : (
                  <>
                    <th scope="col" className="py-2 px-3 text-right font-medium">Total debt</th>
                    {series.map((s) => (
                      <th key={s.id} scope="col" className="py-2 px-3 text-right font-medium">{s.name}</th>
                    ))}
                  </>
                )}
              </tr>
            </thead>
            <tbody className="fg-secondary">
              {model.rows.map((row) => (
                <tr key={row.month} className="border-b border-default last:border-0">
                  <th scope="row" className="py-2 pr-3 font-medium fg-primary">{monthYearLong(row.month)}</th>
                  {compare ? (
                    series.map((s) => (
                      <td key={s.id} className="py-2 px-3 text-right tabular-nums">
                        {row[s.id] === null || row[s.id] === undefined ? 'Paid off' : formatMoney(Number(row[s.id]))}
                      </td>
                    ))
                  ) : (
                    <>
                      <td className="py-2 px-3 text-right tabular-nums">{formatMoney(Number(row.total ?? 0))}</td>
                      {series.map((s) => (
                        <td key={s.id} className="py-2 px-3 text-right tabular-nums">
                          {row[s.id] === null || row[s.id] === undefined ? 'Paid off' : formatMoney(Number(row[s.id]))}
                        </td>
                      ))}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

// ---- Data shaping -------------------------------------------------------

type ChartRow = Record<string, string | number | null> & { month: string };

interface ChartModel {
  /** Draw order: largest debt first, so its curve sits behind the rest. */
  series: PayoffChartSeries[];
  rows: ChartRow[];
  maxAccountBalance: number;
}

function buildChartModel(
  accounts: PayoffChartSeries[],
  projection: PayoffChartProjection,
): ChartModel {
  const scenario = projection.timeline;
  const startingBalance = (id: string) => projection.timeline[0]?.byAccount[id] ?? 0;

  // Areas overlap, and each one's translucent fill paints over whatever
  // was drawn before it. Ordering largest balance first keeps every
  // stroke clear, because a smaller debt's fill never rises above the
  // curve of a larger one. It also reads biggest-debt-first in the legend.
  const series = [...accounts].sort(
    (a, b) => startingBalance(b.id) - startingBalance(a.id) || a.name.localeCompare(b.name),
  );

  const months = scenario.map((point) => point.month);

  // Draw each account through its first zero snapshot, then stop. The
  // snapshot is start-of-month, so the zero entry is the month after the
  // final payment — that is the point where the curve should touch the axis.
  const lastIndex = new Map<string, number>();
  for (const s of series) {
    let end = months.length - 1;
    for (let i = 0; i < scenario.length; i++) {
      if ((scenario[i]!.byAccount[s.id] ?? 0) <= PAID_OFF) {
        end = i;
        break;
      }
    }
    lastIndex.set(s.id, end);
  }

  let maxAccountBalance = 0;

  const rows: ChartRow[] = months.map((month, i) => {
    const point = scenario[i]!;
    const total = Math.max(0, point.totalDebt);
    const row: ChartRow = { month, total };
    for (const s of series) {
      const end = lastIndex.get(s.id) ?? months.length - 1;
      if (i > end) {
        row[s.id] = null;
        continue;
      }
      const balance = Math.max(0, point.byAccount[s.id] ?? 0);
      // Snap the payoff snapshot to exactly zero so the curve meets the axis.
      const value = i === end ? 0 : balance;
      row[s.id] = value;
      if (value > maxAccountBalance) maxAccountBalance = value;
    }
    return row;
  });

  return { series, rows, maxAccountBalance };
}

function cutAtPayoff(points: PayoffChartPoint[], months: string[]): { values: (number | null)[]; max: number } {
  const byMonth = new Map(points.map((point) => [point.month, Math.max(0, point.totalDebt)]));
  let ended = false;
  let started = false;
  let max = 0;
  const values = months.map((month) => {
    if (ended) return null;
    const value = byMonth.get(month);
    if (value === undefined) {
      if (!started) return null;
      ended = true;
      return 0;
    }
    started = true;
    if (value <= PAID_OFF) {
      ended = true;
      return 0;
    }
    if (value > max) max = value;
    return value;
  });
  return { values, max };
}

function buildComparisonModel(
  scenario: PayoffChartPoint[],
  baseline: PayoffChartPoint[],
): ChartModel {
  const months = [...new Set([...scenario.map((point) => point.month), ...baseline.map((point) => point.month)])].sort();
  const scenarioSeries = cutAtPayoff(scenario, months);
  const baselineSeries = cutAtPayoff(baseline, months);
  const rows: ChartRow[] = months.map((month, i) => ({
    month,
    total: scenarioSeries.values[i] ?? 0,
    [SCENARIO_KEY]: scenarioSeries.values[i] ?? null,
    [BASELINE_KEY]: baselineSeries.values[i] ?? null,
  }));
  return {
    series: [SCENARIO_SERIES, BASELINE_SERIES],
    rows,
    maxAccountBalance: Math.max(scenarioSeries.max, baselineSeries.max),
  };
}

function debtFreeMarkers(
  projection: PayoffChartProjection,
  compare: boolean,
): { month: string; label: string; color: string; position: 'insideTopLeft' | 'insideTopRight' | 'insideTop' }[] {
  if (!compare) {
    return projection.debtFreeMonth
      ? [{ month: projection.debtFreeMonth, label: 'Final payment', color: 'var(--chart-axis)', position: 'insideTop' }]
      : [];
  }
  const markers: { month: string; label: string; color: string }[] = [];
  if (projection.debtFreeMonth) {
    markers.push({ month: projection.debtFreeMonth, label: 'This scenario', color: 'var(--chart-total)' });
  }
  if (projection.baselineDebtFreeMonth && projection.baselineDebtFreeMonth !== projection.debtFreeMonth) {
    markers.push({ month: projection.baselineDebtFreeMonth, label: 'Current plan', color: 'var(--chart-comparison)' });
  }
  if (markers.length === 1) return [{ ...markers[0]!, position: 'insideTop' }];
  markers.sort((a, b) => a.month.localeCompare(b.month));
  return markers.map((marker, index) => ({
    ...marker,
    position: index === 0 ? 'insideTopLeft' : 'insideTopRight',
  }));
}

// ---- Axis helpers -------------------------------------------------------

const STEP_MANTISSAS = [1, 2, 5];

/**
 * Round axis steps from 0 up to at least `max`, so gridlines land on
 * values like $200K rather than $187,431. Candidate steps are scored by
 * how much empty headroom they leave above the data, subject to a cap on
 * how many gridlines fit; ties prefer the sparser axis.
 */
export function niceTicks(max: number, maxSteps = 5): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const magnitude = 10 ** Math.floor(Math.log10(max));
  let best: { step: number; steps: number } | null = null;
  for (const scale of [magnitude / 10, magnitude, magnitude * 10]) {
    for (const mantissa of STEP_MANTISSAS) {
      const step = mantissa * scale;
      const steps = Math.ceil(max / step);
      if (steps < 2 || steps > maxSteps) continue;
      if (best === null || steps * step < best.steps * best.step) best = { step, steps };
    }
  }
  // Nothing fit the cap (a very small or very large max); fall back to
  // whatever a plain division suggests so the axis still renders.
  const step = best?.step ?? max / maxSteps;
  const steps = best?.steps ?? maxSteps;
  const ticks: number[] = [];
  for (let i = 0; i <= steps; i++) ticks.push(Math.round(step * i * 100) / 100);
  return ticks;
}

/**
 * Pick X-axis ticks that read consistently regardless of the month the
 * projection starts in.
 *
 * The first and last months always get a tick, so the axis states the
 * span it covers — a 30-year projection that labels only up to 2051
 * reads as if it ends there. Interior ticks land on January of evenly
 * spaced years for long horizons, or on an even month stride for short
 * ones, and any that crowd an endpoint are dropped.
 */
export function buildMonthTicks(months: string[], target = 6): string[] {
  if (months.length <= 3) return [...months];
  const first = months[0]!;
  const lastIndex = months.length - 1;
  const last = months[lastIndex]!;
  // Roughly how many months of axis a label occupies, so interior ticks
  // keep clear of the endpoint labels.
  const edgeGap = Math.max(1, Math.ceil(months.length / (target * 2.5)));
  const interior: string[] = [];

  if (months.length <= 36) {
    const stride = Math.max(1, Math.ceil(lastIndex / target));
    for (let i = stride; i < lastIndex; i += stride) interior.push(months[i]!);
  } else {
    const startYear = Number(first.slice(0, 4));
    const endYear = Number(last.slice(0, 4));
    const spanYears = Math.max(1, endYear - startYear);
    const yearStride = [1, 2, 3, 5, 10].find((s) => spanYears / s <= target)
      ?? Math.ceil(spanYears / target);
    for (let year = startYear + yearStride; year <= endYear; year += yearStride) {
      interior.push(`${year}-01`);
    }
  }

  const index = new Map(months.map((month, i) => [month, i]));
  const ticks = [first];
  for (const month of interior) {
    const i = index.get(month);
    if (i === undefined) continue;
    if (i < edgeGap || i > lastIndex - edgeGap) continue;
    ticks.push(month);
  }
  ticks.push(last);
  return ticks;
}

/**
 * X-axis tick that anchors the endpoint labels inward. Recharts centres
 * every tick on its coordinate, which pushes "Today" off the left edge
 * and the payoff month off the right; aligning the two endpoints to
 * their own side keeps both fully inside the card.
 */
function MonthTick({
  x,
  y,
  payload,
  format,
  firstMonth,
  lastMonth,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string | number };
  format: (month: string) => string;
  firstMonth: string;
  lastMonth: string;
}) {
  const month = String(payload?.value ?? '');
  const anchor = month === firstMonth ? 'start' : month === lastMonth ? 'end' : 'middle';
  return (
    <text x={x} y={y} dy="0.71em" textAnchor={anchor} fill="var(--chart-axis)">
      {format(month)}
    </text>
  );
}

// ---- Tooltip ------------------------------------------------------------

interface TooltipEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
}

/**
 * Hover card for the projection.
 *
 * Paid-off accounts drop out and the rest sort by balance so the largest
 * debt reads first; a combined footer supplies the figure the overlaid
 * areas cannot show.
 */
function PayoffTooltip({
  active,
  payload,
  label,
  config,
  showCombined = true,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  config: ChartConfig;
  showCombined?: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  let rows = payload
    .map((entry) => {
      const key = String(entry.name ?? entry.dataKey ?? '');
      return {
        key,
        label: config[key]?.label ?? key,
        color: entry.color ?? config[key]?.color,
        value: typeof entry.value === 'number' && Number.isFinite(entry.value) ? entry.value : null,
      };
    })
    .filter((row) => row.value !== null);
  rows = rows.filter((row) => (row.value ?? 0) > PAID_OFF);
  if (showCombined) rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const total = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);

  return (
    <div
      className="rounded-lg border bg-[var(--chart-tooltip-bg)] text-[var(--chart-tooltip-fg)] shadow-lg p-3 text-xs min-w-[190px]"
      style={{ borderColor: 'var(--chart-tooltip-border)' }}
    >
      <div className="font-semibold mb-2">{label !== undefined ? monthYearLong(String(label)) : ''}</div>
      {rows.length === 0 ? (
        <div style={{ color: 'var(--chart-tooltip-muted)' }}>Debt-free</div>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                <span style={{ color: 'var(--chart-tooltip-muted)' }}>{row.label}</span>
              </span>
              <span className="tabular-nums font-medium">{formatMoney(row.value ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
      {showCombined && rows.length > 1 && (
        <div
          className="mt-2 flex items-center justify-between gap-4 border-t pt-2 font-medium"
          style={{ borderColor: 'var(--chart-tooltip-border)' }}
        >
          <span>Combined</span>
          <span className="tabular-nums">{formatMoney(total)}</span>
        </div>
      )}
    </div>
  );
}

// ---- Viewport -----------------------------------------------------------

/** Tick density depends on how much horizontal room the labels get. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setIsDesktop(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}
