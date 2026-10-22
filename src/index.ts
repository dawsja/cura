/**
 * Hono application entry. Wires:
 *   1. /health (public, no auth)
 *   2. /api/auth/* → Better Auth handler
 *   3. /api/setup/* → first-run wizard (public until complete)
 *   4. /.well-known/oauth-*, /oauth/* → MCP device-code OAuth (public)
 *   5. /mcp → remote MCP server (bearer access tokens, not sessions)
 *   6. /api/{accounts,budget,categories,goals,transactions,simplefin}/* → resource routes
 *   7. Everything else → Vite-built static SPA (Caddy serves it in prod; in dev
 *      Vite proxies to here and the SPA fallback is handled by Caddy too)
 *
 * On boot: run migrations, then ensureSetupState() (prints bootstrap token).
 */
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { getAuth, initAuth, isLocalAuthDisabled } from '@/auth';
import { ensureSetupState } from '@/auth/setup';
import { guard } from '@/lib/guard';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { checkDb, closeDb } from '@/db/client';
import { runMigrations } from '@/db/migrate';
import { startCron, type CronHandle } from '@/jobs/cron';
import { runExclusiveJob } from '@/jobs/lifecycle';
import { runRetention } from '@/jobs/retention';
import { resetDemoDatabase } from '@/db/demo-reset';
import { authRoutes } from '@/routes/auth';
import { setupRoutes } from '@/routes/setup';
import { accountRoutes } from '@/routes/accounts';
import { budgetRoutes } from '@/routes/budget';
import { categoryRoutes } from '@/routes/categories';
import { transactionRoutes } from '@/routes/transactions';
import { simplefinRoutes } from '@/routes/simplefin';
import { adminOidcRoutes } from '@/routes/admin-oidc';
import { adminUserRoutes } from '@/routes/admin-users';
import { adminAuthRoutes } from '@/routes/admin-auth';
import { adminSystemRoutes } from '@/routes/admin-system';
import { paydownRoutes } from '@/routes/paydown';
import { goalRoutes } from '@/routes/goals';
import { reportRoutes } from '@/routes/reports';
import { ruleRoutes } from '@/routes/rules';
import { reviewRoutes } from '@/routes/reviews';
import { recurringRoutes } from '@/routes/recurring';
import { notificationRoutes } from '@/routes/notifications';
import { dashboardRoutes } from '@/routes/dashboard';
import { dataRoutes } from '@/routes/data';
import { onboardingRoutes } from '@/routes/onboarding';
import { preferenceRoutes } from '@/routes/preferences';
import { oauthRoutes } from '@/routes/oauth';
import { mcpRoutes } from '@/routes/mcp';
import { mcpGrantRoutes } from '@/routes/mcp-grants';
import type { AppEnv } from '@/lib/tenant';

export const app = new Hono<AppEnv>();
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const READINESS_TIMEOUT_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 25_000;
let ready = false;

// ---- Logging + error JSON -----------------------------------------------
app.use('*', requestId({ limitLength: 128 }));
app.use('*', async (c, next) => {
  const start = Date.now();
  try {
    await next();
  } finally {
    logger.debug(
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Date.now() - start,
      },
      'http',
    );
  }
});
app.use('*', bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: (c) => c.json({ error: 'request body too large', code: 'payload_too_large' }, 413),
}));

app.onError((err, c) => {
  logger.error({ err, requestId: c.get('requestId'), path: c.req.path }, 'unhandled');
  return c.json({ error: 'internal server error', code: 'unhandled' }, 500);
});

app.notFound((c) => c.json({ error: 'not found', code: 'not_found' }, 404));

// ---- Health (public) ----------------------------------------------------
app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/ready', async (c) => {
  if (!ready) return c.json({ status: 'not_ready' }, 503);
  try {
    await checkDb(READINESS_TIMEOUT_MS);
    return c.json({ status: 'ok' });
  } catch (err) {
    logger.warn({ err, requestId: c.get('requestId') }, 'readiness check failed');
    return c.json({ status: 'not_ready' }, 503);
  }
});

// ---- Local-auth gate (mounted BEFORE Better Auth) -----------------------
//
// Public email sign-up is always blocked here; bootstrap uses Better Auth's
// internal API and does not traverse this HTTP middleware. When
// `local_auth_disabled` is TRUE, sign-in/change-password via email+password
// are also blocked. The OIDC endpoints
// (/api/auth/sign-in/oauth2, /api/auth/oauth2/callback/*) are NOT
// gated here — they fall through to the Better Auth handler below.
//
// We only short-circuit POSTs against the known email/password
// endpoints. Everything else (GET session, OAuth, etc.) flows through
// to Better Auth untouched. The check is one cheap indexed SELECT per
// attempt — acceptable on the auth path, and the read is consistent
// with the value the sign-in page is rendering against.
const LOCAL_AUTH_GATED_POSTS = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-up/email',
  '/api/auth/change-password',
  // Password reset flow: blocking the request side (and the consume
  // side, for defense in depth) prevents account-takeover via the
  // "request a reset email to a known address" path while local auth
  // is supposedly off.
  '/api/auth/request-password-reset',
  '/api/auth/reset-password',
  // verify-password is an internal session-gated check (used by
  // confirm-delete-style flows) — gate it too so a stale session
  // can't be repurposed against the now-disabled email/password
  // world.
  '/api/auth/verify-password',
]);

