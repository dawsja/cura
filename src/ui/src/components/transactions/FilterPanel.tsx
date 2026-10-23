import { useEffect, useId, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { CategoryPicker } from '../CategoryPicker';
import { Checkbox } from '../ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { TX_TYPES, type FilterState, type TxType } from '../../lib/transaction-filters';
import { MerchantPicker } from './MerchantPicker';
import { TYPE_STYLE } from './shared';
import type { Account, MainCategory } from './types';

/**
 * Filter controls. Owns no state of its own — reads / writes the parent's
 * `filters` state and applies every change immediately (no "Apply" button).
 */
export function FilterPanel({
  filters,
  setFilters,
  accounts,
  categories,
  merchants,
}: {
  filters: FilterState;
  setFilters: Dispatch<SetStateAction<FilterState>>;
  accounts: Account[];
  categories: MainCategory[];
  merchants: string[];
}) {
  // Local string state for amount inputs — lets the user type partial
  // values like "1." without the parent re-running the query on every
  // keystroke. Valid numbers are mirrored into the parent state.
  const [minStr, setMinStr] = useState(filters.minAmount);
  const [maxStr, setMaxStr] = useState(filters.maxAmount);
  const idPrefix = useId();

  // Keep local amount state in sync when the parent resets (e.g.
  // "Clear all" pressed while the panel is still open).
  useEffect(() => { setMinStr(filters.minAmount); }, [filters.minAmount]);
  useEffect(() => { setMaxStr(filters.maxAmount); }, [filters.maxAmount]);

  const onAmountChange = (key: 'minAmount' | 'maxAmount', v: string) => {
    (key === 'minAmount' ? setMinStr : setMaxStr)(v);
    if (v === '' || Number.isFinite(Number(v))) setFilters((prev) => ({ ...prev, [key]: v }));
  };

  let categoryValue: { category: string; subCategory: string } | null = null;
  try {
    if (filters.categoryPick) {
      const parsed = JSON.parse(filters.categoryPick) as { category?: string; subCategory?: string };
      if (parsed.category) categoryValue = { category: parsed.category, subCategory: parsed.subCategory ?? '' };
    }
  } catch { /* malformed selections show as "Any category" */ }

  return (
    <>
      <FieldSet>
        <FieldLegend variant="label">Type</FieldLegend>
        <ToggleGroup
          type="multiple"
          variant="outline"
          value={Array.from(filters.types)}
          onValueChange={(values) => setFilters((prev) => ({ ...prev, types: new Set(values as TxType[]) }))}
          className="w-full"
          aria-label="Transaction types"
        >
          {TX_TYPES.map((t) => (
            <ToggleGroupItem key={t} value={t} className="flex-1">
              {TYPE_STYLE[t].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">Account</FieldLegend>
        {accounts.length === 0 ? (
          <FieldDescription>No accounts yet.</FieldDescription>
        ) : (
          <FieldGroup className="gap-2.5">
            {accounts.map((a) => {
              const id = `${idPrefix}-account-${a.id}`;
              return (
                <Field key={a.id} orientation="horizontal">
                  <Checkbox
                    id={id}
                    checked={filters.accounts.has(a.id)}
                    onCheckedChange={() => {
                      setFilters((prev) => {
                        const next = new Set(prev.accounts);
                        if (next.has(a.id)) next.delete(a.id);
                        else next.add(a.id);
                        return { ...prev, accounts: next };
                      });
                    }}
                  />
                  <FieldLabel htmlFor={id} className="font-normal">{a.alias || a.name}</FieldLabel>
                </Field>
              );
            })}
          </FieldGroup>
        )}
      </FieldSet>

      <Field>
        <FieldLabel>Category</FieldLabel>
        <CategoryPicker
          categories={categories}
          value={categoryValue}
          anyLabel="Any category"
          onSelect={(pick) => setFilters((prev) => ({
            ...prev,
            categoryPick: pick ? JSON.stringify({ category: pick.category, subCategory: pick.subCategory }) : '',
          }))}
          aria-label="Category filter"
        />
      </Field>

      <Field>
        <FieldLabel>Merchant</FieldLabel>
        <MerchantPicker
          merchants={merchants}
          value={filters.merchant}
          onChange={(merchant) => setFilters((prev) => ({ ...prev, merchant }))}
        />
      </Field>

      <FieldSet>
        <FieldLegend variant="label">Amount</FieldLegend>
        <FieldGroup className="grid grid-cols-2 gap-2">
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-min`} className="font-normal text-muted-foreground">At least</FieldLabel>
            <InputGroup>
              <InputGroupAddon>$</InputGroupAddon>
              <InputGroupInput id={`${idPrefix}-min`} type="number" step="0.01" min="0" inputMode="decimal" value={minStr} onChange={(e) => onAmountChange('minAmount', e.target.value)} placeholder="0" />
            </InputGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-max`} className="font-normal text-muted-foreground">At most</FieldLabel>
            <InputGroup>
              <InputGroupAddon>$</InputGroupAddon>
              <InputGroupInput id={`${idPrefix}-max`} type="number" step="0.01" min="0" inputMode="decimal" value={maxStr} onChange={(e) => onAmountChange('maxAmount', e.target.value)} placeholder="Any" />
            </InputGroup>
          </Field>
        </FieldGroup>
      </FieldSet>
    </>
  );
}
