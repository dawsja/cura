/**
 * Centralised, validated environment loader. Imported everywhere we need config
 * so we crash loudly on boot if anything required is missing or malformed.
 *
 * Design note: this app is built to be self-hostable behind any reverse proxy
 * (Caddy, nginx, Traefik, Cloudflare Tunnel, plain port-forward, …). The URL
 * env vars below are therefore all OPTIONAL. If unset, the app derives the
 * effective origin from the incoming request's `Host` + `X-Forwarded-Proto`
 * headers. Set them only when you want a stable URL across all requests —
 * typically when running behind a domain-fronting proxy.
 */
import { isIP } from 'node:net';
import { z } from 'zod';

const httpOrigin = z.string().default('').superRefine((value, ctx) => {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a valid URL' });
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must use http or https' });
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an origin without credentials, path, query, or fragment' });
  }
});

const databaseUrl = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().optional().superRefine((value, ctx) => {
    if (value === undefined) return;
    const protocol = new URL(value).protocol;
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must use postgres or postgresql' });
    }
  }),
);

const booleanFlag = (fallback: 'true' | 'false') => z
  .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0'), z.literal('')])
  .default(fallback)
  .transform((v) => v === 'true' || v === '1');

const previousEncryptionKeys = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().optional().superRefine((value, ctx) => {
    if (value === undefined) return;
    const keys = value.split(',').map((key) => key.trim());
    if (keys.some((key) => key.length < 32)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'each DATA_ENCRYPTION_KEY_PREVIOUS key must be at least 32 chars',
      });
    }
  }),
);

const trustedProxies = z.string().trim().default('').superRefine((value, ctx) => {
  if (!value || value === 'none') return;
  for (const entry of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const [address = '', prefix, extra] = entry.split('/');
    const family = isIP(address);
    const maxPrefix = family === 6 ? 128 : 32;
    const validPrefix = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix);
    if (!family || !validPrefix || extra !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${entry}" is not an IP address or CIDR range` });
    }
  }
});

const timeZone = z.string().trim().min(1).max(100).default('UTC').superRefine((value, ctx) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a valid IANA timezone, such as America/Chicago' });
  }
});

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Deployment-wide calendar timezone. Financial timestamps are converted to
  // ledger dates in this zone instead of the container's implicit timezone.
  TZ: timeZone,

  // External-facing URL of the app. Empty → derive per-request from headers.
  // Set this when you want OIDC callbacks and self-references to always use
  // a stable domain (e.g. https://cura.zerd.cc). Leave empty for raw-IP dev
  // or when the public hostname is the same as the request's Host header.
  APP_URL: httpOrigin,

  // Better Auth's self-reference. Same semantics as APP_URL — leave empty to
  // derive from the request. If you do set it, it must match what the user
  // types in the browser (or what the proxy forwards as Host).
  BETTER_AUTH_URL: httpOrigin,

  // Redirect base sent to OIDC providers as the post-login callback. Defaults
  // to the request origin (or BETTER_AUTH_URL if set). Set this explicitly
  // when your reverse proxy rewrites the host.
  OIDC_REDIRECT_BASE: httpOrigin,

  // `auto` preserves existing production behavior when no public URL is set,
  // while explicit false supports the documented direct-HTTP Compose setup.
  AUTH_SECURE_COOKIES: z.enum(['auto', 'true', 'false']).default('auto'),

  // Reverse proxies whose X-Forwarded-For is believed when rate limiting
  // sign-in and setup: comma-separated IPs or CIDR ranges. Empty trusts
  // loopback and private networks (a proxy on the same host or Compose
  // network); `none` trusts no proxy and keys limits on the TCP peer.
  TRUSTED_PROXIES: trustedProxies,

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Public showcase mode. This is intentionally a single switch: when enabled,
  // startup and scheduled jobs replace the entire application database with
  // the built-in demo fixture.
  DEMO_MODE: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0'), z.literal('')])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // Injected by the release image build. Empty in host development, where
  // there is no meaningful running container revision to compare.
  APP_REVISION: z.string().max(128).default(''),

  // The SQLite database file. Keep it on a persistent volume.
  DATABASE_PATH: z.string().trim().min(1).default(
    process.env.NODE_ENV === 'production' ? '/data/cura.db' : './data/cura.db',
  ),

  // Only used to move an existing install off Postgres: when DATABASE_PATH
  // does not exist yet and this is set, startup copies the Postgres data into
  // a new SQLite file. Remove it (and the `db` service) once that is done.
  DATABASE_URL: databaseUrl,

  // Copy Postgres into SQLite again even though a previous copy was recorded.
  // Only for recovering a lost SQLite file; changes made since are lost.
  SQLITE_REIMPORT: booleanFlag('false'),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 chars'),
  DATA_ENCRYPTION_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32, 'DATA_ENCRYPTION_KEY must be at least 32 chars').optional(),
  ),
  DATA_ENCRYPTION_KEY_PREVIOUS: previousEncryptionKeys,

  // Enable the in-process cron scheduler (SimpleFIN poll + budget roll-forward
  // + retention sweep). Run a single app instance per database file.
  RUN_CRON: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0'), z.literal('')])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  // Remote MCP server (/mcp). Disabled automatically in DEMO_MODE.
  MCP_ENABLED: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0'), z.literal('')])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  // Destructive retention is opt-in. Zero keeps financial history forever.
  RETENTION_DAYS: z.coerce.number().int().min(0).max(36_500).default(0),
});

export type Env = z.infer<typeof Env>;

function loadEnv(): Env {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    console.error('[env] invalid environment:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment; see logs above');
  }
  return parsed.data;
}

export const env = loadEnv();

/** Canonical browser-facing origin, when the deployment configured one. */
export function configuredExternalOrigin(): string | undefined {
  return env.OIDC_REDIRECT_BASE || env.BETTER_AUTH_URL || env.APP_URL || undefined;
}

/** Better Auth cookie names and attributes must use one deployment-wide scheme. */
export function useSecureAuthCookies(): boolean {
  if (env.AUTH_SECURE_COOKIES === 'true') return true;
  if (env.AUTH_SECURE_COOKIES === 'false') return false;
  const origin = configuredExternalOrigin();
  return origin ? new URL(origin).protocol === 'https:' : env.NODE_ENV === 'production';
}

/**
 * Resolve the effective external origin for a given request.
 * Priority: env override (APP_URL / BETTER_AUTH_URL) → request headers.
 * The result is the scheme + host (no trailing slash, no path).
 */
export function resolveOrigin(request: Request, fallback: 'app' | 'auth' | 'oidc' = 'app'): string {
  const configured =
    fallback === 'app' ? env.APP_URL : fallback === 'auth' ? env.BETTER_AUTH_URL : env.OIDC_REDIRECT_BASE;
  if (configured && configured.length > 0) {
    const u = new URL(configured);
    return `${u.protocol}//${u.host}`;
  }
  const host = request.headers.get('host') ?? request.headers.get('x-forwarded-host') ?? 'localhost:3000';
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const inferredProto = host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('192.168.')
    ? 'http'
    : 'https';
  const proto = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : inferredProto;
  return `${proto}://${host}`;
}