app.use('/api/auth/*', async (c, next) => {
  if (env.DEMO_MODE) {
    const path = c.req.path.replace(/\/+$/, '');
    if (c.req.method === 'POST' && path === '/api/auth/sign-in/email') return next();
    return c.json(
      { error: 'This authentication operation is disabled for demo purposes.', code: 'demo_mode' },
      403,
    );
  }
  if (c.req.method !== 'POST') return next();
  if (c.req.path.replace(/\/+$/, '') === '/api/auth/sign-up/email') {
    return c.json(
      { error: 'Public email sign-up is disabled.', code: 'public_signup_disabled' },
      403,
    );
  }
  if (!LOCAL_AUTH_GATED_POSTS.has(c.req.path)) return next();
  if (!(await isLocalAuthDisabled())) return next();
  return c.json(
    {
      error: 'Email/password authentication is disabled. Sign in with an OIDC provider.',
      code: 'local_auth_disabled',
    },
    403,
  );
});

// ---- Better Auth handler (public, mounted BEFORE guard) -----------------
app.on(['GET', 'POST'], '/api/auth/*', (c) => getAuth().handler(c.req.raw));

// ---- Setup wizard (public until bootstrap completes) -------------------
app.route('/api/setup', setupRoutes);

// ---- Auth (sign-in / sign-up / sign-out thin wrappers, public) ----------
//    Better Auth's own /api/auth/sign-in/email is used by the SPA; this
//    router exposes /api/auth/me, /api/auth/logout helpers the UI uses.
app.route('/api/auth-app', authRoutes);

// ---- MCP server + its OAuth device flow (public, bearer-token auth) ------
//    Mounted before the guard: MCP clients authenticate with access tokens
//    from /oauth/token, which are deliberately not valid as browser sessions
//    (and session cookies are not accepted at /mcp).
app.route('/', oauthRoutes);
app.route('/mcp', mcpRoutes);

// ---- Guard everything below --------------------------------------------
app.use('*', guard);

app.use('/api/admin/*', async (c, next) => {
  if (!env.DEMO_MODE) return next();
  return c.json({ error: 'Administration is disabled for demo purposes.', code: 'demo_mode' }, 403);
});

// ---- Resource routes (all require auth) ---------------------------------
app.route('/api/accounts', accountRoutes);
app.route('/api/budget', budgetRoutes);
app.route('/api/categories', categoryRoutes);
app.route('/api/transactions', transactionRoutes);
app.route('/api/simplefin', simplefinRoutes);
app.route('/api/admin/oidc', adminOidcRoutes);
app.route('/api/admin/users', adminUserRoutes);
app.route('/api/admin/auth', adminAuthRoutes);
app.route('/api/admin/system', adminSystemRoutes);
app.route('/api/paydown', paydownRoutes);
app.route('/api/goals', goalRoutes);
app.route('/api/rules', ruleRoutes);
app.route('/api/reviews', reviewRoutes);
app.route('/api/reports', reportRoutes);
app.route('/api/recurring', recurringRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/data', dataRoutes);
app.route('/api/onboarding', onboardingRoutes);
app.route('/api/preferences', preferenceRoutes);
app.route('/api/mcp', mcpGrantRoutes);

// ---- Static SPA ------------------------------------------------------------
// The Vite-built SPA is baked into ./public at image-build time. Serve the
// static assets first, then fall back to index.html for client-side routes.
// Works identically in dev and prod — the operator doesn't need a separate
// Vite dev server to view the UI; just hit the root URL.
//
// Note: @hono/node-server's `serveStatic({ root })` has a known path-join
// quirk (path.join('./public', '/foo.png') drops the root on some path
// libs) that ends up falling through to the index.html fallback for files
// at the top of `public/`. We do the static serving ourselves with a tiny
// custom middleware — only ~20 lines and the behaviour is obvious.
import { createReadStream, statSync, existsSync } from 'node:fs';
import { resolve, join, normalize } from 'node:path';
import { getMimeType } from 'hono/utils/mime';

const PUBLIC_DIR = resolve('./public');
const STATIC_INDEX = join(PUBLIC_DIR, 'index.html');

app.use('/*', async (c, next) => {
  // Only GET/HEAD are served as static; everything else falls through.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();

  // Strip the leading slash and URL-decode. Reject any path that tries
  // to escape the public dir (../, absolute paths, null bytes).
  let rel: string;
  try {
    rel = decodeURIComponent(c.req.path).replace(/^\/+/, '');
  } catch {
    return c.json({ error: 'invalid path encoding', code: 'invalid_path' }, 400);
  }
  if (!rel) rel = 'index.html';
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR + '/') && target !== PUBLIC_DIR) {
    return next(); // traversal attempt, fall through
  }
  if (!existsSync(target)) return next();

  const stats = statSync(target);
  let filePath = target;
  if (stats.isDirectory()) {
    filePath = join(target, 'index.html');
    if (!existsSync(filePath)) return next();
  }

  const ctype = getMimeType(filePath) || 'application/octet-stream';
  c.header('Content-Type', ctype);
  if (rel === 'sw.js') {
    c.header('Cache-Control', 'no-cache');
    c.header('Service-Worker-Allowed', '/');
  } else if (rel === 'index.html' || rel === 'manifest.webmanifest') {
    c.header('Cache-Control', 'no-cache');
  } else if (rel.startsWith('assets/')) {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    c.header('Cache-Control', 'public, max-age=86400');
  }
  const stream = createReadStream(filePath);
  // Hono's helper converts a Node Readable into a Web ReadableStream.
  const { Readable } = await import('node:stream');
  return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 200);
});

