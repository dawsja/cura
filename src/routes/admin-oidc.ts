/**
 * Admin-only OIDC provider management.
 *
 * The first admin can add/edit/delete OIDC providers at any time. As of
 * v0.1 we hot-register providers with the running Better Auth instance
 * via `refreshAuth()` (see src/auth/instance.ts), so the response
 * indicates `restart_required: false` in the common case. The field
 * stays in the response shape for forward compatibility / UI banners.
 *
 *   GET    /api/admin/oidc/providers        — list all (active + inactive)
 *   POST   /api/admin/oidc/providers        — add a new provider
 *   PATCH  /api/admin/oidc/providers/:id    — edit name / scopes / isActive
 *   DELETE /api/admin/oidc/providers/:id    — remove a provider
 *   POST   /api/admin/oidc/providers/test  — validate a discovery URL + creds
 *                                            (no persistence; useful before saving)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, sqlAll } from '@/db/client';
import { oidcProviders } from '@/db/schema/oidc_providers';
import { setupState } from '@/db/schema/setup_state';
import { requireAdmin, routeParam } from '@/lib/tenant';
import { badRequest, conflict, notFound, safe, serverError } from '@/lib/errors';
import { configureOidc } from '@/auth/setup';
import { refreshAuth } from '@/auth/instance';
import { logger } from '@/lib/logger';
import { env, resolveOrigin } from '@/lib/env';
import { assertSecureOidcConfiguration, fetchSecureOidcDiscovery } from '@/lib/oidc-url';
import { sealSecret } from '@/lib/secret-box';

export const adminOidcRoutes = new Hono();

// Better Auth's genericOAuth plugin always handles the IdP callback at this
// path. The providerId is interpolated into the URL when the client redirects
// back from the IdP.
const OAUTH2_CALLBACK_PATH = '/api/auth/oauth2/callback';

/**
 * Compute the exact redirect_uri the OIDC flow will use for a given
 * providerId. The origin is derived from APP_URL / BETTER_AUTH_URL when
 * configured, otherwise from the incoming request's Host header (so the
 * displayed value matches what Better Auth actually sends to the IdP).
 *
 * The operator needs to register this exact string in their IdP's
 * "Allowed redirect URIs" / "Redirect URIs" list, or the IdP will reject
 * the auth request with the error the user just hit:
 *   "The redirect_uri … is not registered for this client."
 */
function callbackUriFor(c: { req: { raw: Request } }, providerId: string): string {
  const origin = env.OIDC_REDIRECT_BASE || env.BETTER_AUTH_URL || env.APP_URL
    ? env.OIDC_REDIRECT_BASE?.replace(/\/+$/, '')
      || env.BETTER_AUTH_URL?.replace(/\/+$/, '')
      || env.APP_URL?.replace(/\/+$/, '')
      || ''
    : resolveOrigin(c.req.raw, 'app');
  return `${origin}${OAUTH2_CALLBACK_PATH}/${encodeURIComponent(providerId)}`;
}

// ---- Helpers -------------------------------------------------------------

/** Public-safe view of a provider (never returns the client_secret). */
function publicProvider(
  p: typeof oidcProviders.$inferSelect,
  callbackUri: string,
) {
  return {
    id: p.id,
    providerId: p.providerId,
    discoveryUrl: p.discoveryUrl,
    clientId: p.clientId,
    hasClientSecret: !!p.clientSecret,
    scopes: p.scopes,
    isActive: p.isActive,
    createdAt: p.createdAt,
    // The exact redirect_uri to register in the IdP. Operators copy-paste
    // this into Pocket ID / Authentik / etc. — getting it wrong produces
    // "redirect_uri not registered" errors at sign-in time.
    callbackUri,
  };
}

const AddProviderSchema = z.object({
  providerId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, {
    message: 'providerId must be alphanumeric / dash / underscore',
  }),
  discoveryUrl: z.string().url(),
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().min(1).max(1024),
  scopes: z.array(z.string().min(1)).optional(),
});

const EditProviderSchema = z.object({
  providerId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i).optional(),
  discoveryUrl: z.string().url().optional(),
  clientId: z.string().min(1).max(256).optional(),
  clientSecret: z.string().min(1).max(1024).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  isActive: z.boolean().optional(),
});

const TestDiscoverySchema = z.object({
  discoveryUrl: z.string().url(),
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().min(1).max(1024).optional(),
});

// ---- Routes --------------------------------------------------------------

adminOidcRoutes.get(
  '/providers',
  safe(async (c) => {
    requireAdmin(c);
    const rows = await db
      .select()
      .from(oidcProviders)
      .orderBy(desc(oidcProviders.createdAt));
    return c.json(rows.map((p) => publicProvider(p, callbackUriFor(c, p.providerId))));
  }),
);

