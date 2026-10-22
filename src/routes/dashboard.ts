import { Hono } from 'hono';
import { z } from 'zod';
import { getDashboardActivity, getSetting, setSetting } from '@/db/queries';
import { userId } from '@/lib/tenant';
import { badRequest, safe } from '@/lib/errors';

export const dashboardRoutes = new Hono();

dashboardRoutes.get(
  '/activity',
  safe(async (c) => c.json(await getDashboardActivity(userId(c)))),
);

const DASHBOARD_LAYOUT_KEY = 'dashboard_widget_order';
const WidgetId = z.enum([
  'summary',
  'assets-liabilities',
  'budget',
  'coming-up',
  'save-up',
  'accounts',
  'recent-transactions',
]);
type WidgetIdValue = z.infer<typeof WidgetId>;
const DEFAULT_ORDER: WidgetIdValue[] = [
  'summary',
  'budget',
  'coming-up',
  'save-up',
  'assets-liabilities',
  'recent-transactions',
  'accounts',
];
const DEFAULT_HIDDEN: WidgetIdValue[] = ['accounts'];
const Layout = z.object({
  order: z.array(WidgetId).length(DEFAULT_ORDER.length),
  hidden: z.array(WidgetId).max(DEFAULT_ORDER.length),
}).refine(
  ({ order, hidden }) => new Set(order).size === DEFAULT_ORDER.length && new Set(hidden).size === hidden.length,
  'layout must contain every dashboard widget exactly once without duplicate hidden widgets',
);

/** Insert newly added widgets next to their default neighbors instead of appending. */
function insertMissingWidgets(stored: WidgetIdValue[], defaultOrder: readonly WidgetIdValue[]): WidgetIdValue[] {
  const order = [...stored];
  for (const id of defaultOrder) {
    if (order.includes(id)) continue;
    const defaultIdx = defaultOrder.indexOf(id);
    let insertAt = order.length;
    for (let i = defaultIdx - 1; i >= 0; i--) {
      const prevPos = order.indexOf(defaultOrder[i]!);
      if (prevPos !== -1) {
        insertAt = prevPos + 1;
        break;
      }
    }
    order.splice(insertAt, 0, id);
  }
  return order;
}

function parseStoredLayout(raw: string | null): z.infer<typeof Layout> {
  if (!raw) return { order: [...DEFAULT_ORDER], hidden: [...DEFAULT_HIDDEN] };
  try {
    const json: unknown = JSON.parse(raw);
    const stored = Array.isArray(json)
      ? { order: z.array(z.string()).parse(json), hidden: [] }
      : z.object({ order: z.array(z.string()), hidden: z.array(z.string()).optional() }).parse(json);
    const validIds = new Set<string>(DEFAULT_ORDER);
    const order = insertMissingWidgets(
      [...new Set(stored.order.filter((id) => validIds.has(id)))] as WidgetIdValue[],
      DEFAULT_ORDER,
    );
    const hidden = [...new Set((stored.hidden ?? []).filter((id) => validIds.has(id)))] as WidgetIdValue[];
    return { order, hidden };
  } catch {
    return { order: [...DEFAULT_ORDER], hidden: [...DEFAULT_HIDDEN] };
  }
}

dashboardRoutes.get(
  '/layout',
  safe(async (c) => {
    const raw = await getSetting(userId(c), DASHBOARD_LAYOUT_KEY);
    return c.json(parseStoredLayout(raw));
  }),
);

dashboardRoutes.put(
  '/layout',
  safe(async (c) => {
    const parsed = Layout.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid dashboard layout');

    await setSetting(userId(c), DASHBOARD_LAYOUT_KEY, JSON.stringify(parsed.data));
    return c.json(parsed.data);
  }),
);
