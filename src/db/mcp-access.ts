/**
 * Persistence for MCP personal access tokens. See `src/lib/mcp-access.ts`
 * for the token format and hashing.
 *
 * Authentication is keyed by the token's hash. Management operations
 * (create, list, delete) take `userId` and filter by `user_id`.
 */
import { and, count, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from './client';
import { mcpAccessTokens } from './schema/mcp_access_tokens';
import { MCP_SCOPE, generateMcpAccessToken, hashSecret, tokenDisplayPrefix } from '@/lib/mcp-access';
import { logger } from '@/lib/logger';

/** Per-user cap, so a runaway script can't fill the table. */
export const MAX_MCP_TOKENS_PER_USER = 25;
// Avoid a write on every request; minute resolution is plenty for "last used".
const LAST_USED_RESOLUTION_MS = 60_000;
// Expired tokens stay listed (as expired) for a while before cleanup.
const EXPIRED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface McpPrincipal {
  userId: string;
  tokenId: string;
  scope: string;
}

export interface McpTokenSummary {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

function toSummary(row: typeof mcpAccessTokens.$inferSelect): McpTokenSummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.tokenPrefix,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

export async function authenticateMcpAccessToken(token: string, now = new Date()): Promise<McpPrincipal | null> {
  const [row] = await db
    .select({
      id: mcpAccessTokens.id,
      userId: mcpAccessTokens.userId,
      scope: mcpAccessTokens.scope,
      expiresAt: mcpAccessTokens.expiresAt,
      lastUsedAt: mcpAccessTokens.lastUsedAt,
    })
    .from(mcpAccessTokens)
    .where(eq(mcpAccessTokens.tokenHash, hashSecret(token)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await db.update(mcpAccessTokens).set({ lastUsedAt: now }).where(eq(mcpAccessTokens.id, row.id));
  }
  return { userId: row.userId, tokenId: row.id, scope: row.scope };
}

/** Create a token. The plaintext is returned once and never stored. */
export async function createMcpAccessToken(
  userId: string,
  input: { name: string; expiresAt: Date | null },
): Promise<{ token: string; summary: McpTokenSummary }> {
  const [existing] = await db
    .select({ n: count() })
    .from(mcpAccessTokens)
    .where(eq(mcpAccessTokens.userId, userId));
  if ((existing?.n ?? 0) >= MAX_MCP_TOKENS_PER_USER) {
    throw Object.assign(
      new Error(`You can have up to ${MAX_MCP_TOKENS_PER_USER} tokens. Revoke one you no longer use first.`),
      { status: 409 },
    );
  }
  const token = generateMcpAccessToken();
  const [row] = await db
    .insert(mcpAccessTokens)
    .values({
      id: `mcpt-${nanoid(12)}`,
      userId,
      name: input.name,
      tokenHash: hashSecret(token),
      tokenPrefix: tokenDisplayPrefix(token),
      scope: MCP_SCOPE,
      expiresAt: input.expiresAt,
    })
    .returning();
  logger.info({ userId, tokenId: row!.id, expiresAt: input.expiresAt }, 'mcp: access token created');
  return { token, summary: toSummary(row!) };
}

export async function listMcpAccessTokens(userId: string): Promise<McpTokenSummary[]> {
  const rows = await db
    .select()
    .from(mcpAccessTokens)
    .where(eq(mcpAccessTokens.userId, userId))
    .orderBy(desc(mcpAccessTokens.createdAt));
  return rows.map(toSummary);
}

/** Revoke a token by deleting it. Returns false if it isn't the user's. */
export async function deleteMcpAccessToken(userId: string, tokenId: string): Promise<boolean> {
  const deleted = await db
    .delete(mcpAccessTokens)
    .where(and(eq(mcpAccessTokens.userId, userId), eq(mcpAccessTokens.id, tokenId)))
    .returning({ id: mcpAccessTokens.id });
  if (deleted.length > 0) logger.info({ userId, tokenId }, 'mcp: access token revoked');
  return deleted.length > 0;
}

export interface McpAuthCleanupReport {
  tokens: number;
}

/** Daily job: drop tokens that expired more than 30 days ago. */
export async function cleanupMcpAuth(now = new Date()): Promise<McpAuthCleanupReport> {
  const cutoff = new Date(now.getTime() - EXPIRED_RETENTION_MS);
  const deleted = await db
    .delete(mcpAccessTokens)
    .where(and(isNotNull(mcpAccessTokens.expiresAt), lt(mcpAccessTokens.expiresAt, cutoff)))
    .returning({ id: mcpAccessTokens.id });
  if (deleted.length > 0) logger.info({ tokens: deleted.length }, 'mcp: expired access tokens removed');
  return { tokens: deleted.length };
}
