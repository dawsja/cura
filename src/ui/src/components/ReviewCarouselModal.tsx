import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Inbox, ListChecks, X } from 'lucide-react';
import { api } from '../lib/api';
import { formatMoney, parseLocalDate } from '../lib/format';
import {
  confirmReviewedTransactionRule,
  createReviewedTransactionRule,
  type ReviewDecisionResult,
  type ReviewRule,
  type ReviewTransaction,
} from '../lib/reviews';
import { CategoryPicker, categoriesForType, type PickerCategory } from './CategoryPicker';
import { cn } from '@/lib/utils';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

type TxType = 'income' | 'expense' | 'transfer';

interface EditState {
  category: string;
  subCategory: string;
  type: TxType;
}

interface Assignment {
  category: string;
  subCategory: string;
}

const TYPES: { value: TxType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
];

/** Past this many items the segmented bar gets too thin, so a plain bar is used. */
const MAX_SEGMENTS = 40;
const DESKTOP_QUERY = '(min-width: 768px)';

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return isDesktop;
}

/** "Uncategorized" is a real sub-category, but confirming it decides nothing. */
function isPlaceholder(subCategory: string | undefined): boolean {
  return !subCategory || /uncategori[sz]ed/i.test(subCategory);
}

function sameAssignment(a: Assignment, b: Assignment): boolean {
  return a.category === b.category && a.subCategory === b.subCategory;
}

function defaultEdit(tx: ReviewTransaction): EditState {
  const real = !isPlaceholder(tx.subCategory);
  return {
    category: real ? tx.category : '',
    subCategory: real ? tx.subCategory ?? '' : '',
    type: tx.type,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function sameYear(date: Date): boolean {
  return date.getFullYear() === new Date().getFullYear();
}

function shortDate(iso: string): string {
  const date = parseLocalDate(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear(date) ? {} : { year: 'numeric' }),
  });
}

function budgetMonth(iso: string): string {
  const date = parseLocalDate(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    month: 'long',
    ...(sameYear(date) ? {} : { year: 'numeric' }),
  });
}

/** How the scoped rule from /api/rules/from-transaction matches future imports. */
function ruleNoun(tx: ReviewTransaction): string {
  if (!tx.sourceClassificationTrusted) return 'transactions';
  if (tx.sourceType === 'income') return 'deposits';
  if (tx.sourceType === 'transfer') return 'transfers';
  return 'charges';
}

function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded border border-current/25 px-1 font-sans text-[11px] font-medium opacity-70',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export interface ReviewCarouselModalProps {
  queue: ReviewTransaction[];
  pendingCount: number;
  completedCount: number;
  isLoading: boolean;
  queueError: string | null;
  isMutating: boolean;
  onRetryQueue: () => Promise<void>;
  onClose: () => void;
  onDecide: (
    id: string,
    payload: {
      action: 'skip' | 'categorize';
      category?: string;
      subCategory?: string | null;
      type?: TxType;
    },
  ) => Promise<ReviewDecisionResult>;
  onSkipAll: () => Promise<void>;
}

