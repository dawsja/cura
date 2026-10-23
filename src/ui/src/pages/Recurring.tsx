/**
 * Recurring — automatic detection of recurring charges.
 *
 * Scans past transactions for charges from the same merchant on the
 * same account repeated on a regular schedule. Amount follows the
 * latest charge so a price change updates the existing row. Surfaces
 * subscriptions, memberships, and recurring bills to help users stay
 * on top of recurring charges, catch fraud, or cancel unused services.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { currencySymbol, formatMoney, formatDate, todayLocalISO } from '../lib/format';
import { RefreshCw, AlertCircle, CalendarDays, CreditCard, Tag, X, Plus, Pencil, Trash2, Check, Ellipsis } from 'lucide-react';
import clsx from 'clsx';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardHeader } from '../components/ui/card';
import { DatePicker } from '../components/ui/date-picker';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';

type Frequency = 'weekly' | 'monthly' | 'yearly';

interface RecurringCharge {
  merchant: string;
  amount: number;
  frequency: Frequency;
  occurrences: number;
  lastDate: string;
  category: string;
  account: string;
  accountId?: string;
  nextDate: string;
  daysUntil: number;
  comingSoon: boolean;
  /** True for user-defined entries (editable/deletable rather than dismissible). */
  manual?: boolean;
  /** Stable id for manual entries; absent on auto-detected charges. */
  id?: string;
}

interface ManualDraft {
  merchant: string;
  amount: string;
  frequency: Frequency;
  account: string;
  category: string;
  anchorDate: string;
}

const FREQUENCY_LABEL: Record<string, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

const FREQUENCY_BADGE: Record<string, string> = {
  weekly: 'bg-emerald-900/40 text-emerald-300',
  monthly: 'bg-sky-900/40 text-sky-300',
  yearly: 'bg-rose-900/40 text-rose-300',
};

/** Normalize any frequency to a monthly burn rate. */
function monthlyBurn(c: RecurringCharge): number {
  if (c.frequency === 'weekly') return c.amount * 52 / 12;
  if (c.frequency === 'monthly') return c.amount;
  return c.amount / 12;
}

/** Annual cost for a single charge. */
function annualCost(c: RecurringCharge): number {
  if (c.frequency === 'weekly') return c.amount * 52;
  if (c.frequency === 'monthly') return c.amount * 12;
  return c.amount;
}

function recurringKey(merchant: string, account: string): string {
  return `${merchant.toLowerCase()}|${account.toLowerCase()}`;
}

function daysLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

