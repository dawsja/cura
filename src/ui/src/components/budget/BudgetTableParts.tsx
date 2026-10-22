/**
 * Shared building blocks for the Budget page's grouped table (Monarch-style):
 * one card, collapsible group header rows that carry the group totals, and
 * calm sub-category rows with a thin progress bar and a Remaining pill.
 *
 * Desktop columns: Category | Budget | Actual | Remaining.
 * Phone: name + remaining on one line, the bar below, then "spent of" with
 * the editable budget field.
 */
import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { formatMoney } from '../../lib/format';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Progress } from '../ui/progress';
import type { PlannedCellStatus } from '../PaydownBudgetSection';

/** Sum money values in integer cents so float noise never shows as "−$0.00". */
export function sumMoney(values: readonly number[]): number {
  return values.reduce((cents, value) => cents + Math.round(value * 100), 0) / 100;
}

/** a − b computed in cents. */
export function subMoney(a: number, b: number): number {
  return (Math.round(a * 100) - Math.round(b * 100)) / 100;
}

export type ProgressTone = 'amber' | 'emerald' | 'rose';

export function progressTone(actual: number, planned: number): ProgressTone {
  if (actual > planned) return 'rose';
  if (actual >= planned * 0.7) return 'amber';
  return 'emerald';
}

const COLUMNS = 'sm:grid-cols-[minmax(0,1fr)_7.5rem_7rem_7.5rem]';

export function BudgetColumnHeader() {
  return (
    <div className={cn('hidden items-center gap-x-4 border-b px-5 py-3 text-sm text-muted-foreground sm:grid', COLUMNS)}>
      <span>Category</span>
      <span className="text-right">Budget</span>
      <span className="text-right">Actual</span>
      <span className="text-right">Remaining</span>
    </div>
  );
}

export function RemainingPill({ value, size = 'sm' }: { value: number; size?: 'sm' | 'md' }) {
  const tone = value > 0 ? 'positive' : value < 0 ? 'negative' : 'zero';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-semibold whitespace-nowrap tabular-nums',
        size === 'md' ? 'h-7 px-3 text-sm' : 'h-6 px-2 text-xs',
        tone === 'positive' && 'bg-emerald-400/10 text-emerald-400',
        tone === 'negative' && 'bg-rose-400/10 text-rose-400',
        tone === 'zero' && 'text-muted-foreground',
      )}
    >
      {value < 0 ? '−' : ''}{formatMoney(Math.abs(value))}
    </span>
  );
}

/** Plain remaining figure used for income, aligned with the pill text. */
export function RemainingText({ value, size = 'sm' }: { value: number; size?: 'sm' | 'md' }) {
  return (
    <span className={cn('font-semibold whitespace-nowrap text-muted-foreground tabular-nums', size === 'md' ? 'px-3 text-sm' : 'px-2 text-xs')}>
      {value < 0 ? '−' : ''}{formatMoney(Math.abs(value))}
    </span>
  );
}

export function GroupDot({ color }: { color: string }) {
  return <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color } as CSSProperties} />;
}

interface BudgetGroupProps {
  id?: string;
  name: string;
  color: string;
  planned: number;
  actual: number;
  open: boolean;
  onToggle: () => void;
  /** Income shows remaining as plain text and the earned amount on phones. */
  isIncome?: boolean;
  /** Extra context next to the name, e.g. sync time or category count. */
  note?: ReactNode;
  first?: boolean;
  children?: ReactNode;
}

