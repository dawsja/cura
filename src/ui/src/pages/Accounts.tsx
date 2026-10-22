import { useEffect, useState, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { formatAccountBalance, isLiability, netWorthContribution } from '../lib/accounting';
import { cn } from '../lib/utils';
import { Plus, Trash2, RefreshCw, ExternalLink, Wallet, AlertTriangle, EyeOff, Eye, Pencil, EllipsisVertical, ChevronDown, ChevronRight } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';

type EditableAccountType = 'checking' | 'savings' | 'credit' | 'investment' | 'loan';
type AccountType = EditableAccountType | 'uncategorized';
type GroupFilter = 'all' | 'owned' | 'owed';

interface Account { id: string; source: 'manual' | 'simplefin'; name: string; type: AccountType; balance: number; institution?: string; interestRate?: number; minPayment?: number; plannedPayment?: number; includeInPaydown?: boolean; hidden?: boolean; alias?: string; }
interface SfStatus { demoMode: boolean; connected: boolean; lastSync?: string | null; lastAttempt?: string | null; lastError?: string | null; }
interface SfClaim { setupToken: string; }

// Share-bar colours come from the shared chart palette (the same tokens
// Reports and Paydown use for series), keyed by account type so a
// savings account always reads the same colour.
const TYPE_META: Record<AccountType, { label: string; barColor: string }> = {
  checking: { label: 'Checking', barColor: 'var(--chart-category-4)' },
  savings: { label: 'Savings', barColor: 'var(--chart-category-2)' },
  credit: { label: 'Credit', barColor: 'var(--chart-category-3)' },
  investment: { label: 'Investment', barColor: 'var(--chart-category-5)' },
  loan: { label: 'Loan', barColor: 'var(--chart-category-6)' },
  uncategorized: { label: 'Uncategorized', barColor: 'var(--chart-category-8)' },
};

const EDITABLE_ACCOUNT_TYPES: EditableAccountType[] = ['checking', 'savings', 'credit', 'investment', 'loan'];

const FINANCIAL_QUERY_KEYS = [
  'accounts',
  'transactions',
  'reviews',
  'dashboard',
  'budget',
  'reports',
  'paydown',
  'goals',
  'recurring',
  'notifications',
  'simplefin',
] as const;

const byBalanceDesc = (a: Account, b: Account) => Math.abs(b.balance) - Math.abs(a.balance);

/** Signed display for a net amount: debts and negative totals get a leading minus. */
function formatSigned(value: number): string {
  return value < 0 ? `−${formatMoney(Math.abs(value))}` : formatMoney(value);
}

function formatShare(share: number): string {
  if (share > 0 && share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}

export function Accounts() {
  const qc = useQueryClient();
  // Always fetch with `includeHidden=true` so the user can toggle the
  // "Show hidden" section and un-hide from the same page. The server
  // marks each row with `hidden: boolean`; we filter client-side.
  const accounts = useQuery({
    queryKey: ['accounts', 'all'],
    queryFn: () => api.get<Account[]>('/api/accounts?includeHidden=true'),
  });
  const sf = useQuery({ queryKey: ['simplefin', 'status'], queryFn: () => api.get<SfStatus>('/api/simplefin/status') });

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<EditableAccountType>('checking');
  const [balance, setBalance] = useState('0');
  const [institution, setInstitution] = useState('');

  const [sfToken, setSfToken] = useState('');
  const [sfBusy, setSfBusy] = useState(false);
  const [sfErr, setSfErr] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const [filter, setFilter] = useState<GroupFilter>('all');

  // The "Show hidden" toggle. Off by default — hidden accounts shouldn't
  // be visible clutter, but the user needs a path back to un-hide.
  const [showHidden, setShowHidden] = useState(false);

  // Account currently open in the edit modal (alias + type).
  const [editing, setEditing] = useState<Account | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: 'hide' | 'delete'; account: Account } | null>(null);

  const invalidateFinancialData = () => {
    FINANCIAL_QUERY_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: [key] }));
  };

  const add = useMutation({
    mutationFn: (input: Omit<Account, 'id' | 'source' | 'hidden'>) => api.post<Account>('/api/accounts', input),
    onSuccess: () => {
      invalidateFinancialData();
      setName('');
      setBalance('0');
      setInstitution('');
      setAddOpen(false);
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/accounts/${id}`),
    onSuccess: invalidateFinancialData,
  });
  const hide = useMutation({
    mutationFn: (id: string) => api.post(`/api/accounts/${id}/hide`),
    onSuccess: invalidateFinancialData,
  });
  const unhide = useMutation({
    mutationFn: (id: string) => api.post(`/api/accounts/${id}/unhide`),
    onSuccess: invalidateFinancialData,
  });
  // Alias + type: both are user-owned overrides. SimpleFIN sync never
  // overwrites either on conflict, so the choices survive every re-sync.
  const editAccount = useMutation({
    mutationFn: (input: { id: string; alias: string | null; type: EditableAccountType; balance: number }) =>
      api.patch(`/api/accounts/${input.id}`, { alias: input.alias, type: input.type, balance: input.balance }),
    onSuccess: () => {
      invalidateFinancialData();
      setEditing(null);
    },
  });
  const sync = useMutation({
    mutationFn: () =>
      api.post<{
        accountsSynced: number;
        transactionsSynced: number;
        transactionsReconciled: number;
        reconciliationAmbiguous: number;
        stalePendingTransactions: number;
        errors: string[];
      }>(
        '/api/simplefin/sync',
        {},
      ),
    onSuccess: invalidateFinancialData,
  });
  const claim = useMutation({
    mutationFn: (body: SfClaim) => api.post('/api/simplefin/claim', body),
  });
  const disconnect = useMutation({
    mutationFn: () => api.delete('/api/simplefin/disconnect'),
    onSuccess: () => {
      setConfirmDisconnect(false);
      qc.invalidateQueries({ queryKey: ['simplefin'] });
    },
  });

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    add.mutate({
      name,
      type,
      balance: Math.abs(Number(balance) || 0),
      institution: institution || undefined,
    });
  };

  const onClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    setSfErr(null);
    claim.reset();
    setSfBusy(true);
    try {
      await claim.mutateAsync({ setupToken: sfToken });
      setSfToken('');
      await qc.invalidateQueries({ queryKey: ['simplefin'] });
      try {
        await sync.mutateAsync();
      } catch (syncError) {
        setSfErr(`Connected, but the initial sync failed: ${(syncError as Error).message}`);
      }
    } catch (e2) {
      setSfErr((e2 as Error).message);
    } finally {
      setSfBusy(false);
    }
  };

  // Split visible accounts into what the user owns (assets), what they
  // owe (credit + loans) and accounts that still need a type. Hidden
  // accounts live in their own dimmed section and never count.
  const all = accounts.data ?? [];
  const visible = all.filter((a) => !a.hidden);
  const hidden = all.filter((a) => a.hidden);
  const uncategorized = visible.filter((a) => a.type === 'uncategorized');
  const owned = visible.filter((a) => a.type !== 'uncategorized' && !isLiability(a.type)).sort(byBalanceDesc);
  const owed = visible.filter((a) => isLiability(a.type)).sort(byBalanceDesc);
  const ownedTotal = owned.reduce((sum, a) => sum + Math.abs(a.balance), 0);
  const owedTotal = owed.reduce((sum, a) => sum + Math.abs(a.balance), 0);
  const netWorth = visible.reduce((sum, account) => sum + netWorthContribution(account), 0);
  const countedAccounts = owned.length + owed.length;
  const accountOperationError = unhide.error;
  const loaded = !accounts.isPending && !accounts.isError;

  const openAdd = () => {
    add.reset();
    setAddOpen(true);
  };

  const headerActions = (
    <>
      {!sf.data?.demoMode && (
        <Button
          type="button"
          variant="outline"
          onClick={() => sync.mutate()}
          disabled={sync.isPending || !sf.data?.connected}
          aria-label={sync.isPending ? 'Syncing with SimpleFIN' : 'Sync with SimpleFIN'}
        >
          {sync.isPending ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          <span className="hidden sm:inline">{sync.isPending ? 'Syncing…' : 'Sync'}</span>
        </Button>
      )}
      <Button type="button" onClick={openAdd} aria-label="Add account" data-onboarding-target="manual-account-add">
        <Plus data-icon="inline-start" />
        Add<span className="hidden sm:inline">&nbsp;account</span>
      </Button>
    </>
  );

  const renderRow = (a: Account, opts: { share?: number; dimmed?: boolean }) => {
    const { text: balanceText, colorClass: balanceColor } = formatAccountBalance(a, (n) => formatMoney(n));
    // The display name is the user-set alias when present, otherwise
    // the canonical name (e.g. SimpleFIN's "CHASE CHECKING ...").
    const displayName = a.alias || a.name;
    const meta = TYPE_META[a.type];
    const hasApr = isLiability(a.type) && a.interestRate != null && a.interestRate > 0;
    const subtitle = [
      a.institution ?? (a.alias ? a.name : null),
      hasApr ? `${((a.interestRate ?? 0) * 100).toFixed(2)}% APR` : meta.label.toLowerCase(),
      opts.dimmed ? 'hidden' : null,
    ].filter(Boolean).join(', ');
    const showShare = opts.share !== undefined;
    return (
      <li
        key={a.id}
        className={cn(
          'grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2 border-t border-border py-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_3rem_minmax(7.5rem,auto)_auto] sm:gap-x-4',
          opts.dimmed && 'opacity-60',
        )}
      >
        <div className="flex min-w-0 flex-col sm:order-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium text-foreground" title={a.alias ? `Bank name: ${a.name}` : undefined}>
              {displayName}
            </span>
            {a.source === 'simplefin' && (
              <Badge variant="outline" className="hidden lg:inline-flex">SimpleFIN</Badge>
            )}
          </div>
          <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
        </div>
        <div
          className={cn(
            'col-span-3 row-start-2 flex items-center gap-3 sm:contents',
            !showShare && 'hidden sm:contents',
          )}
        >
          <div aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted sm:order-2">
            {showShare && (
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(0, Math.min(1, opts.share ?? 0)) * 100}%`, background: meta.barColor }}
              />
            )}
          </div>
          <span className="w-10 text-right text-xs text-muted-foreground tabular-nums sm:order-3 sm:w-auto sm:text-sm">
            {showShare ? formatShare(opts.share ?? 0) : null}
          </span>
        </div>
        <span
          className={cn(
            'text-right font-medium tabular-nums sm:order-4',
            a.type === 'uncategorized' ? 'text-muted-foreground' : balanceColor,
          )}
        >
          {balanceText}
        </span>
        <div className="sm:order-5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${displayName}`}
                data-onboarding-target={a.type === 'uncategorized' ? 'unclassified-account-edit' : undefined}
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => setEditing(a)}>
                  <Pencil aria-hidden="true" />
                  {a.type === 'uncategorized' ? 'Choose account type' : 'Edit account'}
                </DropdownMenuItem>
                {opts.dimmed ? (
                  <DropdownMenuItem onSelect={() => unhide.mutate(a.id)} disabled={unhide.isPending}>
                    <Eye aria-hidden="true" /> Unhide account
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onSelect={() => {
                      hide.reset();
                      setConfirmation({ action: 'hide', account: a });
                    }}
                  >
                    <EyeOff aria-hidden="true" /> Hide account
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              {a.source === 'manual' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        del.reset();
                        setConfirmation({ action: 'delete', account: a });
                      }}
                    >
                      <Trash2 aria-hidden="true" /> Delete account
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    );
  };

  const renderGroup = ({
    id,
    title,
    list,
    total,
    totalClassName,
    description,
    shareTotal,
    dimmed,
  }: {
    id: string;
    title: string;
    list: Account[];
    total?: React.ReactNode;
    totalClassName?: string;
    description?: string;
    /** Group total each row's share bar is measured against. */
    shareTotal?: number;
    dimmed?: boolean;
  }) => (
    <Card key={id} className="gap-0 pt-3 pb-1" aria-labelledby={`account-group-${id}`} role="region">
      <CardHeader className="gap-0.5 pb-3">
        <CardTitle id={`account-group-${id}`} className="font-semibold">
          {title} <span className="font-normal text-muted-foreground">· {list.length}</span>
        </CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
        {total !== undefined && (
          <CardAction className="self-center">
            <span className={cn('text-base font-semibold tabular-nums', totalClassName)}>{total}</span>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {list.map((a) => renderRow(a, {
            dimmed,
            share: shareTotal === undefined ? undefined : shareTotal > 0 ? Math.abs(a.balance) / shareTotal : 0,
          }))}
        </ul>
      </CardContent>
    </Card>
  );

  const showOwned = filter !== 'owed';
  const showOwed = filter !== 'owned';

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-bold text-foreground">Accounts</h1>
          {loaded && visible.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Net worth{' '}
              <strong className={cn('font-semibold tabular-nums', netWorth < 0 ? 'text-rose-400' : 'text-foreground')}>
                {formatSigned(netWorth)}
              </strong>{' '}
              across {countedAccounts} {countedAccounts === 1 ? 'account' : 'accounts'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loaded && visible.length > 0 && (
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={filter}
              onValueChange={(next) => {
                if (next) setFilter(next as GroupFilter);
              }}
              aria-label="Show accounts"
              className="w-full md:w-auto"
            >
              <ToggleGroupItem value="all" className="h-11 flex-1 px-2 sm:px-3 md:h-8 md:flex-none">All</ToggleGroupItem>
              <ToggleGroupItem value="owned" className="h-11 flex-1 px-2 sm:px-3 md:h-8 md:flex-none">Owned</ToggleGroupItem>
              <ToggleGroupItem value="owed" className="h-11 flex-1 px-2 sm:px-3 md:h-8 md:flex-none">Owed</ToggleGroupItem>
            </ToggleGroup>
          )}
          {headerActions}
        </div>
      </header>

      {accountOperationError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Account operation failed</AlertTitle>
          <AlertDescription>{accountOperationError.message}</AlertDescription>
        </Alert>
      )}

      <section className="flex flex-col gap-4" aria-label="Your accounts">
        {accounts.isPending && (
          <Card>
            <CardContent className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading accounts…
            </CardContent>
          </Card>
        )}
        {accounts.isError && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 text-center">
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Could not load accounts</AlertTitle>
                <AlertDescription>{accounts.error.message}</AlertDescription>
              </Alert>
              <Button type="button" onClick={() => accounts.refetch()} disabled={accounts.isFetching}>
                {accounts.isFetching ? <Spinner data-icon="inline-start" /> : null}
                {accounts.isFetching ? 'Retrying…' : 'Retry'}
              </Button>
            </CardContent>
          </Card>
        )}

        {loaded && filter === 'all' && uncategorized.length > 0 && renderGroup({
          id: 'uncategorized',
          title: 'Needs a type',
          list: uncategorized,
          description: 'Not counted in net worth. Use the account menu to choose a type.',
        })}

        {loaded && showOwned && owned.length > 0 && renderGroup({
          id: 'owned',
          title: 'Owned',
          list: owned,
          total: formatMoney(ownedTotal),
          totalClassName: 'text-foreground',
          shareTotal: ownedTotal,
        })}

        {loaded && showOwed && owed.length > 0 && renderGroup({
          id: 'owed',
          title: 'Owed',
          list: owed,
          total: formatSigned(-owedTotal),
          totalClassName: owedTotal > 0 ? 'text-rose-400' : 'text-foreground',
          shareTotal: owedTotal,
        })}

        {loaded && visible.length > 0 && filter !== 'all' && (filter === 'owned' ? owned : owed).length === 0 && (
          <Card>
            <CardContent className="text-sm text-muted-foreground">
              {filter === 'owned' ? 'No asset accounts yet.' : 'Nothing owed. No credit cards or loans are being tracked.'}
            </CardContent>
          </Card>
        )}

        {loaded && visible.length === 0 && (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Wallet />
              </EmptyMedia>
              <EmptyTitle>No accounts yet</EmptyTitle>
              <EmptyDescription>Add one manually or connect SimpleFIN below to import automatically.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" onClick={openAdd}>
                <Plus data-icon="inline-start" />
                Add account
              </Button>
            </EmptyContent>
          </Empty>
        )}

        {/* Hidden section. Off by default — the user has to opt in to
            see them. From here they can un-hide to bring the account
            (and its future sync data) back. */}
        {loaded && hidden.length > 0 && (
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowHidden((v) => !v)}
              aria-expanded={showHidden}
              className="self-start text-muted-foreground"
            >
              {showHidden
                ? <ChevronDown data-icon="inline-start" aria-hidden="true" />
                : <ChevronRight data-icon="inline-start" aria-hidden="true" />}
              {showHidden ? 'Hide' : 'Show'} hidden accounts
              <span className="text-muted-foreground">· {hidden.length}</span>
            </Button>
            {showHidden && renderGroup({
              id: 'hidden',
              title: 'Hidden',
              list: hidden,
              description: 'Excluded from totals, budgets and reports. Sync is paused until you unhide them.',
              dimmed: true,
            })}
          </div>
        )}
      </section>

      <Card data-onboarding-target="simplefin-connect">
        <CardHeader>
          <CardTitle>SimpleFIN</CardTitle>
          <CardDescription>Import balances and transactions from your bank automatically.</CardDescription>
          {!sf.isPending && !sf.isError && (
            <CardAction>
              <Badge variant={sf.data.demoMode ? 'outline' : sf.data.connected ? 'secondary' : 'outline'}>
                {sf.data.demoMode ? 'Demo' : sf.data.connected ? 'Connected' : 'Not connected'}
              </Badge>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {sf.isPending ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Checking connection…
            </p>
          ) : sf.isError ? (
            <div className="flex flex-col gap-3">
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Could not load SimpleFIN status</AlertTitle>
                <AlertDescription>{sf.error.message}</AlertDescription>
              </Alert>
              <Button type="button" onClick={() => sf.refetch()} disabled={sf.isFetching} className="self-start">
                {sf.isFetching ? <Spinner data-icon="inline-start" /> : null}
                {sf.isFetching ? 'Retrying…' : 'Retry'}
              </Button>
            </div>
          ) : sf.data.demoMode ? (
            <p className="text-sm text-muted-foreground">
              Bank connections are disabled in the public demo. The accounts above use sample data.
            </p>
          ) : sf.data.connected ? (
            <div className="flex flex-col gap-1 text-sm text-muted-foreground">
              <p>Connected. Last sync: {sf.data.lastSync ?? 'never'}.</p>
              {sf.data.lastAttempt && sf.data.lastAttempt !== sf.data.lastSync && (
                <p className="text-xs text-muted-foreground">Last attempt: {sf.data.lastAttempt}.</p>
              )}
              {sync.data && (
                <p className="text-xs text-muted-foreground">
                  Synced {sync.data.accountsSynced} account(s), {sync.data.transactionsSynced} transaction(s).
                  {sync.data.transactionsReconciled > 0 && ` Reconciled ${sync.data.transactionsReconciled} pending charge(s).`}
                </p>
              )}
              {sync.data && sync.data.reconciliationAmbiguous > 0 && (
                <Alert>
                  <AlertTriangle />
                  <AlertDescription>
                    {sync.data.reconciliationAmbiguous} pending charge(s) need manual duplicate review.
                  </AlertDescription>
                </Alert>
              )}
              {sync.data && sync.data.stalePendingTransactions > 0 && (
                <Alert>
                  <AlertTriangle />
                  <AlertDescription>
                    {sync.data.stalePendingTransactions} pending charge(s) have not been seen for at least 7 days.
                  </AlertDescription>
                </Alert>
              )}
              {sync.data?.errors && sync.data.errors.length > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertTitle>Sync errors</AlertTitle>
                  <AlertDescription>
                    <ul className="flex flex-col gap-0.5">
                      {sync.data.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {(sync.error?.message || (!sync.data && sf.data.lastError)) && (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertDescription>{sync.error?.message ?? sf.data.lastError}</AlertDescription>
                </Alert>
              )}
              {!confirmDisconnect ? (
                <Button
                  type="button"
                  variant="destructive"
                  className="mt-3 self-start"
                  onClick={() => { disconnect.reset(); setConfirmDisconnect(true); }}
                >
                  Disconnect
                </Button>
              ) : (
                <div className="mt-3 flex flex-col gap-3">
                  <Alert variant="destructive">
                    <AlertTitle>Disconnect SimpleFIN?</AlertTitle>
                    <AlertDescription>
                      Imported accounts and transactions will remain in Cura Money. Automatic and manual SimpleFIN syncs will stop until you reconnect.
                    </AlertDescription>
                  </Alert>
                  {disconnect.error && (
                    <Alert variant="destructive">
                      <AlertTriangle />
                      <AlertDescription>{disconnect.error.message}</AlertDescription>
                    </Alert>
                  )}
                  <div className="flex gap-2">
                    <Button type="button" variant="destructive" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                      {disconnect.isPending ? <Spinner data-icon="inline-start" /> : null}
                      {disconnect.isPending ? 'Disconnecting…' : 'Yes, disconnect'}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setConfirmDisconnect(false)} disabled={disconnect.isPending}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={onClaim} className="flex flex-col gap-3">
              <FieldGroup>
                <Field data-invalid={!!sfErr || undefined}>
                  <FieldLabel htmlFor="simplefin-token">SimpleFIN setup token</FieldLabel>
                  <div className="flex items-center gap-1">
                    <FieldDescription>Connect or reconnect via SimpleFIN setup token</FieldDescription>
                    <Button variant="ghost" size="icon" asChild>
                      <a
                        href="https://bridge.simplefin.org/simplefin/create"
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Get a SimpleFIN setup token"
                        title="Get a SimpleFIN setup token"
                      >
                        <ExternalLink />
                      </a>
                    </Button>
                  </div>
                  <Input
                    id="simplefin-token"
                    value={sfToken}
                    onChange={(e) => setSfToken(e.target.value)}
                    placeholder="Paste SimpleFIN setup token"
                    className="font-mono"
                    aria-invalid={!!sfErr || undefined}
                  />
                </Field>
              </FieldGroup>
              {sfErr && (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertDescription>{sfErr}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={sfBusy} className="self-start">
                {sfBusy ? <Spinner data-icon="inline-start" /> : null}
                {sfBusy ? (claim.isSuccess ? 'Running initial sync…' : 'Connecting…') : 'Connect'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open && add.isPending) return;
          setAddOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={onAdd} className="contents">
            <DialogHeader>
              <DialogTitle>Add an account</DialogTitle>
              <DialogDescription>
                Balances are entered and displayed in USD only. Enter a positive amount; the account type decides whether it is owned or owed.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="manual-account-name">Name</FieldLabel>
                <Input id="manual-account-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Everyday checking" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="manual-account-type">Type</FieldLabel>
                <Select value={type} onValueChange={(value) => setType(value as EditableAccountType)}>
                  <SelectTrigger id="manual-account-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {EDITABLE_ACCOUNT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{TYPE_META[t].label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="manual-account-balance">{isLiability(type) ? 'Amount owed (USD)' : 'Balance (USD)'}</FieldLabel>
                <Input id="manual-account-balance" value={balance} onChange={(e) => setBalance(e.target.value)} type="number" min="0" step="0.01" placeholder="0.00" />
              </Field>
              <Field>
                <FieldLabel htmlFor="manual-account-institution">Institution</FieldLabel>
                <Input id="manual-account-institution" value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Optional" />
              </Field>
            </FieldGroup>
            {add.error && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{add.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)} disabled={add.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={add.isPending}>
                {add.isPending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                {add.isPending ? 'Adding…' : 'Add account'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {editing && (
        <EditAccountModal
          account={editing}
          isSaving={editAccount.isPending}
          error={editAccount.error?.message ?? null}
          onClose={() => {
            if (!editAccount.isPending) {
              editAccount.reset();
              setEditing(null);
            }
          }}
          onSave={(patch) => editAccount.mutate({ id: editing.id, ...patch })}
        />
      )}
      {confirmation?.action === 'hide' && (
        <ConfirmDialog
          title={`Hide “${confirmation.account.alias || confirmation.account.name}”?`}
          confirmLabel="Hide account"
          onConfirm={() => hide.mutateAsync(confirmation.account.id)}
          onClose={() => setConfirmation(null)}
        >
          <p>This account and its activity will be excluded from Home, Transactions, Budget, Paydown, Reports, and the main account list.</p>
          <p>It will remain available in the hidden accounts section, and sync will pause until you unhide it.</p>
        </ConfirmDialog>
      )}
      {confirmation?.action === 'delete' && (
        <ConfirmDialog
          title={`Delete “${confirmation.account.alias || confirmation.account.name}”?`}
          confirmLabel="Delete account"
          destructive
          onConfirm={() => del.mutateAsync(confirmation.account.id)}
          onClose={() => setConfirmation(null)}
        >
          <p>This permanently removes the account balance and detaches any savings goals linked to the account.</p>
          <p>Account-specific paydown rows will also be removed.</p>
          <p>If its name uniquely matches a Pay down category, that category, its budget entries, and its categorization rules will also be removed.</p>
          <p>Historical transactions are retained and remain visible in your ledger and reports.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * Edit account modal — alias, type, and positive balance magnitude.
 * Alias and type are user-owned overrides that SimpleFIN sync leaves alone.
 * Empty alias clears back to the canonical bank name.
 */
function EditAccountModal({
  account,
  isSaving,
  error,
  onClose,
  onSave,
}: {
  account: Account;
  isSaving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (patch: { alias: string | null; type: EditableAccountType; balance: number }) => void;
}) {
  const [alias, setAlias] = useState(account.alias ?? '');
  const [type, setType] = useState<AccountType>(account.type);
  const [balance, setBalance] = useState(String(Math.abs(account.balance)));
  const inputRef = useRef<HTMLInputElement>(null);
  const typeUncategorized = type === 'uncategorized';
  const balanceInvalid = balance === '' || Number(balance) < 0;

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedBalance = Number(balance);
    if (isSaving || type === 'uncategorized' || !Number.isFinite(parsedBalance) || parsedBalance < 0) return;
    const trimmed = alias.trim();
    onSave({
      alias: trimmed === '' ? null : trimmed,
      type: type as EditableAccountType,
      balance: parsedBalance,
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={(event) => {
          if (isSaving) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (isSaving) event.preventDefault();
        }}
      >
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Edit account</DialogTitle>
            <DialogDescription>
              Bank name: {account.name}
              {account.institution ? ` · ${account.institution}` : ''}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="edit-account-alias">Display name</FieldLabel>
              <Input
                ref={inputRef}
                id="edit-account-alias"
                type="text"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                maxLength={120}
                placeholder={account.name}
                disabled={isSaving}
              />
              <FieldDescription>
                Leave blank to use the bank name. Survives SimpleFIN sync.
              </FieldDescription>
            </Field>

            <Field data-invalid={balanceInvalid || undefined}>
              <FieldLabel htmlFor="edit-account-balance">{isLiability(type) ? 'Amount owed' : 'Balance'} (USD)</FieldLabel>
              <Input
                id="edit-account-balance"
                type="number"
                min="0"
                step="0.01"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                disabled={isSaving}
                required
                aria-invalid={balanceInvalid || undefined}
              />
              <FieldDescription>
                Cura Money supports USD only. Enter a positive amount; the account type determines its net-worth sign.
              </FieldDescription>
            </Field>

            <Field data-invalid={typeUncategorized || undefined}>
              <FieldLabel htmlFor="edit-account-type">Account type</FieldLabel>
              <Select
                value={typeUncategorized ? undefined : type}
                onValueChange={(value) => setType(value as EditableAccountType)}
                disabled={isSaving}
              >
                <SelectTrigger id="edit-account-type" className="w-full" aria-invalid={typeUncategorized || undefined}>
                  <SelectValue placeholder="Select account type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {EDITABLE_ACCOUNT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{TYPE_META[t].label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {type === 'investment'
                  ? 'Investment is balance-only: value stays on Accounts/Home for growth; no transactions are imported or shown.'
                  : 'Affects net worth sign and paydown. Survives SimpleFIN sync.'}
              </FieldDescription>
            </Field>
          </FieldGroup>

          {error && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || typeUncategorized || balanceInvalid}>
              {isSaving ? <Spinner data-icon="inline-start" /> : null}
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
