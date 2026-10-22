/**
 * First-run setup wizard endpoints.
 *
 * The middleware in src/lib/guard.ts short-circuits to /setup while the
 * `bootstrap_completed` flag is false. This module owns the state machine:
 *
 *   1. ensureSetupState()  — called on app boot, creates the single
 *      setup_state row if missing and prints the bootstrap token to logs.
 *   2. status()            — cheap read for the middleware / UI.
 *   3. bootstrapAdmin()    — first sign-up, atomically promoted to admin
 *      under a Postgres serializable transaction.
 *   4. configureOidc()     — validate discovery doc, store provider,
 *      register with Better Auth's genericOAuth plugin.
 *   5. markBootstrapComplete() — lock and complete the setup state.
 *   6. issueBootstrapToken()   — break-glass CLI helper.
 */
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { customAlphabet } from 'nanoid';
// Bootstrap token hashing uses Bun.password (built-in, bcrypt algorithm).
// No native deps, no platform-specific binaries, works identically in
// every Bun runtime including the distroless production image.
import { db } from '@/db/client';
import { setupState } from '@/db/schema/setup_state';
import { oidcProviders } from '@/db/schema/oidc_providers';
import { user } from '@/db/schema/auth';
import { logger } from '@/lib/logger';
import { fetchSecureOidcDiscovery } from '@/lib/oidc-url';
import { sealSecret } from '@/lib/secret-box';
import { getAuth, refreshAuth } from './instance';

const tokenId = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 24);

export interface SetupStatus {
  needsSetup: boolean;
  bootstrapCompleted: boolean;
  oidcConfigured: boolean;
  bootstrapTokenRequired: boolean;
  needsAdmin: boolean;
  nextStep: 'admin' | 'oidc-configure' | 'oidc-review' | 'done';
  /**
   * True when local email/password auth is hidden + blocked. Set by
   * an admin from /settings after at least one OIDC user has
   * been promoted to admin. Defaults to false — local auth is on by
   * default so a fresh install never locks its first admin out.
   */
  localAuthDisabled: boolean;
}

export async function status(): Promise<SetupStatus> {
  const rows = await db.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
  const row = rows[0];
  if (!row) {
    return {
      needsSetup: true,
      bootstrapCompleted: false,
      oidcConfigured: false,
      bootstrapTokenRequired: false,
      needsAdmin: true,
      nextStep: 'admin',
      localAuthDisabled: false,
    };
  }
  const tokenValid =
    !!row.bootstrapTokenHash &&
    !!row.bootstrapTokenExpiresAt &&
    row.bootstrapTokenExpiresAt > new Date();
  return {
    needsSetup: !row.bootstrapCompleted,
    bootstrapCompleted: row.bootstrapCompleted,
    oidcConfigured: row.oidcConfigured,
    bootstrapTokenRequired: !row.bootstrapCompleted && tokenValid,
    needsAdmin: row.needsAdmin,
    nextStep: row.bootstrapCompleted
      ? 'done'
      : row.needsAdmin
        ? 'admin'
        : row.oidcConfigured
          ? 'oidc-review'
          : 'oidc-configure',
    localAuthDisabled: row.localAuthDisabled,
  };
}

/**
 * Called once on app boot. Creates the setup_state row if missing,
 * generates a fresh bootstrap token, prints it to logs.
 */
export async function ensureSetupState(): Promise<void> {
  const existing = await db.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
  if (existing[0]?.bootstrapCompleted) {
    logger.info('setup: already completed; nothing to do');
    return;
  }

  const token = tokenId();
  const tokenHash = await Bun.password.hash(token, { algorithm: 'bcrypt' });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  if (existing.length === 0) {
    await db.insert(setupState).values({
      id: 1,
      needsAdmin: true,
      oidcConfigured: false,
      bootstrapCompleted: false,
      bootstrapTokenHash: tokenHash,
      bootstrapTokenExpiresAt: expiresAt,
    });
  } else {
    await db
      .update(setupState)
      .set({
        bootstrapTokenHash: tokenHash,
        bootstrapTokenExpiresAt: expiresAt,
      })
      .where(eq(setupState.id, 1));
  }

  // Loud. This token is the ONLY way to bootstrap the first admin.
  logger.warn({ setupBootstrapToken: token }, '===========================================');
  logger.warn({ setupBootstrapToken: token }, '  SETUP BOOTSTRAP TOKEN (1h expiry)');
  logger.warn({ setupBootstrapToken: token }, '  Use this in the /setup wizard');
  logger.warn({ setupBootstrapToken: token }, '===========================================');
}

