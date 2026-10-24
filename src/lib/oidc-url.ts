import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { env, resolveOrigin } from './env';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_DISCOVERY_BYTES = 1024 * 1024;

// Keep one list per family. Bun's BlockList matches IPv4 addresses against IPv6 entries such as
// ::ffff:0:0/96, so a mixed list reported every public IPv4 address as blocked.
const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}
// IPv4-mapped addresses (::ffff:0:0/96) are unwrapped and checked against the IPv4 list instead.
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

function parseSecureUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}_invalid_url`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label}_https_required`);
  if (url.username || url.password) throw new Error(`${label}_credentials_forbidden`);
  return url;
}

/** Expand any textual IPv6 form (`::`, embedded dotted quad) into its eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address.replace(/%.*$/, '');
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail].map((group) => (
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN
  ));
  return groups.some(Number.isNaN) ? null : groups;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIpv4.check(address, 'ipv4');
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return true;
    // ::ffff:a.b.c.d and ::ffff:xxxx:xxxx reach the embedded IPv4 host, so judge that address.
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      const ipv4 = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
      return blockedIpv4.check(ipv4, 'ipv4');
    }
    // Currently allocated global-unicast IPv6 space is 2000::/3.
    if ((groups[0]! & 0xe000) !== 0x2000) return true;
    return blockedIpv6.check(address.replace(/%.*$/, ''), 'ipv6');
  }
  return true;
}

interface PublicOidcTarget {
  url: URL;
  hostname: string;
  /** A validated address to connect to, or undefined when the URL host is already an IP literal. */
  address?: string;
}

async function resolvePublicOidcTarget(value: string, label: string): Promise<PublicOidcTarget> {
  const url = parseSecureUrl(value, label);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`${label}_private_address`);
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isBlockedAddress(hostname)) throw new Error(`${label}_private_address`);
    return { url, hostname };
  }

  let addresses: Array<{ address: string }>;
  let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        dnsTimeout = setTimeout(() => reject(new Error('dns_timeout')), DISCOVERY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new Error(`${label}_dns_unresolved`);
  } finally {
    clearTimeout(dnsTimeout);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error(`${label}_private_address`);
  }
  return { url, hostname, address: addresses[0]!.address };
}

/** Resolve and reject every non-public address, rather than trusting only the hostname text. */
export async function assertPublicOidcUrl(value: string, label: string): Promise<URL> {
  return (await resolvePublicOidcTarget(value, label)).url;
}

/**
 * Fetch from the address that was validated instead of letting fetch resolve the hostname again,
 * which would let a DNS-rebinding server answer the guard with a public address and fetch with a
 * private one. The original Host header and TLS SNI are kept, and Bun still verifies the
 * certificate against `serverName`. Better Auth fetches the stored endpoints itself at sign-in, so
 * those later requests resolve DNS independently of this guard.
 */
function fetchPinned(target: PublicOidcTarget, init: RequestInit): Promise<Response> {
  if (!target.address) return fetch(target.url, init);
  const pinned = new URL(target.url);
  pinned.hostname = isIP(target.address) === 6 ? `[${target.address}]` : target.address;
  const headers = new Headers(init.headers);
  headers.set('host', target.url.host);
  return fetch(pinned, { ...init, headers, tls: { serverName: target.hostname } });
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DISCOVERY_BYTES) {
    throw new Error('discovery_doc_too_large');
  }
  if (!response.body) throw new Error('discovery_doc_invalid_json');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DISCOVERY_BYTES) throw new Error('discovery_doc_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('discovery_doc_invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('discovery_doc_invalid_json');
  }
  return parsed as Record<string, unknown>;
}

/** Fetch a discovery document without redirects and validate every advertised OIDC target. */
export async function fetchSecureOidcDiscovery(value: string): Promise<Record<string, unknown>> {
  const target = await resolvePublicOidcTarget(value.trim(), 'discovery_url');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetchPinned(target, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) throw new Error('discovery_doc_redirect_forbidden');
    if (!response.ok) throw new Error(`discovery_doc_unreachable_${response.status}`);
    const doc = await readBoundedJson(response);

    const endpointNames = [
      'authorization_endpoint',
      'token_endpoint',
      'userinfo_endpoint',
      'jwks_uri',
    ] as const;
    await Promise.all(endpointNames.map(async (name) => {
      const endpoint = doc[name];
      if (endpoint === undefined && (name === 'authorization_endpoint' || name === 'token_endpoint')) {
        throw new Error('discovery_doc_missing_endpoints');
      }
      if (endpoint !== undefined) {
        if (typeof endpoint !== 'string' || endpoint.length === 0) {
          throw new Error(`discovery_doc_invalid_${name}`);
        }
        await assertPublicOidcUrl(endpoint, name);
      }
    }));
    return doc;
  } catch (err) {
    if (controller.signal.aborted) throw new Error('discovery_doc_timeout');
    if (err instanceof Error && err.message.startsWith('discovery_')) throw err;
    if (err instanceof Error && /^(authorization_endpoint|token_endpoint|userinfo_endpoint|jwks_uri)_/.test(err.message)) {
      throw err;
    }
    throw new Error(`discovery_doc_unreachable_${err instanceof Error ? err.message : 'network_error'}`);
  } finally {
    clearTimeout(timeout);
  }
}

function assertSecureCallbackUrl(value: string, label: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return;
    if (env.NODE_ENV !== 'production' && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return;
  } catch {
    throw new Error(`${label}_invalid_url`);
  }
  throw new Error(`${label}_https_required`);
}

export function assertSecureOidcConfiguration(request: Request): void {
  const configured = [env.APP_URL, env.BETTER_AUTH_URL, env.OIDC_REDIRECT_BASE].filter(Boolean);
  for (const value of configured) assertSecureCallbackUrl(value, 'oidc_base_url');
  assertSecureCallbackUrl(resolveOrigin(request, 'app'), 'oidc_callback_url');
}
