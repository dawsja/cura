import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleHelp, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Spinner } from './ui/spinner';
import { useReviews } from './ReviewsProvider';

const STEP_IDS = [
  'welcome',
  'accounts',
  'connect',
  'manual-account',
  'classify',
  'categories',
  'review',
  'transactions',
  'rules',
  'budget-income',
  'budget-expense',
  'paydown',
  'saveup',
  'reports',
  'recurring',
  'complete',
] as const;

type StepId = (typeof STEP_IDS)[number];
type OnboardingStatus = 'pending' | 'in_progress' | 'completed' | 'dismissed';

interface OnboardingState {
  version: 2;
  runId: string | null;
  status: OnboardingStatus;
  currentStep: StepId;
  skippedSteps: StepId[];
}

interface Account {
  id: string;
  type: string;
  hidden?: boolean;
}

interface StepDefinition {
  title: string;
  body: string;
  target?: string;
  path?: string;
  action: string;
}

const STEPS: Record<StepId, StepDefinition> = {
  welcome: {
    title: 'Build your financial foundation',
    body: 'Connect or add accounts, clean up imported data, review transactions, and create your first monthly budget. You can skip any step or leave the entire tutorial at any time.',
    action: 'Start tutorial',
  },
  accounts: {
    title: 'Start with your accounts',
    body: 'Accounts power balances, transactions, budgets, debt plans, and savings goals. Open Accounts to choose how you want to begin.',
    target: 'nav-accounts',
    action: 'Open accounts',
  },
  connect: {
    title: 'Connect with SimpleFIN',
    body: 'SimpleFIN securely imports account balances and six months of transaction history, then keeps them synchronized. Skip this step if you prefer to enter an account manually.',
    target: 'simplefin-connect',
    path: '/accounts',
    action: 'See the manual option',
  },
  'manual-account': {
    title: 'Or add an account manually',
    body: 'Manual accounts are useful when you do not use SimpleFIN or want to track an account yourself. Choose its type carefully because that determines whether the balance is an asset or amount owed.',
    target: 'manual-account-add',
    path: '/accounts',
    action: 'Continue to classification',
  },
  classify: {
    title: 'Classify imported accounts',
    body: 'If Cura could not infer an account type, use the pencil to classify it. The type determines whether its balance is an asset, debt, or balance-only investment.',
    target: 'unclassified-account-edit',
    path: '/accounts',
    action: 'Continue',
  },
  categories: {
    title: 'Shape your categories',
    body: 'Categories organize income, expenses, and transfers. Transactions and budgets use the leaf subcategories inside each group, and the order you set here is reused on the Budget page.',
    target: 'categories-add',
    path: '/categories',
    action: 'Continue to reviews',
  },
  review: {
    title: 'Review imported transactions',
    body: 'Save & next accepts a transaction. Check Create a rule to teach Cura the merchant. Keep suggestion accepts the imported category without training a rule. Pending reviews do not count in Home or budget actuals.',
    target: 'review-transactions',
    path: '/transactions',
    action: 'Open reviews',
  },
  transactions: {
    title: 'Your transaction workspace',
    body: 'Search and filter your ledger, correct categories inline, or add cash and manual transactions here. Cura can remember merchant corrections as rules.',
    target: 'add-transaction',
    path: '/transactions',
    action: 'Learn about rules',
  },
  rules: {
    title: 'Automate future categorization',
    body: 'Rules remember how merchants should be categorized and typed. Reviews train them automatically, or you can create rules manually and reapply them to matching history.',
    target: 'rules-intro',
    path: '/rules',
    action: 'Create a budget',
  },
  'budget-income': {
    title: 'Plan your income',
    body: 'Enter how much income you expect this month. Values save when you press Enter or leave the field.',
    target: 'budget-plan-income',
    path: '/budget',
    action: 'Income is planned',
  },
  'budget-expense': {
    title: 'Plan an expense',
    body: 'Add a planned amount for at least one expense category. The summary shows how much income remains available to assign.',
    target: 'budget-plan-expense',
    path: '/budget',
    action: 'Explore debt planning',
  },
  paydown: {
    title: 'Build a debt payoff plan',
    body: 'Pay down models credit cards and loans using planned payments, snowball, or avalanche strategies. Save the selected monthly plan into Budget when you are ready.',
    target: 'paydown-summary',
    path: '/paydown',
    action: 'Explore savings goals',
  },
  saveup: {
    title: 'Track savings goals',
    body: 'Save up links each goal to an asset account and tracks progress from its live balance. Use goals for emergency funds, major purchases, or any target you are building toward.',
    target: 'saveup-new-goal',
    path: '/saveup',
    action: 'View reports',
  },
  reports: {
    title: 'Understand your financial trends',
    body: 'Reports turn reviewed transactions into cash-flow, spending, merchant, pace, and net-worth views. You can rearrange report widgets and export your data from this page.',
    target: 'reports-header',
    path: '/reports',
    action: 'Review recurring charges',
  },
  recurring: {
    title: 'Watch recurring spending',
    body: 'Cura detects repeating charges from transaction history and estimates their monthly and yearly impact. Use this page to spot subscriptions and unexpected repeating costs.',
    target: 'recurring-summary',
    path: '/recurring',
    action: 'Finish tutorial',
  },
  complete: {
    title: 'Your financial workspace is ready',
    body: 'You have seen the full workflow: accounts, categories, reviews, rules, budgets, debt, savings goals, reports, and recurring charges. You can run this tutorial again from your profile menu at any time.',
    action: 'Go to Home',
  },
};

