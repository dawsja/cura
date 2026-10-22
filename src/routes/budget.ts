/**
 * /api/budget — read + set monthly planned budgets.
 *
 * Carry-forward rule (from the original app): updating the planned budget
 * for month M updates M and removes all overrides for months > M. Reading
 * month M returns the most recent override with yearMonth <= M, so a value
 * set in July automatically applies to August, September, … until the user
 * sets a new override. This keeps the table small (only explicit edits are
 * stored) while letting the user push a single change forward through time
 * and preview future months before any roll-forward cron has run.
 *
 * The "budget-rollforward" cron in src/jobs/budget-rollforward.ts is kept
 * as a physical-row seeder for any future feature that expects rows to
 * exist for every month — GET does not depend on it.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { latestBudgetsUpTo } from '@/db/budget-repository';
import { userId, routeParam } from '@/lib/tenant';
import { badRequest, conflict, safe } from '@/lib/errors';
import { getBudgetActivity } from '@/db/queries';
import { applyBudgetToFutureMonths, setMonthlyBudget } from '@/services/budget';
import { moneyAmount } from '@/lib/money';

export const budgetRoutes = new Hono();
const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'yearMonth must be YYYY-MM');

const SetSchema = z.object({
  subCategoryId: z.string().min(1),
  yearMonth: YearMonth,
  planned: moneyAmount,
});

const ApplyFutureSchema = SetSchema.pick({ subCategoryId: true, yearMonth: true }).extend({
  revision: z.string().min(1),
});


budgetRoutes.get(
  '/:yearMonth/activity',
  safe(async (c) => {
    const ym = routeParam(c, 'yearMonth');
    if (!YearMonth.safeParse(ym).success) return badRequest(c, 'yearMonth must be YYYY-MM');
    return c.json(await getBudgetActivity(userId(c), ym));
  }),
);

budgetRoutes.get(
  '/:yearMonth',
  safe(async (c) => {
    const ym = routeParam(c, 'yearMonth');
    if (!YearMonth.safeParse(ym).success) return badRequest(c, 'yearMonth must be YYYY-MM');
    const latest = await latestBudgetsUpTo(userId(c), ym);
    return c.json(
      Array.from(latest, ([subCategoryId, planned]) => ({
        subCategoryId,
        planned,
      })),
    );
  }),
);

budgetRoutes.post(
  '/',
  safe(async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SetSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const { revision } = await setMonthlyBudget(userId(c), parsed.data);
    return c.json({ ok: true, revision });
  }),
);

budgetRoutes.post(
  '/apply-future',
  safe(async (c) => {
    const parsed = ApplyFutureSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const applied = await applyBudgetToFutureMonths(userId(c), parsed.data);
    if (!applied) return conflict(c, 'This budget changed after the prompt appeared. Save it again to apply forward.');
    return c.json({ ok: true });
  }),
);
