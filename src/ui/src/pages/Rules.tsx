/**
 * Rules page — user-defined "always set this merchant to this category"
 * mappings. Applied at import time (SimpleFIN + manual add), from a row's
 * "Run on past transactions" action, or "Run all rules" for the full set.
 *
 * Each rule is one row (merchant → files as → account). Clicking a row
 * expands it in place to describe the whole rule and show its actions.
 *
 * Rules are created explicitly here or from a corrected transaction.
 * Transaction-derived rules include source account/type/category scope.
 */
import { useDeferredValue, useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation, type QueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { api } from '../lib/api';
import {
  RuleFormModal,
  type RuleFormAccount,
  type RuleFormCategory,
} from '../components/RuleFormModal';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../components/ui/input-group';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '../components/ui/popover';
import { Skeleton } from '../components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';

type RuleTxType = 'income' | 'expense' | 'transfer';

interface Rule {
  id: string;
  matchType: 'exact';
  matchValue: string;
  accountId?: string;
  sourceType?: RuleTxType;
  sourceCategory?: string;
  sourceSubCategory?: string;
  category: string;
  subCategory?: string;
  type?: RuleTxType;
  createdAt: string;
  updatedAt: string;
  version: number;
}

const RULE_TYPE_LABEL: Record<RuleTxType, string> = {
  expense: 'Expense',
  income: 'Income',
  transfer: 'Transfer',
};

const PAGE_SIZE = 10;

// Desktop columns: merchant | files as | account | chevron. On mobile the
// three text cells stack in the first column with the chevron beside them.
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,13rem)_1rem] md:gap-x-6';

function categoryPath(category: string, subCategory?: string): string {
  return subCategory ? `${category}, ${subCategory}` : category;
}

function fuzzyTokenIn(value: string | undefined, token: string): boolean {
  if (!value) return false;
  const normalizedValue = value.toLowerCase();
  const normalizedToken = token.toLowerCase();
  if (normalizedValue.includes(normalizedToken)) return true;

  const compactValue = normalizedValue.replace(/[^a-z0-9]+/g, '');
  const compactToken = normalizedToken.replace(/[^a-z0-9]+/g, '');
  return compactToken.length > 0 && compactValue.includes(compactToken);
}

function ruleMatchesSearch(rule: Rule, search: string, accountName?: string): boolean {
  const tokens = search.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const fields = [
    rule.matchValue,
    accountName,
    rule.sourceCategory,
    rule.sourceSubCategory,
    rule.sourceType ? RULE_TYPE_LABEL[rule.sourceType] : undefined,
    rule.category,
    rule.subCategory,
    rule.type ? RULE_TYPE_LABEL[rule.type] : undefined,
  ];
  return tokens.every((token) => fields.some((field) => fuzzyTokenIn(field, token)));
}

interface MainCategory {
  id: string;
  name: string;
  type: RuleTxType;
  subCategories: { id: string; name: string }[];
}

interface Account {
  id: string;
  name: string;
  alias?: string;
}

