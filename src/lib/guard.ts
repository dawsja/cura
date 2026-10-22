/**
 * Top-level guard middleware.
 *
 * For every request:
 *   1. Allow /setup/*, /api/auth/*, /api/setup/*, /health through.
 *   2. Look up setup_state in one cheap query.
 *   3. If the wizard hasn't finished, 307 to /setup.
 *   4. Otherwise ask Better Auth for the session.
 *   5. If no session, 307 to /sign-in.
 *   6. Stash user + session on the Hono context for downstream handlers.
 *
 * Self-host note: redirects use RELATIVE paths (`/setup`, `/sign-in`) so the
 * browser stays on whatever host the user typed (raw IP, LAN IP, or their
 * own domain). We do not assume a canonical APP_URL.
 */
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { db } from '@/db/client';
import { setupState } from '@/db/schema/setup_state';
import { getAuth } from '@/auth';
import { logger } from './logger';
import type { AppEnv } from './tenant';

let cachedStatus: { needsSetup: boolean; expiresAt: number } | null = null;

async function getSetupStatus(): Promise<{ needsSetup: boolean }> {
  // 30-second cache. Avoids a DB hit on every request.
  if (cachedStatus && cachedStatus.expiresAt > Date.now()) {
    return { needsSetup: cachedStatus.needsSetup };
  }
  const rows = await db.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
  const row = rows[0];
  const needsSetup = !row || !row.bootstrapCompleted;
  cachedStatus = { needsSetup, expiresAt: Date.now() + 30_000 };
  return { needsSetup };
}

const PUBLIC_PREFIXES = [
  '/setup',
  '/api/setup',
  '/api/auth',   // Better Auth handler
  '/health',
  '/assets',     // Vite-built static assets
  // Brand assets. Add new ones here when the operator drops a new file
  // into public/. (The match is exact for the basename or `startsWith` for
  // a directory-style prefix, so listing the leaf files is enough.)
  '/logo.png',
  '/logo.ico',
  '/favicon.ico',
  '/favicon',
  '/manifest',
  '/manifest.webmanifest',
  '/icons',
  '/sw.js',
  // SPA routes that render without a session. The React app handles the
  // post-auth flow itself.
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
];

function isPublic(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path === p);
}

export const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;

  if (c.req.method === 'OPTIONS') return next();

  if (isPublic(path)) return next();

  let status: { needsSetup: boolean };
  try {
    status = await getSetupStatus();
  } catch (err) {
    logger.error({ err }, 'guard: failed to read setup_state');
    return c.json({ error: 'service unavailable' }, 503);
  }

  if (status.needsSetup) {
    if (path.startsWith('/api/')) {
      return c.json({ error: 'setup_required', code: 'setup_required' }, 503);
    }
    return c.redirect('/setup', 307);
  }

  const session = await getAuth().api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    if (path.startsWith('/api/')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.redirect('/sign-in', 307);
  }

  c.set('user', {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role:
      'role' in session.user && (typeof session.user.role === 'string' || session.user.role === null)
        ? session.user.role
        : null,
  });
  c.set('session', {
    id: session.session.id,
    token: session.session.token,
    expiresAt: session.session.expiresAt,
  });
  return next();
};

/** Invalidate the cached setup status. Call from the setup wizard after a write. */
export function invalidateSetupCache(): void {
  cachedStatus = null;
}
