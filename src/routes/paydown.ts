/**
 * /api/paydown — Monarch-style debt paydown.
 *
 *   - GET    /accounts      → liability accounts (credit + loan) with
 *                             paydown fields.
 *   - GET    /projection    → current projection under "Planned".
 *   - POST   /simulate      → projection under a chosen method + extras.
 *     Both take an optional `start` (YYYY-MM) so the projection begins in
 *     the browser's month rather than the server's.
 *   - PATCH  /account/:id   → edit interest / min / planned / include.
 *
 * The calculator is in @/lib/paydown and is a pure function — the routes
 * just translate HTTP → function args and persist side effects.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  getLiabilityAccounts,
  getAccount,
  editAccountPaydown,
  getPaydownModalData,
  getSavedPaydownScenario,
} from '@/db/queries';
import {
  emptyProjection,
  projectPaydown,
  toPaydownAccount,
  type PaydownMethod,
  type PaydownParams,
} from '@/lib/paydown';
import { userId, routeParam } from '@/lib/tenant';
import { badRequest, safe } from '@/lib/errors';
import { aprRate, moneyAmount } from '@/lib/money';
import { saveDebtPlanToBudget, setPlannedDebtPayment } from '@/services/budget';

export const paydownRoutes = new Hono();
const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'yearMonth must be YYYY-MM');

const Method = z.enum(['planned', 'avalanche', 'snowball']);
const SimulateSchema = z.object({
  method: Method,
  monthlyExtra: moneyAmount.default(0),
  oneTimeExtra: moneyAmount.default(0),
  start: YearMonth.optional(),
});

/** First day of a YYYY-MM month, or now when the client didn't send one. */
function startDate(ym: string | undefined): Date {
  if (!ym) return new Date();
  const [y, m] = ym.split('-').map(Number);
  return new Date(y!, m! - 1, 1);
}
const EditPaydownSchema = z
  .object({
    interestRate: aprRate.optional(),
    minPayment: moneyAmount.optional(),
    plannedPayment: moneyAmount.optional(),
    includeInPaydown: z.boolean().optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: 'empty patch',
  });

// GET /api/paydown/accounts — every credit + loan account, including
// ones the user has excluded (so the UI can render the "Manage" list).
paydownRoutes.get(
  '/accounts',
  safe(async (c) => c.json(await getLiabilityAccounts(userId(c)))),
);

// GET /api/paydown/projection — Planned-only projection. The page calls
// this once on mount to populate the chart, then POSTs /simulate for
// each calculator tweak.
paydownRoutes.get(
  '/projection',
  safe(async (c) => {
    const start = c.req.query('start');
    if (start !== undefined && !YearMonth.safeParse(start).success) return badRequest(c, 'start must be YYYY-MM');
    const accts = await getLiabilityAccounts(userId(c));
    if (accts.length === 0) {
      return c.json(
        emptyProjection('planned', {
          method: 'planned',
          monthlyExtra: 0,
          oneTimeExtra: 0,
        }),
      );
    }
    const projection = projectPaydown(accts.map(toPaydownAccount), {
      method: 'planned',
      monthlyExtra: 0,
      oneTimeExtra: 0,
    }, startDate(start));
    return c.json(projection);
  }),
);

// POST /api/paydown/simulate — body: { method, monthlyExtra, oneTimeExtra }.
paydownRoutes.post(
  '/simulate',
  safe(async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SimulateSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const accts = await getLiabilityAccounts(userId(c));
    if (accts.length === 0) {
      return c.json(emptyProjection(parsed.data.method, parsed.data));
    }
    const params: PaydownParams = {
      method: parsed.data.method as PaydownMethod,
      monthlyExtra: parsed.data.monthlyExtra,
      oneTimeExtra: parsed.data.oneTimeExtra,
    };
    const projection = projectPaydown(accts.map(toPaydownAccount), params, startDate(parsed.data.start));
    return c.json(projection);
  }),
);

// PATCH /api/paydown/account/:id — edit per-account paydown fields.
paydownRoutes.patch(
  '/account/:id',
  safe(async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = EditPaydownSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    // Keep liability projections contractually valid: they need a minimum,
    // and an optional planned payment cannot undercut that minimum.
    if (parsed.data.minPayment !== undefined || parsed.data.plannedPayment !== undefined) {
      const existing = await getAccount(userId(c), routeParam(c, 'id'));
      if (existing && (existing.type === 'credit' || existing.type === 'loan')) {
        const nextMinimum = parsed.data.minPayment ?? existing.minPayment;
        const nextPlanned = parsed.data.plannedPayment ?? existing.plannedPayment;
        if (nextMinimum <= 0) {
          return badRequest(c, 'Credit and loan accounts require a minimum payment greater than 0');
        }
        if (nextPlanned > 0 && nextPlanned < nextMinimum) {
          return badRequest(c, 'Planned payment must be at least the minimum payment');
        }
      }
    }
    await editAccountPaydown(userId(c), routeParam(c, 'id'), parsed.data);
    return c.json({ ok: true });
  }),
);

const SyncSchema = z.object({
  yearMonth: YearMonth,
  method: Method,
  monthlyExtra: moneyAmount,
  oneTimeExtra: moneyAmount,
});

// GET /api/paydown/snapshot/:yearMonth — modal data for the Budget page.
// Returns per-account planned (snapshot, falling back to
// `accounts.plannedPayment` when no snapshot exists), per-account actual
// (sum of transfers on the account in ym), and meta { syncedAt, rowCount }.
paydownRoutes.get(
  '/snapshot/:yearMonth',
  safe(async (c) => {
    const ym = routeParam(c, 'yearMonth');
    if (!YearMonth.safeParse(ym).success) return badRequest(c, 'yearMonth must be YYYY-MM');
    return c.json(await getPaydownModalData(userId(c), ym));
  }),
);

// GET /api/paydown/scenario/:yearMonth — exact calculator inputs last
// committed by Save to Budget for this month.
paydownRoutes.get(
  '/scenario/:yearMonth',
  safe(async (c) => {
    const ym = routeParam(c, 'yearMonth');
    if (!YearMonth.safeParse(ym).success) return badRequest(c, 'yearMonth must be YYYY-MM');
    return c.json({ scenario: await getSavedPaydownScenario(userId(c), ym) });
  }),
);

const SnapshotPlannedSchema = z.object({
  planned: moneyAmount,
});

// PATCH /api/paydown/snapshot/:yearMonth/account/:id — edit planned from
// Budget. Syncs accounts.planned_payment + monthly_paydown for the month.
paydownRoutes.patch(
  '/snapshot/:yearMonth/account/:id',
  safe(async (c) => {
    const ym = routeParam(c, 'yearMonth');
    if (!YearMonth.safeParse(ym).success) return badRequest(c, 'yearMonth must be YYYY-MM');
    const body = await c.req.json().catch(() => null);
    const parsed = SnapshotPlannedSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    await setPlannedDebtPayment(userId(c), { accountId: routeParam(c, 'id'), yearMonth: ym, planned: parsed.data.planned });
    return c.json({ ok: true });
  }),
);

// POST /api/paydown/sync — Save-to-Budget action. Body
//   { yearMonth, method, monthlyExtra, oneTimeExtra }.
// Avalanche/Snowball allocate extras to the priority account, capped at
// its remaining balance. Planned normalizes extras to zero.
paydownRoutes.post(
  '/sync',
  safe(async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SyncSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const saved = await saveDebtPlanToBudget(userId(c), parsed.data);
    return c.json({ ok: true, ...saved });
  }),
);
