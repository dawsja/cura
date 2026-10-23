import { useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { CategoryPicker, PAYDOWN_CATEGORY } from './CategoryPicker';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from './ui/field';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Spinner } from './ui/spinner';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

/**
 * Reusable form modal for creating or editing a categorization rule.
 *
 * Used from two places:
 *   1. The Transactions page popup CTA — opened with a pre-filled
 *      merchant and a default category/sub-category the user just set.
 *   2. The Rules page "Add rule" button — opened empty.
 *
 * The modal owns no network state; the parent wires `onSave` to a
 * useMutation that POSTs or PATCHes `/api/rules` and closes the modal
 * on success.
 */

export interface RuleFormCategory {
  id: string;
  name: string;
  type: RuleFormTxType;
  subCategories: { id: string; name: string }[];
}

export interface RuleFormAccount {
  id: string;
  name: string;
}

export type RuleFormTxType = 'income' | 'expense' | 'transfer';

export interface RuleFormInitial {
  merchant: string;
  accountId?: string;
  sourceType?: RuleFormTxType;
  sourceCategory?: string;
  sourceSubCategory?: string;
  category: string;
  subCategory?: string;
  type?: RuleFormTxType;
}

export interface RuleFormSubmit {
  matchValue: string;
  accountId?: string;
  sourceType?: RuleFormTxType;
  sourceCategory?: string;
  sourceSubCategory?: string;
  category: string;
  subCategory: string;
  type?: RuleFormTxType;
}

const ANY = '__any__';
const TYPE_OPTIONS: { value: RuleFormTxType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
];

