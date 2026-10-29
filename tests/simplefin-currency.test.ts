import { describe, expect, test } from 'bun:test';
import { unsupportedSimpleFinCurrencies } from '@/lib/simplefin';

describe('unsupportedSimpleFinCurrencies', () => {
  test('treats missing or blank currency as USD', () => {
    expect(unsupportedSimpleFinCurrencies([{}, { currency: '' }, { currency: '  ' }, { currency: ' usd ' }])).toEqual([]);
  });

  test('reports each explicit non-USD currency once', () => {
    expect(unsupportedSimpleFinCurrencies([
      { currency: 'USD' },
      { currency: 'eur' },
      { currency: 'CAD' },
      { currency: 'EUR' },
    ])).toEqual(['EUR', 'CAD']);
  });
});
