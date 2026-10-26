import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db, sqlAll } from '../client';
import { accounts } from '../schema/accounts';
import { categories } from '../schema/categories';
import { subCategories } from '../schema/sub_categories';
import { transactions } from '../schema/transactions';
import { monthlyBudgets } from '../schema/monthly_budgets';
import { settings } from '../schema/settings';
import { goals } from '../schema/goals';
import { monthlyPaydown, monthlyPaydownSnapshots } from '../schema/monthly_paydown';
import { rules } from '../schema/rules';
import { account as authAccount, session as authSession, user as authUser } from '../schema/auth';
import { mcpAccessTokens } from '../schema/mcp_access_tokens';
import { oidcProviders } from '../schema/oidc_providers';
import { setupState } from '../schema/setup_state';

// ---- Users (admin) ------------------------------------------------------

/** True if this user has a credential (email/password) account row. */
export async function userHasCredential(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')))
    .limit(1);
  return rows.length > 0;
}

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: string | null;
  createdAt: Date;
  hasCredential: boolean;
  hasOidc: boolean;
  /** Comma-separated list of provider IDs (e.g. "pocketid,credential"). */
  providers: string;
  /** True when demoting/deleting this admin would lock the operator out. */
  isProtected: boolean;
  /** Why this admin is locked (used for the UI tooltip). */
  protectionReason: AdminProtectionReason | null;
}

export type AdminProtectionReason = 'last_admin' | 'last_local_admin' | 'last_oidc_admin_when_local_disabled';

/**
 * Single source of truth for the "can this admin be removed?" question.
 * Used by the role-change + delete guards and by the admin UI's lock icon,
 * so the UI and the server can't disagree about who is protected.
 *
 * Rules:
 *   - Non-admin users are never protected.
 *   - The last remaining admin overall is always protected (would leave
 *     the instance with zero admins).
 *   - A local admin is protected when they are the only local admin AND
 *     local auth is still enabled (they are the only recovery path).
 *   - An OIDC admin is protected when they are the only OIDC admin AND
 *     local auth is disabled (they are the only sign-in path).
 */
export function computeIsProtected(
  user: {
    id: string;
    role: string | null;
    hasCredential: boolean;
    hasOidc?: boolean;
  },
  allUsers: Array<{
    id: string;
    role: string | null;
    hasCredential: boolean;
    hasOidc?: boolean;
  }>,
  localAuthDisabled: boolean,
): { isProtected: boolean; reason: AdminProtectionReason | null } {
  if (user.role !== 'admin') return { isProtected: false, reason: null };

  const admins = allUsers.filter((u) => u.role === 'admin');
  const localAdmins = admins.filter((u) => u.hasCredential);
  const oidcAdmins = admins.filter((u) => u.hasOidc);

  const remainingTotal = admins.length - 1;
  if (remainingTotal === 0) return { isProtected: true, reason: 'last_admin' };

  if (user.hasCredential) {
    const remainingLocal = localAdmins.length - 1;
    if (remainingLocal === 0 && !localAuthDisabled) {
      return { isProtected: true, reason: 'last_local_admin' };
    }
  }

  if (user.hasOidc) {
    const remainingOidc = oidcAdmins.length - 1;
    if (remainingOidc === 0 && localAuthDisabled) {
      return {
        isProtected: true,
        reason: 'last_oidc_admin_when_local_disabled',
      };
    }
  }

  return { isProtected: false, reason: null };
}

/**
 * List every user with their provider(s) and computed protection state.
 * The protection calculation needs `localAuthDisabled` because OIDC admins
 * become the only recovery path once local auth is off.
 */
export async function getAllUsers(localAuthDisabled: boolean): Promise<AdminUserRow[]> {
  const rows = await db
    .select({
      id: authUser.id,
      name: authUser.name,
      email: authUser.email,
      role: authUser.role,
      createdAt: authUser.createdAt,
      providerId: authAccount.providerId,
      activeOidcProviderId: oidcProviders.providerId,
    })
    .from(authUser)
    .leftJoin(authAccount, eq(authAccount.userId, authUser.id))
    .leftJoin(oidcProviders, and(
      eq(oidcProviders.providerId, authAccount.providerId),
      eq(oidcProviders.isActive, true),
    ))
    .orderBy(asc(authUser.createdAt));

  // Group providers per user.
  const byId = new Map<string, AdminUserRow>();
  for (const r of rows) {
    let row = byId.get(r.id);
    if (!row) {
      row = {
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        createdAt: r.createdAt,
        hasCredential: false,
        hasOidc: false,
        providers: '',
        isProtected: false,
        protectionReason: null,
      };
      byId.set(r.id, row);
    }
    if (r.providerId) {
      if (r.providerId === 'credential') row.hasCredential = true;
      else if (r.activeOidcProviderId) row.hasOidc = true;
      const list = row.providers ? row.providers.split(',') : [];
      if (!list.includes(r.providerId)) list.push(r.providerId);
      row.providers = list.join(',');
    }
  }
  const allUsers = Array.from(byId.values());
  // Compute protection per row in a second pass so each call sees the
  // full roster (the helper needs the full list to count "other admins").
  for (const u of allUsers) {
    const { isProtected, reason } = computeIsProtected(u, allUsers, localAuthDisabled);
    u.isProtected = isProtected;
    u.protectionReason = reason;
  }
  return allUsers;
}

interface AdminRosterRow {
  id: string;
  role: string | null;
  hasCredential: boolean;
  hasOidc: boolean;
}

