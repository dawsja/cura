/**
 * /api/admin/users — list + mutate users.
 *
 * GET    /api/admin/users          → all users with their provider info
 * PATCH  /api/admin/users/:id      → update a user's role (admin/user)
 * DELETE /api/admin/users/:id      → delete a user and all of their data
 * POST   /api/admin/users/:id/password → set a local user's password
 *
 * Admin-only. The PATCH and DELETE handlers refuse to mutate/delete the
 * last admin (overall, or last of a viable auth path) so the operator
 * can't lock themselves out of the app.
 *
 * There's no self-service, email-based password reset in this app (no
 * SMTP is configured anywhere) — this admin-mediated reset is the
 * account-recovery path for a household member who forgets their
 * password. It delegates to Better Auth's own admin plugin, which
 * already grants the `user:set-password` permission to the admin role
 * (see src/auth/permissions.ts).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getAllUsers, deleteUserWithData, revokeUserCredentials, updateUserRole, type AdminUserRow } from '@/db/queries';
import { isLocalAuthDisabled } from '@/auth/local_auth';
import { getAuth } from '@/auth';
import { db } from '@/db/client';
import { user as authUser } from '@/db/schema/auth';
import { eq } from 'drizzle-orm';
import { requireAdmin, routeParam, userId, type AppEnv } from '@/lib/tenant';
import { safe, notFound, badRequest, forbidden } from '@/lib/errors';
import { logger } from '@/lib/logger';

export const adminUserRoutes = new Hono<AppEnv>();

const createBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(12).max(256),
});

adminUserRoutes.post(
  '/',
  safe(async (c) => {
    requireAdmin(c);
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const result = await getAuth().api.signUpEmail({
      body: parsed.data,
      headers: new Headers(),
    });
    if (!result.user?.id) throw new Error('user creation failed');
    await db
      .update(authUser)
      .set({ emailVerified: true, role: null })
      .where(eq(authUser.id, result.user.id));
    return c.json({ id: result.user.id, name: result.user.name, email: result.user.email, role: null }, 201);
  }),
);

adminUserRoutes.get(
  '/',
  safe(async (c) => {
    requireAdmin(c);
    const localAuthDisabled = await isLocalAuthDisabled();
    const rows = await getAllUsers(localAuthDisabled);
    return c.json(rows satisfies AdminUserRow[]);
  }),
);

const patchBody = z.object({
  role: z.enum(['admin', 'user']),
});

adminUserRoutes.patch(
  '/:id',
  safe(async (c) => {
    requireAdmin(c);
    const id = routeParam(c, 'id');
    const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, 'role must be "admin" or "user"');
    try {
      const result = await updateUserRole(id, parsed.data.role);
      return c.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed';
      if (/not found/i.test(message)) return notFound(c, message);
      return badRequest(c, message);
    }
  }),
);

adminUserRoutes.delete(
  '/:id',
  safe(async (c) => {
    requireAdmin(c);
    const id = routeParam(c, 'id');
    try {
      const { deletedRows } = await deleteUserWithData(id);
      return c.json({ ok: true, deletedRows });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'delete failed';
      if (/not found/i.test(message)) return notFound(c, message);
      return badRequest(c, message);
    }
  }),
);

const setPasswordBody = z.object({
  password: z.string().min(12).max(256),
});

// The admin plugin's `/admin/set-user-password` endpoint (registered by
// adminPlugin() in src/auth/config.ts) isn't visible on `Auth['api']`'s
// inferred type here: `plugins` is assembled by pushing onto a
// `BetterAuthOptions['plugins']`-typed array rather than passed as a
// literal tuple, so Better Auth's endpoint-merging generics can't see the
// concrete plugin shape. It exists and works at runtime — verified against
// node_modules/better-auth/dist/plugins/admin/routes.mjs — so this call is
// typed by hand instead of restructuring the shared plugin list.
type AdminSetPasswordApi = {
  setUserPassword: (args: {
    body: { userId: string; newPassword: string };
    headers: Headers;
  }) => Promise<{ status: boolean }>;
};

adminUserRoutes.post(
  '/:id/password',
  safe(async (c) => {
    requireAdmin(c);
    const id = routeParam(c, 'id');
    const parsed = setPasswordBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    try {
      const api = getAuth().api as unknown as AdminSetPasswordApi;
      await api.setUserPassword({
        body: { userId: id, newPassword: parsed.data.password },
        headers: c.req.raw.headers,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to set password';
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 403) return forbidden(c, message);
      if (statusCode === 404) return notFound(c, message);
      return badRequest(c, message);
    }
    // A reset is how an admin evicts someone using the old password, so end
    // every session and MCP token that password could have produced.
    const adminId = userId(c);
    const revoked = await revokeUserCredentials(id, adminId === id ? c.get('session').id : undefined);
    logger.info({ userId: id, adminId, ...revoked }, 'admin: password reset revoked credentials');
    return c.json({ ok: true });
  }),
);