/**
 * Verify a bootstrap token. Returns true if valid and not expired.
 */
export async function verifyBootstrapToken(token: string): Promise<boolean> {
  const rows = await db.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
  const row = rows[0];
  if (!row?.bootstrapTokenHash || !row.bootstrapTokenExpiresAt) return false;
  if (row.bootstrapTokenExpiresAt < new Date()) return false;
  return Bun.password.verify(token, row.bootstrapTokenHash);
}

/**
 * Bootstrap the first admin while holding the singleton setup row lock.
 * Only the lock winner may create a Better Auth user. The token remains as
 * the setup continuation credential until the wizard is completed.
 */
export async function bootstrapAdmin(input: {
  token: string;
  email: string;
  password: string;
  name: string;
}): Promise<{ userId: string }> {
  let createdUserId: string | null = null;
  try {
    const userId = await db.transaction(async (tx) => {
      const [state] = await tx.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
      if (!state || state.bootstrapCompleted || !state.needsAdmin) {
        throw new Error('admin_already_exists');
      }
      if (!state.bootstrapTokenHash || !state.bootstrapTokenExpiresAt || state.bootstrapTokenExpiresAt < new Date()) {
        throw new Error('invalid_or_expired_bootstrap_token');
      }
      if (!await Bun.password.verify(input.token, state.bootstrapTokenHash)) {
        throw new Error('invalid_or_expired_bootstrap_token');
      }

      const signUpResult = await getAuth().api.signUpEmail({
        body: { email: input.email, password: input.password, name: input.name },
        headers: new Headers(),
      });
      if (!signUpResult?.user?.id) throw new Error('signup_failed');
      createdUserId = signUpResult.user.id;

      const promoted = await tx
        .update(user)
        .set({ role: 'admin', emailVerified: true })
        .where(eq(user.id, createdUserId))
        .returning({ id: user.id });
      if (promoted.length !== 1) throw new Error('signup_failed');

      await tx.update(setupState).set({ needsAdmin: false }).where(eq(setupState.id, 1));
      return createdUserId;
    });
    return { userId };
  } catch (err) {
    // Better Auth uses its own connection. If anything after signup fails,
    // remove the unpromoted account and its cascaded credential/session rows.
    if (createdUserId) {
      try {
        const [createdUser] = await db
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, createdUserId))
          .limit(1);
        // A connection error can make a committed transaction look failed.
        // Never delete the user if the promotion actually became visible.
        if (createdUser && createdUser.role !== 'admin') {
          await db.delete(user).where(eq(user.id, createdUserId));
        }
      } catch (cleanupErr) {
        logger.error({ err: cleanupErr, userId: createdUserId }, 'bootstrap: failed to clean up losing user');
      }
    }
    throw err;
  }
}

/**
 * Validate an OIDC discovery doc, persist the provider, and hot-register
 * it with Better Auth's genericOAuth plugin via `refreshAuth()`. After
 * this returns, OIDC sign-in works for the new provider WITHOUT a
 * container restart.
 *
 * Returns the new providerId plus a `restartRequired: boolean` so the
 * wizard / admin UI can decide whether to surface a "restart" banner
 * (in practice it's `false` for the happy path; `true` only if the
 * in-memory rebuild didn't take, which would indicate a server bug).
 */
