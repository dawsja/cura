import { useState, useEffect, useRef, useMemo, useId, Fragment } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Search, ArrowUpRight, Filter, BellRing, Plus, MoreVertical, Calendar,
  ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight, ChevronDown, AlertTriangle,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { formatMoney, formatDateLong, parseLocalDate } from '../lib/format';
import {
  activeFilterCount,
  dateRangeFromParams,
  dateRangeLabel,
  EMPTY_DATE_RANGE,
  filtersFromParams,
  hasActiveFilters,
  pageFromParams,
  TX_TYPES,
  type DateRangeState,
  type FilterState,
  type TxType,
} from '../lib/transaction-filters';
import { cn } from '../lib/utils';
import { CategoryPicker } from '../components/CategoryPicker';
import { useReviews } from '../components/ReviewsProvider';
import {
  AddTransactionModal,
  DateRangePanel,
  EditTransactionModal,
  EmptyTransactions,
  FilterChip,
  FilterPanel,
  ToolbarPanel,
  TransactionActionModal,
  TransactionDetailModal,
} from '../components/transactions';
import { CategorySelect, needsCategory, TYPE_ICON, TYPE_ICON_WRAP, TYPE_STYLE } from '../components/transactions/shared';
import type {
  Account,
  EditableTransaction,
  MainCategory,
  PageResponse,
  Transaction,
  TransactionSplit,
} from '../components/transactions/types';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

/** Rows-per-page choices; 25 fits a comfortable full table on a 13" laptop. */
const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_KEY = 'cura.transactions.pageSize';