// SPA fallback: any GET that didn't match a real file → index.html.
app.get('*', async (c) => {
  if (!existsSync(STATIC_INDEX)) return c.text('not found', 404);
  const ctype = getMimeType(STATIC_INDEX) || 'text/html';
  c.header('Content-Type', ctype);
  c.header('Cache-Control', 'no-cache');
  const { Readable } = await import('node:stream');
  const stream = createReadStream(STATIC_INDEX);
  return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 200);
});

// ---- Boot ---------------------------------------------------------------
let server: ServerType | undefined;
let cronHandle: CronHandle | undefined;

async function runStartupDemoReset(): Promise<void> {
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    const reset = await runExclusiveJob('demo-reset', resetDemoDatabase);
    if (reset.status === 'completed') {
      logger.info({ result: reset.value }, 'demo: startup database reset complete');
      return;
    }
    if (attempt === 1) {
      logger.info({ reason: reset.reason }, 'demo: waiting for another replica to release the reset lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('timed out waiting to acquire the demo reset lock during startup');
}

async function main(): Promise<void> {
  await runMigrations();
  if (env.DEMO_MODE) {
    logger.warn('DEMO MODE IS ACTIVE: all application data will be replaced every 15 minutes');
    await runStartupDemoReset();
  }
  await ensureSetupState();
  // Initialise Better Auth with whatever OIDC providers are currently in
  // the DB. Providers are hot-registered via `refreshAuth()` from the
  // setup wizard and the admin OIDC endpoints — no restart required.
  await initAuth();

  // Retention sweep on boot — a fresh deploy needs to clean up old
  // data immediately, not wait for the next 04:00 UTC cron tick. The
  // job is idempotent (no-op when there's nothing to delete).
  if (!env.DEMO_MODE) {
    try {
      const retention = await runExclusiveJob('retention', runRetention);
      if (retention.status === 'skipped') {
        logger.info({ reason: retention.reason }, 'retention: boot sweep skipped because another run owns the lock');
      }
    } catch (err) {
      logger.error({ err }, 'retention: boot sweep failed');
    }
  }

  if (env.DEMO_MODE || env.RUN_CRON) {
    cronHandle = startCron();
  } else {
    logger.warn('cron: disabled by RUN_CRON=false');
  }

  server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    ready = true;
    logger.info(
      { port: info.port, env: env.NODE_ENV, cron: env.DEMO_MODE || env.RUN_CRON, demoMode: env.DEMO_MODE },
      'cura-money v2 listening',
    );
  });
}

function closeServer(): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server!.close((err?: Error) => err ? reject(err) : resolve());
  });
}

let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: string, initialFailure = false): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logger.warn({ signal }, 'shutting down');
    ready = false;
    let failed = initialFailure;
    try {
      await cronHandle?.stop();
      const draining = Promise.all([
        closeServer(),
        cronHandle?.waitForIdle() ?? Promise.resolve(),
      ]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          draining,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('graceful shutdown deadline exceeded')),
              SHUTDOWN_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (err) {
      failed = true;
      logger.error({ err }, 'graceful shutdown failed');
      if (server && 'closeAllConnections' in server) server.closeAllConnections();
    } finally {
      try {
        await closeDb();
      } catch (err) {
        failed = true;
        logger.error({ err }, 'database shutdown failed');
      }
    }
    process.exit(failed ? 1 : 0);
  })();
  return shutdownPromise;
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

if (import.meta.main) {
  main().catch((err) => {
    logger.fatal({ err }, 'boot failed');
    void shutdown('boot_failure', true);
  });
}
