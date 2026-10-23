/**
 * Save up — savings goals ("save up for X") watched against a single
 * account.
 *
 * Each goal card shows the goal name, the watched account, the live
 * balance, the target, and an animated milestone progress bar. Active
 * goals use the CTA accent while reached goals use the success tone.
 *
 * Clicking a card opens an edit modal for that goal. Adding a new
 * goal opens the same modal in "create" mode (no X-to-close needed
 * when creating — there's no destructive action to abandon; users
 * can just click outside or hit the X to dismiss). Editing shows a
 * Delete button at the bottom of the modal so it's only reachable
 * through the destructive intent path.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { api } from '../lib/api';
import { currencySymbol, formatMoney } from '../lib/format';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  PiggyBank,
  Plus,
  Check,
  Pencil,
  Trash2,
  Target,
  WalletCards,
  Link,
  Link2Off,
  Trophy,
  Sparkles,
  TrendingUp,
  AlertTriangle,
} from 'lucide-react';
import clsx from 'clsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { AsyncQueryState } from '../components/ui/AsyncQueryState';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { GoalProgressBar } from '../components/GoalProgressBar';

interface Goal {
  id: string;
  name: string;
  target: number;
  startingValue: number;
  accountId: string | null;
  accountBalance: number | null;
  accountName: string | null;
}

interface Account {
  id: string;
  name: string;
  type: string;
  hidden: boolean;
}

const MILESTONES = [25, 50, 75, 100] as const;

export function SaveUp() {
  const qc = useQueryClient();
  const goals = useQuery({ queryKey: ['goals'], queryFn: () => api.get<Goal[]>('/api/goals') });
  const accounts = useQuery({
    queryKey: ['accounts', { forGoal: true }],
    // We need hidden accounts too — a user might want to attach a goal
    // to a hidden account they still track. (`?includeHidden=true`.)
    queryFn: () => api.get<Account[]>('/api/accounts?includeHidden=true'),
  });

  const [openGoalId, setOpenGoalId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);

  if (goals.isLoading || accounts.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-foreground">Save up</h1>
        <AsyncQueryState status="loading" title="Loading savings goals…" message="Fetching your goals and available accounts." />
      </div>
    );
  }

  if (goals.isError || accounts.isError) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-foreground">Save up</h1>
        <AsyncQueryState
          status="error"
          title="Could not load savings goals"
          message="Goals and account balances are unavailable. No progress amounts are being shown."
          onRetry={() => void Promise.all([goals.refetch(), accounts.refetch()])}
          retrying={goals.isFetching || accounts.isFetching}
        />
      </div>
    );
  }

  const list = goals.data ?? [];
  const accList = (accounts.data ?? []).filter(
    (a) => a.type !== 'credit' && a.type !== 'loan' && a.type !== 'uncategorized',
  );
  const reachedGoals = list.filter((goal) => goal.accountBalance !== null && goal.accountBalance >= goal.target);
  const activeGoals = list.filter((goal) => goal.accountBalance === null || goal.accountBalance < goal.target);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Save up</h1>
        <Button
          type="button"
          onClick={() => setCreatingNew(true)}
          data-onboarding-target="saveup-new-goal"
        >
          <Plus data-icon="inline-start" /> New goal
        </Button>
      </div>

      <p className="max-w-xl text-sm text-muted-foreground">
        Pick a savings goal and the account you're stashing money in.
        The progress bar tracks that account's live balance — every
        dollar in counts toward your target.
      </p>

      {accList.length === 0 && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>A savings goal needs an eligible account</AlertTitle>
          <AlertDescription>
            Add a cash, checking, savings, or investment account from Accounts, then return here to track its balance.
          </AlertDescription>
        </Alert>
      )}

      {list.length > 0 && (
        <Card>
          <CardContent className="flex items-center gap-3">
            <div className={clsx(
              'flex size-9 shrink-0 items-center justify-center rounded-full',
              reachedGoals.length > 0
                ? 'bg-emerald-900/40 text-emerald-400'
                : 'bg-primary/15 text-primary',
            )}>
              {reachedGoals.length > 0 ? <Sparkles className="size-4" /> : <TrendingUp className="size-4" />}
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground">
                {reachedGoals.length} of {list.length} {list.length === 1 ? 'goal' : 'goals'} reached
              </div>
              <div className="text-xs text-muted-foreground">
                {reachedGoals.length === list.length
                  ? 'Every goal is funded. Nice work.'
                  : reachedGoals.length > 0
                    ? `${list.length - reachedGoals.length} still in progress.`
                    : 'Every contribution moves you closer.'}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {list.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PiggyBank />
            </EmptyMedia>
            <EmptyTitle>Start with one goal</EmptyTitle>
            <EmptyDescription>
              Choose what you're saving for and link the account whose balance should count toward it.
            </EmptyDescription>
          </EmptyHeader>
          {accList.length > 0 && (
            <EmptyContent>
              <Button
                type="button"
                onClick={() => setCreatingNew(true)}
              >
                <Plus data-icon="inline-start" aria-hidden="true" /> Create your first goal
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {activeGoals.length > 0 && (
            <GoalGroup
              title={reachedGoals.length > 0 ? 'In progress' : undefined}
              goals={activeGoals}
              allGoals={list}
              onOpen={setOpenGoalId}
            />
          )}
          {reachedGoals.length > 0 && (
            <GoalGroup
              title="Reached"
              goals={reachedGoals}
              allGoals={list}
              onOpen={setOpenGoalId}
            />
          )}
        </div>
      )}

      {/* Edit modal — one instance per open goal. Render via a portal-like
          key trick so each open goal gets its own state. */}
      {openGoalId && (() => {
        const g = list.find((x) => x.id === openGoalId);
        if (!g) return null;
        return (
          <GoalModal
            key={g.id}
            goal={g}
            goals={list}
            accounts={accList}
            onClose={() => setOpenGoalId(null)}
            onSaved={() => {
              void qc.invalidateQueries({ queryKey: ['goals'] });
              setOpenGoalId(null);
            }}
            onDeleted={() => {
              void qc.invalidateQueries({ queryKey: ['goals'] });
              setOpenGoalId(null);
            }}
          />
        );
      })()}

      {creatingNew && (
        <GoalModal
          key="new"
          goal={null}
          goals={list}
          accounts={accList}
          onClose={() => setCreatingNew(false)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['goals'] });
            setCreatingNew(false);
          }}
          onDeleted={() => setCreatingNew(false)}
        />
      )}
    </div>
  );
}

