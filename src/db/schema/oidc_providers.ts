import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * OIDC providers the owner has wired up via the first-run wizard. The app
 * consumes these via Better Auth's `genericOAuth` plugin, registered at
 * boot from this table. client_secret is sensitive; encrypt at rest in
 * production deployments.
 */
export const oidcProviders = sqliteTable(
  'oidc_providers',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull().unique(), // e.g. "pocketid"
    discoveryUrl: text('discovery_url').notNull(),
    clientId: text('client_id').notNull(),
    clientSecret: text('client_secret').notNull(),
    // A JSON array of scope strings.
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default(['openid', 'email', 'profile']),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    providerIdx: index('idx_oidc_providers_provider').on(t.providerId),
  }),
);

export type OidcProviderRow = typeof oidcProviders.$inferSelect;
export type NewOidcProviderRow = typeof oidcProviders.$inferInsert;
