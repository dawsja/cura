/**
 * ReviewsProvider — owns the bell + carousel review state.
 *
 * Architecture:
 *   - One tiny polling query for the count (`['reviews', 'count']`).
 *     Drives the bell badge with low bandwidth — refreshes every 30s.
 *   - The full queue (`['reviews', 'queue']`) only fetches when the
 *     modal is open. Every open refreshes it before establishing progress.
 *   - Decisions drop rows optimistically, roll back on failure, and only
 *     celebrate after the server confirms the final queued item.
 *   - The modal is mounted as a child so it renders inside the
 *     portal-free DOM tree. Internal state (slide index, edit copy)
 *     lives in the modal itself.
 *
 * Render once at the authenticated app root (App.tsx). Children read
 * state via `useReviews()`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  decideReview,
  fetchReviewQueue,
  skipAllReviews,
  type ReviewTransaction,
} from '../lib/reviews';
import { ReviewCarouselModal } from './ReviewCarouselModal';

interface ReviewsContextValue {
  /** 0-or-more pending count. Drives the bell badge. */
  count: number;
  /** True until the initial pending-count request resolves. */
  isLoading: boolean;
  /** Refresh the count before deciding that a newly imported queue is empty. */
  refreshCount: () => Promise<boolean>;
  /** True while the modal is mounted. */
  isOpen: boolean;
  /** Open the carousel (fetches the queue on first open). No-op when count = 0. */
  openModal: () => void;
  /** Close — remaining items stay in the queue. */
  closeModal: () => void;
}

const ReviewsContext = createContext<ReviewsContextValue | null>(null);

