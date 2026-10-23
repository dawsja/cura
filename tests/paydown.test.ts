import { describe, expect, test } from 'bun:test';
import { centsToDollars, dollarsToCents } from '@/lib/money';
import { firstMonthPaydownPayments, projectPaydown, type PaydownAccount } from '@/lib/paydown';

describe('money conversion', () => {
  test('round-trips exact cents and accepts string input', () => {
    expect(dollarsToCents(0.1)).toBe(10);
    expect(dollarsToCents('12.34')).toBe(1_234);
    expect(dollarsToCents('-0.05')).toBe(-5);
    expect(centsToDollars(1_234)).toBe(12.34);
  });

  test('rejects fractional cents and unsafe amounts', () => {
    expect(() => dollarsToCents(0.001)).toThrow('at most 2 decimal places');
    expect(() => dollarsToCents('1.234')).toThrow('at most 2 decimal places');
    expect(() => centsToDollars(Number.MAX_SAFE_INTEGER + 1)).toThrow('supported range');
  });
});

const account = (overrides: Partial<PaydownAccount>): PaydownAccount => ({
  id: 'debt',
  name: 'Debt',
  type: 'credit',
  balance: 1_000,
  apr: 0,
  minPayment: 100,
  plannedPayment: 0,
  includeInPaydown: true,
  ...overrides,
});

describe('paydown projections', () => {
  test('caps the final payment and reports a deterministic payoff month', () => {
    const result = projectPaydown(
      [account({ balance: 250, minPayment: 100 })],
      { method: 'planned', monthlyExtra: 0, oneTimeExtra: 0 },
      new Date('2026-01-15T12:00:00Z'),
    );

    expect(result.monthsToDebtFree).toBe(3);
    expect(result.debtFreeMonth).toBe('2026-03');
    expect(result.totalPaid).toBe(250);
    expect(result.totalInterest).toBe(0);
    expect(result.timeline.at(-1)?.totalDebt).toBe(0);
  });

  test('avalanche targets the highest APR and snowball the smallest balance', () => {
    const accounts = [
      account({ id: 'high', name: 'High APR', balance: 1_000, apr: 0.12, minPayment: 50 }),
      account({ id: 'small', name: 'Small', balance: 500, apr: 0, minPayment: 50 }),
    ];
    const avalanche = firstMonthPaydownPayments(accounts, {
      method: 'avalanche',
      monthlyExtra: 100,
      oneTimeExtra: 0,
    });
    const snowball = firstMonthPaydownPayments(accounts, {
      method: 'snowball',
      monthlyExtra: 100,
      oneTimeExtra: 0,
    });

    expect(avalanche).toEqual({ high: 150, small: 50 });
    expect(snowball).toEqual({ high: 50, small: 150 });
  });

  test('cascades a one-time extra and reports non-amortizing debt', () => {
    const accounts = [
      account({ id: 'first', balance: 100, minPayment: 25 }),
      account({ id: 'second', balance: 500, minPayment: 25 }),
    ];
    const firstMonth = firstMonthPaydownPayments(accounts, {
      method: 'snowball',
      monthlyExtra: 0,
      oneTimeExtra: 150,
    });
    expect(firstMonth.first).toBe(100);
    expect(firstMonth.second).toBe(100);

    const stuck = projectPaydown(
      [account({ balance: 1_000, apr: 0.12, minPayment: 5 })],
      { method: 'planned', monthlyExtra: 0, oneTimeExtra: 0 },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(stuck.nonAmortizingIds).toEqual(['debt']);
    expect(stuck.monthsToDebtFree).toBeNull();
    expect(stuck.debtFreeMonth).toBeNull();
  });
});