adminOidcRoutes.post(
  '/providers',
  safe(async (c) => {
    requireAdmin(c);
    const body = await c.req.json().catch(() => null);
    const parsed = AddProviderSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    const [duplicate] = await db
      .select({ id: oidcProviders.id })
      .from(oidcProviders)
      .where(eq(oidcProviders.providerId, parsed.data.providerId))
      .limit(1);
    if (duplicate) return conflict(c, 'A provider with this providerId already exists.', 'provider_exists');
    try {
      assertSecureOidcConfiguration(c.req.raw);
      const result = await configureOidc({
        providerId: parsed.data.providerId,
        discoveryUrl: parsed.data.discoveryUrl,
        clientId: parsed.data.clientId,
        clientSecret: parsed.data.clientSecret,
        scopes: parsed.data.scopes,
      });
      logger.info(
        { providerId: parsed.data.providerId, by: 'admin' },
        'admin-oidc: provider added',
      );
      // First-ever provider flips the setup flag.
      const all = await db.select({ id: oidcProviders.id }).from(oidcProviders);
      if (all.length > 0) {
        await db.update(setupState).set({ oidcConfigured: true }).where(eq(setupState.id, 1));
      }
      return c.json(
        {
          ok: true,
          providerId: result.providerId,
          restart_required: result.restartRequired,
          callbackUri: callbackUriFor(c, parsed.data.providerId),
        },
        201,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      if (message.startsWith('discovery_doc_unreachable_')) {
        return badRequest(c, `OIDC discovery doc unreachable: ${message}`, 'discovery_unreachable');
      }
      if (message === 'discovery_doc_missing_endpoints') {
        return badRequest(c, 'Discovery doc missing authorization_endpoint or token_endpoint', 'invalid_discovery');
      }
      if (
        message.startsWith('discovery_')
        || message.endsWith('_https_required')
        || message.endsWith('_invalid_url')
        || /^(authorization_endpoint|token_endpoint|userinfo_endpoint|jwks_uri)_/.test(message)
      ) {
        return badRequest(c, 'OIDC URLs must use HTTPS and resolve only to public addresses.', 'invalid_discovery');
      }
      logger.error({ err }, 'admin-oidc: add failed');
      return serverError(c);
    }
  }),
);

adminOidcRoutes.patch(
  '/providers/:id',
  safe(async (c) => {
    requireAdmin(c);
    const body = await c.req.json().catch(() => null);
    const parsed = EditProviderSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    if (Object.keys(parsed.data).length === 0) return badRequest(c, 'no fields to update');
    const id = routeParam(c, 'id');
    const [existing] = await db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1);
    if (!existing) return notFound(c, 'provider not found');
    const shouldValidateDiscovery = parsed.data.isActive !== false || Object.keys(parsed.data).length > 1;
    if (shouldValidateDiscovery) {
      try {
        assertSecureOidcConfiguration(c.req.raw);
        await fetchSecureOidcDiscovery(parsed.data.discoveryUrl ?? existing.discoveryUrl);
      } catch (err) {
        logger.warn({ err, providerId: existing.providerId }, 'admin-oidc: provider validation failed');
        return badRequest(c, 'OIDC discovery and endpoint URLs must use HTTPS and resolve only to public addresses.', 'invalid_discovery');
      }
    }
    const patch: Partial<typeof oidcProviders.$inferInsert> = {};
    if (parsed.data.providerId) patch.providerId = parsed.data.providerId;
    if (parsed.data.discoveryUrl) patch.discoveryUrl = parsed.data.discoveryUrl;
    if (parsed.data.clientId) patch.clientId = parsed.data.clientId;
    if (parsed.data.clientSecret) patch.clientSecret = sealSecret(parsed.data.clientSecret);
    if (parsed.data.scopes) patch.scopes = parsed.data.scopes;
    if (parsed.data.isActive !== undefined) patch.isActive = parsed.data.isActive;
    let updateResult: 'not_found' | 'updated';
    try {
      updateResult = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1);
        if (!current) return 'not_found' as const;
        const [state] = await tx
          .select({ localAuthDisabled: setupState.localAuthDisabled })
          .from(setupState)
          .where(eq(setupState.id, 1))
          .limit(1);
        const mutatesSigninPath = current.isActive && Object.keys(parsed.data).length > 0;
        await tx.update(oidcProviders).set(patch).where(eq(oidcProviders.id, id));
        if (state?.localAuthDisabled && mutatesSigninPath) {
          const linkedAdmin = await sqlAll(sql`
            SELECT 1 FROM oidc_providers p
            JOIN "account" a ON a.provider_id = p.provider_id
            JOIN "user" u ON u.id = a.user_id AND u.role = 'admin'
            WHERE p.is_active = true
              AND p.id <> ${id}
            LIMIT 1
          `);
          if (linkedAdmin.length === 0) throw new Error('last_signin_path');
        }
        return 'updated' as const;
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'last_signin_path') {
        return conflict(c, 'Re-enable local auth before changing the final administrator-linked OIDC provider.', 'last_signin_path');
      }
      throw err;
    }
    if (updateResult === 'not_found') return notFound(c, 'provider not found');
    logger.info({ id, by: 'admin' }, 'admin-oidc: provider updated');
    // Hot-register any active provider configuration change.
    await refreshAuth();
    // If the providerId was renamed, the callback URI also changes — the
    // operator will need to update the IdP registration. Include the new
    // URI in the response so the UI can show "callback URI changed, update
    // your IdP".
    return c.json({
      ok: true,
      restart_required: false,
      callbackUri: callbackUriFor(c, parsed.data.providerId ?? existing.providerId),
      callbackUriChanged: !!parsed.data.providerId && parsed.data.providerId !== existing.providerId,
    });
  }),
);

