import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Setup state — single-row table that tracks the first-run wizard progress.
 *
 * The middleware in src/lib/guard.ts reads this on every request to decide
 * whether to 307 to /setup. The bootstrap token hash is bcrypt; the plain
 * token is printed to container logs ONCE on first boot and stored nowhere
 * plaintext after that.
 */
export const setupState = sqliteTable('setup_state', {
  // Single row, id is always 1
  id: integer('id').primaryKey().default(1),
  needsAdmin: integer('needs_admin', { mode: 'boolean' }).notNull().default(true),
  oidcConfigured: integer('oidc_configured', { mode: 'boolean' }).notNull().default(false),
  bootstrapCompleted: integer('bootstrap_completed', { mode: 'boolean' }).notNull().default(false),
  bootstrapTokenHash: text('bootstrap_token_hash'),
  bootstrapTokenExpiresAt: integer('bootstrap_token_expires_at', { mode: 'timestamp_ms' }),
  // When TRUE, email/password sign-in + change-password
  // endpoints return 403 and the sign-in page hides the local-auth
  // form. Admins can only flip this after at least one OIDC user has
  // been promoted to admin (see `setLocalAuthDisabled()` in
  // src/auth/local_auth.ts). Defaults to FALSE so a fresh install
  // never blocks its first admin out.
  localAuthDisabled: integer('local_auth_disabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
});

export type SetupStateRow = typeof setupState.$inferSelect;
export type NewSetupStateRow = typeof setupState.$inferInsert;
