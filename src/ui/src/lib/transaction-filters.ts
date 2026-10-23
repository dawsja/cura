import { formatDate, parseLocalDate, todayLocalISO, toLocalISODate } from './format';

/** Date-range toolbar presets. `custom` is set when the user edits from/to. */
export type DatePreset = 'all' | '7d' | '30d' | '90d' | 'month' | 'ytd' | 'custom';

export interface DateRangeState {
  preset: DatePreset;
  from: string; // YYYY-MM-DD or ''
  to: string;
}

export const EMPTY_DATE_RANGE: DateRangeState = { preset: 'all', from: '', to: '' };

export function resolveDatePreset(preset: Exclude<DatePreset, 'all' | 'custom'>): { from: string; to: string } {
  const to = todayLocalISO();
  const today = parseLocalDate(to);
  if (preset === '7d' || preset === '30d' || preset === '90d') {
    const days = preset === '7d' ? 6 : preset === '30d' ? 29 : 89;
    const from = new Date(today);
    from.setDate(from.getDate() - days);
    return { from: toLocalISODate(from), to };
  }
  if (preset === 'month') {
    return { from: toLocalISODate(new Date(today.getFullYear(), today.getMonth(), 1)), to };
  }
  // ytd
  return { from: toLocalISODate(new Date(today.getFullYear(), 0, 1)), to };
}

export function dateRangeLabel(r: DateRangeState): string {
  if (r.preset === 'all' || (!r.from && !r.to)) return 'All dates';
  if (r.preset === '7d') return 'Last 7 days';
  if (r.preset === '30d') return 'Last 30 days';
  if (r.preset === '90d') return 'Last 90 days';
  if (r.preset === 'month') return 'This month';
  if (r.preset === 'ytd') return 'Year to date';
  if (r.from && r.to) return `${formatDate(r.from)} – ${formatDate(r.to)}`;
  if (r.from) return `From ${formatDate(r.from)}`;
  if (r.to) return `Until ${formatDate(r.to)}`;
  return 'Custom';
}

export type TxType = 'income' | 'expense' | 'transfer';
export const TX_TYPES: TxType[] = ['income', 'expense', 'transfer'];

/**
 * Filter state held by the Transactions page. Each field is `undefined`
 * (or empty / an empty Set) when the corresponding dimension has no
 * active filter — there's no "match nothing" mode; absence = no filter.
 */
export interface FilterState {
  types: Set<TxType>;
  accounts: Set<string>;
  categoryPick: string;
  merchant: string;
  minAmount: string;
  maxAmount: string;
}

export function validDateParam(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = parseLocalDate(value);
  return !Number.isNaN(parsed.getTime()) && toLocalISODate(parsed) === value ? value : '';
}

export function accountIdsParam(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === 'string' && id !== ''));
  } catch {
    return new Set(value.split(',').map((id) => id.trim()).filter(Boolean));
  }
  return new Set();
}

export function finiteAmountParam(value: string | null): string {
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? value : '';
}

export function filtersFromParams(params: URLSearchParams): FilterState {
  const rawTypes = (params.get('types') ?? '').split(',');
  const types = new Set(rawTypes.filter((type): type is TxType => TX_TYPES.includes(type as TxType)));
  const category = params.get('category') ?? '';
  const subCategory = params.get('subCategory') ?? '';
  return {
    types,
    accounts: accountIdsParam(params.get('accountIds')),
    categoryPick: category ? JSON.stringify({ category, ...(subCategory ? { subCategory } : {}) }) : '',
    merchant: params.get('merchant') ?? '',
    minAmount: finiteAmountParam(params.get('minAmount') ?? params.get('min')),
    maxAmount: finiteAmountParam(params.get('maxAmount') ?? params.get('max')),
  };
}

export function dateRangeFromParams(params: URLSearchParams): DateRangeState {
  const from = validDateParam(params.get('from'));
  const to = validDateParam(params.get('to'));
  if (!from && !to) return EMPTY_DATE_RANGE;
  for (const preset of ['7d', '30d', '90d', 'month', 'ytd'] as const) {
    const resolved = resolveDatePreset(preset);
    if (from === resolved.from && to === resolved.to) return { preset, from, to };
  }
  return { preset: 'custom', from, to };
}

export function pageFromParams(params: URLSearchParams): number {
  const value = Number(params.get('page'));
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function hasActiveFilters(f: FilterState, q: string, accountCount: number): boolean {
  return f.types.size > 0
    || (f.accounts.size > 0 && f.accounts.size < accountCount)
    || f.categoryPick !== ''
    || f.merchant !== ''
    || f.minAmount !== ''
    || f.maxAmount !== ''
    || q.trim() !== '';
}

export function activeFilterCount(f: FilterState, accountCount: number): number {
  let n = 0;
  if (f.types.size > 0) n++;
  if (f.accounts.size > 0 && f.accounts.size < accountCount) n++;
  if (f.categoryPick) n++;
  if (f.merchant) n++;
  if (f.minAmount || f.maxAmount) n++;
  return n;
}
