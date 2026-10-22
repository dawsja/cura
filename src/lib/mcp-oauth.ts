/**
 * Shared primitives for the MCP server's OAuth 2.0 Device Authorization
 * Grant (RFC 8628): secret generation/hashing, user-code formatting,
 * token lifetimes, and transport/origin checks.
 *
 * Persistence lives in `src/db/mcp-auth.ts`; HTTP wiring in
 * `src/routes/oauth.ts` (public OAuth endpoints), `src/routes/mcp.ts`
 * (the MCP endpoint), and `src/routes/mcp-grants.ts` (SPA approval and
 * connected-app management).
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { env, resolveOrigin } from './env';

export const MCP_SCOPE = 'finance:read';
export const MCP_SCOPES_SUPPORTED = [MCP_SCOPE] as const;
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
export const SLOW_DOWN_INCREMENT_SECONDS = 5;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
// Each refresh rotates the pair, so this is an idle timeout: a client that
// refreshes at least once every 90 days stays connected until revoked.
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

const ACCESS_TOKEN_PREFIX = 'cma_';
const REFRESH_TOKEN_PREFIX = 'cmr_';
// RFC 8628 §6.1: consonants only, no ambiguous characters, no vowels (so
// codes can't spell words). 20^8 ≈ 2.56e10 combinations.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;

/** True when the MCP server and its OAuth endpoints should be served. */
export function mcpEnabled(): boolean {
  return env.MCP_ENABLED && !env.DEMO_MODE;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function randomSecret(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export const generateDeviceCode = (): string => randomSecret();
export const generateAccessToken = (): string => randomSecret(ACCESS_TOKEN_PREFIX);
export const generateRefreshToken = (): string => randomSecret(REFRESH_TOKEN_PREFIX);

/** Normalized (stored) form: uppercase alphabet characters only. */
export function generateUserCode(): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

/** Display form `XXXX-XXXX`. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accept user input with any casing, spaces, or dashes. Returns null if malformed. */
export function normalizeUserCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const ch of code) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** Parse a space-delimited OAuth scope string; null if it requests anything unsupported. */
export function parseScope(raw: string | undefined): string | null {
  if (!raw || raw.trim() === '') return MCP_SCOPE;
  const requested = new Set(raw.trim().split(/\s+/));
  for (const scope of requested) {
    if (!(MCP_SCOPES_SUPPORTED as readonly string[]).includes(scope)) return null;
  }
  return [...requested].join(' ');
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

export function mcpResourceUrl(request: Request): string {
  return `${resolveOrigin(request)}/mcp`;
}

export function protectedResourceMetadataUrl(request: Request): string {
  return `${resolveOrigin(request)}/.well-known/oauth-protected-resource/mcp`;
}