/** Every user with the sign-in methods that decide admin protection. */
async function adminRoster(): Promise<AdminRosterRow[]> {
  const rows = await sqlAll<{ id: string; role: string | null; hasCredential: number; hasOidc: number }>(sql`
    SELECT u.id, u.role,
      EXISTS (SELECT 1 FROM "account" a WHERE a.user_id = u.id AND a.provider_id = 'credential') AS "hasCredential",
      EXISTS (
        SELECT 1 FROM "account" a
        JOIN oidc_providers p ON p.provider_id = a.provider_id AND p.is_active = 1
        WHERE a.user_id = u.id
      ) AS "hasOidc"
    FROM "user" u
  `);
  return rows.map((row) => ({ ...row, hasCredential: row.hasCredential === 1, hasOidc: row.hasOidc === 1 }));
}

/**
 * Delete a user and all of their data. The financial tables
 * (transactions, accounts, categories, sub_categories, monthly_budgets,
 * settings) have no ON DELETE CASCADE on `user_id`, so we delete them
 * manually first. The auth `user` row cascades to `session` and
 * `account` automatically.
 *
 * Returns the number of rows deleted (summed across all the data
 * tables) so the admin UI can show "deleted 47 rows of data".
 *
 * Throws if `userId` is a protected admin — uses the same
 * `computeIsProtected` helper that the UI shows the lock icon from, so
 * the server can never reach a zero-admin state through delete.
 */
export async function deleteUserWithData(userId: string): Promise<{ deletedRows: number }> {
  const deletedRows = await db.transaction(async (tx) => {
    const [state] = await tx
      .select({ localAuthDisabled: setupState.localAuthDisabled })
      .from(setupState)
      .where(eq(setupState.id, 1))
      .limit(1);
    const roster = await adminRoster();
    const target = roster.find((row) => row.id === userId);
    if (!target) throw new Error('User not found');
    const { isProtected, reason } = computeIsProtected(target, roster, state?.localAuthDisabled ?? false);
    if (isProtected) throw new Error(protectionMessage(reason));

    let n = 0;
    for (const tbl of [
      transactions,
      monthlyBudgets,
      monthlyPaydown,
      monthlyPaydownSnapshots,
      goals,
      rules,
      subCategories,
      categories,
      accounts,
      settings,
    ]) {
      const r = await tx.delete(tbl).where(eq(tbl.userId, userId)).returning({ userId: tbl.userId });
      n += r.length;
    }
    // Delete the user last. Cascades to session + account (auth).
    const r = await tx.delete(authUser).where(eq(authUser.id, userId)).returning({ id: authUser.id });
    n += r.length;
    return n;
  });

  return { deletedRows };
}

/**
 * Sign a user out everywhere after an admin resets their password: delete
 * their browser sessions and MCP access tokens, so whoever held the old
 * credentials (or a token created with them) loses access. `keepSessionId`
 * spares the admin's own session when they reset their own password.
 */
export async function revokeUserCredentials(
  userId: string,
  keepSessionId?: string,
): Promise<{ sessions: number; tokens: number }> {
  return db.transaction(async (tx) => {
    const sessions = await tx
      .delete(authSession)
      .where(keepSessionId
        ? and(eq(authSession.userId, userId), ne(authSession.id, keepSessionId))
        : eq(authSession.userId, userId))
      .returning({ id: authSession.id });
    const tokens = await tx
      .delete(mcpAccessTokens)
      .where(eq(mcpAccessTokens.userId, userId))
      .returning({ id: mcpAccessTokens.id });
    return { sessions: sessions.length, tokens: tokens.length };
  });
}

/**
 * Update a user's role. Used by the admin UI to promote OIDC users to
 * admin (or demote them). Better Auth's admin plugin stores the role on
 * the `user` row as a free-form text column with two meaningful values:
 * `'admin'` and `'user'` (null also means a regular user).
 *
 * Throws if the target user is the last remaining local admin and the
 * caller is trying to demote them — same guard as delete. When local
 * auth is disabled, the final admin linked to an active OIDC provider
 * is protected instead.
 */
export async function updateUserRole(
  userId: string,
  role: 'admin' | 'user',
): Promise<{ id: string; role: string | null }> {
  if (role !== 'admin' && role !== 'user') {
    throw new Error('role must be "admin" or "user"');
  }
  const nextRole = role === 'admin' ? 'admin' : null;
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select({ localAuthDisabled: setupState.localAuthDisabled })
      .from(setupState)
      .where(eq(setupState.id, 1))
      .limit(1);
    const roster = await adminRoster();
    const target = roster.find((row) => row.id === userId);
    if (!target) throw new Error('User not found');
    if (target.role === 'admin' && role !== 'admin') {
      const { isProtected, reason } = computeIsProtected(target, roster, state?.localAuthDisabled ?? false);
      if (isProtected) throw new Error(protectionMessage(reason));
    }
    await tx.update(authUser).set({ role: nextRole, updatedAt: new Date() }).where(eq(authUser.id, userId));
    return { id: userId, role: nextRole };
  });
}

/**
 * Human-readable message for a protection reason. Used by the route
 * layer's error path so the toast/error text matches what the UI's
 * lock-icon tooltip says.
 */
function protectionMessage(reason: AdminProtectionReason | null): string {
  switch (reason) {
    case 'last_admin':
      return 'Cannot demote or delete the only admin — promote another user to admin first.';
    case 'last_local_admin':
      return 'Cannot demote or delete the last local admin — promote another user to admin first.';
    case 'last_oidc_admin_when_local_disabled':
      return 'Cannot demote or delete the last OIDC admin while local auth is disabled — promote another OIDC user to admin first.';
    default:
      return 'This user is protected.';
  }
}

