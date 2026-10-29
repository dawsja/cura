/**
 * Keeps OIDC redirect URIs registered before Better Auth 1.7 working.
 *
 * 1.7 moved Generic OAuth providers onto the core social routes, so the IdP
 * callback moved from `/api/auth/oauth2/callback/:id` to
 * `/api/auth/callback/:id`. Operators have the old URI registered in their
 * IdP, so this plugin pins each provider's callback path (and with it the
 * `redirect_uri` sent on authorize and token exchange) to the old path, and
 * routes requests arriving there to the core callback handler.
 */
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';

const LEGACY_CALLBACK = /^\/api\/auth\/oauth2\/callback\/([^/]+)\/?$/;

export function legacyOidcCallback(providerIds: string[]): BetterAuthPlugin {
  const ids = new Set(providerIds);
  return {
    id: 'legacy-oidc-callback',
    onRequest: async (request) => {
      const url = new URL(request.url);
      const match = LEGACY_CALLBACK.exec(url.pathname);
      if (!match) return;
      url.pathname = `/api/auth/callback/${match[1]}`;
      return { request: new Request(url, request) };
    },
    hooks: {
      // Runs after genericOAuth's own before-hook, which may add a provider
      // whose discovery failed at startup, so late providers are pinned too.
      before: [{
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          for (const provider of ctx.context.socialProviders) {
            if (ids.has(provider.id)) provider.callbackPath = `/oauth2/callback/${encodeURIComponent(provider.id)}`;
          }
        }),
      }],
    },
  };
}