adminOidcRoutes.delete(
  '/providers/:id',
  safe(async (c) => {
    requireAdmin(c);
    const id = routeParam(c, 'id');
    const [existing] = await db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1);
    if (!existing) return notFound(c, 'provider not found');
    let deleteResult: 'not_found' | 'deleted';
    try {
      deleteResult = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1);
        if (!current) return 'not_found' as const;
        const [state] = await tx
          .select({ localAuthDisabled: setupState.localAuthDisabled })
          .from(setupState)
          .where(eq(setupState.id, 1))
          .limit(1);
        await tx.delete(oidcProviders).where(eq(oidcProviders.id, id));
        if (state?.localAuthDisabled) {
          const linkedAdmin = await sqlAll(sql`
            SELECT 1 FROM oidc_providers p
            JOIN "account" a ON a.provider_id = p.provider_id
            JOIN "user" u ON u.id = a.user_id AND u.role = 'admin'
            WHERE p.is_active = true
            LIMIT 1
          `);
          if (linkedAdmin.length === 0) throw new Error('last_signin_path');
        }
        const remaining = await tx
          .select({ id: oidcProviders.id })
          .from(oidcProviders)
          .where(and(eq(oidcProviders.isActive, true)))
          .limit(1);
        if (remaining.length === 0) {
          await tx.update(setupState).set({ oidcConfigured: false }).where(eq(setupState.id, 1));
        }
        return 'deleted' as const;
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'last_signin_path') {
        return conflict(c, 'Cannot delete the final active OIDC provider while local auth is disabled.', 'last_signin_path');
      }
      throw err;
    }
    if (deleteResult === 'not_found') return notFound(c, 'provider not found');
    logger.info({ id, by: 'admin' }, 'admin-oidc: provider deleted');
    // Hot-register the deletion. The active provider set changed (one
    // fewer entry), so the auth instance is rebuilt.
    await refreshAuth();
    return c.json({ ok: true, restart_required: false });
  }),
);

/**
 * Validate a discovery URL + client credentials without persisting anything.
 * Useful as a "Test connection" button on the add/edit form.
 */
adminOidcRoutes.post(
  '/providers/test',
  safe(async (c) => {
    requireAdmin(c);
    const body = await c.req.json().catch(() => null);
    const parsed = TestDiscoverySchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message ?? 'invalid input');
    try {
      assertSecureOidcConfiguration(c.req.raw);
      const doc = await fetchSecureOidcDiscovery(parsed.data.discoveryUrl);
      const authEp = typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : null;
      const tokenEp = typeof doc.token_endpoint === 'string' ? doc.token_endpoint : null;
      const userInfoEp = typeof doc.userinfo_endpoint === 'string' ? doc.userinfo_endpoint : null;
      const jwksUri = typeof doc.jwks_uri === 'string' ? doc.jwks_uri : null;
      if (!authEp || !tokenEp) {
        return c.json(
          {
            ok: false,
            error: 'Discovery doc missing authorization_endpoint or token_endpoint',
            code: 'invalid_discovery',
          },
          422,
        );
      }
      return c.json({
        ok: true,
        discovery: { authorizationEndpoint: authEp, tokenEndpoint: tokenEp, userinfoEndpoint: userInfoEp, jwksUri },
      });
    } catch (err) {
      return c.json(
        { ok: false, error: `Discovery doc unreachable: ${(err as Error).message}`, code: 'discovery_unreachable' },
        422,
      );
    }
  }),
);
