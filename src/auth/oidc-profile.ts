/**
 * Map an OIDC profile onto the Better Auth user fields for genericOAuth.
 *
 * - `name` comes from the `name` claim, falling back to `preferred_username`
 *   only when `name` is empty.
 * - `email` is pinned to the local user's email once the IdP subject is
 *   linked. With `overrideUserInfo` enabled, Better Auth writes the profile's
 *   email back onto the user on every sign-in, so pinning it here keeps the
 *   local email the source of truth even if the IdP's email claim changes.
 *   Unlinked subjects keep the IdP email so first sign-in can still match
 *   (and link to) an existing user by verified email.
 */
import { and, eq } from 'drizzle-orm';
import type { User } from 'better-auth';
import { db } from '@/db/client';
import { account, user } from '@/db/schema/auth';

function claim(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function mapOidcProfileToUser(
  providerId: string,
  profile: Record<string, unknown>,
): Promise<Partial<User>> {
  const mapped: Partial<User> = {};

  const name = claim(profile.name) ?? claim(profile.preferred_username);
  if (name) mapped.name = name;

  // Better Auth stores the account under `id` (set from `sub` when absent).
  const rawId = typeof profile.id === 'number' ? String(profile.id) : profile.id;
  const subject = claim(rawId) ?? claim(profile.sub);
  if (subject) {
    const [linked] = await db
      .select({ email: user.email })
      .from(account)
      .innerJoin(user, eq(account.userId, user.id))
      .where(and(eq(account.providerId, providerId), eq(account.accountId, subject)))
      .limit(1);
    if (linked) {
      const idpEmail = claim(profile.email)?.toLowerCase();
      mapped.email = linked.email;
      // A verified claim for a different address must not mark the local
      // email verified.
      if (idpEmail !== linked.email.toLowerCase()) mapped.emailVerified = false;
    }
  }

  return mapped;
}