export function Rules() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState('all');
  const [sourceTypeFilter, setSourceTypeFilter] = useState<'all' | RuleTxType>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [confirmation, setConfirmation] = useState<
    | { kind: 'delete'; rule: Rule }
    | { kind: 'run'; rule: Rule }
    | { kind: 'run-all' }
    | null
  >(null);

  const rules = useQuery({
    queryKey: ['rules'],
    queryFn: () => api.get<Rule[]>('/api/rules'),
  });

  const cats = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<MainCategory[]>('/api/categories'),
  });

  const accounts = useQuery({
    queryKey: ['accounts', 'includeHidden'],
    queryFn: () => api.get<Account[]>('/api/accounts?includeHidden=true'),
  });

  const ruleFormCategories: RuleFormCategory[] = (cats.data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    subCategories: c.subCategories.map((s) => ({ id: s.id, name: s.name })),
  }));
  const ruleFormAccounts: RuleFormAccount[] = (accounts.data ?? []).map((account) => ({
    id: account.id,
    name: account.alias || account.name,
  }));
  const accountNames = new Map(ruleFormAccounts.map((account) => [account.id, account.name]));

  // ---- Modal state ----------------------------------------------------
  // `null` = closed. Otherwise the modal is open in either 'create' or
  // 'edit' mode with the given initial values (edit pre-fills).
  const [modal, setModal] = useState<
    | {
        mode: 'create';
        initial?: {
          merchant: string;
          accountId?: string;
          sourceType?: RuleTxType;
          sourceCategory?: string;
          sourceSubCategory?: string;
          category: string;
          subCategory?: string;
          type?: RuleTxType;
        };
      }
    | { mode: 'edit'; rule: Rule }
    | null
  >(null);

  // ---- Mutations ------------------------------------------------------

  const createRule = useMutation({
    mutationFn: (input: {
      matchValue: string;
      accountId?: string;
      sourceType?: RuleTxType;
      sourceCategory?: string;
      sourceSubCategory?: string;
      category: string;
      subCategory: string;
      type?: RuleTxType;
    }) => api.post<Rule>('/api/rules', input),
    onSuccess: (created) => {
      qc.setQueryData<Rule[]>(['rules'], (current) => current ? [...current, created] : [created]);
      void qc.invalidateQueries({ queryKey: ['rules'] });
      setModal(null);
    },
  });

  const updateRule = useMutation({
    mutationFn: (input: {
      id: string;
      patch: {
        expectedVersion: number;
        matchValue: string;
        accountId?: string | null;
        sourceType?: RuleTxType | null;
        sourceCategory?: string | null;
        sourceSubCategory?: string | null;
        category: string;
        subCategory: string;
        type?: RuleTxType | null;
      };
    }) => api.patch<Rule>(`/api/rules/${input.id}`, input.patch),
    onSuccess: (updated) => {
      qc.setQueryData<Rule[]>(['rules'], (current) =>
        current?.map((rule) => rule.id === updated.id ? updated : rule) ?? [updated],
      );
      void qc.invalidateQueries({ queryKey: ['rules'] });
      setModal(null);
    },
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => api.delete(`/api/rules/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  const runRule = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; updated: number }>(`/api/rules/${id}/run`, {}),
    onSuccess: (result) => {
      invalidateRuleRunDependents(qc);
      toast.success(`Updated ${result.updated} transaction${result.updated === 1 ? '' : 's'}.`);
    },
  });

  const runAllRules = useMutation({
    mutationFn: () => api.post<{ ok: boolean; updated: number }>('/api/rules/run-all', {}),
    onSuccess: (result) => {
      invalidateRuleRunDependents(qc);
      toast.success(`Updated ${result.updated} transaction${result.updated === 1 ? '' : 's'}.`);
    },
  });

  const anyRunPending = runRule.isPending || runAllRules.isPending;
  const hasRules = (rules.data?.length ?? 0) > 0;
  const activeFilterCount = [accountFilter, sourceTypeFilter, categoryFilter].filter((value) => value !== 'all').length;
  const filteredRules = (rules.data ?? []).filter((rule) => {
    if (!ruleMatchesSearch(rule, deferredSearch, rule.accountId ? accountNames.get(rule.accountId) : undefined)) return false;
    if (accountFilter === 'any' && rule.accountId) return false;
    if (accountFilter !== 'all' && accountFilter !== 'any' && rule.accountId !== accountFilter) return false;
    if (sourceTypeFilter !== 'all' && rule.sourceType !== sourceTypeFilter) return false;
    if (categoryFilter !== 'all' && rule.category !== categoryFilter) return false;
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filteredRules.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedRules = filteredRules.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const canEditRules = !(cats.isLoading || accounts.isLoading || cats.isError || accounts.isError);
  const totalRules = rules.data?.length ?? 0;
  const firstShown = (currentPage - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(currentPage * PAGE_SIZE, filteredRules.length);
  const accountLabel = (rule: Rule) =>
    rule.accountId ? accountNames.get(rule.accountId) ?? 'Unknown account' : 'Any account';
  const clearFilters = () => {
    setAccountFilter('all');
    setSourceTypeFilter('all');
    setCategoryFilter('all');
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1" data-onboarding-target="rules-intro">
          <h1 className="text-2xl font-bold fg-primary">Rules</h1>
          <p className="text-sm text-muted-foreground">
            New transactions from these merchants are filed automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmation({ kind: 'run-all' })}
            disabled={!hasRules || anyRunPending}
            title="Re-apply every rule to matching transactions in your history"
          >
            {runAllRules.isPending ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
            {runAllRules.isPending ? 'Running…' : 'Run all rules'}
          </Button>
          <Button
            type="button"
            onClick={() => setModal({ mode: 'create' })}
            disabled={!canEditRules}
          >
            <Plus data-icon="inline-start" />
            Add rule
          </Button>
        </div>
      </div>

      {(cats.isError || accounts.isError) && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Rule editing is unavailable</AlertTitle>
          <AlertDescription>Categories or accounts could not be loaded.</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => { void cats.refetch(); void accounts.refetch(); }}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {rules.isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load rules.</AlertTitle>
          <AlertAction>
            <Button type="button" size="sm" onClick={() => void rules.refetch()} disabled={rules.isFetching}>
              {rules.isFetching ? <Spinner data-icon="inline-start" /> : null}
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <div className="flex flex-col gap-3">
          {hasRules && (
            <div className="flex flex-wrap items-center gap-2">
              <InputGroup className="h-11 w-full sm:w-80 md:h-8">
                <InputGroupAddon aria-hidden="true">
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search merchants or categories"
                  aria-label="Search rules"
                />
              </InputGroup>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline">
                    <ListFilter data-icon="inline-start" />
                    Filters
                    {activeFilterCount > 0 && (
                      <Badge variant="secondary" className="tabular-nums">{activeFilterCount}</Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] gap-4 p-4">
                  <PopoverHeader>
                    <PopoverTitle>Filter rules</PopoverTitle>
                  </PopoverHeader>
                  <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel htmlFor="rule-filter-account">Account</FieldLabel>
                      <Select
                        value={accountFilter}
                        onValueChange={(value) => { setAccountFilter(value); setPage(1); }}
                      >
                        <SelectTrigger id="rule-filter-account" className="w-full">
                          <SelectValue placeholder="All rules" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="all">All rules</SelectItem>
                            <SelectItem value="any">Rules for any account</SelectItem>
                            {ruleFormAccounts.map((account) => (
                              <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>Original type</FieldLabel>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        value={sourceTypeFilter}
                        onValueChange={(value) => {
                          if (!value) return;
                          setSourceTypeFilter(value as 'all' | RuleTxType);
                          setPage(1);
                        }}
                        className="w-full"
                        aria-label="Original type"
                      >
                        <ToggleGroupItem value="all" className="flex-1">All</ToggleGroupItem>
                        {(Object.keys(RULE_TYPE_LABEL) as RuleTxType[]).map((type) => (
                          <ToggleGroupItem key={type} value={type} className="flex-1">
                            {RULE_TYPE_LABEL[type]}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="rule-filter-category">Files as</FieldLabel>
                      <Select
                        value={categoryFilter}
                        onValueChange={(value) => { setCategoryFilter(value); setPage(1); }}
                      >
                        <SelectTrigger id="rule-filter-category" className="w-full">
                          <SelectValue placeholder="Any category" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="all">Any category</SelectItem>
                            {ruleFormCategories.map((category) => (
                              <SelectItem key={category.id} value={category.name}>{category.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  </FieldGroup>
                  {activeFilterCount > 0 && (
                    <Button type="button" variant="ghost" size="sm" className="self-start" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  )}
                </PopoverContent>
              </Popover>
              <span className="ml-auto text-sm text-muted-foreground tabular-nums">
                {filteredRules.length === totalRules
                  ? `${totalRules.toLocaleString()} ${totalRules === 1 ? 'rule' : 'rules'}`
                  : `${filteredRules.length.toLocaleString()} of ${totalRules.toLocaleString()} rules`}
              </span>
            </div>
          )}

          <Card className="gap-0 py-0">
            {rules.isLoading ? (
              <div aria-busy="true" aria-label="Loading rules">
                {Array.from({ length: 5 }, (_, index) => (
                  <div
                    key={index}
                    className={cn(ROW_GRID, 'items-center gap-y-2 border-b border-border px-4 py-4 last:border-b-0 md:px-5')}
                  >
                    <Skeleton className="col-start-1 row-start-1 h-4 w-32" />
                    <Skeleton className="col-start-1 row-start-2 h-4 w-24 md:col-start-2 md:row-start-1" />
                    <Skeleton className="col-start-1 row-start-3 h-3 w-28 md:col-start-3 md:row-start-1" />
                  </div>
                ))}
              </div>
            ) : totalRules === 0 ? (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><WandSparkles /></EmptyMedia>
                  <EmptyTitle>No rules yet</EmptyTitle>
                  <EmptyDescription>
                    Correct a transaction and choose Create scoped rule, or click Add rule to create one by hand.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : filteredRules.length === 0 ? (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyTitle>No matching rules</EmptyTitle>
                  <EmptyDescription>No rules match your search or filters.</EmptyDescription>
                </EmptyHeader>
                {activeFilterCount > 0 && (
                  <EmptyContent>
                    <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  </EmptyContent>
                )}
              </Empty>
            ) : (
              <>
                <div
                  className={cn(ROW_GRID, 'hidden border-b border-border px-5 py-3 text-sm text-muted-foreground md:grid')}
                  aria-hidden="true"
                >
                  <span>Merchant</span>
                  <span className="pl-6">Files as</span>
                  <span>Account</span>
                  <span />
                </div>
                <ul className="divide-y divide-border">
                  {pagedRules.map((r) => {
                    const open = expandedId === r.id;
                    const rowId = `rule-row-${r.id}`;
                    const panelId = `rule-panel-${r.id}`;
                    const running = runRule.isPending && runRule.variables === r.id;
                    return (
                      <li key={r.id} className={cn(open && 'bg-muted/50')}>
                        <button
                          type="button"
                          id={rowId}
                          aria-expanded={open}
                          aria-controls={panelId}
                          onClick={() => setExpandedId(open ? null : r.id)}
                          className={cn(
                            ROW_GRID,
                            'w-full items-center gap-y-1 px-4 py-3 text-left text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:min-h-13 md:px-5 md:py-2',
                          )}
                        >
                          <span className="col-start-1 row-start-1 truncate font-semibold text-foreground">
                            {r.matchValue}
                          </span>
                          <span className="col-start-1 row-start-2 flex min-w-0 items-baseline gap-2 md:col-start-2 md:row-start-1">
                            <ArrowRight className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
                            <span className="sr-only">files as</span>
                            <span className="truncate text-foreground">{r.subCategory || r.category}</span>
                            {r.type && r.type !== 'expense' && (
                              <span
                                className={cn(
                                  'shrink-0 text-xs',
                                  r.type === 'income' ? 'text-emerald-400' : 'text-muted-foreground',
                                )}
                              >
                                {RULE_TYPE_LABEL[r.type]}
                              </span>
                            )}
                          </span>
                          <span className="col-start-1 row-start-3 truncate text-xs text-muted-foreground md:col-start-3 md:row-start-1 md:text-sm">
                            <span className="sr-only">on </span>
                            {accountLabel(r)}
                          </span>
                          <ChevronDown
                            aria-hidden="true"
                            className={cn(
                              'col-start-2 row-span-3 row-start-1 size-4 text-muted-foreground transition-transform md:col-start-4 md:row-span-1',
                              open && 'rotate-180',
                            )}
                          />
                        </button>
                        <div
                          id={panelId}
                          role="region"
                          aria-labelledby={rowId}
                          hidden={!open}
                          className="px-4 pb-4 md:px-5 md:pb-5"
                        >
                          {open && (
                            <div className="flex flex-col gap-4 pt-1">
                              <RuleSentence
                                rule={r}
                                accountName={r.accountId ? accountNames.get(r.accountId) : undefined}
                              />
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => setConfirmation({ kind: 'run', rule: r })}
                                  disabled={anyRunPending}
                                  title="Re-apply this rule to every existing matching transaction"
                                >
                                  {running ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                                  {running ? 'Running…' : 'Run on past transactions'}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => setModal({ mode: 'edit', rule: r })}
                                  disabled={!canEditRules}
                                >
                                  <Pencil data-icon="inline-start" />
                                  Edit
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  onClick={() => setConfirmation({ kind: 'delete', rule: r })}
                                  disabled={deleteRule.isPending}
                                >
                                  <Trash2 data-icon="inline-start" />
                                  Delete
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {totalPages > 1 && (
                  <nav
                    aria-label="Rules pages"
                    className="flex items-center justify-end gap-3 border-t border-border px-4 py-3 md:px-5"
                  >
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {firstShown.toLocaleString()}–{lastShown.toLocaleString()} of {filteredRules.length.toLocaleString()}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="Previous page"
                        onClick={() => setPage((value) => Math.max(1, value - 1))}
                        disabled={currentPage === 1}
                      >
                        <ChevronLeft />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="Next page"
                        onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                        disabled={currentPage === totalPages}
                      >
                        <ChevronRight />
                      </Button>
                    </div>
                  </nav>
                )}
              </>
            )}
          </Card>
        </div>
      )}

      {modal && modal.mode === 'create' && (
        <RuleFormModal
          key="create-rule"
          mode="create"
          initial={modal.initial}
          categories={ruleFormCategories}
          accounts={ruleFormAccounts}
          onSave={(input) => createRule.mutateAsync(input)}
          onClose={() => setModal(null)}
        />
      )}
      {modal && modal.mode === 'edit' && (
        <RuleFormModal
          key={`edit-${modal.rule.id}`}
          mode="edit"
          initial={{
            merchant: modal.rule.matchValue,
            accountId: modal.rule.accountId,
            sourceType: modal.rule.sourceType,
            sourceCategory: modal.rule.sourceCategory,
            sourceSubCategory: modal.rule.sourceSubCategory,
            category: modal.rule.category,
            subCategory: modal.rule.subCategory,
            type: modal.rule.type,
          }}
          categories={ruleFormCategories}
          accounts={ruleFormAccounts}
          onSave={(input) =>
            updateRule.mutateAsync({
              id: modal.rule.id,
              patch: {
                expectedVersion: modal.rule.version,
                matchValue: input.matchValue,
                accountId: input.accountId ?? null,
                sourceType: input.sourceType ?? null,
                sourceCategory: input.sourceCategory ?? null,
                sourceSubCategory: input.sourceSubCategory ?? null,
                category: input.category,
                subCategory: input.subCategory,
                // null clears a previously-set type when the user picks
                // "Leave type unchanged" on edit.
                type: input.type ?? null,
              },
            })
          }
          onClose={() => setModal(null)}
        />
      )}

      {confirmation?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete rule for “${confirmation.rule.matchValue}”?`}
          confirmLabel="Delete rule"
          destructive
          onConfirm={() => deleteRule.mutateAsync(confirmation.rule.id)}
          onClose={() => setConfirmation(null)}
        >
          <p>This merchant will no longer be categorized automatically by this rule.</p>
          <p>Transactions categorized previously by the rule keep their current categorization.</p>
        </ConfirmDialog>
      )}
      {confirmation?.kind === 'run' && (
        <ConfirmDialog
          title={`Run rule for “${confirmation.rule.matchValue}”?`}
          confirmLabel="Run rule"
          onConfirm={() => runRule.mutateAsync(confirmation.rule.id)}
          onClose={() => setConfirmation(null)}
        >
          <p>
            Every existing transaction for which this is the most-specific matching rule will be changed to{' '}
            <span className="font-medium fg-primary">
              {categoryPath(confirmation.rule.category, confirmation.rule.subCategory)}
              {confirmation.rule.type ? ` (${RULE_TYPE_LABEL[confirmation.rule.type]})` : ''}
            </span>.
          </p>
          <p>
            Match scope: {confirmation.rule.accountId ? accountNames.get(confirmation.rule.accountId) ?? 'Unknown account' : 'any account'}
            {' · '}{confirmation.rule.sourceType ? RULE_TYPE_LABEL[confirmation.rule.sourceType] : 'any type'}
            {' · '}{confirmation.rule.sourceCategory
              ? categoryPath(confirmation.rule.sourceCategory, confirmation.rule.sourceSubCategory)
              : 'any category'}.
          </p>
          <p>This can overwrite categories or transaction types you set previously.</p>
        </ConfirmDialog>
      )}
      {confirmation?.kind === 'run-all' && (
        <ConfirmDialog
          title="Run all rules on transaction history?"
          confirmLabel="Run all rules"
          onConfirm={() => runAllRules.mutateAsync()}
          onClose={() => setConfirmation(null)}
        >
          <p>Every rule will be applied to all matching existing transactions.</p>
          <p>This can overwrite categories and transaction types you set previously.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Plain-English description of everything a rule matches and sets. */
function RuleSentence({ rule, accountName }: { rule: Rule; accountName?: string }) {
  const sourceType = rule.sourceType ? RULE_TYPE_LABEL[rule.sourceType].toLowerCase() : undefined;
  const source = rule.sourceCategory ? categoryPath(rule.sourceCategory, rule.sourceSubCategory) : undefined;
  const account = rule.accountId ? accountName ?? 'an account that no longer exists' : 'any account';
  const arrives = sourceType && source
    ? ` that arrive as ${sourceType} in ${source}`
    : sourceType
      ? ` that arrive as ${sourceType}`
      : source
        ? ` that arrive in ${source}`
        : '';
  const target = <strong className="font-semibold text-foreground">{categoryPath(rule.category, rule.subCategory)}</strong>;

  return (
    <p className="max-w-3xl text-sm leading-relaxed fg-secondary">
      Transactions from <strong className="font-semibold text-foreground">{rule.matchValue}</strong> on {account}
      {arrives}
      {rule.type
        ? <> are filed as {rule.type} in {target}.</>
        : <> are filed in {target} and keep their type.</>}
    </p>
  );
}

function invalidateRuleRunDependents(qc: QueryClient) {
  for (const queryKey of ['transactions', 'dashboard', 'budget', 'reports', 'reviews']) {
    void qc.invalidateQueries({ queryKey: [queryKey] });
  }
}
