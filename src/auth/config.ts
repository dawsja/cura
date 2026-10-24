/**
 * Better Auth configuration.
 *
 * Plugins:
 *   - admin        → adds `role` to user, gates admin-only routes
 *   - genericOAuth → consumes OIDC providers from the `oidc_providers` table
 *
 * Self-host note: baseURL + trustedOrigins are dynamic. If `BETTER_AUTH_URL`
 * is unset, the effective baseURL is derived from the request's Host header
 * (and `X-Forwarded-Proto` if behind a proxy). Same for trustedOrigins: any
 * same-origin request is allowed, plus the configured `APP_URL` if the user
 * has set one (useful when OIDC IdPs need a stable callback origin).
 *
 * Dynamic OIDC providers: the genericOAuth plugin is registered with the
 * providers that exist in the DB at boot time. Use `createAuth(providers)`
 * to construct the instance and `initAuth()` / `getAuth()` (in
 * `./instance.ts`) to manage the singleton.
 */
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin as adminPlugin } from 'better-auth/plugins/admin';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { mapOidcProfileToUser } from './oidc-profile';
import { ac, admin as adminRole, user as userRole } from './permissions';
import { db } from '@/db/client';
import * as schema from '@/db/schema';
import { configuredExternalOrigin, env, resolveOrigin, useSecureAuthCookies } from '@/lib/env';

/** Provider shape that gets handed to Better Auth's genericOAuth plugin. */
export interface AuthOidcProvider {
  providerId: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

/** True if the request's Origin header matches the request's Host header. */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser callers (no Origin) are allowed
  const host = request.headers.get('host') ?? request.headers.get('x-forwarded-host');
  if (!host) return false;
  try {
    const o = new URL(origin);
    return o.host === host;
  } catch {
    return false;
  }
}

function isExplicitOrigin(request: Request): boolean {
  // Treat the configured APP_URL (if any) as a valid cross-origin allowance —
  // useful when the OIDC IdP is on a different subdomain the operator trusts.
  const configured = env.APP_URL;
  if (!configured) return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const a = new URL(configured);
    const b = new URL(origin);
    return a.host === b.host;
  } catch {
    return false;
  }
}

/**
 * Build a Better Auth instance. Providers are passed in (read from the DB
 * by the caller) so the genericOAuth plugin is configured with whatever's
 * live at boot time. Adding a new provider via the admin UI requires an
 * app restart to re-call this with the updated list — see instance.ts.
 */
export function createAuth(providers: AuthOidcProvider[]) {
  const baseConfig: BetterAuthOptions = {
    appName: 'Cura Money',
    baseURL: configuredExternalOrigin(),
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: (request) => {
      if (!request) return env.APP_URL ? [env.APP_URL] : [];
      if (isSameOrigin(request)) {
        const host = request.headers.get('host') ?? request.headers.get('x-forwarded-host');
        const proto = request.headers.get('x-forwarded-proto') ?? 'http';
        return host ? [`${proto}://${host}`] : [];
      }
      if (isExplicitOrigin(request)) {
        return env.APP_URL ? [env.APP_URL] : [];
      }
      return [];
    },

    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),

    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: env.DEMO_MODE ? 4 : 12,
      maxPasswordLength: 256,
    },

    // Account linking: by default Better Auth allows an OIDC sign-in to
    // implicitly link to an existing local user when the emails match.
    // The local email is the source of truth (never overwritten by the
    // IdP's claim), and the local user is created on first OIDC sign-in
    // if it doesn't exist yet. We make this explicit so the policy is
    // auditable; the defaults are also explicit here for the same
    // reason. See the better-auth "users-accounts#account-linking" docs.
    account: {
      accountLinking: {
        enabled: true,
        // Require the local email to be verified before allowing an OIDC
        // sign-in to link to it. Our admin user gets `emailVerified=true`
        // at bootstrap time (see src/auth/setup.ts), so this lets the
        // admin sign in with OIDC after a fresh install without any
        // email-verification roundtrip. For a stricter setup, an
        // operator could flip this to false and require explicit
        // invitation.
        requireLocalEmailVerified: true,
        // If you want to allow only specific providers to link implicitly,
        // list them here. Empty = all configured providers are allowed.
        trustedProviders: [],
        // Copy the user's `name` and `image` from the OIDC profile when an
        // IdP identity is first linked to an existing local user. Better
        // Auth only applies this at link time; the per-sign-in refresh is
        // the provider's `overrideUserInfo` option below.
        updateUserInfoOnLink: true,
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24,        // refresh once per day
      // NOTE: cookieCache is intentionally disabled. With it on, Better
      // Auth caches the session in a `session_data` HTTP-only cookie for
      // 5 minutes, and sign-out does NOT clear that cookie (the
      // cookie-clearing Set-Cookie header is dropped on the way out of
      // Better Auth's internal API method). The end result: clicking
      // "Sign out" deletes the session row, but /api/auth-app/me still
      // returns the user from the cache for up to 5 minutes, and the
      // protected Layout never re-renders to the sign-in page. For a
      // single-user self-host the DB hit per request is fine, so we
      // skip the cache. Re-enable here if you ever need to scale reads.
      cookieCache: {
        enabled: false,
      },
    },

    advanced: {
      useSecureCookies: useSecureAuthCookies(),
    },

    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
    },
  };

  // Build the plugin list dynamically. Only attach genericOAuth when
  // there's at least one provider configured — an empty config would log
  // a warning on every request.
  const plugins: NonNullable<BetterAuthOptions['plugins']> = [
    adminPlugin({
      ac,
      roles: { admin: adminRole, user: userRole },
      defaultRole: 'user',
      adminRoles: ['admin'],
    }),
  ];

  if (!env.DEMO_MODE && providers.length > 0) {
    plugins.push(
      genericOAuth({
        config: providers.map((p) => ({
          providerId: p.providerId,
          discoveryUrl: p.discoveryUrl,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          scopes: p.scopes ?? ['openid', 'email', 'profile'],
          // Existing users may sign in or link by verified email, but an
          // arbitrary IdP identity cannot silently create a new tenant.
          disableImplicitSignUp: true,
          // Refresh `name` and `image` from the IdP on every sign-in, not
          // only on first link. Better Auth also writes the profile email
          // here, so mapOidcProfileToUser pins it to the local email once
          // the IdP subject is linked: the local email stays the source of
          // truth.
          overrideUserInfo: true,
          mapProfileToUser: (profile) => mapOidcProfileToUser(p.providerId, profile),
          // Dynamic authorize-URL params. Better Auth's genericOAuth plugin
          // accepts the static `prompt` field only at config time (not from
          // the request body, since the sign-in body schema doesn't include
          // it). To force re-auth on a per-request basis (e.g. right after
          // a local sign-out so the IdP doesn't silently re-authenticate
          // using its own session cookie), the client passes
          // `additionalData: { promptLogin: true }` in the body, and we
          // translate that to `prompt=login` on the authorize URL here.
          //
          // Better Auth's typing requires this function to ALWAYS return a
          // `Record<string, string>` — never undefined. Returning {} when
          // no extra params are needed is the canonical no-op.
          authorizationUrlParams: (ctx): Record<string, string> => {
            const body = ctx.body as
              | { additionalData?: { promptLogin?: boolean } }
              | undefined;
            return body?.additionalData?.promptLogin ? { prompt: 'login' } : {};
          },
        })),
      }),
    );
  }

  return betterAuth({ ...baseConfig, plugins });
}

export type Auth = ReturnType<typeof createAuth>;

// Re-export for callers that need to compute effective origins without
// importing from @/lib/env separately.
export { resolveOrigin };