function storedPageSize(): number {
  try {
    const value = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

/** "Oct 21", with the year only when it isn't the current one. */
function shortDate(iso: string): string {
  const d = parseLocalDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

const DESKTOP_QUERY = '(min-width: 768px)';

export function Transactions() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api.get<MainCategory[]>('/api/categories') });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  // Investment accounts are balance-only — keep them off the cash
  // ledger filter and the manual-add account picker.
  const ledgerAccounts = useMemo(
    () => (accounts.data ?? []).filter((a) => a.type !== 'investment' && a.type !== 'uncategorized'),
    [accounts.data],
  );
  // Distinct merchants — fetched once on mount so the merchant filter
  // dropdown doesn't issue a query per keystroke. The list is small
  // (one row per unique merchant, not per transaction) and changes only
  // when the user adds transactions, so we refetch alongside the
  // transactions list cache via the same `['transactions']` key.
  const merchants = useQuery({ queryKey: ['transactions', 'merchants'], queryFn: () => api.get<string[]>('/api/transactions/merchants') });

  // URL parameters are the only persisted view state. Every interaction
  // writes a canonical URL, and back/forward simply produces a new view.
  const q = searchParams.get('q') ?? '';
  const page = pageFromParams(searchParams);
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const dateRange = useMemo(() => dateRangeFromParams(searchParams), [searchParams]);
  const reviewed = searchParams.get('reviewed') === 'true';

  const setPage = (value: React.SetStateAction<number>) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      const resolved = typeof value === 'function' ? value(pageFromParams(current)) : value;
      if (resolved > 1) next.set('page', String(resolved)); else next.delete('page');
      return next;
    });
  };
  const setQ = (value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value.trim()) next.set('q', value); else next.delete('q');
      next.delete('page');
      return next;
    }, { replace: true });
  };
  const setFilters: React.Dispatch<React.SetStateAction<FilterState>> = (value) => {
    setSearchParams((current) => {
      const previous = filtersFromParams(current);
      const nextFilters = typeof value === 'function' ? value(previous) : value;
      const next = new URLSearchParams(current);
      const types = TX_TYPES.filter((type) => nextFilters.types.has(type));
      if (types.length) next.set('types', types.join(',')); else next.delete('types');
      const accountIds = Array.from(nextFilters.accounts).sort();
      if (accountIds.length) next.set('accountIds', JSON.stringify(accountIds)); else next.delete('accountIds');
      next.delete('category');
      next.delete('subCategory');
      if (nextFilters.categoryPick) {
        try {
          const picked = JSON.parse(nextFilters.categoryPick) as { category?: string; subCategory?: string };
          if (picked.category) next.set('category', picked.category);
          if (picked.subCategory) next.set('subCategory', picked.subCategory);
        } catch { /* malformed selections are omitted */ }
      }
      if (nextFilters.merchant) next.set('merchant', nextFilters.merchant); else next.delete('merchant');
      next.delete('min');
      next.delete('max');
      if (nextFilters.minAmount) next.set('minAmount', nextFilters.minAmount); else next.delete('minAmount');
      if (nextFilters.maxAmount) next.set('maxAmount', nextFilters.maxAmount); else next.delete('maxAmount');
      next.delete('page');
      return next;
    });
  };
  const [filterOpen, setFilterOpen] = useState(false);
  const setDateRange = (value: DateRangeState) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      let { from, to } = value;
      if (from && to && from > to) [from, to] = [to, from];
      if (from) next.set('from', from); else next.delete('from');
      if (to) next.set('to', to); else next.delete('to');
      next.delete('page');
      return next;
    });
  };
  const [dateOpen, setDateOpen] = useState(false);
  const [pageSize, setPageSizeState] = useState(storedPageSize);
  const pageSizeLabelId = useId();
  const setPageSize = (size: number) => {
    setPageSizeState(size);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      // Storage can be blocked; the choice still applies for this visit.
    }
    setPage(1);
  };

  // Build the API query string from the filter state. Memoised so the
  // query key only changes when a filter actually changes (not when
  // unrelated state updates re-render the component).
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set('limit', String(pageSize));
    params.set('offset', String((page - 1) * pageSize));
    if (q.trim()) params.set('q', q.trim());
    if (filters.types.size > 0) params.set('types', Array.from(filters.types).join(','));
    if (filters.accounts.size > 0 && (ledgerAccounts.length === 0 || filters.accounts.size < ledgerAccounts.length)) {
      params.set('accountIds', JSON.stringify(Array.from(filters.accounts)));
    }
    if (filters.categoryPick) {
      // JSON-encoded value carries both fields without a delimiter
      // that could collide with user-defined category names.
      try {
        const parsed = JSON.parse(filters.categoryPick) as { category: string; subCategory?: string };
        params.set('category', parsed.category);
        if (parsed.subCategory) params.set('subCategory', parsed.subCategory);
      } catch {
        /* ignore malformed */
      }
    }
    if (filters.merchant) params.set('merchant', filters.merchant);
    if (filters.minAmount) {
      const n = Number(filters.minAmount);
      if (Number.isFinite(n)) params.set('minAmount', String(n));
    }
    if (filters.maxAmount) {
      const n = Number(filters.maxAmount);
      if (Number.isFinite(n)) params.set('maxAmount', String(n));
    }
    let from = dateRange.from;
    let to = dateRange.to;
    if (from && to && from > to) {
      const tmp = from;
      from = to;
      to = tmp;
    }
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (reviewed) params.set('reviewed', 'true');
    return params.toString();
  }, [page, pageSize, q, filters, dateRange, ledgerAccounts.length, reviewed]);

  const txns = useQuery({
    queryKey: ['transactions', 'page', queryString],
    queryFn: () => api.get<PageResponse>(`/api/transactions/page?${queryString}`),
  });
  const total = txns.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // A delete or a shrinking result set can invalidate the current page.
  // Only clamp after a successful response so changing pages does not
  // bounce through page 1 while the next page is loading.
  useEffect(() => {
    if (!txns.data || page <= totalPages) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (totalPages > 1) next.set('page', String(totalPages)); else next.delete('page');
      return next;
    }, { replace: true });
  }, [txns.data, page, totalPages, setSearchParams]);

  const invalidateFinancialQueries = () => {
    for (const key of ['transactions', 'reviews', 'accounts', 'dashboard', 'budget', 'reports', 'paydown', 'recurring', 'notifications', 'goals', 'simplefin']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/transactions/${id}`),
    onSuccess: invalidateFinancialQueries,
  });

  // Manual transaction create. Server applies any matching user rule
  // to the category (rules win over what the user typed), so the new
  // row lands in the list with the rule's category rather than the
  // picker's. Refresh both the page query and the merchants list so
  // the new merchant immediately appears in the filter dropdown.
  const addTx = useMutation({
    mutationFn: (input: EditableTransaction) =>
      api.post<Transaction>('/api/transactions', input),
    onSuccess: invalidateFinancialQueries,
  });

  // User-defined rules. Loaded once on mount; consulted both by the
  // popup-trigger check below ("does a rule already exist for this
  // merchant?") and by the modal that creates a new rule. Invalidated
  // on rule create/edit/delete so the popup check stays fresh.
  interface Rule {
    id: string;
    matchType: 'exact';
    matchValue: string;
    accountId?: string;
    sourceType?: TxType;
    sourceCategory?: string;
    sourceSubCategory?: string;
    category: string;
    subCategory?: string;
    type?: TxType;
    updatedAt: string;
    version: number;
  }

  // `rulePromptIdRef` tracks the latest assignment-correction toast so
  // a late rule-create response cannot attach to a newer edit.
  const rulePromptIdRef = useRef<string | null>(null);
  const [ruleConfirmation, setRuleConfirmation] = useState<{
    transactionId: string;
    existingRule: Rule;
  } | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState<{
    transaction: Transaction;
    type: TxType;
    categoryPick: string;
  } | null>(null);

  type RuleFromTransactionResult = {
    status: 'created' | 'narrowed' | 'updated' | 'unchanged' | 'confirmation_required';
    rule: Rule;
  };
  const createRuleFromTransaction = useMutation({
    mutationFn: (input: { transactionId: string; replaceRuleId?: string; expectedVersion?: number }) =>
      api.post<RuleFromTransactionResult>(`/api/rules/from-transaction/${input.transactionId}`, {
        replaceRuleId: input.replaceRuleId,
        expectedVersion: input.expectedVersion,
      }),
    onSuccess: (result, input) => {
      if (rulePromptIdRef.current !== input.transactionId && !input.replaceRuleId) return;
      if (result.status === 'confirmation_required') {
        setRuleConfirmation({ transactionId: input.transactionId, existingRule: result.rule });
        rulePromptIdRef.current = null;
        return;
      }
      void qc.invalidateQueries({ queryKey: ['rules'] });
      setRuleConfirmation(null);
      rulePromptIdRef.current = null;
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not create rule.');
    },
  });

  // Type and category form one assignment and are always written together.
  // Rule creation is a separate, explicit action after the correction saves.
  const updateAssignmentInline = useMutation({
    mutationFn: (input: {
      transaction: Transaction;
      type: TxType;
      category: string;
      subCategory: string;
    }) =>
      api.patch<{ ok: true }>(`/api/transactions/${input.transaction.id}`, {
        type: input.type,
        category: input.category,
        subCategory: input.subCategory,
      }),
    onSuccess: (_data, vars) => {
      createRuleFromTransaction.reset();
      invalidateFinancialQueries();
      setDetailTx((current) => current?.id === vars.transaction.id ? null : current);
      rulePromptIdRef.current = vars.transaction.id;
      toast.success(
        `Saved ${TYPE_STYLE[vars.type].label} · ${vars.category}${vars.subCategory ? ` › ${vars.subCategory}` : ''}.`,
        {
          description: vars.transaction.sourceClassificationTrusted
            ? `Match ${TYPE_STYLE[vars.transaction.sourceType].label} · ${vars.transaction.sourceCategory}${vars.transaction.sourceSubCategory ? ` › ${vars.transaction.sourceSubCategory}` : ''} on ${vars.transaction.account}.`
            : `Match this merchant on ${vars.transaction.account}. Original type/category was not retained for this older transaction.`,
          duration: 8000,
          action: {
            label: 'Create scoped rule',
            onClick: () => createRuleFromTransaction.mutate({ transactionId: vars.transaction.id }),
          },
        },
      );
    },
    onError: (error) => {
      toast.error(`Assignment was not saved: ${error instanceof Error ? error.message : 'unknown'}`);
    },
  });
  const onPickCategory = (transaction: Transaction, jsonValue: string) => {
    let parsed: { category: string; subCategory: string };
    try {
      parsed = JSON.parse(jsonValue);
    } catch {
      return; // malformed option value, ignore
    }
    if (!parsed.category || !parsed.subCategory) return;
    updateAssignmentInline.mutate({
      transaction,
      type: transaction.type,
      category: parsed.category,
      subCategory: parsed.subCategory,
    });
  };

  const toggleType = (t: TxType) => {
    setFilters((prev) => {
      const next = new Set(prev.types);
      if (next.has(t)) next.delete(t); else next.add(t);
      return { ...prev, types: next };
    });
  };

  const clearFilters = () => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const key of ['q', 'types', 'accountIds', 'category', 'subCategory', 'merchant', 'min', 'max', 'minAmount', 'maxAmount', 'from', 'to', 'page']) {
        next.delete(key);
      }
      return next;
    });
  };

  const datesActive = !!dateRange.from || !!dateRange.to;
  const filterActive = hasActiveFilters(filters, q, ledgerAccounts.length) || datesActive;
  const popoverFilterCount = activeFilterCount(filters, ledgerAccounts.length);
  const filterChips: { key: string; label: string; onRemove: () => void }[] = [];
  if (q.trim()) {
    filterChips.push({ key: 'q', label: `Search: ${q.trim()}`, onRemove: () => setQ('') });
  }
  if (datesActive) {
    filterChips.push({ key: 'dates', label: dateRangeLabel(dateRange), onRemove: () => setDateRange(EMPTY_DATE_RANGE) });
  }
  for (const type of TX_TYPES) {
    if (filters.types.has(type)) {
      filterChips.push({ key: `type-${type}`, label: TYPE_STYLE[type].label, onRemove: () => toggleType(type) });
    }
  }
  if (filters.accounts.size > 0 && filters.accounts.size < ledgerAccounts.length) {
    for (const id of filters.accounts) {
      const account = ledgerAccounts.find((a) => a.id === id);
      filterChips.push({
        key: `account-${id}`,
        label: account?.alias || account?.name || id,
        onRemove: () => setFilters((prev) => {
          const next = new Set(prev.accounts);
          next.delete(id);
          return { ...prev, accounts: next };
        }),
      });
    }
  }
  if (filters.categoryPick) {
    let categoryLabel = 'Category';
    try {
      const parsed = JSON.parse(filters.categoryPick) as { category?: string; subCategory?: string };
      if (parsed.category) categoryLabel = parsed.subCategory ? `${parsed.category} › ${parsed.subCategory}` : parsed.category;
    } catch {
      categoryLabel = 'Category';
    }
    filterChips.push({ key: 'category', label: categoryLabel, onRemove: () => setFilters((prev) => ({ ...prev, categoryPick: '' })) });
  }
  if (filters.merchant) {
    filterChips.push({ key: 'merchant', label: filters.merchant, onRemove: () => setFilters((prev) => ({ ...prev, merchant: '' })) });
  }
  if (filters.minAmount || filters.maxAmount) {
    const min = filters.minAmount && Number.isFinite(Number(filters.minAmount)) ? formatMoney(Number(filters.minAmount)) : '';
    const max = filters.maxAmount && Number.isFinite(Number(filters.maxAmount)) ? formatMoney(Number(filters.maxAmount)) : '';
    const amountLabel = min && max ? `${min}–${max}` : min ? `≥ ${min}` : `≤ ${max}`;
    filterChips.push({
      key: 'amount',
      label: amountLabel,
      onRemove: () => setFilters((prev) => ({ ...prev, minAmount: '', maxAmount: '' })),
    });
  }

  // Mirror the bell badge so the banner is a discoverable backstop if
  // the user ignores the chrome. Clicking the CTA opens the same
  // carousel modal the bell drives.
  const reviews = useReviews();
  const dependenciesLoading = cats.isLoading || accounts.isLoading;
  const dependenciesError = cats.error ?? accounts.error;

  // Manual transaction entry. The "+ Add" button in the page header
  // opens the modal; submitting POSTs a new transaction and refreshes
  // the list (and the bell badge, since new rows may match the review
  // queue if the user left needs_review unset on creation).
  const [addOpen, setAddOpen] = useState(false);

  // Mobile detail modal — tapping a row on small screens opens a
  // read-only detail sheet showing all fields.
  const [detailTx, setDetailTx] = useState<Transaction | null>(null);
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      setIsDesktop(media.matches);
      if (media.matches) setDetailTx(null);
    };
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // Action modal — opened by the triple-dot button on each row.
  // Allows editing posting date and marking as recurring.
  const [actionTx, setActionTx] = useState<Transaction | null>(null);
  const [editTx, setEditTx] = useState<Transaction | null>(null);
  const [deleteTx, setDeleteTx] = useState<Transaction | null>(null);

  const updateTransaction = useMutation({
    mutationFn: (input: {
      id: string;
      parent: EditableTransaction;
      splits: Omit<TransactionSplit, 'id'>[];
    }) => api.put<Transaction>(`/api/transactions/${input.id}/full`, {
      transaction: input.parent,
      splits: input.splits,
    }),
    onSuccess: invalidateFinancialQueries,
  });

  const updateTxDate = useMutation({
    mutationFn: (input: { id: string; date: string }) =>
      api.patch<{ ok: true }>(`/api/transactions/${input.id}`, { date: input.date }),
    onSuccess: invalidateFinancialQueries,
  });

  const markRecurring = useMutation({
    mutationFn: (input: { transactionId: string; frequency: 'weekly' | 'monthly' | 'yearly' }) =>
      api.post('/api/recurring/mark', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const dismissRecurring = useMutation({
    mutationFn: (input: { merchant: string; amount: number; account: string; accountId?: string }) =>
      api.post('/api/recurring/dismiss', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const changeTransactionType = (t: Transaction, newType: TxType) => {
    if (newType === t.type) return;
    const newBucketCats = (cats.data ?? []).filter((c) => c.type === newType || c.name === 'Pay down goals');
    const currentCategory = newBucketCats.find((c) => c.name === t.category);
    const stillValid = !!t.subCategory
      && currentCategory?.subCategories.some((s) => s.name === t.subCategory);
    if (stillValid && t.subCategory) {
      updateAssignmentInline.mutate({
        transaction: t,
        type: newType,
        category: t.category,
        subCategory: t.subCategory,
      });
      return;
    }
    if (detailTx?.id === t.id) setDetailTx(null);
    setAssignmentDraft({ transaction: t, type: newType, categoryPick: '' });
  };

  return (
    <div className="flex flex-col gap-6 app-fab-page-space">
      <div className="flex items-baseline gap-2">
        <h1 className="text-2xl font-bold fg-primary">Transactions</h1>
        <span className="text-xs fg-muted tabular-nums">
          {txns.isLoading
            ? '…'
            : filterActive
              ? `${total.toLocaleString()} match${total === 1 ? '' : 'es'}`
              : `${total.toLocaleString()} transaction${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {reviews.count > 0 && (
        <Alert data-onboarding-target="review-transactions">
          <BellRing />
          <AlertTitle>
            {reviews.count} imported transaction{reviews.count === 1 ? ' needs' : 's need'} a review before {reviews.count === 1 ? 'it counts' : 'they count'} in your budget.
          </AlertTitle>
          <AlertAction>
            <Button type="button" variant="link" onClick={reviews.openModal}>
              Review now
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          </AlertAction>
        </Alert>
      )}

      {/* On mobile the section drops its card chrome so the list renders
          edge-to-edge on the page canvas, native-app style. */}
      <Card className="card-mobile-plain">
        <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
          <InputGroup className="col-span-2 min-h-11 min-w-0 md:min-h-0 md:flex-1">
            <InputGroupAddon aria-hidden="true">
              <Search className="h-4 w-4" />
            </InputGroupAddon>
            <InputGroupInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search merchants and accounts"
              aria-label="Search transactions"
            />
          </InputGroup>

          <ToolbarPanel
            title="Date range"
            open={dateOpen}
            onOpenChange={setDateOpen}
            isDesktop={isDesktop}
            footer={datesActive && (
              <Button type="button" variant="link" className="h-auto px-0" onClick={() => setDateRange(EMPTY_DATE_RANGE)}>
                Clear dates
              </Button>
            )}
            trigger={(
              <Button
                type="button"
                variant={datesActive ? 'secondary' : 'outline'}
                onClick={isDesktop ? undefined : () => setDateOpen(true)}
                aria-haspopup="dialog"
                aria-label={`Date range: ${dateRangeLabel(dateRange)}`}
                className="w-full min-w-0 md:w-auto md:max-w-[11rem] md:shrink-0"
              >
                <Calendar data-icon="inline-start" />
                <span className="truncate">{dateRangeLabel(dateRange)}</span>
              </Button>
            )}
          >
            <DateRangePanel value={dateRange} onChange={setDateRange} />
          </ToolbarPanel>

          <ToolbarPanel
            title="Filters"
            open={filterOpen}
            onOpenChange={setFilterOpen}
            isDesktop={isDesktop}
            className="w-[22rem]"
            footer={(
              <>
                <Button type="button" variant="link" className="h-auto px-0" onClick={clearFilters} disabled={!filterActive}>
                  Clear all
                </Button>
                <Button type="button" size="sm" onClick={() => setFilterOpen(false)}>
                  Done
                </Button>
              </>
            )}
            trigger={(
              <Button
                type="button"
                variant={popoverFilterCount > 0 ? 'secondary' : 'outline'}
                onClick={isDesktop ? undefined : () => setFilterOpen(true)}
                aria-haspopup="dialog"
                aria-label="Filters"
                className="w-full min-w-0 md:w-auto md:shrink-0"
              >
                <Filter data-icon="inline-start" />
                Filters
                {popoverFilterCount > 0 && (
                  <Badge className="h-[18px] min-w-[18px] px-1 text-[10px]">
                    {popoverFilterCount}
                  </Badge>
                )}
              </Button>
            )}
          >
            <FilterPanel
              filters={filters}
              setFilters={setFilters}
              accounts={ledgerAccounts}
              categories={cats.data ?? []}
              merchants={merchants.data ?? []}
            />
          </ToolbarPanel>

          <Button
            type="button"
            onClick={() => setAddOpen(true)}
            data-onboarding-target="add-transaction"
            disabled={dependenciesLoading || !!dependenciesError}
            className="hidden md:inline-flex md:shrink-0"
            aria-label="Add transaction"
          >
            <Plus data-icon="inline-start" />
            Add transaction
          </Button>
        </div>
        {filterChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {filterChips.map((chip) => (
              <FilterChip key={chip.key} label={chip.label} onRemove={chip.onRemove} />
            ))}
            <Button type="button" variant="link" className="h-auto px-0 text-xs" onClick={clearFilters}>
              Clear all
            </Button>
          </div>
        )}
        {dependenciesLoading && (
          <Alert>
            <Spinner />
            <AlertTitle>Loading categories and accounts…</AlertTitle>
          </Alert>
        )}
        {dependenciesError && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Editing is unavailable</AlertTitle>
            <AlertDescription>Categories or accounts could not be loaded.</AlertDescription>
            <AlertAction>
              <Button type="button" size="sm" variant="outline" onClick={() => { void cats.refetch(); void accounts.refetch(); }}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        {/* Mobile list — tappable rows grouped by date. Every field the
            desktop table shows (and edits) remains reachable through the
            detail bottom sheet each row opens. */}
        <div className="md:hidden">
          {txns.isLoading && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><Spinner /></EmptyMedia>
                <EmptyTitle>Loading transactions…</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
          {txns.isError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Transactions could not be loaded.</AlertTitle>
              <AlertAction>
                <Button type="button" size="sm" variant="outline" onClick={() => void txns.refetch()}>Retry</Button>
              </AlertAction>
            </Alert>
          )}
          {txns.isSuccess && txns.data.rows.length === 0 && (
            <EmptyTransactions
              filtered={filterActive}
              onClear={clearFilters}
              onAdd={() => setAddOpen(true)}
              addDisabled={dependenciesLoading || !!dependenciesError}
            />
          )}
          {txns.isSuccess && txns.data.rows.map((t, idx) => {
            const prevDate = idx > 0 ? txns.data!.rows[idx - 1]!.date : null;
            const showDateHeader = t.date !== prevDate;
            const splitCount = t.splits?.length ?? 0;
            const TypeIcon = TYPE_ICON[t.type];
            return (
              <Fragment key={t.id}>
                {showDateHeader && (
                  <div className={clsx('flex items-center gap-3 pb-2', idx === 0 ? 'pt-1' : 'pt-5')}>
                    <span className="shrink-0 text-xs font-semibold fg-primary">{formatDateLong(t.date)}</span>
                    <span className="flex-1 border-t border-default" aria-hidden="true" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setDetailTx(t)}
                  className="flex w-full items-center gap-3 border-b border-default py-3 text-left transition-transform active:scale-[0.99]"
                  aria-label={`${t.merchant}, ${TYPE_STYLE[t.type].label}, ${formatMoney(t.amount)} — view details`}
                >
                  <span className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', TYPE_ICON_WRAP[t.type])} aria-hidden="true">
                    <TypeIcon className="h-[18px] w-[18px]" strokeWidth={2.2} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold fg-primary">{t.merchant}</span>
                    <span className="mt-0.5 block truncate text-xs fg-muted">
                      {splitCount > 0
                        ? `${splitCount} split${splitCount === 1 ? '' : 's'}`
                        : (t.subCategory || t.category || 'Uncategorized')}
                      {' · '}
                      {t.account}
                    </span>
                  </span>
                  <span className={clsx('shrink-0 text-sm font-semibold tabular-nums', TYPE_STYLE[t.type].amount)}>
                    {TYPE_STYLE[t.type].sign}{formatMoney(t.amount)}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 fg-muted" aria-hidden="true" />
                </button>
              </Fragment>
            );
          })}
        </div>

        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-24">Date</TableHead>
                <TableHead>Merchant and account</TableHead>
                <TableHead className="w-72">Category</TableHead>
                <TableHead className="w-36 text-right">Amount</TableHead>
                <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txns.isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground" role="status">
                    <span className="inline-flex items-center gap-2"><Spinner /> Loading transactions…</span>
                  </TableCell>
                </TableRow>
              )}
              {txns.isError && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Alert variant="destructive">
                      <AlertTriangle />
                      <AlertTitle>Transactions could not be loaded.</AlertTitle>
                      <AlertAction>
                        <Button type="button" size="sm" variant="outline" onClick={() => void txns.refetch()}>Retry</Button>
                      </AlertAction>
                    </Alert>
                  </TableCell>
                </TableRow>
              )}
              {txns.isSuccess && txns.data.rows.map((t, idx) => {
                const rows = txns.data!.rows;
                const firstOfDay = idx === 0 || rows[idx - 1]!.date !== t.date;
                const lastOfDay = idx === rows.length - 1 || rows[idx + 1]!.date !== t.date;
                const hasSplits = (t.splits?.length ?? 0) > 0;
                const assignmentBusy = updateAssignmentInline.isPending || createRuleFromTransaction.isPending || !!cats.error;
                return (
                  <TableRow key={t.id} className={cn('group/row', !lastOfDay && 'border-b-0')}>
                    <TableCell className="align-top text-muted-foreground">
                      {firstOfDay ? shortDate(t.date) : <span className="sr-only">{shortDate(t.date)}</span>}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="fg-primary">{t.merchant}</div>
                      <div className="text-xs text-muted-foreground">{t.account}</div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {hasSplits ? (
                        <div className="flex flex-col gap-0.5" title="Edit the transaction to change split allocations.">
                          <span>Split in {t.splits!.length}</span>
                          <span className="text-xs text-muted-foreground">
                            {t.splits!.map((split) => `${split.subCategory} ${formatMoney(split.amount)}`).join(', ')}
                          </span>
                        </div>
                      ) : (
                        <CategoryPicker
                          categories={cats.data ?? []}
                          value={t.subCategory ? { category: t.category, subCategory: t.subCategory } : null}
                          type={t.type}
                          showTypeTabs
                          disabled={assignmentBusy}
                          onSelect={(pick) => {
                            if (!pick) return;
                            if (pick.type === t.type && pick.category === t.category && pick.subCategory === t.subCategory) return;
                            updateAssignmentInline.mutate({ transaction: t, ...pick });
                          }}
                        >
                          {needsCategory(t) ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="rounded-full border-sky-300/60 text-sky-300 hover:bg-sky-900/40 hover:text-sky-300"
                              aria-label={`Choose a category for ${t.merchant}`}
                            >
                              Needs a category
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="-ml-2.5 max-w-full justify-start font-normal"
                              aria-label={`Change category for ${t.merchant}, now ${t.subCategory}`}
                            >
                              <span className="truncate">{t.subCategory}</span>
                              {t.type === 'transfer' && <span className="text-muted-foreground">(transfer)</span>}
                              <ChevronDown data-icon="inline-end" className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/button:opacity-100" />
                            </Button>
                          )}
                        </CategoryPicker>
                      )}
                    </TableCell>
                    <TableCell className={cn('text-right font-semibold tabular-nums', TYPE_STYLE[t.type].amount)}>
                      {TYPE_STYLE[t.type].sign}{formatMoney(t.amount)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setActionTx(t)}
                        aria-label={`Actions for ${t.merchant}`}
                      >
                        <MoreVertical />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {txns.isSuccess && txns.data.rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5}>
                    <EmptyTransactions
                      filtered={filterActive}
                      onClear={clearFilters}
                      onAdd={() => setAddOpen(true)}
                      addDisabled={dependenciesLoading || !!dependenciesError}
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {txns.isSuccess && total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-sm text-muted-foreground">
            <span className="tabular-nums">
              {((page - 1) * pageSize + 1).toLocaleString()}–{Math.min(page * pageSize, total).toLocaleString()} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-4">
              <div className="hidden items-center gap-2 md:flex">
                <span id={pageSizeLabelId}>Rows per page</span>
                <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
                  <SelectTrigger size="sm" className="w-[4.5rem]" aria-labelledby={pageSizeLabelId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {PAGE_SIZES.map((size) => (
                        <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <span className="tabular-nums text-foreground">Page {page} of {totalPages.toLocaleString()}</span>
              <div className="flex items-center gap-1">
                <Button type="button" variant="outline" size="icon-sm" aria-label="First page" disabled={page === 1} onClick={() => setPage(1)}>
                  <ChevronsLeft />
                </Button>
                <Button type="button" variant="outline" size="icon-sm" aria-label="Previous page" disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft />
                </Button>
                <Button type="button" variant="outline" size="icon-sm" aria-label="Next page" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                  <ChevronRight />
                </Button>
                <Button type="button" variant="outline" size="icon-sm" aria-label="Last page" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>
                  <ChevronsRight />
                </Button>
              </div>
            </div>
          </div>
        )}
        </CardContent>
      </Card>

      {/* Mobile floating action button — the page's primary action, kept
          in the right thumb zone above the pill tab bar. Shares the
          onboarding target with the desktop toolbar button; the provider
          picks whichever one is visible at the current breakpoint. */}
      <Button
        type="button"
        onClick={() => setAddOpen(true)}
        data-onboarding-target="add-transaction"
        disabled={dependenciesLoading || !!dependenciesError}
        aria-label="Add transaction"
        size="icon-lg"
        className="app-fab md:hidden h-14 w-14 rounded-full shadow-[0_10px_30px_rgba(0,0,0,0.35)] [&_svg:not([class*='size-'])]:size-6"
      >
        <Plus strokeWidth={2.4} />
      </Button>

      {ruleConfirmation && (
        <ConfirmDialog
          title={ruleConfirmation.existingRule.accountId ? 'Update existing scoped rule?' : 'Narrow existing broad rule?'}
          confirmLabel={ruleConfirmation.existingRule.accountId ? 'Update rule' : 'Narrow rule'}
          onConfirm={async () => {
            const result = await createRuleFromTransaction.mutateAsync({
              transactionId: ruleConfirmation.transactionId,
              replaceRuleId: ruleConfirmation.existingRule.id,
              expectedVersion: ruleConfirmation.existingRule.version,
            });
            if (result.status === 'confirmation_required') {
              throw new Error('The matching rule changed. Review the updated rule and confirm again.');
            }
          }}
          onClose={() => setRuleConfirmation(null)}
        >
          <p>
            The existing rule for <span className="font-medium fg-primary">{ruleConfirmation.existingRule.matchValue}</span>{' '}
            currently sets {ruleConfirmation.existingRule.type ? `${TYPE_STYLE[ruleConfirmation.existingRule.type].label} · ` : ''}
            {ruleConfirmation.existingRule.category}
            {ruleConfirmation.existingRule.subCategory ? ` › ${ruleConfirmation.existingRule.subCategory}` : ''}.
          </p>
          <p>
            Confirming replaces it with this transaction&apos;s account, original type, and original category conditions.
          </p>
        </ConfirmDialog>
      )}

      {assignmentDraft && (
        <ConfirmDialog
          title={`Choose a category for ${TYPE_STYLE[assignmentDraft.type].label}`}
          confirmLabel="Save assignment"
          onConfirm={async () => {
            let selected: { category: string; subCategory: string };
            try {
              selected = JSON.parse(assignmentDraft.categoryPick) as { category: string; subCategory: string };
            } catch {
              throw new Error('Choose a category before saving.');
            }
            if (!selected.category || !selected.subCategory) throw new Error('Choose a category before saving.');
            await updateAssignmentInline.mutateAsync({
              transaction: assignmentDraft.transaction,
              type: assignmentDraft.type,
              category: selected.category,
              subCategory: selected.subCategory,
            });
          }}
          onClose={() => setAssignmentDraft(null)}
        >
          <p>The transaction will not change until both its type and category can be saved together.</p>
          <CategorySelect
            value={assignmentDraft.categoryPick}
            onValueChange={(value) => setAssignmentDraft((current) => current ? {
              ...current,
              categoryPick: value,
            } : null)}
            categories={(cats.data ?? []).filter((category) => category.type === assignmentDraft.type || category.name === 'Pay down goals')}
            placeholder="Choose a category"
            aria-label="New transaction category"
          />
        </ConfirmDialog>
      )}

      {addOpen && (
        <AddTransactionModal
          categories={cats.data ?? []}
          accounts={ledgerAccounts}
          merchants={merchants.data ?? []}
          isDesktop={isDesktop}
          isPending={addTx.isPending}
          error={addTx.error?.message ?? null}
          onClose={() => setAddOpen(false)}
          onSubmit={async (input) => {
            await addTx.mutateAsync(input);
            setAddOpen(false);
          }}
        />
      )}

      {detailTx && !isDesktop && (
        <TransactionDetailModal
          transaction={detailTx}
          categories={cats.data ?? []}
          isPending={updateAssignmentInline.isPending || createRuleFromTransaction.isPending}
          onClose={() => setDetailTx(null)}
          onChangeType={(type) => changeTransactionType(detailTx, type)}
          onChangeCategory={(value) => onPickCategory(detailTx, value)}
          onActions={() => { setActionTx(detailTx); setDetailTx(null); }}
          onDelete={() => setDeleteTx(detailTx)}
        />
      )}

      {actionTx && (
        <TransactionActionModal
          transaction={actionTx}
          onClose={() => setActionTx(null)}
          onEdit={() => { updateTransaction.reset(); setEditTx(actionTx); }}
          editDisabled={dependenciesLoading || !!dependenciesError}
          onUpdateDate={async (id, date) => {
            await updateTxDate.mutateAsync({ id, date });
          }}
          onSetRecurring={async (frequency) => {
            const identity = {
              merchant: actionTx.merchant,
              amount: actionTx.amount,
              account: actionTx.account,
              accountId: actionTx.accountId,
            };
            if (frequency === 'none') {
              await dismissRecurring.mutateAsync(identity);
            } else {
              await markRecurring.mutateAsync({ transactionId: actionTx.id, frequency });
            }
          }}
          onDelete={() => setDeleteTx(actionTx)}
          isPending={updateTxDate.isPending || markRecurring.isPending || dismissRecurring.isPending}
        />
      )}

      {editTx && (
        <EditTransactionModal
          transaction={editTx}
          categories={cats.data ?? []}
          accounts={ledgerAccounts}
          isPending={updateTransaction.isPending}
          error={updateTransaction.error?.message ?? null}
          onClose={() => { if (!updateTransaction.isPending) { updateTransaction.reset(); setEditTx(null); } }}
          onSubmit={async (parent, splits) => {
            await updateTransaction.mutateAsync({ id: editTx.id, parent, splits });
            setEditTx(null);
            setActionTx(null);
          }}
        />
      )}

      {deleteTx && (
        <ConfirmDialog
          title="Delete transaction?"
          confirmLabel="Delete transaction"
          destructive
          onClose={() => setDeleteTx(null)}
          onConfirm={async () => {
            await del.mutateAsync(deleteTx.id);
            setDetailTx(null);
            setActionTx(null);
          }}
        >
          <p>This permanently deletes the transaction for <strong className="fg-primary">{deleteTx.merchant}</strong>.</p>
          <p>If it came from SimpleFIN, later syncs will not import it again.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
