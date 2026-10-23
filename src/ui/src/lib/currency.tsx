/**
 * Display-currency preference. `formatMoney` (in ./format) reads a
 * module-level active currency; this provider keeps that global in sync
 * with the per-user server setting and, because it holds the currency in
 * React state, re-renders the tree whenever it changes so every amount
 * on screen updates immediately.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from './api';
import { getActiveCurrency, setActiveCurrency } from './format';

/** Curated ISO 4217 codes offered in the picker. Kept in sync with the
 *  server whitelist in `src/lib/currency.ts`. */
export const SUPPORTED_CURRENCIES: { code: string; label: string }[] = [
  { code: 'USD', label: 'US Dollar' },
  { code: 'EUR', label: 'Euro' },
  { code: 'GBP', label: 'British Pound' },
  { code: 'CAD', label: 'Canadian Dollar' },
  { code: 'AUD', label: 'Australian Dollar' },
  { code: 'NZD', label: 'New Zealand Dollar' },
  { code: 'JPY', label: 'Japanese Yen' },
  { code: 'CHF', label: 'Swiss Franc' },
  { code: 'CNY', label: 'Chinese Yuan' },
  { code: 'INR', label: 'Indian Rupee' },
  { code: 'BRL', label: 'Brazilian Real' },
  { code: 'MXN', label: 'Mexican Peso' },
  { code: 'ZAR', label: 'South African Rand' },
  { code: 'SEK', label: 'Swedish Krona' },
  { code: 'NOK', label: 'Norwegian Krone' },
  { code: 'DKK', label: 'Danish Krone' },
  { code: 'PLN', label: 'Polish Zloty' },
  { code: 'CZK', label: 'Czech Koruna' },
  { code: 'HUF', label: 'Hungarian Forint' },
  { code: 'SGD', label: 'Singapore Dollar' },
  { code: 'HKD', label: 'Hong Kong Dollar' },
  { code: 'KRW', label: 'South Korean Won' },
  { code: 'TRY', label: 'Turkish Lira' },
  { code: 'AED', label: 'UAE Dirham' },
  { code: 'ILS', label: 'Israeli Shekel' },
];

interface CurrencyContextValue {
  currency: string;
  setCurrency: (code: string) => void;
  saving: boolean;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

export function CurrencyProvider({
  initialCurrency,
  children,
}: {
  initialCurrency: string;
  children: ReactNode;
}) {
  const [currency, setCurrencyState] = useState(() => {
    // Sync the format.ts global to the server value before first paint.
    if (getActiveCurrency() !== initialCurrency) setActiveCurrency(initialCurrency);
    return initialCurrency;
  });

  const save = useMutation({
    mutationFn: (code: string) => api.put<{ currency: string }>('/api/preferences', { currency: code }),
  });

  const setCurrency = (code: string) => {
    if (code === currency) return;
    // Update the global first so this render already formats with the new
    // currency, then bump state to re-render every consumer.
    setActiveCurrency(code);
    setCurrencyState(code);
    save.mutate(code, {
      onError: () => {
        setActiveCurrency(currency);
        setCurrencyState(currency);
        toast.error('Could not save the display currency. Please try again.');
      },
    });
  };

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency, saving: save.isPending }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency must be used within a CurrencyProvider');
  return ctx;
}
