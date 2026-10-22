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
import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { monthlyBudgets } from '@/db/schema/monthly_budgets';
import { subCategories } from '@/db/schema/sub_categories';
import { latestBudgetsUpTo } from '@/db/budget-repository';
import { userId, routeParam } from '@/lib/tenant';
import { badRequest, conflict, safe } from '@/lib/errors';
import { getBudgetActivity, subCategoryExists } from '@/db/queries';
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

function nextMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month!, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

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
    const { subCategoryId, yearMonth, planned } = parsed.data;
    const uid = userId(c);
    if (!(await subCategoryExists(uid, subCategoryId)))
      return badRequest(c, 'subCategoryId must belong to the current user');

    const saved = await db.transaction(async (tx) => {
      const [previous] = await tx
        .select({ planned: monthlyBudgets.planned })
        .from(monthlyBudgets)
        .where(and(
          eq(monthlyBudgets.userId, uid),
          eq(monthlyBudgets.subCategoryId, subCategoryId),
          lte(monthlyBudgets.yearMonth, yearMonth),
        ))
        .orderBy(desc(monthlyBudgets.yearMonth))
        .limit(1);
      const [subcategory] = await tx
        .select({ planned: subCategories.planned })
        .from(subCategories)
        .where(and(eq(subCategories.userId, uid), eq(subCategories.id, subCategoryId)))
        .limit(1);
      const priorEffective = previous?.planned ?? subcategory?.planned ?? 0;

      await tx
        .insert(monthlyBudgets)
        .values({
          userId: uid,
          subCategoryId,
          yearMonth,
          planned,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [monthlyBudgets.userId, monthlyBudgets.subCategoryId, monthlyBudgets.yearMonth],
          set: { planned, updatedAt: new Date() },
        })
        .returning({ updatedAt: monthlyBudgets.updatedAt });

      // Preserve the value future months had before this one-month edit.
      await tx
        .insert(monthlyBudgets)
        .values({
          userId: uid,
          subCategoryId,
          yearMonth: nextMonth(yearMonth),
          planned: priorEffective,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();

      const [row] = await tx
        .select({ revision: monthlyBudgets.revision })
        .from(monthlyBudgets)
        .where(and(
          eq(monthlyBudgets.userId, uid),
          eq(monthlyBudgets.subCategoryId, subCategoryId),
          eq(monthlyBudgets.yearMonth, yearMonth),
        ))
        .limit(1);
      return row;
    });
    return c.json({ ok: true, revision: saved?.revision ?? '' });
  }),
);

budgetRoutes.post(
  '/apply-future',
  safe(async (c) => {
    const parsed = ApplyFutureSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const uid = userId(c);
    const { subCategoryId, yearMonth, revision } = parsed.data;

    const applied = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ revision: monthlyBudgets.revision })
        .from(monthlyBudgets)
        .where(and(
          eq(monthlyBudgets.userId, uid),
          eq(monthlyBudgets.subCategoryId, subCategoryId),
          eq(monthlyBudgets.yearMonth, yearMonth),
        ))
        .limit(1);
      if (!current || current.revision !== revision) return false;
      await tx.delete(monthlyBudgets).where(and(
        eq(monthlyBudgets.userId, uid),
        eq(monthlyBudgets.subCategoryId, subCategoryId),
        gt(monthlyBudgets.yearMonth, yearMonth),
      ));
      return true;
    });
    if (!applied) return conflict(c, 'This budget changed after the prompt appeared. Save it again to apply forward.');
    return c.json({ ok: true });
  }),
);
