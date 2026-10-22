import { CreditCard, Banknote, RefreshCw, Save } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatMoney, timeAgo } from '../lib/format';
import { Button } from './ui/button';
import { Alert, AlertAction, AlertDescription } from './ui/alert';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty';
import { BudgetGroup, BudgetLine, PlannedInput, subMoney, sumMoney } from './budget/BudgetTableParts';

export interface PaydownBudgetRow {
  accountId: string;
  accountName: string;
  type: 'credit' | 'loan';
  apr: number;
  planned: number;
  actual: number;
  remaining: number;
}

export interface PaydownBudgetMeta {
  syncedAt: string | null;
  rowCount: number;
}

export type PlannedCellStatus = 'saving' | 'saved' | 'error';

/**
 * The Pay down group of the Budget table: one row per included debt account
 * with an editable planned payment. Renders as a group inside the Budget
 * page's table card (not its own card).
 */
export function PaydownBudgetSection({
  title = 'Pay down',
  rows,
  meta,
  open,
  onToggle,
  color,
  id,
  livePlanned,
  onLiveChange,
  onLiveCommit,
  onLiveReset,
  statuses,
  errorMessages,
  loading,
  error,
  onRetry,
}: {
  title?: string;
  rows: PaydownBudgetRow[];
  meta: PaydownBudgetMeta;
  open: boolean;
  onToggle: () => void;
  color: string;
  id?: string;
  livePlanned?: Map<string, number>;
  onLiveChange?: (accountId: string, value: number) => void;
  onLiveCommit?: (accountId: string) => void;
  onLiveReset?: (accountId: string) => void;
  statuses?: Map<string, PlannedCellStatus | undefined>;
  /** Server error text per account, e.g. a planned amount below the minimum payment. */
  errorMessages?: Map<string, string | undefined>;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const navigate = useNavigate();
  // Integer-cent arithmetic so float noise never renders as a red "−$0.00".
  const displayRows = rows.map((r) => {
    const planned = livePlanned?.get(r.accountId) ?? r.planned;
    return { ...r, planned, remaining: subMoney(planned, r.actual) };
  });
  const totalPlanned = sumMoney(displayRows.map((r) => r.planned));
  const totalActual = sumMoney(displayRows.map((r) => r.actual));
  const editable = !!onLiveChange && !!onLiveCommit;

  return (
    <BudgetGroup
      id={id}
      name={title}
      color={color}
      planned={totalPlanned}
      actual={totalActual}
      open={open}
      onToggle={onToggle}
      note={meta.syncedAt ? (
        <span className="hidden items-center gap-1 text-xs whitespace-nowrap text-muted-foreground sm:inline-flex">
          <RefreshCw aria-hidden="true" className="size-3" />
          Synced {timeAgo(meta.syncedAt)}
        </span>
      ) : undefined}
    >
      {loading ? (
        <p className="px-5 py-6 text-center text-sm text-muted-foreground" role="status">Loading pay down…</p>
      ) : error ? (
        <div className="px-4 pt-1 sm:px-5">
          <Alert variant="destructive">
            <AlertDescription>Pay down data could not be loaded.</AlertDescription>
            {onRetry && (
              <AlertAction>
                <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>
              </AlertAction>
            )}
          </Alert>
        </div>
      ) : displayRows.length === 0 ? (
        <EmptyState onSyncClick={() => navigate('/paydown')} synced={!!meta.syncedAt} />
      ) : (
        <>
          {meta.syncedAt && (
            <p className="pb-1 pl-10 text-xs text-muted-foreground sm:hidden">Synced {timeAgo(meta.syncedAt)}</p>
          )}
          {displayRows.map((r) => (
            <BudgetLine
              key={r.accountId}
              planned={r.planned}
              actual={r.actual}
              actualVerb="assigned"
              label={(
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  {r.type === 'credit'
                    ? <CreditCard aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    : <Banknote aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
                  <span className="truncate text-foreground">{r.accountName}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{(r.apr * 100).toFixed(2)}% APR</span>
                </span>
              )}
              budget={editable ? (
                <PlannedInput
                  value={r.planned}
                  label={`Planned payment for ${r.accountName}`}
                  status={statuses?.get(r.accountId)}
                  errorMessage={errorMessages?.get(r.accountId)}
                  onChange={(v) => onLiveChange!(r.accountId, v)}
                  onCommit={() => onLiveCommit!(r.accountId)}
                  onReset={onLiveReset ? () => onLiveReset(r.accountId) : undefined}
                />
              ) : (
                <span className="text-sm text-muted-foreground tabular-nums sm:pr-[11px]">{formatMoney(r.planned)}</span>
              )}
            />
          ))}
        </>
      )}
    </BudgetGroup>
  );
}

function EmptyState({ onSyncClick, synced }: { onSyncClick: () => void; synced: boolean }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No debt accounts included yet</EmptyTitle>
        <EmptyDescription>
          Add a credit card or loan on the Accounts page, then enable Include on the Pay down page.
          {synced && (
            <> A snapshot exists for this month but no accounts are currently included.</>
          )}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button type="button" variant="outline" size="sm" onClick={onSyncClick}>
          <Save data-icon="inline-start" /> Open Pay down page
        </Button>
      </EmptyContent>
    </Empty>
  );
}
