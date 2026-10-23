import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import {
  accountIdsParam,
  activeFilterCount,
  dateRangeFromParams,
  dateRangeLabel,
  filtersFromParams,
  finiteAmountParam,
  hasActiveFilters,
  pageFromParams,
  resolveDatePreset,
  validDateParam,
  type FilterState,
} from '../src/ui/src/lib/transaction-filters';

function emptyFilters(): FilterState {
  return {
    types: new Set(),
    accounts: new Set(),
    categoryPick: '',
    merchant: '',
    minAmount: '',
    maxAmount: '',
  };
}

afterEach(() => {
  setSystemTime();
});

describe('transaction URL filters', () => {
  test('parses canonical filters and legacy amount keys', () => {
    const params = new URLSearchParams({
      types: 'expense,transfer',
      accountIds: '["checking","savings"]',
      category: 'Food',
      subCategory: 'Restaurants',
      merchant: 'Cafe',
      min: '12.50',
      max: '99',
    });

    expect(filtersFromParams(params)).toEqual({
      types: new Set(['expense', 'transfer']),
      accounts: new Set(['checking', 'savings']),
      categoryPick: '{"category":"Food","subCategory":"Restaurants"}',
      merchant: 'Cafe',
      minAmount: '12.50',
      maxAmount: '99',
    });
  });

  test('drops unknown types and malformed or non-finite amounts', () => {
    const filters = filtersFromParams(new URLSearchParams({
      types: 'expense,unknown,,income',
      minAmount: 'Infinity',
      maxAmount: 'not-a-number',
    }));

    expect(filters.types).toEqual(new Set(['expense', 'income']));
    expect(filters.minAmount).toBe('');
    expect(filters.maxAmount).toBe('');
    expect(finiteAmountParam(null)).toBe('');
    expect(finiteAmountParam('')).toBe('');
    expect(finiteAmountParam('-0.25')).toBe('-0.25');
  });

  test('accepts JSON and legacy comma-separated account sets', () => {
    expect(accountIdsParam(null)).toEqual(new Set());
    expect(accountIdsParam('["a","b","a",null,""]')).toEqual(new Set(['a', 'b']));
    expect(accountIdsParam('a, b, ,c')).toEqual(new Set(['a', 'b', 'c']));
    expect(accountIdsParam('{"not":"an array"}')).toEqual(new Set());
  });

  test('validates real ISO calendar dates', () => {
    expect(validDateParam('2026-02-28')).toBe('2026-02-28');
    expect(validDateParam('2026-02-30')).toBe('');
    expect(validDateParam('2026-2-03')).toBe('');
    expect(validDateParam('not-a-date')).toBe('');
    expect(validDateParam(null)).toBe('');
  });

  test('only accepts positive safe integer pages', () => {
    expect(pageFromParams(new URLSearchParams())).toBe(1);
    expect(pageFromParams(new URLSearchParams('page=3'))).toBe(3);
    for (const page of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
      expect(pageFromParams(new URLSearchParams({ page }))).toBe(1);
    }
  });
});

describe('transaction active filters', () => {
  test('treats an empty state and selecting every account as inactive', () => {
    const filters = emptyFilters();
    filters.accounts = new Set(['a', 'b']);

    expect(hasActiveFilters(filters, '   ', 2)).toBe(false);
    expect(activeFilterCount(filters, 2)).toBe(0);
  });

  test('counts dimensions and groups both amount bounds into one filter', () => {
    const filters = emptyFilters();
    filters.types = new Set(['expense']);
    filters.accounts = new Set(['a']);
    filters.categoryPick = '{"category":"Food"}';
    filters.merchant = 'Cafe';
    filters.minAmount = '1';
    filters.maxAmount = '20';

    expect(hasActiveFilters(filters, '', 3)).toBe(true);
    expect(activeFilterCount(filters, 3)).toBe(5);
  });

  test('search activates filtering without affecting the popover count', () => {
    const filters = emptyFilters();
    expect(hasActiveFilters(filters, ' coffee ', 2)).toBe(true);
    expect(activeFilterCount(filters, 2)).toBe(0);
  });
});

describe('transaction date ranges', () => {
  test('resolves rolling, month, and year presets deterministically', () => {
    setSystemTime(new Date('2026-10-23T12:00:00Z'));

    expect(resolveDatePreset('7d')).toEqual({ from: '2026-10-17', to: '2026-10-23' });
    expect(resolveDatePreset('30d')).toEqual({ from: '2026-09-24', to: '2026-10-23' });
    expect(resolveDatePreset('90d')).toEqual({ from: '2026-07-26', to: '2026-10-23' });
    expect(resolveDatePreset('month')).toEqual({ from: '2026-10-01', to: '2026-10-23' });
    expect(resolveDatePreset('ytd')).toEqual({ from: '2026-01-01', to: '2026-10-23' });
  });

  test('recognizes presets and falls back to custom or empty ranges', () => {
    setSystemTime(new Date('2026-10-23T12:00:00Z'));

    expect(dateRangeFromParams(new URLSearchParams('from=2026-10-17&to=2026-10-23'))).toEqual({
      preset: '7d', from: '2026-10-17', to: '2026-10-23',
    });
    expect(dateRangeFromParams(new URLSearchParams('from=2026-09-01&to=2026-09-15'))).toEqual({
      preset: 'custom', from: '2026-09-01', to: '2026-09-15',
    });
    expect(dateRangeFromParams(new URLSearchParams('from=2026-02-30'))).toEqual({
      preset: 'all', from: '', to: '',
    });
  });

  test('labels preset and custom ranges', () => {
    expect(dateRangeLabel({ preset: '30d', from: '2026-09-24', to: '2026-10-23' })).toBe('Last 30 days');
    expect(dateRangeLabel({ preset: 'custom', from: '2026-09-01', to: '2026-09-15' })).toBe('09/01/2026 – 09/15/2026');
    expect(dateRangeLabel({ preset: 'custom', from: '', to: '2026-09-15' })).toBe('Until 09/15/2026');
  });
});
