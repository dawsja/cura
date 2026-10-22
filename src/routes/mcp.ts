/**
 * /mcp — remote MCP server (Streamable HTTP transport). Mounted BEFORE the
 * guard: it authenticates with a personal access token sent as
 * `Authorization: Bearer <token>` (created in Settings), never with browser
 * session cookies.
 *
 * Tools that change data are only listed for tokens with the write scope;
 * read-only tokens never see them.
 *
 * The transport runs stateless (no Mcp-Session-Id) with JSON responses: each
 * POST builds a fresh server bound to the token's user and handles exactly
 * one JSON-RPC message or batch. There is no server-initiated traffic, so
 * the optional GET SSE stream and DELETE session teardown return 405.
 */
import { Hono, type Context } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticateMcpAccessToken } from '@/db/mcp-access';
import { createFinanceMcpServer } from '@/mcp/server';
import { logger } from '@/lib/logger';
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE, hasScope, isAllowedOrigin, isSecureTransport, mcpEnabled } from '@/lib/mcp-access';

export const mcpRoutes = new Hono();

function jsonRpcError(c: Context, status: 400 | 401 | 403 | 404 | 405, message: string): Response {
  return c.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, status);
}

/**
 * RFC 6750 §3 challenge. There is no OAuth authorization server to point
 * at: the token is created by the user in Settings and configured in the
 * client as a header.
 */
function challenge(c: Context, error?: 'invalid_token' | 'insufficient_scope', description?: string): Response {
  const parts = ['realm="cura"', `scope="${MCP_READ_SCOPE}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description}"`);
  c.header('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
  const status = error === 'insufficient_scope' ? 403 : 401;
  return jsonRpcError(c, status, description ?? 'authorization required');
}

mcpRoutes.all('/', async (c) => {
  if (!mcpEnabled()) return c.json({ error: 'not found', code: 'not_found' }, 404);
  if (!isAllowedOrigin(c.req.raw)) return jsonRpcError(c, 403, 'origin not allowed');
  if (!isSecureTransport(c.req.raw)) return jsonRpcError(c, 400, 'HTTPS is required');

  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return challenge(c, undefined, 'send a Cura access token as a Bearer token; create one in Settings');
  const principal = await authenticateMcpAccessToken(match[1]!);
  if (!principal) return challenge(c, 'invalid_token', 'the access token is invalid, expired, or revoked');
  if (!hasScope(principal.scope, MCP_READ_SCOPE)) {
    return challenge(c, 'insufficient_scope', `requires ${MCP_READ_SCOPE}`);
  }

  if (c.req.method !== 'POST') {
    c.header('Allow', 'POST');
    return jsonRpcError(c, 405, 'method not allowed; this server is stateless and only accepts POST');
  }

  const server = createFinanceMcpServer({
    userId: principal.userId,
    tokenId: principal.tokenId,
    canWrite: hasScope(principal.scope, MCP_WRITE_SCOPE),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (err) {
    logger.error({ err, userId: principal.userId, tokenId: principal.tokenId }, 'mcp: request failed');
    return c.json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }, 500);
  } finally {
    // JSON-response mode has fully buffered the reply; release the pair.
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  }
});
