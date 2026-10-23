import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatMoney, todayLocalISO } from '../../lib/format';
import { TX_TYPES, type TxType } from '../../lib/transaction-filters';
import { CategoryPicker } from '../CategoryPicker';
import { Alert, AlertDescription } from '../ui/alert';
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
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from '../ui/drawer';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Textarea } from '../ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { needsCategory, TYPE_STYLE } from './shared';
import type { Account, EditableTransaction, MainCategory, PageResponse } from './types';

/**
 * AddTransactionModal — manual transaction entry.
 *
 * Fields mirror the inline row on the Transactions page: date,
 * merchant, type (3-way pill matching the review carousel), category
 * (hierarchical main + sub), an existing ledger account, and amount.
 * Sub-category picker only appears once a main category is chosen and
 * the selected main has sub-categories.
 *
 * On submit: POST /api/transactions. On error, the server message is
 * shown inline so the user can correct the input. On success, the
 * parent closes the modal; React Query invalidates the page list +
 * reviews + merchants caches.
 *
 * Closes on Escape, overlay click, and the X button.
 */
export function AddTransactionModal({
  categories,
  accounts,
  merchants,
  isDesktop,
  isPending,
  error,
  onClose,
  onSubmit,
}: {
  categories: MainCategory[];
  accounts: Account[];
  merchants: string[];
  isDesktop: boolean;
  isPending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: EditableTransaction) => Promise<void>;
}) {
  const today = todayLocalISO();
  const ids = useId();
  const [date, setDate] = useState(today);
  const [merchant, setMerchant] = useState('');
  const [type, setType] = useState<TxType>('expense');
  const [pick, setPick] = useState<{ category: string; subCategory: string } | null>(null);
  const [suggested, setSuggested] = useState(false);
  const [accountId, setAccountId] = useState(() => (accounts.length === 1 ? accounts[0]!.id : ''));
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);

  // A merchant the user has used before suggests the category (and type)
  // of its most recent transaction, until the user picks one themselves.
  const knownMerchant = merchants.find((m) => m.toLowerCase() === merchant.trim().toLowerCase());
  const lastForMerchant = useQuery({
    queryKey: ['transactions', 'page', 'last-for-merchant', knownMerchant],
    queryFn: () => api.get<PageResponse>(`/api/transactions/page?limit=1&merchant=${encodeURIComponent(knownMerchant!)}`),
    enabled: !!knownMerchant,
    staleTime: 60_000,
  });
  useEffect(() => {
    const last = lastForMerchant.data?.rows[0];
    if (!last || !last.subCategory || needsCategory(last) || (pick && !suggested)) return;
    setType(last.type);
    setPick({ category: last.category, subCategory: last.subCategory });
    setSuggested(true);
    if (!accountId && last.accountId && accounts.some((a) => a.id === last.accountId)) setAccountId(last.accountId);
  }, [lastForMerchant.data, pick, suggested, accountId, accounts]);

  const amt = Number(amount);
  const amountValid = amount !== '' && Number.isFinite(amt) && amt > 0;
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const canSubmit = merchant.trim() !== '' && !!selectedAccount && !!pick && amountValid && !isPending;

  const onSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !pick || !selectedAccount) return;
    await onSubmit({
      date,
      merchant: merchant.trim(),
      category: pick.category,
      subCategory: pick.subCategory,
      account: selectedAccount.name,
      accountId: selectedAccount.id,
      amount: amt,
      type,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
  };

  const submitLabel = isPending
    ? 'Adding…'
    : amountValid
      ? `Add ${formatMoney(amt)} ${TYPE_STYLE[type].label.toLowerCase()}`
      : 'Add transaction';

  const form = (
    <form id={`${ids}-form`} onSubmit={(event) => void onSubmitForm(event)} className="flex flex-col gap-5">
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={type}
        onValueChange={(next) => {
          if (!next || next === type) return;
          setType(next as TxType);
          // Categories belong to a type, so a type change clears the pick.
          setPick(null);
          setSuggested(false);
        }}
        disabled={isPending}
        className="w-full"
        aria-label="Type"
      >
        {TX_TYPES.map((t) => (
          <ToggleGroupItem key={t} value={t} className="flex-1">
            {TYPE_STYLE[t].label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-amount`}>Amount</FieldLabel>
          <InputGroup className="h-14">
            <InputGroupAddon className="text-2xl text-muted-foreground">$</InputGroupAddon>
            <InputGroupInput
              id={`${ids}-amount`}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={isPending}
              placeholder="0.00"
              className="text-3xl font-semibold tabular-nums md:text-3xl"
              autoFocus={isDesktop}
              required
            />
          </InputGroup>
        </Field>

        <Field>
          <FieldLabel htmlFor={`${ids}-merchant`}>Merchant</FieldLabel>
          <Input
            id={`${ids}-merchant`}
            type="text"
            list={`${ids}-merchants`}
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            disabled={isPending}
            placeholder="Where was it?"
            maxLength={255}
            autoComplete="off"
            required
          />
          <datalist id={`${ids}-merchants`}>
            {merchants.map((m) => <option key={m} value={m} />)}
          </datalist>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Date</FieldLabel>
            <DatePicker value={date} onChange={setDate} disabled={isPending} aria-label="Transaction date" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-account`}>Account</FieldLabel>
            <Select value={accountId || undefined} onValueChange={setAccountId} disabled={isPending || accounts.length === 0}>
              <SelectTrigger id={`${ids}-account`} className="w-full">
                <SelectValue placeholder={accounts.length === 0 ? 'No accounts yet' : 'Choose'} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.alias || a.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field>
          <FieldLabel>Category</FieldLabel>
          <CategoryPicker
            categories={categories}
            type={type}
            value={pick}
            onSelect={(next) => {
              if (!next) return;
              setPick({ category: next.category, subCategory: next.subCategory });
              setSuggested(false);
            }}
            disabled={isPending}
            aria-label="Category"
          />
          {suggested && knownMerchant && (
            <FieldDescription>Suggested from your last {knownMerchant} transaction.</FieldDescription>
          )}
        </Field>

        {notesOpen ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-notes`}>Note</FieldLabel>
            <Textarea
              id={`${ids}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isPending}
              rows={2}
              maxLength={2000}
              autoFocus
            />
          </Field>
        ) : (
          <Button type="button" variant="link" className="h-auto self-start px-0" onClick={() => setNotesOpen(true)}>
            Add a note
          </Button>
        )}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </FieldGroup>
    </form>
  );

  const actions = (
    <>
      <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
        Cancel
      </Button>
      <Button type="submit" form={`${ids}-form`} disabled={!canSubmit}>
        {isPending && <Spinner data-icon="inline-start" />}
        {submitLabel}
      </Button>
    </>
  );

  if (!isDesktop) {
    return (
      <Drawer open onOpenChange={(open) => { if (!open && !isPending) onClose(); }}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Add transaction</DrawerTitle>
          </DrawerHeader>
          <div className="overflow-y-auto px-4 pb-2">{form}</div>
          <DrawerFooter className="flex-col-reverse">{actions}</DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isPending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add transaction</DialogTitle>
          <DialogDescription className="sr-only">Enter the amount, merchant, date, account and category.</DialogDescription>
        </DialogHeader>
        {form}
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