interface OnboardingContextValue {
  restart: () => void;
  isSaving: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function FinancialOnboardingProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const reviews = useReviews();
  const stateQ = useQuery({
    queryKey: ['financial-onboarding', userId],
    queryFn: () => api.get<OnboardingState>('/api/onboarding'),
  });
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [reviewReady, setReviewReady] = useState(false);
  const [productOverlayOpen, setProductOverlayOpen] = useState(false);
  const [restartPromptOpen, setRestartPromptOpen] = useState(false);
  const step = stateQ.data?.currentStep ?? 'welcome';
  const status = stateQ.data?.status;

  const save = useMutation({
    mutationFn: ({ state, restart }: { state: OnboardingState; restart: boolean }) =>
      api.put<OnboardingState>('/api/onboarding', { state, restart }),
    onSuccess: (next) => qc.setQueryData(['financial-onboarding', userId], next),
    onError: (_error, variables) => {
      if (variables.restart) setRestartPromptOpen(true);
      void qc.invalidateQueries({ queryKey: ['financial-onboarding', userId] });
    },
    scope: { id: `financial-onboarding-${userId}` },
  });

  const persist = useCallback((next: OnboardingState, restart = false) => {
    qc.setQueryData(['financial-onboarding', userId], next);
    save.mutate({ state: next, restart });
  }, [qc, save, userId]);

  const routeForStep = useCallback((nextStep: StepId) => {
    const path = STEPS[nextStep].path;
    if (path && location.pathname !== path) void navigate(path);
  }, [location.pathname, navigate]);

  const moveTo = useCallback((nextStep: StepId, skippedSteps?: StepId[]) => {
    const current = stateQ.data;
    if (!current) return;
    persist({
      ...current,
      status: nextStep === 'complete' ? 'in_progress' : current.status,
      currentStep: nextStep,
      skippedSteps: skippedSteps ?? current.skippedSteps,
    });
    routeForStep(nextStep);
  }, [persist, routeForStep, stateQ.data]);

  const advance = useCallback((skipped = false) => {
    const current = stateQ.data;
    if (!current) return;
    const index = STEP_IDS.indexOf(current.currentStep);
    const nextStep = STEP_IDS[Math.min(index + 1, STEP_IDS.length - 1)]!;
    const skippedSteps = skipped && !current.skippedSteps.includes(current.currentStep)
      ? [...current.skippedSteps, current.currentStep]
      : current.skippedSteps;
    moveTo(nextStep, skippedSteps);
  }, [moveTo, stateQ.data]);

