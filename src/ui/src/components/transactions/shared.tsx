import { ArrowLeftRight, TrendingDown, TrendingUp } from 'lucide-react';
import { CategoryPicker } from '../CategoryPicker';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { TX_TYPES, type TxType } from '../../lib/transaction-filters';
import type { MainCategory } from './types';

/** Visual styling for a transaction type across the page. */
export const TYPE_STYLE: Record<TxType, { label: string; sign: string; amount: string }> = {
  income: {
    label: 'Income',
    sign: '+',
    amount: 'text-emerald-400',
  },
  expense: {
    label: 'Expense',
    sign: '−',
    amount: 'text-rose-400',
  },
  transfer: {
    label: 'Transfer',
    sign: '',
    amount: 'fg-tertiary',
  },
};

/** Leading icon for the mobile list rows — one glyph per type. */
export const TYPE_ICON: Record<TxType, typeof TrendingUp> = {
  income: TrendingUp,
  expense: TrendingDown,
  transfer: ArrowLeftRight,
};

/** Tinted circle behind the mobile row icon (explicit light + dark pairs). */
export const TYPE_ICON_WRAP: Record<TxType, string> = {
  income: 'bg-emerald-900/40 text-emerald-300',
  expense: 'bg-rose-900/40 text-rose-300',
  transfer: 'bg-slate-800 text-slate-300',
};

/** Imports land in Other › Uncategorized until someone files them. */
export function needsCategory(t: { subCategory?: string }): boolean {
  return !t.subCategory || /\buncategorized\b/i.test(t.subCategory);
}

export function TypeSelect({
  value,
  onValueChange,
  disabled,
  size,
  className,
  title,
  'aria-label': ariaLabel,
}: {
  value: TxType;
  onValueChange: (value: TxType) => void;
  disabled?: boolean;
  size?: 'sm' | 'default';
  className?: string;
  title?: string;
  'aria-label'?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as TxType)} disabled={disabled}>
      <SelectTrigger size={size} className={className} aria-label={ariaLabel} title={title}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectGroup>
          {TX_TYPES.map((type) => (
            <SelectItem key={type} value={type}>{TYPE_STYLE[type].label}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function categoryValue(category: string, subCategory?: string): string {
  return category && subCategory ? JSON.stringify({ category, subCategory }) : '';
}

export function parseCategoryValue(value: string): { category: string; subCategory: string } | null {
  try {
    const parsed = JSON.parse(value) as { category?: unknown; subCategory?: unknown };
    return typeof parsed.category === 'string' && typeof parsed.subCategory === 'string'
      ? { category: parsed.category, subCategory: parsed.subCategory }
      : null;
  } catch {
    return null;
  }
}

/**
 * Category field for forms that hold the pick as a JSON string. Renders
 * the shared searchable CategoryPicker over the categories it is given.
 */
export function CategorySelect({
  value,
  onValueChange,
  categories,
  placeholder,
  disabled,
  className,
  allowAny,
  anyLabel = 'Any category',
  title,
  'aria-label': ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  categories: MainCategory[];
  placeholder: string;
  disabled?: boolean;
  className?: string;
  allowAny?: boolean;
  anyLabel?: string;
  title?: string;
  'aria-label'?: string;
}) {
  return (
    <CategoryPicker
      categories={categories}
      value={parseCategoryValue(value)}
      onSelect={(pick) => onValueChange(pick ? JSON.stringify({ category: pick.category, subCategory: pick.subCategory }) : '')}
      anyLabel={allowAny ? anyLabel : undefined}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      title={title}
      aria-label={ariaLabel}
    />
  );
}