export function BudgetGroup({ id, name, color, planned, actual, open, onToggle, isIncome, note, first, children }: BudgetGroupProps) {
  const remaining = subMoney(planned, actual);
  const bodyId = `budget-group-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  return (
    <section id={id} aria-label={name} className={cn('scroll-mt-8', !first && 'border-t')}>
      <Button
        type="button"
        variant="ghost"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className={cn(
          'grid h-auto min-h-13 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-none px-4 py-2 text-left font-normal whitespace-normal aria-expanded:bg-transparent hover:bg-muted/50 aria-expanded:hover:bg-muted/50 sm:px-5 md:h-auto',
          COLUMNS,
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {open
            ? <ChevronDown data-icon="inline-start" className="text-muted-foreground" />
            : <ChevronRight data-icon="inline-start" className="text-muted-foreground" />}
          <GroupDot color={color} />
          <span className={cn('truncate text-[15px] font-bold', open ? 'text-foreground' : 'fg-tertiary')}>{name}</span>
          {note}
        </span>
        <span className="hidden pr-[11px] text-right text-sm font-semibold text-foreground tabular-nums sm:block">{formatMoney(planned)}</span>
        <span className="hidden text-right text-sm font-semibold text-foreground tabular-nums sm:block">{formatMoney(actual)}</span>
        <span className="text-right">
          {isIncome ? (
            <>
              <span className="text-sm font-semibold text-foreground tabular-nums sm:hidden">{formatMoney(actual)}</span>
              <span className="hidden sm:inline"><RemainingText value={remaining} size="md" /></span>
            </>
          ) : (
            <RemainingPill value={remaining} size="md" />
          )}
        </span>
      </Button>
      {open && <div id={bodyId} className="pb-2">{children}</div>}
    </section>
  );
}

interface BudgetLineProps {
  /** Name cell content (drill-down link, account name, …). */
  label: ReactNode;
  planned: number;
  actual: number;
  /** Editable budget control. */
  budget: ReactNode;
  isIncome?: boolean;
  /** Word after the actual amount on phones: "spent", "earned", "assigned". */
  actualVerb: string;
}

export function BudgetLine({ label, planned, actual, budget, isIncome, actualVerb }: BudgetLineProps) {
  const remaining = subMoney(planned, actual);
  const showProgress = planned > 0;
  const pct = showProgress ? Math.min(100, (actual / planned) * 100) : 0;
  return (
    <div
      className={cn(
        'group/row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2.5 pr-4 pl-10 hover:bg-muted/60 sm:py-2 sm:pr-5 sm:pl-[3.25rem]',
        "[grid-template-areas:'name_rem'_'bar_bar'_'act_bud'] sm:[grid-template-areas:'name_bud_act_rem'_'bar_bud_act_rem']",
        COLUMNS,
      )}
    >
      <div className="min-w-0 [grid-area:name]">{label}</div>
      {showProgress && (
        <Progress
          value={pct}
          tone={isIncome ? 'emerald' : progressTone(actual, planned)}
          className="mt-2 h-1 [grid-area:bar] sm:mt-1.5 sm:h-[3px] sm:max-w-[200px]"
          aria-label={`${formatMoney(actual)} ${actualVerb} of ${formatMoney(planned)}`}
        />
      )}
      <div className="mt-2 flex flex-col items-end [grid-area:bud] sm:mt-0">{budget}</div>
      <div className="mt-2 self-start pt-3.5 text-xs text-muted-foreground tabular-nums [grid-area:act] sm:mt-0 sm:self-center sm:pt-0 sm:text-right sm:text-sm">
        <span className={cn(actual > 0 && 'sm:text-[color:var(--fg-tertiary)]')}>{formatMoney(actual)}</span>
        <span className="sm:hidden"> {actualVerb} of</span>
      </div>
      <div className="text-right [grid-area:rem]">
        {isIncome ? (
          <>
            <span className="text-sm font-semibold text-foreground tabular-nums sm:hidden">{formatMoney(actual)}</span>
            <span className="hidden sm:inline"><RemainingText value={remaining} /></span>
          </>
        ) : (
          <RemainingPill value={remaining} />
        )}
      </div>
    </div>
  );
}

interface PlannedInputProps {
  value: number;
  label: string;
  status?: PlannedCellStatus;
  errorMessage?: string;
  onboardingTarget?: string;
  onChange: (value: number) => void;
  onCommit: () => void;
  onReset?: () => void;
}

/**
 * Budget amount field. It keeps a visible control border at all times
 * (THEME.md rule 7: control boundaries stay at 3:1).
 */
export function PlannedInput({ value, label, status, errorMessage, onboardingTarget, onChange, onCommit, onReset }: PlannedInputProps) {
  return (
    <>
      <Input
        data-onboarding-target={onboardingTarget}
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        value={value}
        aria-label={label}
        aria-invalid={status === 'error' || undefined}
        disabled={status === 'saving'}
        onFocus={(event) => {
          if (event.currentTarget.value === '0') event.currentTarget.select();
        }}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onCommit();
          if (event.key === 'Escape') onReset?.();
        }}
        className="min-h-11 w-24 text-right tabular-nums sm:h-8 sm:min-h-0 sm:w-full"
      />
      <CellFeedback status={status} message={errorMessage} onRetry={onCommit} onReset={onReset} />
    </>
  );
}

function CellFeedback({ status, message, onRetry, onReset }: { status?: PlannedCellStatus; message?: string; onRetry: () => void; onReset?: () => void }) {
  if (status !== 'error') return null;
  return (
    <span role="alert" className="mt-1 block w-52 text-right text-xs text-destructive sm:w-64">
      {message ?? 'Could not save.'}{' '}
      <Button type="button" variant="link" size="sm" className="h-auto px-0" onMouseDown={(e) => e.preventDefault()} onClick={onRetry}>Retry</Button>
      {onReset && (
        <>
          {' '}
          <Button type="button" variant="link" size="sm" className="h-auto px-0" onMouseDown={(e) => e.preventDefault()} onClick={onReset}>Undo</Button>
        </>
      )}
    </span>
  );
}