export function ReviewsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [isFreshLoading, setIsFreshLoading] = useState(false);
  const [modalCompleted, setModalCompleted] = useState(0);

  // Cheap polled count — the only network traffic when the modal is
  // closed. 30s matches the cron cadence so a fresh sync shows up in
  // the badge within one poll.
  const countQ = useQuery({
    queryKey: ['reviews', 'count'],
    queryFn: async () => (await fetchReviewQueue(1)).count,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  // Full queue — only fetched when the modal is open.
  const queueQ = useQuery({
    queryKey: ['reviews', 'queue'],
    queryFn: () => fetchReviewQueue(100),
    enabled: isOpen,
    staleTime: 60_000,
    refetchInterval: isOpen ? 30_000 : false,
  });

  // While open, the queue response is the canonical source because it is
  // fetched at the decision endpoint's scope and includes the true total,
  // even when only the first 100 rows are loaded.
  const count = isOpen && queueQ.data ? queueQ.data.count : countQ.data ?? 0;

  useEffect(() => {
    if (!isOpen || queueQ.isFetching || !queueQ.data) return;
    qc.setQueryData(['reviews', 'count'], queueQ.data.count);
    setIsFreshLoading(false);
  }, [isOpen, qc, queueQ.data, queueQ.isFetching]);

  const openModal = useCallback(() => {
    setModalCompleted(0);
    setIsFreshLoading(true);
    qc.removeQueries({ queryKey: ['reviews', 'queue'], exact: true });
    setIsOpen(true);
  }, [qc]);

  const closeModal = useCallback(() => setIsOpen(false), []);
  const refetchCount = countQ.refetch;
  const refreshCount = useCallback(async () => {
    const result = await refetchCount();
    return !result.isError;
  }, [refetchCount]);
  const celebrate = useCallback(() => {
    toast.success("You're all caught up 🎉", {
      description: 'Every transaction has been reviewed.',
    });
  }, []);

  const decision = useMutation({
    mutationFn: (vars: {
      id: string;
      payload: Parameters<typeof decideReview>[1];
    }) => decideReview(vars.id, vars.payload),
    // We do optimistic queue + count updates for instant feedback, but
    // `onSuccess` also reconciles and decides whether to celebrate.
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: ['reviews', 'queue'] });
      const prevQueue = qc.getQueryData<{
        count: number;
        rows: ReviewTransaction[];
      }>(['reviews', 'queue']);
      const prevCount = qc.getQueryData<number>(['reviews', 'count']);
      if (prevQueue) {
        const nextRows = prevQueue.rows.filter((r) => r.id !== id);
        qc.setQueryData(['reviews', 'queue'], {
          count: Math.max(0, prevQueue.count - 1),
          rows: nextRows,
        });
      }
      if (typeof prevCount === 'number') {
        qc.setQueryData(['reviews', 'count'], Math.max(0, prevCount - 1));
      }
      return { prevQueue, prevCount };
    },
    onError: (_err, _vars, ctx) => {
      // Roll back optimistic updates on failure.
      if (ctx?.prevQueue) {
        qc.setQueryData(['reviews', 'queue'], ctx.prevQueue);
      }
      if (typeof ctx?.prevCount === 'number') {
        qc.setQueryData(['reviews', 'count'], ctx.prevCount);
      }
      void qc.invalidateQueries({ queryKey: ['reviews', 'queue'], exact: true });
      void qc.invalidateQueries({ queryKey: ['reviews', 'count'], exact: true });
    },
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['reviews', 'count'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['budget'] });
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      setModalCompleted((current) => current + 1);
      const refreshed = await queueQ.refetch();
      if (!refreshed.isError && refreshed.data?.count === 0) celebrate();
    },
  });

  const onDecide = useCallback(
    async (id: string, payload: Parameters<typeof decideReview>[1]) => {
      return decision.mutateAsync({ id, payload });
    },
    [decision],
  );

  const skipAll = useMutation({
    mutationFn: () => skipAllReviews(),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['reviews'] });
      const prevQueue = qc.getQueryData<{ count: number; rows: ReviewTransaction[] }>(['reviews', 'queue']);
      const prevCount = qc.getQueryData<number>(['reviews', 'count']);
      const completedDelta = prevQueue?.count ?? prevCount ?? 0;
      qc.setQueryData(['reviews', 'queue'], { count: 0, rows: [] });
      qc.setQueryData(['reviews', 'count'], 0);
      setModalCompleted((current) => current + completedDelta);
      return { prevQueue, prevCount, completedDelta };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevQueue) qc.setQueryData(['reviews', 'queue'], ctx.prevQueue);
      if (typeof ctx?.prevCount === 'number') qc.setQueryData(['reviews', 'count'], ctx.prevCount);
      if (ctx?.completedDelta) {
        setModalCompleted((current) => Math.max(0, current - ctx.completedDelta));
      }
    },
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['reviews', 'count'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['budget'] });
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      const refreshed = await queueQ.refetch();
      if (!refreshed.isError && refreshed.data?.count === 0) celebrate();
    },
  });

  const onSkipAll = useCallback(async () => {
    await skipAll.mutateAsync();
  }, [skipAll]);

  const value = useMemo<ReviewsContextValue>(
    () => ({ count, isLoading: countQ.isLoading, refreshCount, isOpen, openModal, closeModal }),
    [count, countQ.isLoading, refreshCount, isOpen, openModal, closeModal],
  );

  return (
    <ReviewsContext.Provider value={value}>
      {children}
      {isOpen && (
        <ReviewCarouselModal
          queue={isFreshLoading ? [] : queueQ.data?.rows ?? []}
          pendingCount={queueQ.data?.count ?? count}
          completedCount={modalCompleted}
          isLoading={isFreshLoading}
          queueError={queueQ.error instanceof Error ? queueQ.error.message : queueQ.isError ? 'Could not load the review queue' : null}
          onRetryQueue={async () => { await queueQ.refetch(); }}
          onClose={closeModal}
          onDecide={onDecide}
          onSkipAll={onSkipAll}
          isMutating={decision.isPending || skipAll.isPending}
        />
      )}
    </ReviewsContext.Provider>
  );
}

export function useReviews(): ReviewsContextValue {
  const ctx = useContext(ReviewsContext);
  if (!ctx) {
    throw new Error('useReviews() called outside <ReviewsProvider>');
  }
  return ctx;
}