export function Recurring() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<RecurringCharge[]>({
    queryKey: ['recurring'],
    queryFn: () => api.get('/api/recurring'),
  });

  // `null` = closed; `'new'` = create; otherwise the manual charge being edited.
  const [editing, setEditing] = useState<RecurringCharge | 'new' | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['recurring'] });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  const saveManual = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: unknown }) =>
      id ? api.patch(`/api/recurring/manual/${id}`, body) : api.post('/api/recurring/manual', body),
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
  });

  const deleteManual = useMutation({
    mutationFn: (id: string) => api.delete(`/api/recurring/manual/${id}`),
    onSuccess: invalidate,
  });

  const dismiss = useMutation({
    mutationFn: (charge: { merchant: string; amount: number; account: string; accountId?: string }) =>
      api.post('/api/recurring/dismiss', charge),
    onMutate: async (charge) => {
      await qc.cancelQueries({ queryKey: ['recurring'] });
      const prev = qc.getQueryData<RecurringCharge[]>(['recurring']);
      if (prev) {
        const key = recurringKey(charge.merchant, charge.accountId ?? charge.account);
        qc.setQueryData<RecurringCharge[]>(
          ['recurring'],
          prev.filter((c) => recurringKey(c.merchant, c.accountId ?? c.account) !== key),
        );
      }
      return { prev };
    },
    onError: (_err, _charge, ctx) => {
      if (ctx?.prev) qc.setQueryData(['recurring'], ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['recurring'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  // Monthly = equivalent monthly burn of every charge (wk x 52/12 + mo + qtr/3 + yr/12).
  // Yearly = sum of annualized costs — always monthlyTotal * 12 (within float).
  const monthlyTotal = data?.reduce((sum, c) => sum + monthlyBurn(c), 0) ?? 0;
  const yearlyEstimate = data?.reduce((sum, c) => sum + annualCost(c), 0) ?? 0;
  const comingUpCount = data?.filter((charge) => charge.comingSoon).length ?? 0;
  const sortedCharges = data ? [...data].sort((a, b) => {
    if (a.comingSoon !== b.comingSoon) return a.comingSoon ? -1 : 1;
    if (a.comingSoon && b.comingSoon) return a.daysUntil - b.daysUntil;
    return 0;
  }) : undefined;
  const chargeSections = sortedCharges ? [
    {
      id: 'due-soon',
      title: 'Due soon',
      description: 'Charges approaching their expected date',
      charges: sortedCharges.filter((charge) => charge.comingSoon),
    },
    {
      id: 'later',
      title: 'Later',
      description: 'The rest of your recurring schedule',
      charges: sortedCharges.filter((charge) => !charge.comingSoon),
    },
  ].filter((section) => section.charges.length > 0) : [];

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>Failed to load recurring charges.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 md:p-6">
      {/* Header */}
      <div data-onboarding-target="recurring-summary" className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Recurring</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Automatically detected charges plus any you add yourself. Review these to catch unused subscriptions or unexpected charges.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => setEditing('new')}
          className="shrink-0"
        >
          <Plus data-icon="inline-start" /> Add recurring
        </Button>
      </div>
      {dismiss.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not dismiss the recurring charge: {dismiss.error.message}
          </AlertDescription>
        </Alert>
      )}
      {deleteManual.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not delete the recurring entry: {deleteManual.error.message}
          </AlertDescription>
        </Alert>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(12rem,1fr)]">
        <Card>
          <CardHeader>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recurring spend</p>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-3">
              <p className="text-2xl font-bold tabular-nums text-foreground">{formatMoney(monthlyTotal)}</p>
              <p className="pb-0.5 text-sm text-muted-foreground">per month</p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatMoney(yearlyEstimate)} estimated per year
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Due soon</p>
            <CardAction>
              <CalendarDays className="size-4 text-sky-300" aria-hidden="true" />
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums text-foreground">{comingUpCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {comingUpCount === 1 ? 'charge needs attention' : 'charges need attention'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recurring charges list */}
      {data && data.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RefreshCw />
            </EmptyMedia>
            <EmptyTitle>No recurring charges detected yet</EmptyTitle>
            <EmptyDescription>
              As more transactions come in, recurring patterns will appear here automatically — or add one manually with <span className="font-semibold">Add recurring</span>.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {chargeSections.map((section) => (
            <section key={section.id} aria-labelledby={`${section.id}-heading`}>
              <div className="mb-2 flex items-end justify-between gap-3 px-1">
                <div>
                  <h2 id={`${section.id}-heading`} className="text-sm font-semibold text-foreground">{section.title}</h2>
                  <p className="text-xs text-muted-foreground">{section.description}</p>
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">{section.charges.length}</span>
              </div>

              <Card className="py-0">
                <CardContent className="divide-y divide-border px-0">
                {section.charges.map((charge) => (
                  <div
                    key={recurringKey(charge.merchant, charge.accountId ?? charge.account)}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 p-4 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{charge.merchant}</h3>
                        <Badge
                          variant="secondary"
                          className={clsx(
                            'border-transparent',
                            FREQUENCY_BADGE[charge.frequency],
                          )}
                        >
                          {FREQUENCY_LABEL[charge.frequency]}
                        </Badge>
                        {charge.manual && (
                          <Badge variant="outline">Manual</Badge>
                        )}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <CreditCard className="size-3.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">{charge.account}</span>
                        </span>
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <Tag className="size-3.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">{charge.category}</span>
                        </span>
                        {!charge.manual && (
                          <span className="inline-flex items-center gap-1">
                            <RefreshCw className="size-3.5" aria-hidden="true" />
                            {charge.occurrences} times
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1">
                      <p className={clsx(
                        'inline-flex items-center gap-1 text-sm font-medium',
                        charge.comingSoon ? 'text-sky-300' : 'text-muted-foreground',
                      )}>
                        <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
                        {daysLabel(charge.daysUntil)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(charge.nextDate)}</p>
                    </div>

                    <div className="col-start-2 row-span-2 row-start-1 flex items-center justify-end gap-2 self-center sm:col-start-3 sm:row-span-1">
                      <div className="text-right">
                        <p className="text-base font-semibold tabular-nums text-destructive">
                          {formatMoney(charge.amount)}
                        </p>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {formatMoney(annualCost(charge))}/yr
                        </p>
                      </div>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${charge.merchant}`}>
                            <Ellipsis />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuGroup>
                            {charge.manual ? (
                              <>
                                <DropdownMenuItem onSelect={() => setEditing(charge)}>
                                  <Pencil />
                                  Edit recurring
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={deleteManual.isPending}
                                  onSelect={() => { if (charge.id) deleteManual.mutate(charge.id); }}
                                >
                                  <Trash2 />
                                  Delete recurring
                                </DropdownMenuItem>
                              </>
                            ) : (
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={dismiss.isPending}
                                onSelect={() => dismiss.mutate({
                                  merchant: charge.merchant,
                                  amount: charge.amount,
                                  account: charge.account,
                                  accountId: charge.accountId,
                                })}
                              >
                                <X />
                                Remove from recurring
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
                </CardContent>
              </Card>
            </section>
          ))}
        </div>
      )}

      {editing && (
        <ManualRecurringModal
          key={editing === 'new' ? 'new' : editing.id}
          charge={editing === 'new' ? null : editing}
          saving={saveManual.isPending}
          error={saveManual.error?.message ?? null}
          onClose={() => {
            if (!saveManual.isPending) {
              saveManual.reset();
              setEditing(null);
            }
          }}
          onSave={(draft) => {
            const id = editing === 'new' ? undefined : editing.id;
            saveManual.mutate({
              id,
              body: {
                merchant: draft.merchant.trim(),
                amount: Number(draft.amount),
                frequency: draft.frequency,
                account: draft.account.trim(),
                category: draft.category.trim(),
                anchorDate: draft.anchorDate,
              },
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * Create / edit a manual recurring entry. Manual entries cover
 * subscriptions and bills that don't have matching transactions yet, so
 * every field is user-supplied. `anchorDate` is any one real occurrence;
 * the server projects the next due date forward from it.
 */
function ManualRecurringModal({
  charge,
  saving,
  error,
  onClose,
  onSave,
}: {
  charge: RecurringCharge | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (draft: ManualDraft) => void;
}) {
  const isEdit = charge !== null;
  const [draft, setDraft] = useState<ManualDraft>({
    merchant: charge?.merchant ?? '',
    amount: charge ? String(charge.amount) : '',
    frequency: charge?.frequency ?? 'monthly',
    account: charge?.account ?? '',
    category: charge?.category ?? '',
    anchorDate: charge?.nextDate ?? todayLocalISO(),
  });

  const amountNum = Number(draft.amount);
  const canSave =
    draft.merchant.trim().length > 0
    && draft.account.trim().length > 0
    && draft.category.trim().length > 0
    && Number.isFinite(amountNum)
    && amountNum > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(draft.anchorDate);
  const amountInvalid = draft.amount !== '' && !(Number.isFinite(amountNum) && amountNum > 0);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={(event) => {
          if (saving) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && !saving) onSave(draft);
          }}
        >
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit recurring' : 'Add recurring'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Update this manual recurring charge.'
                : 'Add a subscription or bill that should appear on your recurring schedule.'}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="recurring-merchant">Merchant</FieldLabel>
              <Input
                id="recurring-merchant"
                value={draft.merchant}
                onChange={(e) => setDraft((d) => ({ ...d, merchant: e.target.value }))}
                placeholder="e.g. Netflix"
                maxLength={120}
                required
                autoFocus
                disabled={saving}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field data-invalid={amountInvalid || undefined}>
                <FieldLabel htmlFor="recurring-amount">Amount</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText>{currencySymbol()}</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    id="recurring-amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={draft.amount}
                    onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
                    placeholder="0"
                    className="tabular-nums"
                    required
                    disabled={saving}
                    aria-invalid={amountInvalid || undefined}
                  />
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="recurring-frequency">Frequency</FieldLabel>
                <Select
                  value={draft.frequency}
                  onValueChange={(value) => setDraft((d) => ({ ...d, frequency: value as Frequency }))}
                  disabled={saving}
                >
                  <SelectTrigger id="recurring-frequency" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field>
              <FieldLabel>Next due date</FieldLabel>
              <DatePicker
                value={draft.anchorDate}
                onChange={(ymd) => setDraft((d) => ({ ...d, anchorDate: ymd }))}
                disabled={saving}
              />
              <FieldDescription>Any real charge date works — the schedule projects forward from it.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="recurring-account">Account</FieldLabel>
              <Input
                id="recurring-account"
                value={draft.account}
                onChange={(e) => setDraft((d) => ({ ...d, account: e.target.value }))}
                placeholder="e.g. Chase Credit"
                maxLength={120}
                required
                disabled={saving}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="recurring-category">Category</FieldLabel>
              <Input
                id="recurring-category"
                value={draft.category}
                onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                placeholder="e.g. Subscriptions"
                maxLength={120}
                required
                disabled={saving}
              />
            </Field>
          </FieldGroup>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || saving}>
              {saving ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              {saving ? 'Saving…' : isEdit ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