  const accountsQ = useQuery({
    queryKey: ['accounts', 'all'],
    queryFn: () => api.get<Account[]>('/api/accounts?includeHidden=true'),
    enabled: status === 'in_progress' && step === 'classify',
  });

  useEffect(() => {
    if (status !== 'in_progress' || !accountsQ.data) return;
    if (step === 'classify' && !accountsQ.data.some((account) => !account.hidden && account.type === 'uncategorized')) advance();
  }, [accountsQ.data, advance, status, step]);

  useEffect(() => {
    if (status === 'in_progress' && step === 'accounts' && location.pathname === '/accounts') advance();
  }, [advance, location.pathname, status, step]);

  const refreshReviewCount = reviews.refreshCount;
  useEffect(() => {
    if (status !== 'in_progress' || step !== 'review') {
      setReviewReady(false);
      return;
    }
    let cancelled = false;
    void refreshReviewCount().then((ready) => {
      if (!cancelled) setReviewReady(ready);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshReviewCount, status, step]);

  useEffect(() => {
    if (status === 'in_progress' && step === 'review' && reviewReady && !reviews.isLoading && reviews.count === 0) advance();
  }, [advance, reviewReady, reviews.count, reviews.isLoading, status, step]);

  useEffect(() => {
    const onBudgetSaved = (event: Event) => {
      const type = (event as CustomEvent<{ type: 'income' | 'expense' }>).detail?.type;
      if (status !== 'in_progress') return;
      if (step === 'budget-income' && type === 'income') advance();
      if (step === 'budget-expense' && type === 'expense') advance();
    };
    window.addEventListener('cura:onboarding-budget-saved', onBudgetSaved);
    return () => window.removeEventListener('cura:onboarding-budget-saved', onBudgetSaved);
  }, [advance, status, step]);

  const activeDefinition = status === 'in_progress' ? STEPS[step] : null;
  useEffect(() => {
    const update = () => {
      const overlay = document.querySelector('[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [data-slot="sheet-overlay"]');
      setProductOverlayOpen(overlay !== null);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!activeDefinition?.path || location.pathname === activeDefinition.path) return;
    void navigate(activeDefinition.path);
  }, [activeDefinition?.path, location.pathname, navigate]);

  useEffect(() => {
    if (!activeDefinition?.target || reviews.isOpen || productOverlayOpen) {
      setTargetRect(null);
      return;
    }

    const targetName = activeDefinition.target;
    let resizeObserver: ResizeObserver | undefined;
    const update = () => {
      const candidates = document.querySelectorAll<HTMLElement>(`[data-onboarding-target="${targetName}"]`);
      const target = [...candidates].find((element) => element.offsetParent !== null);
      if (!target) {
        setTargetRect(null);
        return;
      }
      const navTarget = targetName.startsWith('nav-');
      target.scrollIntoView({ block: window.innerWidth < 768 && !navTarget ? 'start' : 'nearest', inline: 'nearest' });
      setTargetRect(target.getBoundingClientRect());
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => setTargetRect(target.getBoundingClientRect()));
      resizeObserver.observe(target);
    };
    const timer = window.setTimeout(update, 50);
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
    };
  }, [activeDefinition?.target, location.pathname, productOverlayOpen, reviews.isOpen]);

  const start = () => {
    const current = stateQ.data;
    if (!current) return;
    const restarting = restartPromptOpen;
    setProductOverlayOpen(false);
    setRestartPromptOpen(false);
    persist(
      { ...current, runId: createRunId(), status: 'in_progress', currentStep: 'accounts', skippedSteps: [] },
      restarting,
    );
  };
  const dismiss = () => {
    if (restartPromptOpen) {
      setRestartPromptOpen(false);
      return;
    }
    const current = stateQ.data;
    if (!current) return;
    persist({ ...current, status: 'dismissed' });
  };
  const skipAll = () => {
    const current = stateQ.data;
    if (!current) return;
    persist({ ...current, status: 'dismissed' });
  };
  const finish = () => {
    const current = stateQ.data;
    if (!current) return;
    persist({ ...current, status: 'completed', currentStep: 'complete' });
    void navigate('/');
  };
  const restart = useCallback(() => {
    setProductOverlayOpen(false);
    setRestartPromptOpen(true);
    void navigate('/');
  }, [navigate]);

