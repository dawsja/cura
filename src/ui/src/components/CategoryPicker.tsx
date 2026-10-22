import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type PickerTxType = 'income' | 'expense' | 'transfer';

export interface PickerCategory {
  id: string;
  name: string;
  type: PickerTxType;
  subCategories: { id: string; name: string }[];
}

export interface CategoryPick {
  type: PickerTxType;
  category: string;
  subCategory: string;
}

// Goal paydown categories hold payments toward debts and savings goals, so
// they are offered whichever type the transaction has.
export const PAYDOWN_CATEGORY = 'Pay down goals';

const TYPE_LABEL: Record<PickerTxType, string> = {
  expense: 'Expense',
  income: 'Income',
  transfer: 'Transfer',
};

export function categoriesForType(categories: PickerCategory[], type: PickerTxType): PickerCategory[] {
  return categories.filter((c) => c.type === type || c.name === PAYDOWN_CATEGORY);
}

// cmdk's default fuzzy match lets "gro" hit "Gifts & Donations" before
// Groceries. Match on substrings instead, ranking subcategory-name prefixes first.
function filterCategories(value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase();
  if (!query) return 1;
  const [name = value, ...rest] = (keywords ?? [value]).map((k) => k.toLowerCase());
  if (name.startsWith(query)) return 1;
  if (name.split(/[\s&/-]+/).some((word) => word.startsWith(query))) return 0.8;
  if (name.includes(query)) return 0.6;
  return rest.some((k) => k.includes(query)) ? 0.3 : 0;
}

export function pickLabel(pick: Pick<CategoryPick, 'category' | 'subCategory'> | null | undefined): string {
  if (!pick?.category) return '';
  return pick.subCategory || pick.category;
}

/**
 * Searchable category picker: a Popover holding a Command list grouped by
 * parent category. With `showTypeTabs`, the list is preceded by an
 * Expense/Income/Transfer switch, because type and category are always
 * saved together — picking an Income category makes the transaction income.
 */
export function CategoryPicker({
  categories,
  value,
  type,
  onSelect,
  showTypeTabs = false,
  suggestions = [],
  anyLabel,
  placeholder = 'Choose a category',
  disabled,
  align = 'start',
  className,
  title,
  children,
  'aria-label': ariaLabel,
}: {
  categories: PickerCategory[];
  /** Current selection; `null` shows the placeholder (or `anyLabel`). */
  value: Pick<CategoryPick, 'category' | 'subCategory'> | null;
  /** Type whose categories are listed; with tabs, the starting tab. Omit to list every type. */
  type?: PickerTxType;
  /** Called with `null` only when `anyLabel` is set and that option is picked. */
  onSelect: (pick: CategoryPick | null) => void;
  showTypeTabs?: boolean;
  /** Most-used categories, listed first. */
  suggestions?: Pick<CategoryPick, 'category' | 'subCategory'>[];
  /** Adds a first option that clears the selection, for filters. */
  anyLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  className?: string;
  title?: string;
  /** Custom trigger; rendered with `asChild`. Defaults to a field-style button. */
  children?: ReactNode;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PickerTxType>(type ?? 'expense');
  const listType = showTypeTabs ? tab : type;
  const visible = listType ? categoriesForType(categories, listType) : categories;
  const visibleKeys = new Set(visible.flatMap((c) => c.subCategories.map((s) => `${c.name}\u0000${s.name}`)));
  const shownSuggestions = suggestions.filter((s) => visibleKeys.has(`${s.category}\u0000${s.subCategory}`));
  const isSelected = (category: string, subCategory: string) =>
    !!value && value.category === category && value.subCategory === subCategory;

  const choose = (category: PickerCategory | undefined, categoryName: string, subCategory: string) => {
    // Paydown categories are listed under every type, so the listed type wins.
    onSelect({ type: listType ?? category?.type ?? 'expense', category: categoryName, subCategory });
    setOpen(false);
  };
  const parentOf = (name: string) => visible.find((c) => c.name === name);
  const label = pickLabel(value) || anyLabel || '';

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setTab(type ?? 'expense');
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        {children ?? (
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={ariaLabel}
            title={title}
            className={cn('w-full justify-between bg-inset font-normal', !label && 'text-muted-foreground', className)}
          >
            <span className="truncate">{label || placeholder}</span>
            <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        // The field-style trigger gets a list as wide as itself.
        className={cn('w-80 gap-0 p-0', !children && 'w-(--radix-popover-trigger-width) min-w-72')}
      >
        <Command filter={filterCategories}>
          {showTypeTabs && (
            <div className="p-1 pb-0">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={tab}
                onValueChange={(next) => { if (next) setTab(next as PickerTxType); }}
                className="w-full"
                aria-label="Transaction type"
              >
                {(Object.keys(TYPE_LABEL) as PickerTxType[]).map((t) => (
                  <ToggleGroupItem key={t} value={t} className="flex-1">
                    {TYPE_LABEL[t]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          )}
          <CommandInput placeholder="Search categories" />
          <CommandList>
            <CommandEmpty>No category matches.</CommandEmpty>
            {anyLabel && (
              <CommandGroup>
                <CommandItem
                  value={anyLabel}
                  keywords={[anyLabel]}
                  data-checked={!value}
                  onSelect={() => { onSelect(null); setOpen(false); }}
                >
                  {anyLabel}
                </CommandItem>
              </CommandGroup>
            )}
            {shownSuggestions.length > 0 && (
              <>
                <CommandGroup heading="Used most">
                  {shownSuggestions.map((s) => (
                    <CommandItem
                      key={`used-${s.category}-${s.subCategory}`}
                      value={`used ${s.category} ${s.subCategory}`}
                      keywords={[s.subCategory, s.category]}
                      data-checked={isSelected(s.category, s.subCategory)}
                      onSelect={() => choose(parentOf(s.category), s.category, s.subCategory)}
                    >
                      {s.subCategory}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {visible.map((c) => (
              <CommandGroup key={c.id} heading={c.name}>
                {c.subCategories.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`${c.name} ${s.name} ${s.id}`}
                    keywords={[s.name, c.name]}
                    data-checked={isSelected(c.name, s.name)}
                    onSelect={() => choose(c, c.name, s.name)}
                  >
                    {s.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