function GoalGroup({
  title,
  goals,
  allGoals,
  onOpen,
}: {
  title?: string;
  goals: Goal[];
  allGoals: Goal[];
  onOpen: (id: string) => void;
}) {
  return (
    <section>
      {title && <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>}
      <div className="grid gap-3 md:grid-cols-2">
        {goals.map((goal, index) => (
          <GoalCard
            key={goal.id}
            goal={goal}
            index={index}
            sharedGoalCount={allGoals.filter((other) => other.id !== goal.id && other.accountId === goal.accountId).length}
            onOpen={() => onOpen(goal.id)}
          />
        ))}
      </div>
    </section>
  );
}

function GoalCard({
  goal,
  index,
  sharedGoalCount,
  onOpen,
}: {
  goal: Goal;
  index: number;
  sharedGoalCount: number;
  onOpen: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const balance = goal.accountBalance;
  const hasAccount = balance !== null;
  const current = balance ?? 0;
  const rawPct = hasAccount ? (Math.max(0, current) / goal.target) * 100 : 0;
  const pct = Math.min(100, rawPct);
  const reached = hasAccount && current >= goal.target;
  const remaining = Math.max(0, goal.target - current);
  const gained = hasAccount ? current - goal.startingValue : 0;
  const nextMilestone = MILESTONES.find((milestone) => milestone > pct);
  const milestoneAmount = nextMilestone
    ? Math.max(0, (goal.target * nextMilestone) / 100 - current)
    : 0;
  const [celebrate, setCelebrate] = useState(false);

  useEffect(() => {
    if (!reached || reduceMotion) return;
    const key = `cura.goal-celebrated.${goal.id}.${goal.target}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, 'true');
    } catch {
      // Storage can be unavailable in locked-down browser contexts. The
      // celebration remains harmless if it repeats in those environments.
    }
    setCelebrate(true);
    const timer = window.setTimeout(() => setCelebrate(false), 1400);
    return () => window.clearTimeout(timer);
  }, [goal.id, goal.target, reached, reduceMotion]);

  return (
    <motion.button
      type="button"
      onClick={onOpen}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: celebrate ? [1, 1.015, 1] : 1,
      }}
      transition={{
        opacity: { duration: 0.2, delay: index * 0.05 },
        y: { duration: 0.25, delay: index * 0.05 },
        scale: { duration: 0.55, ease: 'easeOut' },
      }}
      className="w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card
        className={clsx(
          'card group transition-colors',
          reached ? 'card-goal-reached' : 'card-goal-active',
        )}
      >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {reached ? (
                <motion.span
                  initial={celebrate ? { scale: 0.5, rotate: -12 } : false}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 16, delay: 0.35 }}
                >
                  <Trophy className="size-4 shrink-0 text-emerald-400" />
                </motion.span>
              ) : (
                <Target className="size-4 shrink-0 text-primary" />
              )}
              <CardTitle className="truncate">{goal.name}</CardTitle>
              {reached && (
                <Badge className="shrink-0 border-transparent text-[10px] bg-emerald-900/50 text-emerald-300">
                  Goal reached
                </Badge>
              )}
            </div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-primary">
            <Pencil className="size-3.5" aria-hidden="true" /> Manage
          </span>
        </div>
      </CardHeader>

      <CardContent>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {goal.accountName ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <WalletCards className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{goal.accountName}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-medium text-destructive">
            <Link2Off className="size-3.5" aria-hidden="true" /> Account removed
          </span>
        )}
        {sharedGoalCount > 0 && goal.accountId && (
          <span className="inline-flex items-center gap-1 text-sky-300">
            <Link className="size-3.5" aria-hidden="true" />
            Shared with {sharedGoalCount} other {sharedGoalCount === 1 ? 'goal' : 'goals'}
          </span>
        )}
      </div>

      <div className="mt-4 flex items-end justify-between gap-3 tabular-nums">
        <div>
          <div className={clsx('text-xs font-semibold', reached ? 'text-emerald-300' : 'text-muted-foreground')}>
            {goalStatusLabel(pct, reached)}
          </div>
          <div className="mt-0.5 text-2xl font-bold text-foreground">
            {formatMoney(hasAccount ? (reached ? current : remaining) : goal.target)}
          </div>
          <div className="text-xs text-muted-foreground">{reached ? 'saved' : hasAccount ? 'remaining' : 'target'}</div>
        </div>
        <div className="text-right">
          <AnimatedPercentage value={pct} reached={reached} />
          <div className="text-xs text-muted-foreground">complete</div>
        </div>
      </div>

      {hasAccount ? (
        <GoalProgressBar className="mt-3" value={pct} celebrate={celebrate} />
      ) : (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-destructive">
          <Link2Off className="size-3.5" /> Pick an account to track this goal.
        </div>
      )}

      {hasAccount && (
        <div className="mt-3 flex items-start justify-between gap-3 text-xs tabular-nums">
          <div className="text-muted-foreground">
            {reached ? `Target ${formatMoney(goal.target)}` : `${formatMoney(current)} saved of ${formatMoney(goal.target)}`}
          </div>
          <div className="text-right text-muted-foreground">
            {reached
              ? current > goal.target
                ? `${formatMoney(current - goal.target)} ahead of goal`
                : 'Fully funded'
              : gained > 0
                ? `+${formatMoney(gained)} since your start`
                : gained < 0
                  ? `${formatMoney(Math.abs(gained))} below your start`
                  : nextMilestone
                    ? `${formatMoney(milestoneAmount)} to ${nextMilestone}%`
                    : null}
          </div>
        </div>
      )}
      </CardContent>
      </Card>
    </motion.button>
  );
}

function goalStatusLabel(pct: number, reached: boolean): string {
  if (reached) return 'You made it!';
  if (pct >= 90) return 'So close!';
  if (pct >= 75) return 'Home stretch!';
  if (pct >= 50) return 'Halfway there!';
  if (pct >= 25) return 'Great start!';
  if (pct > 0) return "You're on your way!";
  return 'Ready when you are!';
}

function AnimatedPercentage({ value, reached }: { value: number; reached: boolean }) {
  const reduceMotion = useReducedMotion();
  const progress = useMotionValue(0);
  const spring = useSpring(progress, { stiffness: 70, damping: 18 });
  const label = useTransform(spring, (latest) => `${Math.round(latest)}%`);

  useEffect(() => {
    if (!reduceMotion) progress.set(value);
  }, [progress, reduceMotion, value]);

  return reduceMotion ? (
    <div className={clsx('text-lg font-bold', progressTextClass(value, reached))}>
      {Math.round(value)}%
    </div>
  ) : (
    <motion.div className={clsx('text-lg font-bold', progressTextClass(value, reached))}>
      {label}
    </motion.div>
  );
}

function progressTextClass(value: number, reached: boolean): string {
  if (reached || value >= 75) return 'text-emerald-300';
  if (value >= 50) return 'text-primary';
  if (value >= 25) return 'text-sky-300';
  return 'text-violet-600';
}

// ---- Goal modal ---------------------------------------------------------
//
// One modal handles both create and edit. `goal === null` means create.
// In edit mode the modal shows a Delete button at the bottom; in
// create mode it's omitted (nothing to delete yet).

function GoalModal({
  goal,
  goals,
  accounts,
  onClose,
  onSaved,
  onDeleted,
}: {
  goal: Goal | null;
  goals: Goal[];
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const isEdit = goal !== null;
  const [name, setName] = useState(goal?.name ?? '');
  const [target, setTarget] = useState(goal ? String(goal.target) : '');
  const [startingValue, setStartingValue] = useState(goal ? String(goal.startingValue) : '0');
  const [accountId, setAccountId] = useState(goal?.accountId ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        target: Number(target),
        startingValue: Number(startingValue) || 0,
        accountId,
      };
      // Different return shapes; useMutation's generic is a single T so
      // we widen it via a Promise<unknown> cast — onSuccess only cares
      // that the call resolved, not what came back.
      const p: Promise<unknown> = isEdit
        ? api.patch<{ ok: true }>(`/api/goals/${goal!.id}`, payload)
        : api.post<Goal>('/api/goals', payload);
      return p as Promise<{ ok: true } | Goal>;
    },
    onSuccess: onSaved,
  });

  const del = useMutation({
    mutationFn: () => api.delete(`/api/goals/${goal!.id}`),
    onSuccess: onDeleted,
  });

  const targetNum = Number(target);
  const canSave = name.trim().length > 0 && Number.isFinite(targetNum) && targetNum > 0 && accountId.length > 0;
  const sharedWith = goals.filter((other) => other.id !== goal?.id && other.accountId === accountId);
  const busy = save.isPending || del.isPending;
  const targetInvalid = target !== '' && !(Number.isFinite(targetNum) && targetNum > 0);
  const accountInvalid = accounts.length > 0 && accountId.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSave || save.isPending) return;
            save.mutate();
          }}
          className="contents"
        >
          <DialogHeader>
            <DialogTitle>
              {isEdit ? 'Edit goal' : 'New goal'}
            </DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Update this savings goal and the account whose balance should count toward it.'
                : 'Choose what you are saving for and the account whose balance should count toward it.'}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="goal-name">Goal name</FieldLabel>
              <Input
                id="goal-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Emergency fund"
                required
                autoFocus
                disabled={busy}
              />
            </Field>
            <Field data-invalid={targetInvalid || undefined}>
              <FieldLabel htmlFor="goal-target">Target amount</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>{currencySymbol()}</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="goal-target"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="0"
                  className="tabular-nums"
                  required
                  disabled={busy}
                  aria-invalid={targetInvalid || undefined}
                />
              </InputGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="goal-starting">
                Starting value <span className="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>{currencySymbol()}</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="goal-starting"
                  type="number"
                  step="0.01"
                  min="0"
                  value={startingValue}
                  onChange={(e) => setStartingValue(e.target.value)}
                  placeholder="0"
                  className="tabular-nums"
                  disabled={busy}
                />
              </InputGroup>
              <FieldDescription>The account balance when you started, used to show how much you've added since.</FieldDescription>
            </Field>
            <Field data-invalid={accountInvalid || undefined}>
              <FieldLabel htmlFor="goal-account">Watch account</FieldLabel>
              <Select
                value={accountId || undefined}
                onValueChange={setAccountId}
                disabled={busy}
              >
                <SelectTrigger id="goal-account" className="w-full" aria-invalid={accountInvalid || undefined}>
                  <SelectValue placeholder="Pick an account" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name} ({a.type})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                The account whose balance drives the progress bar.
              </FieldDescription>
              {accounts.length === 0 && (
                <Alert>
                  <AlertTriangle />
                  <AlertDescription>
                    No eligible accounts are available. Add one from Accounts before saving this goal.
                  </AlertDescription>
                </Alert>
              )}
              {sharedWith.length > 0 && (
                <Alert>
                  <AlertTriangle />
                  <AlertDescription>
                    This account also tracks {sharedWith.map((other) => other.name).join(', ')}. Its full balance will count toward every linked goal.
                  </AlertDescription>
                </Alert>
              )}
            </Field>
          </FieldGroup>

          {save.error && (
            <Alert variant="destructive">
              <AlertDescription>
                {(save.error as Error).message}
              </AlertDescription>
            </Alert>
          )}

          {/* Delete — only shown when editing an existing goal. Two-step
              (button → confirm) so a stray click doesn't nuke data. The
              control lives below the form fields so it's only reached
              through the destructive intent path. */}
          {isEdit && (
            <div className="border-t border-border pt-4">
              {!confirmingDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-destructive hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 data-icon="inline-start" /> Delete goal
                </Button>
              ) : (
                <div className="flex flex-col gap-2">
                  <Alert variant="destructive">
                    <AlertTitle>Delete this goal?</AlertTitle>
                    <AlertDescription>This can't be undone.</AlertDescription>
                  </Alert>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={del.isPending}
                    >
                      Keep
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      className="flex-1"
                      onClick={() => del.mutate()}
                      disabled={del.isPending}
                    >
                      {del.isPending ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
                      Delete
                    </Button>
                  </div>
                  {del.error && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {(del.error as Error).message}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || save.isPending}>
              {save.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              {isEdit ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
