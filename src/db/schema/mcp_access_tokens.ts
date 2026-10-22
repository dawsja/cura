import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { user } from './auth';

/**
 * Personal access tokens for the MCP server. A user creates one in Settings
 * and pastes it into an MCP client as `Authorization: Bearer <token>`.
 *
 * The token itself is shown once and never stored: only its SHA-256 hex
 * digest is persisted, and lookups go through the unique hash index. The
 * short `token_prefix` lets the user tell tokens apart in the list.
 */
export const mcpAccessTokens = pgTable(
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
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('idx_mcp_access_tokens_user').on(t.userId),
  }),
);

export type McpAccessTokenRow = typeof mcpAccessTokens.$inferSelect;
