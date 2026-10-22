/**
 * Shared primitives for MCP server access: personal access tokens (format,
 * hashing, display prefix) and the transport/origin checks applied to every
 * /mcp request.
 *
 * Persistence lives in `src/db/mcp-access.ts`; HTTP wiring in
 * `src/routes/mcp.ts` (the MCP endpoint) and `src/routes/mcp-tokens.ts`
 * (token management for the Settings page).
 */
import { createHash, randomBytes } from 'node:crypto';
import { env, resolveOrigin } from './env';

/** Read access to the user's finances. Every token has it. */
export const MCP_READ_SCOPE = 'finance:read';
/**
 * Changes made through the same rules as the web app: transaction
 * categories, reviews, rules, budgets, and categories. Granted only when
 * the user creates a token with read and write access.
 */
export const MCP_WRITE_SCOPE = 'finance:write';

export type McpAccess = 'read' | 'read_write';

export function scopeForAccess(access: McpAccess): string {
  return access === 'read_write' ? `${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}` : MCP_READ_SCOPE;
}

export function hasScope(scope: string, wanted: string): boolean {
  return scope.split(' ').includes(wanted);
}

const TOKEN_PREFIX = 'cura_';
// Enough of the token to tell several apart in Settings without making
// the stored value useful to an attacker (32 random bytes stay secret).
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 4;

/** True when the MCP server and its token management should be served. */
export function mcpEnabled(): boolean {
  return env.MCP_ENABLED && !env.DEMO_MODE;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** A new token: `cura_` followed by 32 random bytes, base64url encoded. */
export function generateMcpAccessToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH);
}

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127
    || a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    // CGNAT range, used by Tailscale and similar overlay networks.
    || (a === 100 && b >= 64 && b <= 127);
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return true;
  if (isPrivateIPv4(host)) return true;
  // Single-label names (Docker Compose service names such as `app`) and
  // conventional LAN suffixes never resolve on the public internet.
  if (!host.includes('.')) return true;
  return ['.local', '.lan', '.internal', '.home.arpa'].some((suffix) => host.endsWith(suffix));
}

/**
 * Bearer tokens must not cross the network in cleartext. Requests are
 * accepted over HTTPS (as reported by the proxy or the configured APP_URL),
 * or over plain HTTP only when the host is loopback / LAN-only.
 */
export function isSecureTransport(request: Request): boolean {
  const origin = new URL(resolveOrigin(request));
  return origin.protocol === 'https:' || isLocalHostname(origin.hostname);
}

/**
 * DNS-rebinding protection required by the MCP spec: browsers always send
 * `Origin`, so reject any that isn't this app. Non-browser clients omit it.
 */
export function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const requestHost = request.headers.get('host') ?? request.headers.get('x-forwarded-host');
  if (requestHost && originHost === requestHost) return true;
  return originHost === new URL(resolveOrigin(request)).host;
}
