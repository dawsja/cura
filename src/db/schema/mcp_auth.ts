import { pgEnum, pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { user } from './auth';

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) state for the MCP server.
 *
 * Secrets (device codes, access tokens, refresh tokens) are never stored in
 * plaintext: only their SHA-256 hex digest is persisted, and lookups go
 * through the unique hash index. User codes are short, human-typed values
 * that are only useful while a request is pending, so they are stored
 * normalized (uppercase, no separator) to make the approval lookup cheap.
 */
export const mcpDeviceCodeStatusEnum = pgEnum('mcp_device_code_status', [
  'pending',
  'approved',
  'denied',
  'consumed',
]);

export const mcpTokenKindEnum = pgEnum('mcp_token_kind', ['access', 'refresh']);

export const mcpDeviceCodes = pgTable(
  'mcp_device_codes',
  {
    id: text('id').primaryKey(),
    deviceCodeHash: text('device_code_hash').notNull().unique(),
    userCode: text('user_code').notNull().unique(),
    // Self-declared by the client; shown to the user on the approval page.
    clientId: text('client_id').notNull(),
    scope: text('scope').notNull(),
    status: mcpDeviceCodeStatusEnum('status').notNull().default('pending'),
    // Set when the user approves or denies the request.
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    intervalSeconds: integer('interval_seconds').notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('idx_mcp_device_codes_expires').on(t.expiresAt),
  }),
);

/** One row per connected MCP client. Revoking a grant kills all of its tokens. */
export const mcpGrants = pgTable(
  'mcp_grants',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    scope: text('scope').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('idx_mcp_grants_user').on(t.userId),
  }),
);

export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: text('id').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => mcpGrants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: mcpTokenKindEnum('kind').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Refresh tokens are single-use: set when exchanged for a new pair.
    // Presenting a rotated refresh token again revokes the whole grant.
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    grantIdx: index('idx_mcp_tokens_grant').on(t.grantId),
    expiresIdx: index('idx_mcp_tokens_expires').on(t.expiresAt),
  }),
);

export type McpDeviceCodeRow = typeof mcpDeviceCodes.$inferSelect;
export type McpGrantRow = typeof mcpGrants.$inferSelect;
export type McpTokenRow = typeof mcpTokens.$inferSelect;
