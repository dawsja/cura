import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, useMutation, type QueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Trash2, FolderTree, TrendingUp, TrendingDown, GripVertical, ArrowLeftRight, Pencil, Check, X, ChevronDown, ChevronRight, EllipsisVertical, ArrowUp, ArrowDown } from 'lucide-react';
import clsx from 'clsx';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { AsyncQueryState } from '../components/ui/AsyncQueryState';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Field, FieldError, FieldGroup } from '../components/ui/field';
import { Spinner } from '../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';

interface SubCategory { id: string; name: string; }
interface MainCategory {
  id: string;
  name: string;
  type: 'income' | 'expense' | 'transfer';
  icon?: string;
  sortOrder: number;
  subCategories: SubCategory[];
}

export function Categories() {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api.get<MainCategory[]>('/api/categories') });

  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'income' | 'expense' | 'transfer'>('expense');
  const [showAddCategory, setShowAddCategory] = useState(false);

  const addMain = useMutation({
    mutationFn: (input: { name: string; type: 'income' | 'expense' | 'transfer' }) => api.post<MainCategory>('/api/categories', input),
    onSuccess: () => {
      setNewName('');
      setShowAddCategory(false);
      qc.invalidateQueries({ queryKey: ['categories'] });
    },
  });
  const delMain = useMutation({
    mutationFn: (id: string) => api.delete(`/api/categories/${id}`),
    onSuccess: () => invalidateCategoryDependents(qc),
  });
  const renameMain = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api.patch(`/api/categories/${input.id}`, { name: input.name }),
    onSuccess: () => invalidateCategoryDependents(qc),
  });
  const addSub = useMutation({
    mutationFn: (input: { mainCategoryId: string; name: string }) =>
      api.post(`/api/categories/${input.mainCategoryId}/sub`, { name: input.name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
  const delSub = useMutation({
    mutationFn: (input: { mainCategoryId: string; subCategoryId: string }) =>
      api.delete(`/api/categories/${input.mainCategoryId}/sub/${input.subCategoryId}`),
    onSuccess: () => invalidateCategoryDependents(qc),
  });
  const renameSub = useMutation({
    mutationFn: (input: { mainCategoryId: string; subCategoryId: string; name: string }) =>
      api.patch(`/api/categories/${input.mainCategoryId}/sub/${input.subCategoryId}`, { name: input.name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['rules'] });
      qc.invalidateQueries({ queryKey: ['budget'] });
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
  // Drag-to-reorder. Optimistic: we mutate the React Query cache
  // immediately so the UI re-orders without waiting for the server.
  // If the server rejects (e.g. network error), we roll back to the
  // previous order and the user sees the items snap back.
  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) => api.post<{ ok: true }>('/api/categories/reorder', { orderedIds }),
    onMutate: async (orderedIds) => {
      await qc.cancelQueries({ queryKey: ['categories'] });
      const previous = qc.getQueryData<MainCategory[]>(['categories']);
      if (previous) {
        const byId = new Map(previous.map((c) => [c.id, c]));
        const next: MainCategory[] = [];
        for (let i = 0; i < orderedIds.length; i++) {
          const c = byId.get(orderedIds[i]!);
          if (c) next.push({ ...c, sortOrder: i });
        }
        // Append any categories the user didn't include (shouldn't
        // happen, but defensive) at the end so nothing disappears.
        for (const c of previous) {
          if (!orderedIds.includes(c.id)) next.push({ ...c, sortOrder: next.length });
        }
        qc.setQueryData(['categories'], next);
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(['categories'], ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      qc.invalidateQueries({ queryKey: ['budget'] });
    },
  });

  const onAddMain = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    addMain.mutate({ name: newName.trim(), type: newType });
  };

  // The backend already orders all categories together by sortOrder.
  // We group by type for visual layout; the order within each group is
  // the user's drag order, which the Budget page also respects.
  const expenseCats = cats.data?.filter((c) => c.type === 'expense') ?? [];
  const incomeCats = cats.data?.filter((c) => c.type === 'income') ?? [];
  const transferCats = cats.data?.filter((c) => c.type === 'transfer') ?? [];

  // Reorder helper — moves `sourceId` to the position of `targetId`
  // (`position: 'before'` inserts ahead of target, `'after'` past it),
  // then fires the mutation. We pass the full new list so the server
  // renumbers every id (not just the moved one), keeping the order
  // compact from 0..N.
  const onReorder = (
    group: 'expense' | 'income' | 'transfer',
    sourceId: string,
    targetId: string,
    position: 'before' | 'after',
  ) => {
    if (sourceId === targetId) return;
    const list = group === 'expense' ? expenseCats : group === 'income' ? incomeCats : transferCats;
    const fromIdx = list.findIndex((c) => c.id === sourceId);
    let toIdx = list.findIndex((c) => c.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    if (position === 'after') toIdx += 1;
    if (fromIdx < toIdx) toIdx -= 1; // account for the removal
    if (fromIdx === toIdx) return;
    const next = [...list];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved!);
    reorder.mutate(next.map((c) => c.id));
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Categories</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Organize how transactions and budgets are grouped. Category order is shared with Budget.
          </p>
        </div>
        <Button
          type="button"
          data-onboarding-target="categories-add"
          onClick={() => setShowAddCategory((value) => !value)}
          aria-expanded={showAddCategory}
          aria-controls="add-category-form"
        >
          {showAddCategory ? <X data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          {showAddCategory ? 'Close' : 'Add category'}
        </Button>
      </div>

      {showAddCategory && <Card id="add-category-form">
        <CardHeader>
          <CardTitle>Add category</CardTitle>
          <CardDescription>Choose how the category affects totals before adding it.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <form onSubmit={onAddMain} className="flex flex-wrap gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (e.g. Housing, Salary)"
              className="min-w-[200px] flex-1"
            />
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={newType}
              onValueChange={(value) => {
                if (value === 'income' || value === 'expense' || value === 'transfer') setNewType(value);
              }}
              className="rounded-lg border"
            >
              <ToggleGroupItem value="expense" className={clsx(newType === 'expense' && 'bg-rose-900/40 text-rose-300')}>
                <TrendingDown data-icon="inline-start" /> Expense
              </ToggleGroupItem>
              <ToggleGroupItem value="income" className={clsx(newType === 'income' && 'bg-emerald-900/40 text-emerald-300')}>
                <TrendingUp data-icon="inline-start" /> Income
              </ToggleGroupItem>
              <ToggleGroupItem value="transfer">
                <ArrowLeftRight data-icon="inline-start" /> Transfer
              </ToggleGroupItem>
            </ToggleGroup>
            <Button type="submit" disabled={addMain.isPending}>
              {addMain.isPending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
              Add
            </Button>
          </form>
          {addMain.isError && (
            <Alert variant="destructive">
              <AlertDescription>{addMain.error.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>}

      {cats.isLoading ? (
        <AsyncQueryState status="loading" title="Loading categories…" />
      ) : cats.isError ? (
        <AsyncQueryState status="error" title="Could not load categories" message={cats.error.message} onRetry={() => void cats.refetch()} retrying={cats.isFetching} />
      ) : (expenseCats.length > 0 || incomeCats.length > 0 || transferCats.length > 0) ? (
        <div className="flex flex-col gap-4">
          {expenseCats.length > 0 && (
            <CategoryGroup
              title="Expense categories"
              icon={TrendingDown}
              tone="rose"
              group="expense"
              categories={expenseCats}
              onDeleteMain={(id) => delMain.mutateAsync(id)}
              onRenameMain={(id, name) => renameMain.mutateAsync({ id, name })}
              onAddSub={(mainId, name) => addSub.mutateAsync({ mainCategoryId: mainId, name })}
              onDeleteSub={(mainCategoryId, subCategoryId) => delSub.mutateAsync({ mainCategoryId, subCategoryId })}
              onRenameSub={(mainCategoryId, subCategoryId, name) => renameSub.mutateAsync({ mainCategoryId, subCategoryId, name })}
              onReorder={onReorder}
              disabled={reorder.isPending}
            />
          )}
          {incomeCats.length > 0 && (
            <CategoryGroup
              title="Income categories"
              icon={TrendingUp}
              tone="emerald"
              group="income"
              categories={incomeCats}
              onDeleteMain={(id) => delMain.mutateAsync(id)}
              onRenameMain={(id, name) => renameMain.mutateAsync({ id, name })}
              onAddSub={(mainId, name) => addSub.mutateAsync({ mainCategoryId: mainId, name })}
              onDeleteSub={(mainCategoryId, subCategoryId) => delSub.mutateAsync({ mainCategoryId, subCategoryId })}
              onRenameSub={(mainCategoryId, subCategoryId, name) => renameSub.mutateAsync({ mainCategoryId, subCategoryId, name })}
              onReorder={onReorder}
              disabled={reorder.isPending}
            />
          )}
          {transferCats.length > 0 && (
            <CategoryGroup
              title="Transfer categories"
              icon={ArrowLeftRight}
              tone="slate"
              group="transfer"
              categories={transferCats}
              onDeleteMain={(id) => delMain.mutateAsync(id)}
              onRenameMain={(id, name) => renameMain.mutateAsync({ id, name })}
              onAddSub={(mainId, name) => addSub.mutateAsync({ mainCategoryId: mainId, name })}
              onDeleteSub={(mainCategoryId, subCategoryId) => delSub.mutateAsync({ mainCategoryId, subCategoryId })}
              onRenameSub={(mainCategoryId, subCategoryId, name) => renameSub.mutateAsync({ mainCategoryId, subCategoryId, name })}
              onReorder={onReorder}
              disabled={reorder.isPending}
            />
          )}
        </div>
      ) : (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FolderTree /></EmptyMedia>
            <EmptyTitle>No categories yet</EmptyTitle>
            <EmptyDescription>Add one above to start organizing transactions.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function CategoryGroup({
  title,
  icon: Icon,
  tone,
  group,
  categories,
  onDeleteMain,
  onRenameMain,
  onAddSub,
  onDeleteSub,
  onRenameSub,
  onReorder,
  disabled,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'rose' | 'emerald' | 'slate';
  group: 'expense' | 'income' | 'transfer';
  categories: MainCategory[];
  onDeleteMain: (id: string) => Promise<unknown>;
  onRenameMain: (id: string, name: string) => Promise<unknown>;
  onAddSub: (mainId: string, name: string) => Promise<unknown>;
  onDeleteSub: (mainCategoryId: string, subCategoryId: string) => Promise<unknown>;
  onRenameSub: (mainCategoryId: string, subCategoryId: string, name: string) => Promise<unknown>;
  onReorder: (group: 'expense' | 'income' | 'transfer', sourceId: string, targetId: string, position: 'before' | 'after') => void;
  disabled?: boolean;
}) {
  const toneClass =
    tone === 'rose' ? 'bg-rose-900/30 text-rose-300' :
    tone === 'emerald' ? 'bg-emerald-900/30 text-emerald-300' :
    'bg-muted text-muted-foreground';

  // Drag-to-reorder via Pointer Events.
  //
  // The dragged card is *picked up*: a fixed-position clone follows the
  // pointer with direct DOM writes (no React re-render per pixel). The
  // list keeps a dashed placeholder at the live drop index so other
  // cards shift out of the way. React state only updates when the drop
  // index changes or the drag starts/ends.
  //
  // The grip button is the only drag handle so the rest of the header
  // remains available for expanding and category actions.
  const [drag, setDrag] = useState<{
    id: string;
    height: number;
    fromIndex: number;
    dropIndex: number;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: 'category'; category: MainCategory }
    | { kind: 'subcategory'; category: MainCategory; subcategory: SubCategory }
    | null
  >(null);
  const [groupOpen, setGroupOpen] = useState(true);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const cardRefs = useRef(new Map<string, HTMLElement>());
  const floatRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const groupRef = useRef(group);
  groupRef.current = group;

  // Body cursor + selection lock while a card is airborne.
  useEffect(() => {
    if (!drag) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [drag]);

  // Tear down any leftover float / listeners if the group unmounts mid-drag.
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (session?.scrollRaf != null) cancelAnimationFrame(session.scrollRaf);
      session?.detachListeners?.();
      floatRef.current?.remove();
      floatRef.current = null;
      sessionRef.current = null;
    };
  }, []);

  const endDrag = (commit: boolean) => {
    const session = sessionRef.current;
    if (!session) return;

    // Stop edge auto-scroll loop.
    if (session.scrollRaf != null) {
      cancelAnimationFrame(session.scrollRaf);
      session.scrollRaf = null;
    }

    session.detachListeners?.();

    try {
      if (document.body.hasPointerCapture?.(session.pointerId)) {
        document.body.releasePointerCapture(session.pointerId);
      }
    } catch {
      // Ignore — capture may already be released.
    }

    floatRef.current?.remove();
    floatRef.current = null;

    const { id, fromIndex, dropIndex, moved } = session;
    sessionRef.current = null;
    setDrag(null);

    if (!commit || !moved || dropIndex === fromIndex) return;

    const list = categoriesRef.current;
    const without = list.filter((c) => c.id !== id);
    // dropIndex is the index among the full list after removal+insert
    // at that slot (0..length). Clamp and resolve a neighbor target.
    const clamped = Math.max(0, Math.min(dropIndex, without.length));
    if (clamped >= without.length) {
      const last = without[without.length - 1];
      if (last) onReorderRef.current(groupRef.current, id, last.id, 'after');
    } else {
      const target = without[clamped];
      if (target) onReorderRef.current(groupRef.current, id, target.id, 'before');
    }
  };

  const startDrag = (e: React.PointerEvent, id: string) => {
    if (disabled) return;
    if (e.button !== 0) return;
    // Already dragging another card.
    if (sessionRef.current) return;

    const cardEl = cardRefs.current.get(id);
    if (!cardEl) return;

    e.preventDefault();

    const rect = cardEl.getBoundingClientRect();
    const fromIndex = categories.findIndex((c) => c.id === id);
    if (fromIndex < 0) return;

    // Capture on <body> (not the handle) so removing the source card
    // from the list on the next render does not cancel the drag.
    try {
      document.body.setPointerCapture(e.pointerId);
    } catch {
      // Some environments reject capture on body; window listeners still work for mouse.
    }

    // Visual clone rides under the pointer. Direct style writes on
    // pointermove keep it glued to the cursor without React lag.
    const clone = cardEl.cloneNode(true) as HTMLDivElement;
    clone.setAttribute('aria-hidden', 'true');
    clone.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      `transform:translate3d(${rect.left}px,${rect.top}px,0) scale(1.02)`,
      'z-index:1000',
      'margin:0',
      'pointer-events:none',
      'box-shadow:0 16px 40px rgba(0,0,0,0.22),0 4px 12px rgba(0,0,0,0.12)',
      'opacity:1',
      'will-change:transform',
      'touch-action:none',
      // Slightly lift the card so it reads as "picked up"
      'border-color:var(--mp-amber-500, #22c55e)',
    ].join(';');
    // Avoid duplicate ids inside the clone.
    clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    document.body.appendChild(clone);
    floatRef.current = clone;

    const session: DragSession = {
      id,
      fromIndex,
      dropIndex: fromIndex,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      moved: false,
      scrollRaf: null,
      lastClientY: e.clientY,
      pointerId: e.pointerId,
    };
    sessionRef.current = session;

    setDrag({
      id,
      height: rect.height,
      fromIndex,
      dropIndex: fromIndex,
    });

    const EDGE = 56;
    const SCROLL_MAX = 18;

    const positionFloat = (clientX: number, clientY: number) => {
      const float = floatRef.current;
      if (!float) return;
      const x = clientX - session.offsetX;
      const y = clientY - session.offsetY;
      float.style.transform = `translate3d(${x}px,${y}px,0) scale(1.02)`;
    };

    const updateDropIndex = (clientY: number) => {
      const next = computeDropIndex(categoriesRef.current, cardRefs.current, session.id, clientY);
      if (next === session.dropIndex) return;
      session.dropIndex = next;
      setDrag((prev) => (prev && prev.id === session.id ? { ...prev, dropIndex: next } : prev));
    };

    const tickScroll = () => {
      session.scrollRaf = null;
      if (!sessionRef.current || sessionRef.current.id !== session.id) return;
      const y = session.lastClientY;
      let dy = 0;
      if (y < EDGE) {
        dy = -Math.ceil(((EDGE - y) / EDGE) * SCROLL_MAX);
      } else if (y > window.innerHeight - EDGE) {
        dy = Math.ceil(((y - (window.innerHeight - EDGE)) / EDGE) * SCROLL_MAX);
      }
      if (dy !== 0) {
        document.getElementById('app-main')?.scrollBy(0, dy);
        // Re-evaluate drop slot after scroll shifts card midpoints.
        updateDropIndex(session.lastClientY);
        session.scrollRaf = requestAnimationFrame(tickScroll);
      }
    };

    const startClientX = e.clientX;
    const startClientY = e.clientY;

    const onMove = (ev: PointerEvent) => {
      if (!sessionRef.current || sessionRef.current.id !== session.id) return;
      // Only track the pointer that started the drag.
      if (ev.pointerId !== session.pointerId) return;
      session.lastClientY = ev.clientY;
      // "Moved" once the pointer travels past a small threshold so a
      // click on the header never accidentally reorders.
      if (!session.moved) {
        const dist = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
        if (dist > 4) session.moved = true;
      }
      // Keep float under the finger/cursor — DOM only, no setState.
      positionFloat(ev.clientX, ev.clientY);
      updateDropIndex(ev.clientY);

      // Kick auto-scroll when near edges; rAF loop continues while held.
      if (session.scrollRaf == null) {
        const nearEdge =
          ev.clientY < EDGE || ev.clientY > window.innerHeight - EDGE;
        if (nearEdge) session.scrollRaf = requestAnimationFrame(tickScroll);
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== session.pointerId) return;
      cleanup();
      endDrag(true);
    };
    // Ignore pointercancel — unmounting the source card (or capture
    // retargeting) can emit cancel even though the gesture continues.
    // We only end on pointerup or Escape.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cleanup();
        endDrag(false);
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
    session.detachListeners = cleanup;

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
  };

  // Build the visible row list: every category except the airborne one,
  // plus a placeholder slotted at dropIndex.
  type Row =
    | { kind: 'card'; cat: MainCategory }
    | { kind: 'placeholder'; key: string };

  const rows: Row[] = (() => {
    if (!drag) {
      return categories.map((cat) => ({ kind: 'card' as const, cat }));
    }
    const without = categories.filter((c) => c.id !== drag.id);
    const insertAt = Math.max(0, Math.min(drag.dropIndex, without.length));
    const out: Row[] = without.map((cat) => ({ kind: 'card' as const, cat }));
    out.splice(insertAt, 0, { kind: 'placeholder', key: `ph-${drag.id}` });
    return out;
  })();

  const toggleCategory = (id: string) => {
    setExpandedCategories((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Card className="gap-0">
      <CardHeader className="p-0 px-(--card-spacing)">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setGroupOpen((value) => !value)}
          aria-expanded={groupOpen}
          className="h-auto min-h-11 w-full justify-between gap-3 whitespace-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', toneClass)}>
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-foreground">{title}</span>
              <span className="block text-xs text-muted-foreground">{categories.length} {categories.length === 1 ? 'category' : 'categories'}</span>
            </span>
          </span>
          {groupOpen
            ? <ChevronDown data-icon="inline-end" className="text-muted-foreground" aria-hidden="true" />
            : <ChevronRight data-icon="inline-end" className="text-muted-foreground" aria-hidden="true" />}
        </Button>
      </CardHeader>
      {groupOpen && <CardContent className="relative mt-3 flex flex-col gap-2 border-t pt-3">
        {rows.map((row) => {
          if (row.kind === 'placeholder') {
            return (
              <div
                key={row.key}
                aria-hidden
                className="rounded-xl border-2 border-dashed border-amber-500/50 bg-amber-900/10"
                style={{ height: drag?.height ?? 80 }}
              />
            );
          }
          const cat = row.cat;
          return (
            <section
              key={cat.id}
              ref={(el) => {
                if (el) cardRefs.current.set(cat.id, el);
                else cardRefs.current.delete(cat.id);
              }}
              className={clsx(
                'rounded-xl border bg-muted/30',
                // Cards slide into the gap the placeholder opened.
                drag && 'transition-transform duration-150 ease-out',
                disabled && 'opacity-60',
              )}
            >
              <div className="flex min-h-14 items-center gap-1 px-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onPointerDown={(e) => startDrag(e, cat.id)}
                  aria-label={`Drag to reorder ${cat.name}`}
                  title="Drag to reorder"
                  className="cursor-grab touch-none select-none active:cursor-grabbing"
                >
                  <GripVertical className="text-muted-foreground" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => toggleCategory(cat.id)}
                  aria-expanded={expandedCategories.has(cat.id)}
                  aria-label={`${expandedCategories.has(cat.id) ? 'Collapse' : 'Expand'} ${cat.name}`}
                >
                  {expandedCategories.has(cat.id)
                    ? <ChevronDown aria-hidden="true" />
                    : <ChevronRight aria-hidden="true" />}
                </Button>
                <EditableMainCategory
                  category={cat}
                  subCategoryCount={cat.subCategories.length}
                  onRename={(name) => onRenameMain(cat.id, name)}
                  onDelete={() => setDeleteTarget({ kind: 'category', category: cat })}
                  onMoveUp={categories.indexOf(cat) > 0
                    ? () => onReorder(group, cat.id, categories[categories.indexOf(cat) - 1]!.id, 'before')
                    : undefined}
                  onMoveDown={categories.indexOf(cat) < categories.length - 1
                    ? () => onReorder(group, cat.id, categories[categories.indexOf(cat) + 1]!.id, 'after')
                    : undefined}
                />
              </div>
              {expandedCategories.has(cat.id) && <div className="border-t px-4 pt-2 pb-3">
                {cat.subCategories.length > 0 ? (
                  <ul className="divide-y">
                    {cat.subCategories.map((sub) => (
                      <EditableSubCategory
                        key={sub.id}
                        sub={sub}
                        onRename={(name) => onRenameSub(cat.id, sub.id, name)}
                        onDelete={() => setDeleteTarget({ kind: 'subcategory', category: cat, subcategory: sub })}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="py-2 text-xs text-muted-foreground italic">No subcategories yet</p>
                )}
                <AddSub onAdd={(name) => onAddSub(cat.id, name)} />
              </div>}
            </section>
          );
        })}
      </CardContent>}
      {deleteTarget?.kind === 'category' && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.category.name}”?`}
          confirmLabel="Delete category"
          destructive
          onConfirm={() => onDeleteMain(deleteTarget.category.id)}
          onClose={() => setDeleteTarget(null)}
        >
          <p>
            This also deletes its subcategories and removes associated budget entries and categorization rules.
          </p>
          <p>
            Historical transactions keep their category labels, but those labels will no longer point to an active category.
          </p>
        </ConfirmDialog>
      )}
      {deleteTarget?.kind === 'subcategory' && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.subcategory.name}”?`}
          confirmLabel="Delete subcategory"
          destructive
          onConfirm={() => onDeleteSub(deleteTarget.category.id, deleteTarget.subcategory.id)}
          onClose={() => setDeleteTarget(null)}
        >
          <p>
            This removes associated budget entries and categorization rules for this subcategory.
          </p>
          <p>
            Historical transactions keep their category labels, but the subcategory will no longer be available for future use.
          </p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function invalidateCategoryDependents(qc: QueryClient) {
  for (const queryKey of ['categories', 'rules', 'dashboard', 'budget', 'reports', 'transactions']) {
    qc.invalidateQueries({ queryKey: [queryKey] });
  }
}

function EditableMainCategory({
  category,
  subCategoryCount,
  onRename,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  category: MainCategory;
  subCategoryCount: number;
  onRename: (name: string) => Promise<unknown>;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cancel = () => {
    setName(category.name);
    setError('');
    setEditing(false);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextName = name.trim();
    if (!nextName) return;
    if (nextName === category.name) {
      cancel();
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onRename(nextName);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename category');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="min-w-0 flex-1">
        <form onSubmit={save} className="flex items-center gap-2">
          <Input
            autoFocus
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
            }}
            aria-label={`Rename ${category.name}`}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            disabled={saving || !name.trim()}
            title="Save name"
            aria-label="Save name"
          >
            {saving ? <Spinner /> : <Check />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={saving}
            onClick={cancel}
            title="Cancel"
          >
            <X />
          </Button>
        </form>
        {error && <p className="mt-1 text-xs text-destructive" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-semibold text-foreground">{category.name}</h4>
        <p className="text-xs text-muted-foreground">{subCategoryCount} {subCategoryCount === 1 ? 'subcategory' : 'subcategories'}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${category.name}`}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onMoveUp?.()} disabled={!onMoveUp}>
            <ArrowUp /> Move up
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onMoveDown?.()} disabled={!onMoveDown}>
            <ArrowDown /> Move down
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 /> Delete category
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function EditableSubCategory({
  sub,
  onRename,
  onDelete,
}: {
  sub: SubCategory;
  onRename: (name: string) => Promise<unknown>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sub.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cancel = () => {
    setName(sub.name);
    setError('');
    setEditing(false);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextName = name.trim();
    if (!nextName) return;
    if (nextName === sub.name) {
      cancel();
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onRename(nextName);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename sub-category');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <li className="py-2 text-sm">
        <form onSubmit={save} className="flex items-center gap-2">
          <Input
            autoFocus
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
            }}
            aria-label={`Rename ${sub.name}`}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            disabled={saving || !name.trim()}
            title="Save name"
            aria-label="Save name"
          >
            {saving ? <Spinner /> : <Check />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={saving}
            onClick={cancel}
            title="Cancel"
          >
            <X />
          </Button>
        </form>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </li>
    );
  }

  return (
    <li className="flex min-h-11 items-center justify-between gap-2 py-1 text-sm">
      <span className="min-w-0 truncate text-muted-foreground">{sub.name}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${sub.name}`}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 /> Delete subcategory
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

interface DragSession {
  id: string;
  fromIndex: number;
  dropIndex: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
  scrollRaf: number | null;
  lastClientY: number;
  pointerId: number;
  detachListeners?: () => void;
}

/**
 * Drop index in the list *after removing* the dragged item: 0 inserts
 * at the top, `length` inserts after the last remaining card. Based on
 * midpoints of the still-rendered cards (placeholder is ignored via
 * cardRefs — only real cards are registered).
 */
function computeDropIndex(
  categories: MainCategory[],
  cardRefs: Map<string, HTMLElement>,
  draggingId: string,
  cursorY: number,
): number {
  const remaining = categories.filter((c) => c.id !== draggingId);
  if (remaining.length === 0) return 0;

  for (let i = 0; i < remaining.length; i++) {
    const el = cardRefs.get(remaining[i]!.id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (cursorY < mid) return i;
  }
  return remaining.length;
}

function AddSub({ onAdd }: { onAdd: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await onAdd(name.trim());
          setName('');
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
      className="mt-2 flex flex-wrap gap-2"
    >
      <FieldGroup className="flex-row flex-wrap gap-2">
        <Field className="min-w-0 flex-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sub-category"
          />
        </Field>
        <Button type="submit" size="icon" disabled={busy} aria-label="Add subcategory">
          {busy ? <Spinner /> : <Plus />}
        </Button>
        {error && <FieldError className="basis-full">{error}</FieldError>}
      </FieldGroup>
    </form>
  );
}