export async function configureOidc(input: {
  providerId: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}, options?: { requireIncompleteSetup?: boolean }): Promise<{ providerId: string; restartRequired: boolean }> {
  await fetchSecureOidcDiscovery(input.discoveryUrl);
  const sealedClientSecret = sealSecret(input.clientSecret);

  const id = `oidc-${randomBytes(8).toString('hex')}`;
  await db.transaction(async (tx) => {
    const [state] = await tx.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
    if (!state) throw new Error('setup_state_missing');
    if (options?.requireIncompleteSetup) {
      if (state.bootstrapCompleted) throw new Error('setup_already_completed');
      if (state.needsAdmin) throw new Error('admin_required');
    }

    await tx
      .insert(oidcProviders)
      .values({
        id,
        providerId: input.providerId,
        discoveryUrl: input.discoveryUrl,
        clientId: input.clientId,
        clientSecret: sealedClientSecret,
        scopes: input.scopes ?? ['openid', 'email', 'profile'],
        isActive: true,
      })
      .onConflictDoUpdate({
        target: oidcProviders.providerId,
        set: {
          discoveryUrl: input.discoveryUrl,
          clientId: input.clientId,
          clientSecret: sealedClientSecret,
          scopes: input.scopes ?? ['openid', 'email', 'profile'],
          isActive: true,
        },
      });

    await tx.update(setupState).set({ oidcConfigured: true }).where(eq(setupState.id, 1));
  });

  // Hot-register the new provider with the running Better Auth instance.
  // Without this, the wizard's "test" step (and any immediate OIDC
  // sign-in attempt) would 404 because `genericOAuth` was bound to the
  // pre-boot provider list. Operators no longer need to restart the
  // container after the wizard finishes.
  const { changed } = await refreshAuth();
  if (changed) {
    logger.info({ providerId: input.providerId }, 'oidc: provider hot-registered with Better Auth');
  } else {
    // Should not happen — we just inserted the row — but log loudly if it does.
    logger.warn({ providerId: input.providerId }, 'oidc: provider stored but refreshAuth reported no change');
  }

  return { providerId: input.providerId, restartRequired: !changed };
}

/**
 * Mark the wizard complete. OIDC is optional; a local admin is sufficient.
 */
export async function markBootstrapComplete(): Promise<void> {
  await db.transaction(async (tx) => {
    const [state] = await tx.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
    if (!state) throw new Error('setup_state_missing');
    if (state.bootstrapCompleted) return;
    if (state.needsAdmin) throw new Error('admin_required');

    const admins = await tx.select({ id: user.id }).from(user).where(eq(user.role, 'admin')).limit(1);
    if (admins.length === 0) throw new Error('admin_required');
    await tx
      .update(setupState)
      .set({
        bootstrapCompleted: true,
        bootstrapTokenHash: null,
        bootstrapTokenExpiresAt: null,
      })
      .where(eq(setupState.id, 1));
  });
}

/**
 * Break-glass: re-issue a fresh bootstrap token. Only allowed when no
 * admin exists. Used by the CLI script at scripts/bootstrap-token.ts.
 */
export async function issueBootstrapToken(): Promise<string> {
  const existing = await db.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
  if (existing[0]?.bootstrapCompleted) {
    throw new Error('setup_already_completed');
  }
  const existingAdmins = await db.select({ id: user.id }).from(user).where(eq(user.role, 'admin')).limit(1);
  if (existingAdmins.length > 0) {
    throw new Error('admin_already_exists_recover_via_signin');
  }
  const token = tokenId();
  const tokenHash = await Bun.password.hash(token, { algorithm: 'bcrypt' });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  if (existing.length === 0) {
    await db.insert(setupState).values({
      id: 1,
      bootstrapTokenHash: tokenHash,
      bootstrapTokenExpiresAt: expiresAt,
    });
  } else {
    await db
      .update(setupState)
      .set({ bootstrapTokenHash: tokenHash, bootstrapTokenExpiresAt: expiresAt })
      .where(eq(setupState.id, 1));
  }
  return token;
}
