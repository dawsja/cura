/**
 * Local-auth toggle.
 *
 * `local_auth_disabled` lives on the single `setup_state` row. When
 * TRUE, the Hono middleware in `src/index.ts` short-circuits
 * `POST /api/auth/sign-in/email`, `POST /api/auth/sign-up/email`, and
 * `POST /api/auth/change-password` with a 403, and the sign-in page
 * hides the email/password form. The flag is OFF by default — every
 * existing install continues to allow local auth without any user
 * action.
 *
 * The only enforced guard for flipping the flag ON is that at least
 * one OIDC user must already hold the `admin` role, so the operator
 * can never lock themselves out of their own instance. Re-enabling
 * local auth has no precondition.
 *
 * An OIDC-capable user has an `account.provider_id` matching an active
 * `oidc_providers.provider_id`. Stale account rows for removed, renamed,
 * or inactive providers do not count as a viable sign-in path.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { setupState } from '@/db/schema/setup_state';
import { oidcProviders } from '@/db/schema/oidc_providers';
import { user as authUser, account as authAccount } from '@/db/schema/auth';
import { logger } from '@/lib/logger';

/**
 * Read the current `local_auth_disabled` flag. Returns false (the
 * safe default) if the setup_state row doesn't exist yet (fresh
 * install pre-bootstrap) so callers don't have to special-case that
 * window.
 *
 * On any DB error we also return false: local auth being enabled is
 * the safe default (it can never lock the operator out). A missing
 * `local_auth_disabled` column (boot-time migration didn't run for
 * some reason) should NOT break the email/password sign-in path —
 * the admin endpoint will surface the failure separately so the
 * operator can re-run migrations. We log once so this is visible in
 * the container logs without flooding.
 */
export async function isLocalAuthDisabled(): Promise<boolean> {
  try {
    const rows = await db
      .select({ localAuthDisabled: setupState.localAuthDisabled })
      .from(setupState)
      .where(eq(setupState.id, 1))
      .limit(1);
    return rows[0]?.localAuthDisabled ?? false;
  } catch (err) {
    logReadFailureOnce('isLocalAuthDisabled', err);
    return false;
  }
}

let _readFailureLogged = false;
function logReadFailureOnce(where: string, err: unknown): void {
  if (_readFailureLogged) return;
  _readFailureLogged = true;
  logger.warn(
    { where, err: err instanceof Error ? err.message : String(err) },
    'local-auth: read failed, defaulting to enabled (admin endpoint will surface the failure)',
  );
}

/**
 * Flip the flag. Requires an existing OIDC admin when transitioning
 * to disabled; re-enabling (false → true) has no precondition.
 *
 * Throws `local_auth_disabled_precondition_failed` when the caller
 * tries to disable without an OIDC admin in place. The route layer
 * translates that into a 400 with a useful message.
 */
export async function setLocalAuthDisabled(disabled: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    if (disabled) {
      const oidcAdmins = await tx
        .select({ id: authUser.id })
        .from(authUser)
        .innerJoin(authAccount, eq(authAccount.userId, authUser.id))
        .innerJoin(oidcProviders, eq(oidcProviders.providerId, authAccount.providerId))
        .where(and(eq(authUser.role, 'admin'), eq(oidcProviders.isActive, true)))
        .limit(1);
      if (oidcAdmins.length === 0) {
        throw new Error('local_auth_disabled_precondition_failed');
      }
    }
    await tx
      .update(setupState)
      .set({ localAuthDisabled: disabled })
      .where(eq(setupState.id, 1));
  });
  logger.info(
    { localAuthDisabled: disabled, by: 'admin' },
    'local-auth: flag updated',
  );
}

/**
 * Snapshot for the admin endpoint + the sign-in page. Computed in
 * one pass so the UI doesn't see a half-applied state (e.g. OIDC
 * configured but flag already enabled by a parallel request).
 */
export interface LocalAuthInfo {
  localAuthDisabled: boolean;
  canDisable: boolean;
  /** Number of admins who have signed in via a real OIDC provider.
   *  Used by the UI to surface the "promote at least one OIDC user
   *  to admin" message before the toggle is unlocked. */
  oidcAdminCount: number;
}

export async function getLocalAuthInfo(): Promise<LocalAuthInfo> {
  // Both parallel reads go through Drizzle's query
  // builder (no raw SQL cast gymnastics); if the column or table
  // isn't there yet, the query builder throws a structured error
  // with a column/table name the admin UI surfaces verbatim so the
  // operator can re-run migrations.
  const [stateRows, oidcAdminRows] = await Promise.all([
    db
      .select({ localAuthDisabled: setupState.localAuthDisabled })
      .from(setupState)
      .where(eq(setupState.id, 1))
      .limit(1),
    db
      .select({ id: authUser.id })
      .from(authUser)
      .innerJoin(authAccount, eq(authAccount.userId, authUser.id))
      .innerJoin(oidcProviders, eq(oidcProviders.providerId, authAccount.providerId))
      .where(and(eq(authUser.role, 'admin'), eq(oidcProviders.isActive, true)))
      .groupBy(authUser.id),
  ]);
  const localAuthDisabled = stateRows[0]?.localAuthDisabled ?? false;
  const oidcAdminCount = oidcAdminRows.length;
  const canDisable = oidcAdminCount > 0;
  return { localAuthDisabled, canDisable, oidcAdminCount };
}