export function ReviewCarouselModal({
  queue,
  pendingCount,
  completedCount,
  isLoading,
  queueError,
  isMutating,
  onRetryQueue,
  onClose,
  onDecide,
  onSkipAll,
}: ReviewCarouselModalProps) {
  const queryClient = useQueryClient();
  const isDesktop = useIsDesktop();
  const rememberId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [err, setErr] = useState<string | null>(null);
  const [rememberRules, setRememberRules] = useState<Record<string, boolean>>({});
  const [ruleConfirmation, setRuleConfirmation] = useState<{
    transactionId: string;
    rule: ReviewRule;
  } | null>(null);
  const [ruleOperation, setRuleOperation] = useState<{
    transactionId: string;
    status: 'pending' | 'error';
    error?: string;
  } | null>(null);
  const [confirmAcceptAll, setConfirmAcceptAll] = useState(false);

  const cats = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<PickerCategory[]>('/api/categories'),
    staleTime: 60_000,
  });

  // Skipped rows stay in the server queue; forget ids that have left it.
  const queueIds = useMemo(() => new Set(queue.map((row) => row.id)), [queue]);
  const skippedInQueue = useMemo(
    () => queue.filter((row) => skipped.has(row.id)).length,
    [queue, skipped],
  );

  const slide = queue.find((row) => !skipped.has(row.id)) ?? null;
  const edit = slide ? edits[slide.id] ?? defaultEdit(slide) : null;
  const editType = edit?.type ?? 'expense';
  const blocking = Boolean(ruleConfirmation || confirmAcceptAll || ruleOperation?.status === 'pending');
  const closeLocked = isMutating || ruleOperation?.status === 'pending';

  const updateEdit = useCallback((id: string, patch: Partial<EditState>) => {
    setEdits((prev) => {
      const current = queue.find((row) => row.id === id);
      if (!current) return prev;
      const base = prev[id] ?? defaultEdit(current);
      return { ...prev, [id]: { ...base, ...patch } };
    });
  }, [queue]);

  const visibleCats = useMemo(
    () => (cats.data ? categoriesForType(cats.data, editType) : []),
    [cats.data, editType],
  );
  const isValid = useCallback(
    (a: Assignment) =>
      visibleCats.some((category) =>
        category.name === a.category && category.subCategories.some((sub) => sub.name === a.subCategory),
      ),
    [visibleCats],
  );

  // Changing the type can strand a category that belongs to another type.
  useEffect(() => {
    if (!edit || !cats.data || !slide) return;
    if ((edit.category || edit.subCategory) && !isValid(edit)) {
      updateEdit(slide.id, { category: '', subCategory: '' });
    }
  }, [cats.data, edit, isValid, slide, updateEdit]);

  const selection = edit && edit.category && edit.subCategory && isValid(edit)
    ? { category: edit.category, subCategory: edit.subCategory }
    : null;

  const createScopedRule = useCallback(async (transactionId: string) => {
    setRuleOperation({ transactionId, status: 'pending' });
    try {
      const ruleResult = await createReviewedTransactionRule(transactionId);
      queryClient.invalidateQueries({ queryKey: ['rules'] });
      setRuleOperation(null);
      if (ruleResult.status === 'confirmation_required') {
        setRuleConfirmation({ transactionId, rule: ruleResult.rule });
      }
    } catch (caught) {
      setRuleOperation({
        transactionId,
        status: 'error',
        error: caught instanceof Error ? caught.message : 'unknown error',
      });
    }
  }, [queryClient]);

  const handleSkip = useCallback(() => {
    if (!slide || isMutating) return;
    setErr(null);
    setSkipped((prev) => new Set([...prev].filter((id) => queueIds.has(id)).concat(slide.id)));
    contentRef.current?.focus();
  }, [isMutating, queueIds, slide]);

  const handleAcceptAll = useCallback(async () => {
    if (isMutating || pendingCount === 0) return;
    setErr(null);
    try {
      await onSkipAll();
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : 'Could not accept all suggestions.');
      throw caught;
    }
  }, [isMutating, onSkipAll, pendingCount]);

  const canConfirm = Boolean(slide && selection && !isMutating);

  const handleConfirm = useCallback(async () => {
    if (!slide || !edit || !selection || isMutating) return;
    setErr(null);
    // An untouched suggestion only clears the review flag, as before, so it
    // is not marked as a manual category change.
    const unchanged = sameAssignment(selection, { category: slide.category, subCategory: slide.subCategory ?? '' })
      && edit.type === slide.type;
    try {
      await onDecide(
        slide.id,
        unchanged
          ? { action: 'skip' }
          : { action: 'categorize', category: selection.category, subCategory: selection.subCategory, type: edit.type },
      );
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : 'Could not save this category.');
      return;
    }
    if (rememberRules[slide.id] === true) {
      await createScopedRule(slide.id);
    }
    contentRef.current?.focus();
  }, [createScopedRule, edit, isMutating, onDecide, rememberRules, selection, slide]);

  const total = Math.max(completedCount + pendingCount, 1);
  const position = Math.min(completedCount + skippedInQueue + 1, total);
  const remainingAfter = pendingCount - skippedInQueue - 1;
  const isLoadingFirst = isLoading && !queueError;
  const isFinished = !isLoading && pendingCount === 0 && completedCount > 0 && !isMutating && !ruleOperation;
  const isEmpty = !isLoading && queue.length === 0 && pendingCount === 0 && completedCount === 0 && !isMutating;
  const waitingForRows = !isFinished && !isEmpty && !queueError && queue.length === 0 && !ruleOperation && (pendingCount > 0 || isMutating);
  const queueFailed = Boolean(queueError && queue.length === 0 && !isLoadingFirst);
  const allSkipped = !isLoading && queue.length > 0 && !slide && !ruleOperation && !isMutating;
  const reviewing = Boolean(slide && edit && !ruleOperation && !isLoadingFirst && !isFinished && !isEmpty);
  const remember = slide ? rememberRules[slide.id] === true : false;
  const confirmLabel = remainingAfter > 0 ? 'Confirm and next' : 'Confirm and finish';

  // Desktop keyboard flow: Enter confirms, S skips.
  useEffect(() => {
    if (!isDesktop || !reviewing || blocking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target
        && (target.isContentEditable || target.closest('input, textarea, select, [data-slot="popover-content"]'))
      ) return;
      // CategoryPicker (or any other popover) is open.
      if (document.querySelector('[data-slot="popover-content"]')) return;
      if (!slide) return;

      if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        handleSkip();
        return;
      }
      if (event.key === 'Enter') {
        // Buttons keep their own Enter, except the type switch and the
        // checkbox, where Enter would otherwise do nothing useful.
        const ownsEnter = target?.closest('button, a, [role="button"]')
          && !target.closest('[data-slot="toggle-group-item"], [role="checkbox"]');
        if (ownsEnter) return;
        event.preventDefault();
        if (canConfirm) void handleConfirm();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [blocking, canConfirm, handleConfirm, handleSkip, isDesktop, reviewing, slide]);

  const requestClose = (open: boolean) => {
    if (!open && !closeLocked && !blocking) onClose();
  };

  const counter = reviewing ? (
    <span className="shrink-0 text-sm text-muted-foreground tabular-nums" aria-live="polite">
      {position} of {total}
    </span>
  ) : null;
  const progress = reviewing ? (
    <ReviewProgress total={total} completed={completedCount} skipped={skippedInQueue} />
  ) : null;

  const body = (
    <>
      {reviewing && slide && edit ? (
        <div className="flex flex-col gap-5">
          <TransactionHeading transaction={slide} type={edit.type} />

          <ToggleGroup
            type="single"
            value={edit.type}
            onValueChange={(value) => {
              if (value) updateEdit(slide.id, { type: value as TxType });
            }}
            spacing={1}
            className="grid w-full grid-cols-3 rounded-xl bg-muted p-1"
            aria-label="Transaction type"
            disabled={isMutating}
          >
            {TYPES.map((type) => (
              <ToggleGroupItem
                key={type.value}
                value={type.value}
                className="h-11 w-full data-[state=on]:font-semibold data-[state=on]:shadow-sm data-[state=on]:ring-1 data-[state=on]:ring-border-strong md:h-8"
              >
                {type.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Field>
            <FieldLabel>Category</FieldLabel>
            {cats.isLoading ? (
              <Skeleton className="h-11 w-full md:h-8" />
            ) : (
              <CategoryPicker
                categories={cats.data ?? []}
                value={selection}
                type={edit.type}
                placeholder="Choose a category"
                onSelect={(pick) => {
                  if (pick) updateEdit(slide.id, pick);
                }}
                disabled={isMutating || !cats.data}
                aria-label="Category"
                className="h-11 md:h-8"
              />
            )}
            {cats.isError ? (
              <Alert variant="destructive">
                <AlertDescription>Categories could not be loaded.</AlertDescription>
                <AlertAction>
                  <Button type="button" size="sm" variant="outline" onClick={() => void cats.refetch()}>
                    Retry
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
          </Field>

          <Field orientation="horizontal" data-disabled={isMutating || undefined}>
            <Checkbox
              id={rememberId}
              checked={remember}
              onCheckedChange={(checked) => setRememberRules((current) => ({
                ...current,
                [slide.id]: checked === true,
              }))}
              disabled={isMutating}
            />
            <FieldContent>
              <FieldLabel htmlFor={rememberId} className="font-normal">
                Do this automatically next time
              </FieldLabel>
              <FieldDescription>
                Future {slide.merchant} {ruleNoun(slide)} on {slide.account} go to{' '}
                {selection ? selection.subCategory : 'the category you pick'}.
              </FieldDescription>
            </FieldContent>
          </Field>

          {err ? (
            <Alert variant="destructive">
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          ) : null}
          {queueError ? (
            <Alert variant="destructive">
              <AlertDescription>{queueError}</AlertDescription>
              <AlertAction>
                <Button type="button" size="sm" variant="outline" onClick={() => void onRetryQueue()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {isLoadingFirst || waitingForRows ? <ReviewLoadingState /> : null}

      {ruleOperation?.status === 'pending' ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Creating rule</EmptyTitle>
            <EmptyDescription>Checking existing rules for this merchant…</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {ruleOperation?.status === 'error' ? (
        <Alert variant="destructive">
          <AlertTitle>The transaction is saved, but the rule was not created</AlertTitle>
          <AlertDescription>{ruleOperation.error}</AlertDescription>
        </Alert>
      ) : null}

      {queueFailed ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load reviews</AlertTitle>
          <AlertDescription>{queueError}</AlertDescription>
          <AlertAction>
            <Button type="button" size="sm" variant="outline" onClick={() => void onRetryQueue()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {allSkipped ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>{plural(skippedInQueue, 'transaction')} left for later</EmptyTitle>
            <EmptyDescription>
              Skipped transactions stay in your review queue and are not counted in your budget until you confirm them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {isEmpty || isFinished ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {isFinished ? <CircleCheck /> : <Inbox />}
            </EmptyMedia>
            <EmptyTitle>{isFinished ? 'You’re all caught up' : 'Nothing to review'}</EmptyTitle>
            <EmptyDescription>
              {isFinished
                ? `You reviewed ${plural(completedCount, 'transaction')}.`
                : 'New SimpleFIN imports wait here for confirmation before they show up on Home.'}
            </EmptyDescription>
          </EmptyHeader>
          {isFinished && isDesktop ? (
            <EmptyContent>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}
    </>
  );

  // Footer actions per state. Review actions differ by layout; the rest share.
  const acceptAllButton = (
    <Button
      type="button"
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => setConfirmAcceptAll(true)}
      disabled={isMutating || pendingCount === 0}
    >
      <ListChecks data-icon="inline-start" />
      Accept all
    </Button>
  );
  const confirmButton = (
    <Button
      type="button"
      onClick={() => void handleConfirm()}
      disabled={!canConfirm}
      className={cn(!isDesktop && 'w-full')}
    >
      {isMutating ? <Spinner data-icon="inline-start" /> : null}
      {isMutating ? 'Saving…' : confirmLabel}
      {isDesktop && !isMutating ? <Kbd className="ml-1">Enter</Kbd> : null}
    </Button>
  );
  const skipButton = (
    <Button
      type="button"
      variant={isDesktop ? 'outline' : 'ghost'}
      onClick={handleSkip}
      disabled={isMutating}
    >
      Skip for now
      {isDesktop ? <Kbd className="ml-1">S</Kbd> : null}
    </Button>
  );

  let footer: ReactNode = null;
  if (reviewing) {
    footer = isDesktop ? (
      <>
        <span className="mr-auto">{acceptAllButton}</span>
        {skipButton}
        {confirmButton}
      </>
    ) : (
      <>
        {confirmButton}
        <div className="grid grid-cols-2 gap-2">
          {skipButton}
          {acceptAllButton}
        </div>
      </>
    );
  } else if (ruleOperation?.status === 'error') {
    footer = (
      <>
        <Button type="button" variant="outline" onClick={() => setRuleOperation(null)}>
          Continue without rule
        </Button>
        <Button type="button" onClick={() => void createScopedRule(ruleOperation.transactionId)}>
          Retry rule
        </Button>
      </>
    );
  } else if (allSkipped) {
    footer = (
      <>
        <Button type="button" variant="outline" onClick={() => setSkipped(new Set())}>
          Go through skipped
        </Button>
        <Button type="button" onClick={onClose}>
          Close
        </Button>
      </>
    );
  } else if (queueFailed || isEmpty) {
    footer = (
      <Button type="button" variant="outline" onClick={onClose}>
        Close
      </Button>
    );
  } else if (isFinished && !isDesktop) {
    footer = (
      <Button type="button" onClick={onClose}>
        Done
      </Button>
    );
  }

  const srDescription = 'Confirm the category for each imported transaction.';

  return (
    <>
      {isDesktop ? (
        <Dialog open onOpenChange={requestClose}>
          <DialogContent
            ref={contentRef}
            className="gap-5 p-6 sm:max-w-[540px]"
            showCloseButton={!closeLocked}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              contentRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              if (closeLocked || blocking) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (closeLocked || blocking) event.preventDefault();
            }}
          >
            <DialogHeader className="gap-3">
              <div className="flex items-center justify-between gap-3 pr-8">
                <DialogTitle className="text-lg font-semibold">Review imported transactions</DialogTitle>
                {counter}
              </div>
              {progress}
              <DialogDescription className="sr-only">
                {srDescription} Press Enter to confirm, S to skip.
              </DialogDescription>
            </DialogHeader>
            {body}
            {footer ? (
              <DialogFooter className="-mx-6 -mb-6 items-center px-6 py-4">{footer}</DialogFooter>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : (
        <Drawer open onOpenChange={requestClose} dismissible={!closeLocked && !blocking}>
          <DrawerContent ref={contentRef} className="max-h-[92dvh]">
            <DrawerHeader className="gap-2.5 px-5 pt-3 pb-0 text-left">
              <div className="flex items-center justify-between gap-3">
                <DrawerTitle className="font-semibold">Review imported</DrawerTitle>
                <div className="-mr-3 flex items-center gap-1">
                  {counter}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => requestClose(false)}
                    disabled={closeLocked || blocking}
                    aria-label="Close"
                  >
                    <X />
                  </Button>
                </div>
              </div>
              {progress}
              <DrawerDescription className="sr-only">{srDescription}</DrawerDescription>
            </DrawerHeader>
            <div className="min-h-0 overflow-y-auto px-5 pt-4 pb-5">{body}</div>
            {footer ? (
              <DrawerFooter className="mt-0 gap-1 border-t px-5 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
                {footer}
              </DrawerFooter>
            ) : null}
          </DrawerContent>
        </Drawer>
      )}

      {confirmAcceptAll ? (
        <ConfirmDialog
          title="Accept all suggestions?"
          confirmLabel={`Accept ${plural(pendingCount, 'transaction')}`}
          onConfirm={async () => {
            await handleAcceptAll();
            setConfirmAcceptAll(false);
          }}
          onClose={() => setConfirmAcceptAll(false)}
        >
          <p>
            This keeps the suggested category and type for {plural(pendingCount, 'pending transaction')} without
            creating rules.
          </p>
        </ConfirmDialog>
      ) : null}

      {ruleConfirmation ? (
        <ConfirmDialog
          title={ruleConfirmation.rule.accountId ? 'Update existing scoped rule?' : 'Narrow existing broad rule?'}
          confirmLabel={ruleConfirmation.rule.accountId ? 'Update rule' : 'Narrow rule'}
          onConfirm={async () => {
            const result = await confirmReviewedTransactionRule(ruleConfirmation.transactionId, ruleConfirmation.rule);
            if (result.status === 'confirmation_required') {
              setRuleConfirmation({ transactionId: ruleConfirmation.transactionId, rule: result.rule });
              throw new Error('The matching rule changed. Review the updated rule and confirm again.');
            }
            queryClient.invalidateQueries({ queryKey: ['rules'] });
          }}
          onClose={() => setRuleConfirmation(null)}
        >
          <p>
            The existing rule for <span className="font-medium text-foreground">{ruleConfirmation.rule.matchValue}</span>
            {' '}currently sets {ruleConfirmation.rule.category}
            {ruleConfirmation.rule.subCategory ? ` › ${ruleConfirmation.rule.subCategory}` : ''}.
          </p>
          <p>Confirming replaces it with this transaction&apos;s scoped conditions and assignment.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function ReviewProgress({ total, completed, skipped }: { total: number; completed: number; skipped: number }) {
  const label = `${completed} of ${total} reviewed`;
  if (total > MAX_SEGMENTS) {
    return <Progress value={(completed / total) * 100} className="h-1" aria-label={label} />;
  }
  const current = completed + skipped;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      aria-label={label}
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-1 rounded-full',
            i < completed && 'bg-primary',
            i >= completed && i < current && 'bg-muted-foreground/40',
            i === current && 'bg-primary/45',
            i > current && 'bg-border-strong',
          )}
        />
      ))}
    </div>
  );
}

function TransactionHeading({ transaction, type }: { transaction: ReviewTransaction; type: TxType }) {
  const sign = type === 'income' ? '+' : type === 'expense' ? '−' : '';
  const month = budgetMonth(transaction.date);

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-sm text-muted-foreground">
          {shortDate(transaction.date)}, {transaction.account}
        </p>
        <p className="line-clamp-2 text-xl font-semibold tracking-tight break-words text-foreground">
          {transaction.merchant}
        </p>
        {transaction.notes && transaction.notes !== transaction.merchant ? (
          <p className="truncate font-mono text-xs text-muted-foreground" title={transaction.notes}>
            {transaction.notes}
          </p>
        ) : null}
        {/* Pending reviews are excluded from budget, dashboard, and report totals. */}
        {type !== 'transfer' && month ? (
          <p className="text-sm text-muted-foreground">
            Not in your {month} budget until you confirm it.
          </p>
        ) : null}
      </div>
      <p
        className={cn(
          'shrink-0 text-xl font-semibold tabular-nums',
          type === 'income' ? 'text-emerald-400' : type === 'transfer' ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {sign}
        {formatMoney(transaction.amount)}
      </p>
    </div>
  );
}

function ReviewLoadingState() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-6 w-3/5" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <Skeleton className="h-6 w-20" />
      </div>
      <Skeleton className="h-11 w-full rounded-xl md:h-10" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-24 rounded-full md:h-9" />
        ))}
      </div>
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
