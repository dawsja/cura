/**
 * /api/categories — main categories and sub-categories.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  getAllCategories,
  addMainCategory,
  editMainCategory,
  deleteMainCategory,
  addSubCategory,
  editSubCategory,
  deleteSubCategory,
  reorderMainCategories,
  mainCategoryExists,
} from '@/db/queries';
import { userId, routeParam } from '@/lib/tenant';
import { badRequest, safe } from '@/lib/errors';
import { MAX_MONEY } from '@/lib/money';
import { MainCategoryName } from '@/lib/category-name';

export const categoryRoutes = new Hono();

const TxType = z.enum(['income', 'expense', 'transfer']);

const AddMainSchema = z.object({
  name: MainCategoryName,
  type: TxType,
  icon: z.string().max(64).optional(),
});
const EditMainSchema = z.object({ name: MainCategoryName });
const AddSubSchema = z.object({
  mainCategoryId: z.string().min(1),
  name: z.string().min(1).max(120),
  // Per-month planning lives on the Budget page; the Categories page
  // just creates the sub-category. Optional for backward compat — old
  // callers that still POST `planned` will keep working.
  planned: z.number().finite().min(0).max(MAX_MONEY).optional(),
});
const EditSubSchema = z.object({
  name: z.string().trim().min(1).max(120),
  planned: z.number().finite().min(0).max(MAX_MONEY).optional(),
});
// Drag-to-reorder on the Categories page. The array is the user's new
// order — index 0 = top of the list. We accept a partial list (the
// server only renumbers the categories the user moved), so the client
// can send the full visible list and that's fine too.
const ReorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(500),
});

categoryRoutes.get(
  '/',
  safe(async (c) => c.json(await getAllCategories(userId(c)))),
);

categoryRoutes.post(
  '/',
  safe(async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AddMainSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const cat = await addMainCategory(userId(c), parsed.data.name, parsed.data.type, parsed.data.icon ?? 'Folder');
    return c.json(cat, 201);
  }),
);

categoryRoutes.patch(
  '/:id',
  safe(async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = EditMainSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    await editMainCategory(userId(c), routeParam(c, 'id'), parsed.data.name);
    return c.json({ ok: true });
  }),
);

categoryRoutes.delete(
  '/:id',
  safe(async (c) => {
    await deleteMainCategory(userId(c), routeParam(c, 'id'));
    return c.json({ ok: true });
  }),
);

categoryRoutes.post(
  '/:id/sub',
  safe(async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AddSubSchema.safeParse({
      ...(body as object),
      mainCategoryId: routeParam(c, 'id'),
    });
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    if (!(await mainCategoryExists(userId(c), parsed.data.mainCategoryId))) {
      return badRequest(c, 'mainCategoryId must belong to the current user');
    }
    const sub = await addSubCategory(userId(c), parsed.data.mainCategoryId, parsed.data.name, parsed.data.planned ?? 0);
    return c.json(sub, 201);
  }),
);

categoryRoutes.patch(
  '/:id/sub/:subId',
  safe(async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = EditSubSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    await editSubCategory(
      userId(c),
      routeParam(c, 'id'),
      routeParam(c, 'subId'),
      parsed.data.name,
      parsed.data.planned,
    );
    return c.json({ ok: true });
  }),
);

categoryRoutes.delete(
  '/:id/sub/:subId',
  safe(async (c) => {
    await deleteSubCategory(userId(c), routeParam(c, 'id'), routeParam(c, 'subId'));
    return c.json({ ok: true });
  }),
);

// Drag-to-reorder. The body is the full visible order; the server
// rewrites sortOrder to match the array index. Categories the user
// didn't include keep their existing position (the helper only
// touches the ids in the list).
categoryRoutes.post(
  '/reorder',
  safe(async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ReorderSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    await reorderMainCategories(userId(c), parsed.data.orderedIds);
    return c.json({ ok: true });
  }),
);