  const primaryAction = () => {
    if (step === 'accounts') {
      moveTo('connect');
      return;
    }
    if (step === 'review') {
      reviews.openModal();
      return;
    }
    advance();
  };

  const value = useMemo(() => ({ restart, isSaving: save.isPending }), [restart, save.isPending]);
  const modalOpen = status === 'pending' || restartPromptOpen || (status === 'in_progress' && step === 'complete');
  const taskRequired = step === 'classify' || step === 'budget-income' || step === 'budget-expense';

  return (
    <OnboardingContext.Provider value={value}>
      <div className="contents" inert={modalOpen ? true : undefined} aria-hidden={modalOpen ? true : undefined}>
        {children}
      </div>
      {(status === 'pending' || restartPromptOpen) && (
        <OnboardingModal
          title={STEPS.welcome.title}
          body={STEPS.welcome.body}
          primaryLabel="Start tutorial"
          secondaryLabel="Not now"
          onPrimary={start}
          onSecondary={dismiss}
          busy={save.isPending}
          error={save.error?.message}
        />
      )}
      {status === 'in_progress' && step !== 'complete' && !restartPromptOpen && !reviews.isOpen && !productOverlayOpen && (
        <Coachmark
          step={step}
          definition={STEPS[step]}
          targetRect={targetRect}
          onPrimary={primaryAction}
          onSkip={() => advance(true)}
          onSkipAll={skipAll}
          busy={save.isPending}
          primaryDisabled={taskRequired}
          error={save.error?.message}
        />
      )}
      {status === 'in_progress' && step === 'complete' && (
        <OnboardingModal
          title={STEPS.complete.title}
          body={STEPS.complete.body}
          primaryLabel="Go to Home"
          secondaryLabel="Close"
          onPrimary={finish}
          onSecondary={finish}
          busy={save.isPending}
          error={save.error?.message}
          complete
        />
      )}
    </OnboardingContext.Provider>
  );
}

export function useFinancialOnboarding(): OnboardingContextValue {
  const context = useContext(OnboardingContext);
  if (!context) throw new Error('useFinancialOnboarding() called outside <FinancialOnboardingProvider>');
  return context;
}

function OnboardingModal({
  title,
  body,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  busy,
  error,
  complete = false,
}: {
  title: string;
  body: string;
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void;
  onSecondary: () => void;
  busy: boolean;
  error?: string;
  complete?: boolean;
}) {
  const primaryRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onSecondary();
      }}
    >
      <DialogContent
        className="sm:max-w-lg shadow-2xl"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          primaryRef.current?.focus();
        }}
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {complete ? <Check className="size-6" /> : <CircleHelp className="size-6" />}
        </div>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-6">{body}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Could not save tutorial progress: {error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onSecondary} disabled={busy}>{secondaryLabel}</Button>
          <Button ref={primaryRef} onClick={onPrimary} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Coachmark({
  step,
  definition,
  targetRect,
  onPrimary,
  onSkip,
  onSkipAll,
  busy,
  primaryDisabled,
  error,
}: {
  step: StepId;
  definition: StepDefinition;
  targetRect: DOMRect | null;
  onPrimary: () => void;
  onSkip: () => void;
  onSkipAll: () => void;
  busy: boolean;
  primaryDisabled: boolean;
  error?: string;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 });
  const progressIndex = STEP_IDS.indexOf(step);
  const style = coachmarkPosition(targetRect, cardSize);
  const highlightStyle: CSSProperties | undefined = targetRect ? {
    left: Math.max(4, targetRect.left - 6),
    top: Math.max(4, targetRect.top - 6),
    width: targetRect.width + 12,
    height: targetRect.height + 12,
  } : undefined;

  useEffect(() => {
    if (!cardRef.current) return;
    const card = cardRef.current;
    const updateSize = () => {
      const rect = card.getBoundingClientRect();
      setCardSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {highlightStyle && <div className="onboarding-spotlight fixed z-50 rounded-xl" style={highlightStyle} aria-hidden="true" />}
      <section
        ref={cardRef}
        className="onboarding-coachmark fixed z-[60] w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-default bg-surface p-4 shadow-2xl"
        style={style}
        role="dialog"
        aria-live="polite"
        aria-labelledby="onboarding-coachmark-title"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-primary">Getting started · {progressIndex} of {STEP_IDS.length - 2}</span>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onSkipAll} aria-label="Skip entire tutorial">
            <X />
          </Button>
        </div>
        <h2 id="onboarding-coachmark-title" className="mt-2 text-lg font-semibold">{definition.title}</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{definition.body}</p>
        {error && (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription>Could not save progress: {error}</AlertDescription>
          </Alert>
        )}
        {!targetRect && <p className="mt-2 text-xs text-primary">The highlighted control is loading. You can skip this step if it does not apply.</p>}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onSkipAll} disabled={busy}>Skip all</Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onSkip} disabled={busy}>Skip</Button>
            <Button size="sm" onClick={onPrimary} disabled={busy || primaryDisabled}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {definition.action}
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}

