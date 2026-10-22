import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Eye, EyeOff, GripVertical } from 'lucide-react';
import clsx from 'clsx';
import { Button } from './ui/button';

export function SortableWidgetList<T extends string>({
  order,
  labels,
  editing,
  onReorder,
  renderWidget,
  className = 'flex flex-col gap-6',
  itemClassName,
  hidden = new Set<T>(),
  onToggleHidden,
}: {
  order: T[];
  labels: Record<T, string>;
  editing: boolean;
  onReorder: (order: T[]) => void;
  renderWidget: (widget: T) => ReactNode;
  className?: string;
  itemClassName?: (widget: T) => string | undefined;
  hidden?: ReadonlySet<T>;
  onToggleHidden?: (widget: T) => void;
}) {
  const [drag, setDrag] = useState<{ id: T; height: number; dropIndex: number } | null>(null);
  const widgetRefs = useRef(new Map<T, HTMLDivElement>());
  const floatRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<DragSession<T> | null>(null);
  const activeOrder = order.filter((id) => !hidden.has(id));
  const orderRef = useRef(activeOrder);
  const fullOrderRef = useRef(order);
  const hiddenRef = useRef(hidden);
  const onReorderRef = useRef(onReorder);
  orderRef.current = activeOrder;
  fullOrderRef.current = order;
  hiddenRef.current = hidden;
  onReorderRef.current = onReorder;

  useEffect(() => {
    if (!drag) return;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [drag]);

  useEffect(() => () => {
    const session = sessionRef.current;
    if (session?.scrollRaf != null) cancelAnimationFrame(session.scrollRaf);
    session?.detachListeners?.();
    floatRef.current?.remove();
  }, []);

  const endDrag = (commit: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.scrollRaf != null) cancelAnimationFrame(session.scrollRaf);
    session.detachListeners?.();
    try {
      if (document.body.hasPointerCapture?.(session.pointerId)) document.body.releasePointerCapture(session.pointerId);
    } catch {
      // Capture may already have been released by the browser.
    }
    floatRef.current?.remove();
    floatRef.current = null;
    sessionRef.current = null;
    setDrag(null);

    if (!commit || !session.moved || session.dropIndex === session.fromIndex) return;
    const next = orderRef.current.filter((id) => id !== session.id);
    next.splice(Math.max(0, Math.min(session.dropIndex, next.length)), 0, session.id);
    let visibleIndex = 0;
    const merged = fullOrderRef.current.map((id) => hiddenRef.current.has(id) ? id : next[visibleIndex++]!);
    onReorderRef.current(merged);
  };

  const startDrag = (e: React.PointerEvent, id: T) => {
    if (!editing || e.button !== 0 || sessionRef.current) return;
    const widget = widgetRefs.current.get(id);
    if (!widget) return;
    e.preventDefault();

    const rect = widget.getBoundingClientRect();
    const fromIndex = activeOrder.indexOf(id);
    if (fromIndex < 0) return;
    try {
      document.body.setPointerCapture(e.pointerId);
    } catch {
      // Window listeners still support mouse dragging when capture is unavailable.
    }

    const clone = widget.cloneNode(true) as HTMLDivElement;
    clone.setAttribute('aria-hidden', 'true');
    clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    clone.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      `transform:translate3d(${rect.left}px,${rect.top}px,0) scale(1.01)`,
      'z-index:1000',
      'margin:0',
      'pointer-events:none',
      'box-shadow:0 16px 40px rgba(0,0,0,0.28),0 4px 12px rgba(0,0,0,0.16)',
      'will-change:transform',
      'border-color:var(--mp-amber-500, #22c55e)',
    ].join(';');
    document.body.appendChild(clone);
    floatRef.current = clone;

    const session: DragSession<T> = {
      id,
      fromIndex,
      dropIndex: fromIndex,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      moved: false,
      pointerId: e.pointerId,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      scrollRaf: null,
    };
    sessionRef.current = session;
    setDrag({ id, height: rect.height, dropIndex: fromIndex });

    const updateDropIndex = (clientX: number, clientY: number) => {
      const next = dropIndex(orderRef.current, widgetRefs.current, id, clientX, clientY);
      if (next === session.dropIndex) return;
      session.dropIndex = next;
      setDrag((current) => current?.id === id ? { ...current, dropIndex: next } : current);
    };
    const tickScroll = () => {
      session.scrollRaf = null;
      if (sessionRef.current !== session) return;
      const edge = 56;
      let delta = 0;
      if (session.lastClientY < edge) delta = -Math.ceil(((edge - session.lastClientY) / edge) * 18);
      else if (session.lastClientY > window.innerHeight - edge) delta = Math.ceil(((session.lastClientY - window.innerHeight + edge) / edge) * 18);
      if (delta !== 0) {
        document.getElementById('app-main')?.scrollBy(0, delta);
        updateDropIndex(session.lastClientX, session.lastClientY);
        session.scrollRaf = requestAnimationFrame(tickScroll);
      }
    };
    const onMove = (event: PointerEvent) => {
      if (sessionRef.current !== session || event.pointerId !== session.pointerId) return;
      session.lastClientX = event.clientX;
      session.lastClientY = event.clientY;
      if (!session.moved && Math.hypot(event.clientX - e.clientX, event.clientY - e.clientY) > 4) session.moved = true;
      if (floatRef.current) {
        floatRef.current.style.transform = `translate3d(${event.clientX - session.offsetX}px,${event.clientY - session.offsetY}px,0) scale(1.01)`;
      }
      updateDropIndex(event.clientX, event.clientY);
      if (session.scrollRaf == null && (event.clientY < 56 || event.clientY > window.innerHeight - 56)) {
        session.scrollRaf = requestAnimationFrame(tickScroll);
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyDown);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== session.pointerId) return;
      cleanup();
      endDrag(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cleanup();
      endDrag(false);
    };
    session.detachListeners = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKeyDown);
  };

  const moveWithKeyboard = (id: T, direction: -1 | 1) => {
    const from = activeOrder.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= activeOrder.length) return;
    const next = [...activeOrder];
    [next[from], next[to]] = [next[to]!, next[from]!];
    let visibleIndex = 0;
    onReorder(order.map((widget) => hidden.has(widget) ? widget : next[visibleIndex++]!));
  };

  const visibleOrder = drag
    ? (() => {
        const next = activeOrder.filter((id) => id !== drag.id) as Array<T | 'placeholder'>;
        next.splice(Math.max(0, Math.min(drag.dropIndex, next.length)), 0, 'placeholder');
        return next;
      })()
    : activeOrder;

  const hiddenWidgets = order.filter((id) => hidden.has(id));

  return (
    <>
      <div className={className}>
        {visibleOrder.map((item) => {
        if (item === 'placeholder') {
          return (
            <div
              key="sortable-widget-placeholder"
              className={clsx('rounded-xl border-2 border-dashed border-primary/50 bg-primary/5', drag && itemClassName?.(drag.id))}
              style={{ height: drag?.height ?? 100 }}
            />
          );
        }
        return (
          <div
            key={item}
            ref={(element) => {
              if (element) widgetRefs.current.set(item, element);
              else widgetRefs.current.delete(item);
            }}
            className={clsx(itemClassName?.(item), editing && 'rounded-xl border border-dashed border-border p-2')}
          >
            {editing && (
              <div className="mb-2 flex items-center gap-1">
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Reorder ${labels[item]} widget`}
                  title="Drag to reorder"
                  onPointerDown={(event) => startDrag(event, item)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') { event.preventDefault(); moveWithKeyboard(item, -1); }
                    if (event.key === 'ArrowDown') { event.preventDefault(); moveWithKeyboard(item, 1); }
                  }}
                  className="flex min-h-11 flex-1 touch-none select-none items-center gap-2 rounded-lg px-2 text-sm font-medium fg-secondary cursor-grab hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                >
                  <GripVertical className="h-4 w-4" />
                  {labels[item]}
                </div>
                {onToggleHidden && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onToggleHidden(item)}
                    aria-label={`Hide ${labels[item]} widget`}
                    title="Hide widget"
                  >
                    <EyeOff />
                  </Button>
                )}
              </div>
            )}
            {renderWidget(item)}
          </div>
        );
        })}
      </div>
      {editing && hiddenWidgets.length > 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-border p-3">
          <div className="mb-2 text-sm font-medium text-muted-foreground">Hidden widgets</div>
          <div className="flex flex-wrap gap-2">
            {hiddenWidgets.map((widget) => (
              <Button
                key={widget}
                type="button"
                variant="outline"
                onClick={() => onToggleHidden?.(widget)}
              >
                <Eye data-icon="inline-start" />
                Show {labels[widget]}
              </Button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

interface DragSession<T extends string> {
  id: T;
  fromIndex: number;
  dropIndex: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
  pointerId: number;
  lastClientX: number;
  lastClientY: number;
  scrollRaf: number | null;
  detachListeners?: () => void;
}

function dropIndex<T extends string>(
  order: T[],
  refs: Map<T, HTMLDivElement>,
  draggingId: T,
  cursorX: number,
  cursorY: number,
): number {
  const remaining = order.filter((id) => id !== draggingId);
  const rects = remaining.map((id) => refs.get(id)?.getBoundingClientRect());
  for (let index = 0; index < remaining.length; index++) {
    const rect = rects[index];
    if (!rect) continue;
    const sharesRow = rects.some((other, otherIndex) => otherIndex !== index && other && Math.abs(other.top - rect.top) < 8);
    const element = refs.get(remaining[index]!);
    const containerWidth = element?.parentElement?.getBoundingClientRect().width ?? rect.width;
    const isPartialWidth = rect.width < containerWidth * 0.75;
    if ((sharesRow || isPartialWidth) && cursorY >= rect.top && cursorY <= rect.bottom) {
      if (cursorX < rect.left + rect.width / 2) return index;
      continue;
    }
    if (cursorY < rect.top + rect.height / 2) return index;
  }
  return remaining.length;
}
