/**
 * /api/admin/auth — admin-only auth-related settings.
 *
 * Lives under `/api/admin/*` (mounted AFTER the guard middleware in
 * src/index.ts) so `requireAdmin()` finds the authenticated user on
 * the Hono context. Public auth endpoints (sign-in, sign-out, etc.)
 * live under `/api/auth-app/*` and are mounted before the guard.
 *
 *   GET   /api/admin/auth/local-auth   → current flag + can-disable
 *   PATCH /api/admin/auth/local-auth    → { disabled: boolean }
 *
 * Admins can disable local email/password sign-in once at least one
 * OIDC user has been promoted to admin. Re-enabling has no
 * precondition. The guard is enforced in setLocalAuthDisabled(); here
 * we translate the failure into a 400 with a usable message.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getLocalAuthInfo, isLocalAuthDisabled, setLocalAuthDisabled } from '@/auth';
import { badRequest, safe } from '@/lib/errors';
import { requireAdmin } from '@/lib/tenant';

export const adminAuthRoutes = new Hono();

const LocalAuthToggleSchema = z.object({
  disabled: z.boolean(),
});

adminAuthRoutes.get(
  '/local-auth',
  safe(async (c) => {
    requireAdmin(c);
    return c.json(await getLocalAuthInfo());
  }),
);

adminAuthRoutes.patch(
  '/local-auth',
  safe(async (c) => {
    requireAdmin(c);
    const parsed = LocalAuthToggleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return badRequest(c, 'body must be { disabled: boolean }', 'invalid_body');
    }
    try {
      await setLocalAuthDisabled(parsed.data.disabled);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      if (message === 'local_auth_disabled_precondition_failed') {
        return badRequest(
          c,
          'Cannot disable local auth until at least one OIDC user has been promoted to admin. Sign in with OIDC, then promote that account under Users in Settings.',
          'oidc_admin_required',
        );
      }
      throw err;
    }
    return c.json({ ok: true, localAuthDisabled: await isLocalAuthDisabled() });
  }),
);