export function RuleFormModal({
  mode,
  initial,
  categories,
  accounts,
  onSave,
  onClose,
}: {
  mode: 'create' | 'edit';
  initial?: RuleFormInitial;
  categories: RuleFormCategory[];
  accounts: RuleFormAccount[];
  onSave: (input: RuleFormSubmit) => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const [merchant, setMerchant] = useState(initial?.merchant ?? '');
  const [accountId, setAccountId] = useState(initial?.accountId ?? '');
  const [sourceType, setSourceType] = useState<RuleFormTxType | ''>(initial?.sourceType ?? '');
  const [sourceCategory, setSourceCategory] = useState(initial?.sourceCategory ?? '');
  const [sourceSubCategory, setSourceSubCategory] = useState(initial?.sourceSubCategory ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [subCategory, setSubCategory] = useState(initial?.subCategory ?? '');
  const [type, setType] = useState<RuleFormTxType | ''>(initial?.type ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmed = merchant.trim();
  const categoryPick = category && subCategory ? { category, subCategory } : null;
  const targetExists = categories.some((candidate) =>
    candidate.name === category
    && candidate.subCategories.some((sub) => sub.name === subCategory)
    && (!type || candidate.type === type || candidate.name === 'Pay down goals'),
  );
  const sourceExistsInTree = categories.some((candidate) =>
      candidate.name === sourceCategory
      && candidate.subCategories.some((sub) => sub.name === sourceSubCategory)
      && (!sourceType || candidate.type === sourceType || candidate.name === 'Pay down goals'));
  const unchangedHistoricalSource = initial?.sourceCategory === sourceCategory
    && initial?.sourceSubCategory === sourceSubCategory
    && initial?.sourceType === (sourceType || undefined);
  const sourceExists = !sourceCategory || sourceExistsInTree || unchangedHistoricalSource;
  const accountExists = !accountId || accounts.some((account) => account.id === accountId);
  const preservesLegacyPaydownType = mode === 'edit'
    && initial?.category === 'Pay down goals'
    && initial.type === undefined
    && category === 'Pay down goals'
    && !type;
  const canSave = trimmed.length > 0
    && (!!type || preservesLegacyPaydownType)
    && targetExists
    && sourceExists
    && accountExists
    && !submitting;

  const applySourceType = (next: RuleFormTxType | '') => {
    setSourceType(next);
    const selectedCategory = categories.find((candidate) => candidate.name === sourceCategory);
    if (next && selectedCategory && selectedCategory.type !== next && selectedCategory.name !== 'Pay down goals') {
      setSourceCategory('');
      setSourceSubCategory('');
    }
  };

  const applyType = (next: RuleFormTxType | '') => {
    setType(next);
    const selectedCategory = categories.find((candidate) => candidate.name === category);
    if (next && selectedCategory && selectedCategory.type !== next && selectedCategory.name !== 'Pay down goals') {
      setCategory('');
      setSubCategory('');
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSubmitting(true);
    setErr(null);
    try {
      await onSave({
        matchValue: trimmed,
        accountId: accountId || undefined,
        sourceType: sourceType || undefined,
        sourceCategory: sourceCategory || undefined,
        sourceSubCategory: sourceSubCategory || undefined,
        category,
        subCategory,
        type: type || undefined,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'unknown';
      setErr(message);
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Create rule' : 'Edit rule'}</DialogTitle>
          <DialogDescription>
            Choose which transactions this rule matches and how to file them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-6">
          <FieldGroup className="gap-6">
            <FieldSet>
              <FieldLegend>Match</FieldLegend>
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="rule-merchant">Merchant</FieldLabel>
                  <Input
                    id="rule-merchant"
                    type="text"
                    value={merchant}
                    onChange={(e) => setMerchant(e.target.value)}
                    placeholder="e.g. Whole Foods Market"
                    maxLength={255}
                    autoFocus
                  />
                  <FieldDescription>
                    Case-insensitive. Matches this merchant exactly, or when the payee
                    starts with this text (e.g. &quot;Starbucks&quot; matches &quot;STARBUCKS #1234&quot;).
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="rule-account">
                    Account <span className="font-normal text-muted-foreground">(optional)</span>
                  </FieldLabel>
                  <Select
                    value={accountId || ANY}
                    onValueChange={(value) => setAccountId(value === ANY ? '' : value)}
                  >
                    <SelectTrigger id="rule-account" className="w-full">
                      <SelectValue placeholder="Any account" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={ANY}>Any account</SelectItem>
                        {accounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

                <Field>
                  <FieldLabel>
                    Original type <span className="font-normal text-muted-foreground">(optional)</span>
                  </FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={sourceType || ANY}
                    onValueChange={(next) => {
                      if (!next) return;
                      applySourceType(next === ANY ? '' : next as RuleFormTxType);
                    }}
                    className="w-full"
                    aria-label="Original type"
                  >
                    <ToggleGroupItem value={ANY} className="flex-1">Any</ToggleGroupItem>
                    {TYPE_OPTIONS.map((option) => (
                      <ToggleGroupItem key={option.value} value={option.value} className="flex-1">
                        {option.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>

                <Field>
                  <FieldLabel>
                    Original category <span className="font-normal text-muted-foreground">(optional)</span>
                  </FieldLabel>
                  <CategoryPicker
                    categories={categories}
                    type={sourceType || undefined}
                    value={sourceCategory ? { category: sourceCategory, subCategory: sourceSubCategory } : null}
                    anyLabel="Any category"
                    aria-label="Original category"
                    onSelect={(pick) => {
                      // The original type is its own condition, so picking a
                      // category never changes it.
                      setSourceCategory(pick?.category ?? '');
                      setSourceSubCategory(pick?.subCategory ?? '');
                    }}
                  />
                  {sourceCategory && !sourceExistsInTree ? (
                    <FieldDescription>
                      {unchangedHistoricalSource
                        ? `${sourceCategory}, ${sourceSubCategory} is no longer in your categories. The rule keeps matching it until you pick another.`
                        : `${sourceCategory}, ${sourceSubCategory} isn't one of your categories for this type. Pick another category.`}
                    </FieldDescription>
                  ) : null}
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSeparator />

            <FieldSet>
              <FieldLegend>File as</FieldLegend>
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel>Type</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={type || undefined}
                    onValueChange={(next) => {
                      if (!next && preservesLegacyPaydownType) {
                        applyType('');
                        return;
                      }
                      if (!next) return;
                      applyType(next as RuleFormTxType);
                    }}
                    className="w-full"
                    aria-label="Type"
                  >
                    {TYPE_OPTIONS.map((option) => (
                      <ToggleGroupItem key={option.value} value={option.value} className="flex-1">
                        {option.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  {preservesLegacyPaydownType && !type ? (
                    <FieldDescription>Leave type unchanged (legacy rule)</FieldDescription>
                  ) : null}
                </Field>

                <Field>
                  <FieldLabel>Category</FieldLabel>
                  <CategoryPicker
                    categories={categories}
                    type={type || undefined}
                    value={categoryPick}
                    placeholder="Choose a category"
                    aria-label="Category"
                    onSelect={(pick) => {
                      if (!pick) return;
                      setCategory(pick.category);
                      setSubCategory(pick.subCategory);
                      // With no type chosen yet, take it from the category. Goal
                      // paydown categories fit any type, so they leave it alone.
                      if (!type && pick.category !== PAYDOWN_CATEGORY) setType(pick.type);
                    }}
                  />
                </Field>
              </FieldGroup>
            </FieldSet>

            {err ? (
              <Alert variant="destructive">
                <AlertDescription>{err}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => !submitting && onClose()}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {submitting ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              {submitting ? 'Saving…' : mode === 'create' ? 'Create rule' : 'Save rule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
