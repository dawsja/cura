import { Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { formatDate, formatMoney } from '../../lib/format';
import { Button } from '../ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '../ui/drawer';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field';
import { CategorySelect, TYPE_STYLE, TypeSelect } from './shared';
import type { MainCategory, Transaction, TxType } from './types';

/**
 * TransactionDetailModal — mobile-only bottom sheet showing full details
 * of a tapped transaction. Renders date, merchant, type, category,
 * account, amount, and notes in a readable card layout. Includes a
 * delete action so the user doesn't lose that capability on mobile.
 */
export function TransactionDetailModal({
  transaction: t,
  categories,
  isPending,
  onClose,
  onChangeType,
  onChangeCategory,
  onActions,
  onDelete,
}: {
  transaction: Transaction;
  categories: MainCategory[];
  isPending: boolean;
  onClose: () => void;
  onChangeType: (type: TxType) => void;
  onChangeCategory: (value: string) => void;
  onActions: () => void;
  onDelete: (id: string) => void;
}) {
  const rowCats = categories.filter((c) => c.type === t.type || c.name === 'Pay down goals');
  const categoryValue = (() => {
    const category = rowCats.find((c) => c.name === t.category);
    if (!category || !t.subCategory || !category.subCategories.some((s) => s.name === t.subCategory)) return '';
    return JSON.stringify({ category: category.name, subCategory: t.subCategory });
  })();

  return (
    <Drawer
      open
      onOpenChange={(open) => { if (!open && !isPending) onClose(); }}
    >
      <DrawerContent>
        <DrawerHeader className="text-left">
          <DrawerTitle className="truncate">{t.merchant}</DrawerTitle>
          <DrawerDescription asChild>
            <p className={clsx('text-base font-semibold tabular-nums', TYPE_STYLE[t.type].amount)}>
              {TYPE_STYLE[t.type].sign}{formatMoney(t.amount)}
            </p>
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4">
        <dl className="flex flex-col gap-3 text-sm">
          <div className="flex justify-between">
            <dt className="fg-tertiary">Date</dt>
            <dd className="fg-primary font-medium">{formatDate(t.date)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="fg-tertiary">Account</dt>
            <dd className="fg-primary font-medium">{t.account}</dd>
          </div>
          {!!t.splits?.length && (
            <div className="flex flex-col gap-2 border-t border-default pt-3">
              <dt className="fg-tertiary">Split allocations</dt>
              {t.splits.map((split, index) => (
                <dd key={split.id || index} className="flex items-start justify-between gap-3 pl-3 text-xs">
                  <span className="fg-primary">{split.category} › {split.subCategory} <span className="fg-muted">({TYPE_STYLE[split.type].label})</span></span>
                  <span className={clsx('shrink-0 font-semibold tabular-nums', TYPE_STYLE[split.type].amount)}>
                    {TYPE_STYLE[split.type].sign}{formatMoney(split.amount)}
                  </span>
                </dd>
              ))}
            </div>
          )}
          {t.notes && (
            <div className="flex justify-between">
              <dt className="fg-tertiary">Notes</dt>
              <dd className="max-w-[60%] text-right font-medium fg-primary">{t.notes}</dd>
            </div>
          )}
        </dl>

        <FieldGroup className="gap-3 border-t border-default pt-5">
          <Field>
            <FieldLabel>Type</FieldLabel>
            <TypeSelect
              value={t.type}
              disabled={isPending || !!t.splits?.length}
              onValueChange={onChangeType}
            />
          </Field>
          <Field>
            <FieldLabel>Category</FieldLabel>
            <CategorySelect
              value={categoryValue}
              disabled={isPending || !!t.splits?.length}
              onValueChange={onChangeCategory}
              categories={rowCats}
              placeholder="Select category"
            />
          </Field>
          {!!t.splits?.length && (
            <FieldDescription>This is a split transaction. Use More actions, then Edit transaction, to change its type or allocations.</FieldDescription>
          )}
        </FieldGroup>
        </div>

        <DrawerFooter>
          <Button type="button" onClick={onActions} disabled={isPending}>
            More actions
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => onDelete(t.id)}
            disabled={isPending}
          >
            <Trash2 data-icon="inline-start" />
            Delete
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
