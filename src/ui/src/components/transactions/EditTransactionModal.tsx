import { useId, useRef, useState } from 'react';
import clsx from 'clsx';
import { Plus, Trash2 } from 'lucide-react';
import { formatMoney } from '../../lib/format';
import type { TxType } from '../../lib/transaction-filters';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { DatePicker } from '../ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Textarea } from '../ui/textarea';
import { CategorySelect, categoryValue, parseCategoryValue, TypeSelect } from './shared';
import type { Account, EditableTransaction, MainCategory, Transaction, TransactionSplit } from './types';

type SplitDraft = Omit<TransactionSplit, 'id' | 'amount'> & { amount: string };

function emptySplit(type: TxType): SplitDraft {
  return { amount: '', category: '', subCategory: '', type };
}

export function EditTransactionModal({
  transaction: t,
  categories,
  accounts,
  isPending,
  error,
  onClose,
  onSubmit,
}: {
  transaction: Transaction;
  categories: MainCategory[];
  accounts: Account[];
  isPending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (parent: EditableTransaction, splits: Omit<TransactionSplit, 'id'>[]) => Promise<void>;
}) {
  const titleId = useId();
  const merchantRef = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(t.date);
  const [merchant, setMerchant] = useState(t.merchant);
  const [amount, setAmount] = useState(String(t.amount));
  const [accountId, setAccountId] = useState(t.accountId ?? accounts.find((account) => account.name === t.account)?.id ?? '');
  const [type, setType] = useState<TxType>(t.type);
  const [categoryPick, setCategoryPick] = useState(categoryValue(t.category, t.subCategory));
  const [notes, setNotes] = useState(t.notes ?? '');
  const [splitEnabled, setSplitEnabled] = useState((t.splits?.length ?? 0) > 0);
  const [splits, setSplits] = useState<SplitDraft[]>(() => {
    const existing = (t.splits ?? []).map((split) => ({
      amount: String(split.amount),
      category: split.category,
      subCategory: split.subCategory,
      type: split.type,
    }));
    while (existing.length < 2) existing.push(emptySplit(t.type));
    return existing;
  });

  const selectedCategory = parseCategoryValue(categoryPick);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const amountNumber = Number(amount);
  const splitTotalCents = splits.reduce((sum, split) => {
    const value = Number(split.amount);
    return sum + (Number.isFinite(value) ? Math.round(value * 100) : 0);
  }, 0);
  const amountCents = Number.isFinite(amountNumber) ? Math.round(amountNumber * 100) : 0;
  const splitFieldsValid = !splitEnabled || splits.every((split) =>
    Number.isFinite(Number(split.amount))
    && Number(split.amount) > 0
    && !!split.category
    && !!split.subCategory,
  );
  const splitTotalValid = !splitEnabled || splitTotalCents === amountCents;
  const canSubmit = !!merchant.trim()
    && !!date
    && !!selectedAccount
    && !!selectedCategory
    && amountNumber > 0
    && Number.isFinite(amountNumber)
    && splitFieldsValid
    && splitTotalValid
    && !isPending;

  const changeSplit = (index: number, patch: Partial<SplitDraft>) => {
    setSplits((current) => current.map((split, i) => i === index ? { ...split, ...patch } : split));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !selectedAccount || !selectedCategory) return;
    await onSubmit({
      date,
      merchant: merchant.trim(),
      amount: amountNumber,
      account: selectedAccount.name,
      accountId: selectedAccount.id,
      type,
      category: selectedCategory.category,
      subCategory: selectedCategory.subCategory,
      ...(notes.trim() ? { notes: notes.trim() } : { notes: '' }),
    }, splitEnabled ? splits.map((split) => ({
      amount: Number(split.amount),
      category: split.category,
      subCategory: split.subCategory,
      type: split.type,
    })) : []);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !isPending) onClose(); }}
    >
      <DialogContent className="sm:max-w-3xl" aria-labelledby={titleId} aria-busy={isPending}>
        <DialogHeader>
          <DialogTitle id={titleId}>Edit transaction</DialogTitle>
          <DialogDescription>Update the posting details and optional split allocations.</DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="edit-tx-merchant">Merchant</FieldLabel>
              <Input ref={merchantRef} id="edit-tx-merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} disabled={isPending} maxLength={255} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-tx-amount">Amount</FieldLabel>
              <Input id="edit-tx-amount" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={isPending} required />
            </Field>
            <Field>
              <FieldLabel>Date</FieldLabel>
              <DatePicker value={date} onChange={setDate} disabled={isPending} aria-label="Transaction date" />
            </Field>
            <Field>
              <FieldLabel>Account</FieldLabel>
              <Select value={accountId || undefined} onValueChange={setAccountId} disabled={isPending}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectGroup>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>{account.alias || account.name}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Type</FieldLabel>
              <TypeSelect
                value={type}
                onValueChange={(next) => { setType(next); setCategoryPick(''); }}
                disabled={isPending}
              />
            </Field>
            <Field>
              <FieldLabel>Category / subcategory</FieldLabel>
              <CategorySelect
                value={categoryPick}
                onValueChange={setCategoryPick}
                categories={categories.filter((category) => category.type === type || category.name === 'Pay down goals')}
                disabled={isPending}
                placeholder="Select category"
              />
            </Field>
          </FieldGroup>

          <Field>
            <FieldLabel htmlFor="edit-tx-notes">Notes</FieldLabel>
            <Textarea id="edit-tx-notes" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={isPending} rows={3} maxLength={2000} />
          </Field>

          <section className="flex flex-col gap-3 border-t border-default pt-4" aria-labelledby={`${titleId}-splits`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 id={`${titleId}-splits`} className="text-sm font-semibold fg-primary">Split allocations</h3>
                <p className="text-xs text-muted-foreground">Allocations must equal the transaction amount exactly.</p>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm fg-secondary">
                <Checkbox checked={splitEnabled} onCheckedChange={(checked) => setSplitEnabled(checked === true)} disabled={isPending} />
                Split transaction
              </label>
            </div>

            {splitEnabled && (
              <div className="flex flex-col gap-3">
                {splits.map((split, index) => {
                  const splitPick = categoryValue(split.category, split.subCategory);
                  return (
                    <FieldSet key={index} className="rounded-lg border border-default p-3">
                      <FieldLegend variant="label">Allocation {index + 1}</FieldLegend>
                      <div className="grid gap-2 sm:grid-cols-[7rem_8rem_1fr_auto]">
                        <Input type="number" min="0.01" step="0.01" value={split.amount} onChange={(e) => changeSplit(index, { amount: e.target.value })} disabled={isPending} placeholder="Amount" aria-label={`Allocation ${index + 1} amount`} />
                        <TypeSelect
                          value={split.type}
                          onValueChange={(next) => changeSplit(index, { type: next, category: '', subCategory: '' })}
                          disabled={isPending}
                          aria-label={`Allocation ${index + 1} type`}
                        />
                        <CategorySelect
                          value={splitPick}
                          onValueChange={(value) => {
                            const picked = parseCategoryValue(value);
                            changeSplit(index, picked ?? { category: '', subCategory: '' });
                          }}
                          categories={categories.filter((category) => category.type === split.type || category.name === 'Pay down goals')}
                          disabled={isPending}
                          placeholder="Select category"
                          aria-label={`Allocation ${index + 1} category`}
                        />
                        <Button type="button" variant="ghost" size="icon" onClick={() => setSplits((current) => current.filter((_, i) => i !== index))} disabled={isPending || splits.length <= 2} aria-label={`Remove allocation ${index + 1}`}>
                          <Trash2 />
                        </Button>
                      </div>
                    </FieldSet>
                  );
                })}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button type="button" variant="link" className="h-auto px-0" onClick={() => setSplits((current) => [...current, emptySplit(type)])} disabled={isPending}>
                    <Plus data-icon="inline-start" /> Add allocation
                  </Button>
                  <p className={clsx('text-sm tabular-nums', splitTotalValid ? 'fg-secondary' : 'text-destructive')} role={!splitTotalValid ? 'alert' : undefined}>
                    Allocated {formatMoney(splitTotalCents / 100)} of {formatMoney(amountCents / 100)}
                  </p>
                </div>
              </div>
            )}
          </section>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={!canSubmit}>
              {isPending ? <Spinner data-icon="inline-start" /> : null}
              {isPending ? 'Saving…' : 'Save transaction'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
