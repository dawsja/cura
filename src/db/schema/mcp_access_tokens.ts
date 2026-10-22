import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { user } from './auth';

/**
 * Personal access tokens for the MCP server. A user creates one in Settings
 * and pastes it into an MCP client as `Authorization: Bearer <token>`.
 *
 * The token itself is shown once and never stored: only its SHA-256 hex
 * digest is persisted, and lookups go through the unique hash index. The
 * short `token_prefix` lets the user tell tokens apart in the list.
 */
export const mcpAccessTokens = sqliteTable(
  'mcp_access_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    scope: text('scope').notNull(),
    // Null means the token never expires; revoking deletes the row.
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    userIdx: index('idx_mcp_access_tokens_user').on(t.userId),
  }),
);

export type McpAccessTokenRow = typeof mcpAccessTokens.$inferSelect;
