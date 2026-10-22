/**
 * Public OAuth 2.0 endpoints for MCP clients. Mounted BEFORE the guard.
 *
 *   GET  /.well-known/oauth-authorization-server     → RFC 8414 metadata
 *   GET  /.well-known/oauth-protected-resource[/mcp] → RFC 9728 metadata
 *   POST /oauth/device_authorization                 → RFC 8628 §3.1/3.2
 *   POST /oauth/token                                → device_code + refresh_token grants
 *   POST /oauth/revoke                               → RFC 7009
 *
 * Clients are public (no secret); `client_id` is a self-declared label that
 * the user sees on the approval page. Errors use the RFC 6749 §5.2 shape
 * `{ error, error_description }` rather than the app's `{ error, code }`.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { createDeviceAuthorization, exchangeDeviceCode, refreshTokens, revokeToken } from '@/db/mcp-auth';
import { resolveOrigin } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  DEVICE_CODE_GRANT_TYPE,
  MCP_SCOPES_SUPPORTED,
  formatUserCode,
  isSecureTransport,
  mcpEnabled,
  mcpResourceUrl,
  parseScope,
} from '@/lib/mcp-oauth';
import { createRateLimiter, type RateLimitResult } from '@/lib/rate-limit';

export const oauthRoutes = new Hono();

const checkDeviceRateLimit = createRateLimiter({ perClient: 10, global: 60 });
// Clients poll every 5s per pending request, so the token endpoint needs headroom.
const checkTokenRateLimit = createRateLimiter({ perClient: 60, global: 600 });
const checkRevokeRateLimit = createRateLimiter({ perClient: 30, global: 300 });

// Printable ASCII only: the value is rendered verbatim on the approval page.
const ClientId = z.string().trim().min(1).max(100).regex(/^[\x20-\x7e]+$/, 'client_id must be printable ASCII');

const DeviceAuthorizationSchema = z.object({
  client_id: ClientId,
  scope: z.string().max(200).optional(),
});

const TokenSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal(DEVICE_CODE_GRANT_TYPE),
    device_code: z.string().min(1).max(200),
    client_id: ClientId,
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(200),
    client_id: ClientId,
    scope: z.string().max(200).optional(),
  }),
]);

const RevokeSchema = z.object({
  token: z.string().min(1).max(200),
  token_type_hint: z.string().max(50).optional(),
});

function oauthError(c: Context, error: string, description: string, status: 400 | 401 | 429 = 400): Response {
  c.header('Cache-Control', 'no-store');
  return c.json({ error, error_description: description }, status);
}

/** RFC 6749 requires form encoding; JSON is accepted too for lenient clients. */
async function readParams(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const body: unknown = await c.req.json().catch(() => null);
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  }
  const form = await c.req.parseBody().catch(() => ({}));
  return Object.fromEntries(Object.entries(form).filter(([, v]) => typeof v === 'string'));
}

function rateLimited(c: Context, result: RateLimitResult): Response {
  c.header('Retry-After', String(result.retryAfter));
  return oauthError(c, 'slow_down', 'too many requests', 429);
}

// Every endpoint here is invisible when MCP is off, and refuses cleartext
// transport for anything that carries a credential.
// (Scoped to these prefixes: this router is mounted at the app root.)
const gate: MiddlewareHandler = async (c, next) => {
  if (!mcpEnabled()) return c.json({ error: 'not found', code: 'not_found' }, 404);
  if (c.req.method === 'POST' && !isSecureTransport(c.req.raw)) {
    return oauthError(c, 'invalid_request', 'HTTPS is required');
  }
  return next();
};
oauthRoutes.use('/oauth/*', gate);
oauthRoutes.use('/.well-known/oauth-authorization-server', gate);
oauthRoutes.use('/.well-known/oauth-protected-resource', gate);
oauthRoutes.use('/.well-known/oauth-protected-resource/*', gate);

oauthRoutes.get('/.well-known/oauth-authorization-server', (c) => {
  const origin = resolveOrigin(c.req.raw);
  return c.json({
    issuer: origin,
    device_authorization_endpoint: `${origin}/oauth/device_authorization`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    grant_types_supported: [DEVICE_CODE_GRANT_TYPE, 'refresh_token'],
    response_types_supported: [],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: MCP_SCOPES_SUPPORTED,
  });
});

const protectedResourceMetadata = (c: Context) =>
  c.json({
    resource: mcpResourceUrl(c.req.raw),
    authorization_servers: [resolveOrigin(c.req.raw)],
    scopes_supported: MCP_SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'Cura Money',
  });
oauthRoutes.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
oauthRoutes.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

oauthRoutes.post('/oauth/device_authorization', async (c) => {
  const limit = checkDeviceRateLimit(c.req.raw);
  if (!limit.allowed) return rateLimited(c, limit);

  const parsed = DeviceAuthorizationSchema.safeParse(await readParams(c));
  if (!parsed.success) {
    return oauthError(c, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid request');
  }
  const scope = parseScope(parsed.data.scope);
  if (!scope) return oauthError(c, 'invalid_scope', `supported scopes: ${MCP_SCOPES_SUPPORTED.join(' ')}`);

  const created = await createDeviceAuthorization(parsed.data.client_id, scope);
  const userCode = formatUserCode(created.userCode);
  const verificationUri = `${resolveOrigin(c.req.raw)}/device`;
  logger.info({ clientId: parsed.data.client_id }, 'mcp: device authorization requested');
  c.header('Cache-Control', 'no-store');
  return c.json({
    device_code: created.deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: created.expiresIn,
    interval: created.interval,
  });
});

oauthRoutes.post('/oauth/token', async (c) => {
  const limit = checkTokenRateLimit(c.req.raw);
  if (!limit.allowed) return rateLimited(c, limit);

  const params = await readParams(c);
  const grantType = params.grant_type;
  if (grantType !== DEVICE_CODE_GRANT_TYPE && grantType !== 'refresh_token') {
    return oauthError(c, 'unsupported_grant_type', `supported grant types: ${DEVICE_CODE_GRANT_TYPE}, refresh_token`);
  }
  const parsed = TokenSchema.safeParse(params);
  if (!parsed.success) {
    return oauthError(c, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid request');
  }

  let result;
  if (parsed.data.grant_type === 'refresh_token') {
    if (parsed.data.scope !== undefined && !parseScope(parsed.data.scope)) {
      return oauthError(c, 'invalid_scope', `supported scopes: ${MCP_SCOPES_SUPPORTED.join(' ')}`);
    }
    result = await refreshTokens(parsed.data.refresh_token, parsed.data.client_id);
  } else {
    result = await exchangeDeviceCode(parsed.data.device_code, parsed.data.client_id);
  }
  if (!result.ok) return oauthError(c, result.error, result.description);

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(result.tokens);
});

oauthRoutes.post('/oauth/revoke', async (c) => {
  const limit = checkRevokeRateLimit(c.req.raw);
  if (!limit.allowed) return rateLimited(c, limit);

  const parsed = RevokeSchema.safeParse(await readParams(c));
  if (!parsed.success) return oauthError(c, 'invalid_request', 'token is required');
  await revokeToken(parsed.data.token);
  // RFC 7009 §2.2: respond 200 whether or not the token was known.
  return c.body(null, 200);
});