function coachmarkPosition(rect: DOMRect | null, card: { width: number; height: number }): CSSProperties {
  const gap = 16;
  if (card.width === 0 || card.height === 0) return { left: gap, top: gap, visibility: 'hidden' };
  if (!rect) {
    return {
      left: Math.max(gap, (window.innerWidth - card.width) / 2),
      top: Math.max(gap, (window.innerHeight - card.height) / 2),
    };
  }

  const viewportBottom = window.innerWidth < 768 ? window.innerHeight - 96 : window.innerHeight - gap;
  const clampLeft = (left: number) => Math.min(Math.max(gap, left), window.innerWidth - card.width - gap);
  const clampTop = (top: number) => Math.min(Math.max(gap, top), viewportBottom - card.height);
  const rightFits = rect.right + gap + card.width <= window.innerWidth - gap;
  const leftFits = rect.left - gap - card.width >= gap;
  const belowFits = rect.bottom + gap + card.height <= viewportBottom;
  const aboveFits = rect.top - gap - card.height >= gap;
  const candidates = window.innerWidth < 768
    ? [
        aboveFits && { left: clampLeft(rect.left + (rect.width - card.width) / 2), top: rect.top - gap - card.height },
        belowFits && { left: clampLeft(rect.left + (rect.width - card.width) / 2), top: rect.bottom + gap },
        rightFits && { left: rect.right + gap, top: clampTop(rect.top) },
        leftFits && { left: rect.left - gap - card.width, top: clampTop(rect.top) },
      ]
    : [
        rightFits && { left: rect.right + gap, top: clampTop(rect.top) },
        leftFits && { left: rect.left - gap - card.width, top: clampTop(rect.top) },
        belowFits && { left: clampLeft(rect.left), top: rect.bottom + gap },
        aboveFits && { left: clampLeft(rect.left), top: rect.top - gap - card.height },
      ];
  const position = candidates.find((candidate) => candidate !== false);
  if (position) return position;

  const spaceAbove = Math.max(0, rect.top - gap * 2);
  const spaceBelow = Math.max(0, viewportBottom - rect.bottom - gap);
  if (spaceAbove >= spaceBelow) {
    return {
      left: clampLeft(rect.left + (rect.width - card.width) / 2),
      top: gap,
      maxHeight: Math.max(96, spaceAbove),
      overflowY: 'auto',
    };
  }
  return {
    left: clampLeft(rect.left + (rect.width - card.width) / 2),
    top: rect.bottom + gap,
    maxHeight: Math.max(96, spaceBelow),
    overflowY: 'auto',
  };
}

function createRunId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
