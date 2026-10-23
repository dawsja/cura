import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Pencil, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { Button } from '../ui/button';
import { DatePicker } from '../ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { TYPE_STYLE } from './shared';
import type { RecurringPick, Transaction } from './types';

type RecurringState = RecurringPick;

/**
 * TransactionActionModal — opened by the triple-dot button on each
 * transaction row. Allows editing the posting date, marking the
 * transaction's merchant as recurring (weekly, monthly, or yearly), and
 * deleting the transaction.
 */
export function TransactionActionModal({
  transaction: t,
  onClose,
  onEdit,
  editDisabled,
  onUpdateDate,
  onSetRecurring,
  onDelete,
  isPending,
}: {
  transaction: Transaction;
  onClose: () => void;
  onEdit: () => void;
  editDisabled: boolean;
  onUpdateDate: (id: string, date: string) => Promise<void>;
  onSetRecurring: (frequency: RecurringPick) => Promise<void>;
  onDelete: () => void;
  isPending: boolean;
}) {
  const [date, setDate] = useState(t.date);
  const [frequency, setFrequency] = useState<RecurringState>('none');
  const [dateChanged, setDateChanged] = useState(false);
  const [recurringBusy, setRecurringBusy] = useState(false);

  // Hydrate current mark from the recurring list when the modal opens.
  const recurringQ = useQuery({
    queryKey: ['recurring'],
    queryFn: () => api.get<{
      merchant: string;
      amount: number;
      frequency: string;
      account: string;
      accountId?: string;
    }[]>('/api/recurring'),
  });
  useEffect(() => {
    if (!recurringQ.data) return;
    const key = `${t.merchant.toLowerCase()}|${(t.accountId ?? t.account).toLowerCase()}`;
    const match = recurringQ.data.find(
      (c) => `${c.merchant.toLowerCase()}|${(c.accountId ?? c.account).toLowerCase()}` === key,
    );
    if (match && (
      match.frequency === 'weekly'
      || match.frequency === 'monthly'
      || match.frequency === 'yearly'
    )) {
      setFrequency(match.frequency);
    } else {
      setFrequency('none');
    }
  }, [recurringQ.data, t.merchant, t.amount, t.account, t.accountId]);

  const onSaveDate = async () => {
    if (date === t.date) return;
    await onUpdateDate(t.id, date);
    setDateChanged(true);
  };

  const onPickRecurring = async (next: RecurringPick) => {
    if (next === frequency || isPending || recurringBusy) return;
    setRecurringBusy(true);
    try {
      await onSetRecurring(next);
      setFrequency(next);
    } finally {
      setRecurringBusy(false);
    }
  };

  const busy = isPending || recurringBusy;

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transaction Actions</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{t.merchant}</span>
            {' · '}
            <span className={clsx('font-semibold tabular-nums', TYPE_STYLE[t.type].amount)}>
              {TYPE_STYLE[t.type].sign}{formatMoney(t.amount)}
            </span>
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel>Posting Date</FieldLabel>
            <div className="flex items-center gap-2">
              <DatePicker
                value={date}
                onChange={(ymd) => { setDate(ymd); setDateChanged(false); }}
                disabled={busy}
                className="flex-1 min-w-0"
                aria-label="Posting date"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void onSaveDate()}
                disabled={isPending || date === t.date}
                className="shrink-0"
              >
                {dateChanged ? 'Saved ✓' : 'Update'}
              </Button>
            </div>
          </Field>

          <Field>
            <FieldLabel>Recurring</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={frequency}
              onValueChange={(next) => {
                if (!next) return;
                void onPickRecurring(next as RecurringPick);
              }}
              disabled={busy}
              className="w-full"
            >
              {([
                { value: 'none', label: 'None' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'monthly', label: 'Monthly' },
                { value: 'yearly', label: 'Yearly' },
              ] as const).map((opt) => (
                <ToggleGroupItem key={opt.value} value={opt.value} className="flex-1">
                  {opt.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </FieldGroup>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="destructive"
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 data-icon="inline-start" />
            Delete
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Close
            </Button>
            <Button
              type="button"
              onClick={onEdit}
              disabled={busy || editDisabled}
              title={editDisabled ? 'Categories and accounts must load before editing.' : undefined}
            >
              <Pencil data-icon="inline-start" /> Edit
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
