/**
 * /api/mcp — session-authenticated endpoints the SPA uses to approve MCP
 * device requests (the /device page) and manage connected apps (Settings).
 * Mounted AFTER the guard.
 *
 *   GET    /device?userCode=   → pending request details for the approval screen
 *   POST   /device/decision    → { userCode, approve }
 *   GET    /grants             → connected apps for the current user
 *   DELETE /grants/:id         → revoke a connected app and all of its tokens
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { decideDeviceRequest, getPendingDeviceRequest, listMcpGrants, revokeMcpGrant } from '@/db/mcp-auth';
import { badRequest, notFound, safe } from '@/lib/errors';
import { mcpEnabled, normalizeUserCode } from '@/lib/mcp-oauth';
import { createRateLimiter } from '@/lib/rate-limit';
import { routeParam, userId } from '@/lib/tenant';

export const mcpGrantRoutes = new Hono();

// User codes are short; cap guesses so they can't be brute-forced.
const checkUserCodeRateLimit = createRateLimiter({ perClient: 20, global: 200 });

const DecisionSchema = z.object({
  userCode: z.string().min(1).max(20),
  approve: z.boolean(),
});

mcpGrantRoutes.use('*', async (c, next) => {
  if (!mcpEnabled()) return notFound(c);
  return next();
});

mcpGrantRoutes.get(
  '/device',
  safe(async (c) => {
    const limit = checkUserCodeRateLimit(c.req.raw);
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfter));
      return c.json({ error: 'Too many attempts. Try again shortly.', code: 'rate_limited' }, 429);
    }
    const code = normalizeUserCode(c.req.query('userCode') ?? '');
    if (!code) return badRequest(c, 'Enter the 8-character code shown by the app.', 'invalid_user_code');
    const pending = await getPendingDeviceRequest(code);
    if (!pending) return notFound(c, 'This code is invalid, expired, or already used.');
    return c.json({ clientId: pending.clientId, scope: pending.scope, expiresAt: pending.expiresAt.toISOString() });
  }),
);

mcpGrantRoutes.post(
  '/device/decision',
  safe(async (c) => {
    const limit = checkUserCodeRateLimit(c.req.raw);
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfter));
      return c.json({ error: 'Too many attempts. Try again shortly.', code: 'rate_limited' }, 429);
    }
    const parsed = DecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const code = normalizeUserCode(parsed.data.userCode);
    if (!code) return badRequest(c, 'Enter the 8-character code shown by the app.', 'invalid_user_code');
    const decided = await decideDeviceRequest(userId(c), code, parsed.data.approve);
    if (!decided) return notFound(c, 'This code is invalid, expired, or already used.');
    return c.json({ ok: true });
  }),
);

mcpGrantRoutes.get(
  '/grants',
  safe(async (c) => c.json(await listMcpGrants(userId(c)))),
);

mcpGrantRoutes.delete(
  '/grants/:id',
  safe(async (c) => {
    const revoked = await revokeMcpGrant(userId(c), routeParam(c, 'id'));
    if (!revoked) return notFound(c);
    return c.json({ ok: true });
  }),
);
