/**
 * /api/mcp — session-authenticated endpoints the Settings page uses to
 * manage MCP personal access tokens. Mounted AFTER the guard.
 *
 *   GET    /tokens       → the current user's tokens (never the secrets)
 *   POST   /tokens       → { name, expiresInDays, access } → the new token, shown once
 *   DELETE /tokens/:id   → revoke a token
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createMcpAccessToken, deleteMcpAccessToken, listMcpAccessTokens } from '@/db/mcp-access';
import { badRequest, notFound, safe } from '@/lib/errors';
import { mcpEnabled } from '@/lib/mcp-access';
import { routeParam, userId } from '@/lib/tenant';

export const mcpTokenRoutes = new Hono();

const CreateTokenSchema = z.object({
  name: z.string().trim().min(1, 'Give the token a name').max(60, 'Keep the name under 60 characters'),
  // null = never expires.
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
  // Read-only unless the user asks for an agent that can make changes.
  access: z.enum(['read', 'read_write']).default('read'),
});

mcpTokenRoutes.use('*', async (c, next) => {
  if (!mcpEnabled()) return notFound(c);
  return next();
});

mcpTokenRoutes.get(
  '/tokens',
  safe(async (c) => c.json(await listMcpAccessTokens(userId(c)))),
);

mcpTokenRoutes.post(
  '/tokens',
  safe(async (c) => {
    const parsed = CreateTokenSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const { name, expiresInDays, access } = parsed.data;
    const expiresAt = expiresInDays === null ? null : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const created = await createMcpAccessToken(userId(c), { name, expiresAt, access });
    c.header('Cache-Control', 'no-store');
    return c.json({ token: created.token, ...created.summary }, 201);
  }),
);

mcpTokenRoutes.delete(
  '/tokens/:id',
  safe(async (c) => {
    const deleted = await deleteMcpAccessToken(userId(c), routeParam(c, 'id'));
    if (!deleted) return notFound(c);
    return c.json({ ok: true });
  }),
);
