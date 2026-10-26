import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_REDIRECTS = 3;
const DNS_TIMEOUT_MS = 5_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class SecureFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SecureFetchError';
  }
}

export interface SecureFetchOptions {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  timeoutMs: number;
  totalDeadlineMs: number;
  maxBodyBytes: number;
  retry?: boolean;
  allowRedirects?: boolean;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isPublicIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return false;
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function expandIpv6(address: string): number[] | null {
  const withoutZone = address.split('%', 1)[0] ?? '';
  let normalized = withoutZone.toLowerCase();
  const ipv4Start = normalized.lastIndexOf(':');
  const ipv4 = parseIpv4(normalized.slice(ipv4Start + 1));
  if (ipv4) {
    normalized = `${normalized.slice(0, ipv4Start)}:${((ipv4[0] ?? 0) << 8 | (ipv4[1] ?? 0)).toString(16)}:${((ipv4[2] ?? 0) << 8 | (ipv4[3] ?? 0)).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const words = expandIpv6(address);
  if (!words) return false;

  // IPv4-mapped IPv6 must be checked against the IPv4 denylist.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPublicIpv4(`${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 255}.${(words[7] ?? 0) >> 8}.${(words[7] ?? 0) & 255}`);
  }
  // Only globally routable unicast is accepted, excluding IANA special-use,
  // transition, benchmarking, and documentation ranges inside 2000::/3.
  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002) return false;
  if (first === 0x3fff && (second & 0xf000) === 0) return false;
  if (first !== 0x2001) return true;
  if (second <= 0x0003 || (second >= 0x0010 && second <= 0x002f)) return false;
  return second !== 0x0db8;
}

interface PublicTarget {
  url: URL;
  hostname: string;
  /** A validated address to connect to, or undefined when the URL host is already an IP literal. */
  address?: string;
}

async function resolvePublicTarget(value: string): Promise<PublicTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SecureFetchError('SimpleFIN supplied an invalid URL.', 'invalid_url');
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    throw new SecureFetchError('SimpleFIN URLs must use HTTPS.', 'invalid_url');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new SecureFetchError('The SimpleFIN URL is not a permitted public destination.', 'unsafe_destination');
    }
    return { url, hostname };
  }
  let addresses: string[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), DNS_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    addresses = resolved.map(({ address }) => address);
  } catch {
    throw new SecureFetchError('The SimpleFIN server could not be resolved.', 'dns_failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) {
    throw new SecureFetchError('The SimpleFIN URL is not a permitted public destination.', 'unsafe_destination');
  }
  return { url, hostname, address: addresses[0]! };
}

export async function validatePublicHttpsUrl(value: string): Promise<URL> {
  return (await resolvePublicTarget(value)).url;
}

/**
 * Connect to the address that was validated instead of letting fetch resolve
 * the hostname again, which would let a DNS-rebinding server answer the guard
 * with a public address and the request with a private one. The original Host
 * header and TLS SNI are kept, and Bun still verifies the certificate against
 * `serverName`.
 */
function pinnedRequest(
  target: PublicTarget,
  headers: Record<string, string>,
): { url: URL; headers: Record<string, string>; tls?: { serverName: string } } {
  if (!target.address) return { url: target.url, headers };
  const url = new URL(target.url);
  url.hostname = isIP(target.address) === 6 ? `[${target.address}]` : target.address;
  return { url, headers: { ...headers, Host: target.url.host }, tls: { serverName: target.hostname } };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new SecureFetchError('The SimpleFIN response was too large.', 'response_too_large');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SecureFetchError('The SimpleFIN response was too large.', 'response_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : dateDelay;
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return Math.min(500 * 2 ** attempt + Math.random() * 250, 5_000);
}

export async function secureFetch(
  input: string,
  options: SecureFetchOptions,
): Promise<{ response: Response; body: Uint8Array }> {
  const startedAt = Date.now();
  const maxAttempts = options.retry ? 3 : 1;
  let current = await resolvePublicTarget(input);
  const initialOrigin = current.url.origin;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let redirects = 0;
    let response: Response | undefined;
    let networkFailure = false;
    while (true) {
      const remainingMs = options.totalDeadlineMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new SecureFetchError('The SimpleFIN request timed out.', 'timeout');
      try {
        // The destination is user-supplied, so never let the runtime decode a
        // compressed body (CVE-2026-111497 was a Brotli decoder RCE). This also
        // makes maxBodyBytes bound the bytes actually received.
        const pinned = pinnedRequest(current, { ...options.headers, 'Accept-Encoding': 'identity' });
        response = await fetch(pinned.url, {
          method: options.method,
          headers: pinned.headers,
          ...(pinned.tls ? { tls: pinned.tls } : {}),
          redirect: 'manual',
          decompress: false,
          signal: AbortSignal.timeout(Math.min(options.timeoutMs, remainingMs)),
        });
      } catch {
        networkFailure = true;
        break;
      }
      const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
      if (encoding && encoding !== 'identity') {
        await response.body?.cancel().catch(() => undefined);
        throw new SecureFetchError('The SimpleFIN server sent an unsupported compressed response.', 'unsupported_encoding');
      }

      if (response.status < 300 || response.status >= 400) break;
      if (!options.allowRedirects || redirects >= MAX_REDIRECTS) {
        throw new SecureFetchError('The SimpleFIN server returned an unsupported redirect.', 'redirect_rejected');
      }
      const location = response.headers.get('location');
      if (!location) throw new SecureFetchError('The SimpleFIN server returned an invalid redirect.', 'redirect_rejected');
      const redirected = await resolvePublicTarget(new URL(location, current.url).toString());
      if (redirected.url.origin !== initialOrigin) {
        throw new SecureFetchError('The SimpleFIN server redirected to a different origin.', 'redirect_rejected');
      }
      current = redirected;
      redirects++;
    }

    const retryable = networkFailure || (response !== undefined && RETRYABLE_STATUSES.has(response.status));
    if (retryable && attempt + 1 < maxAttempts) {
      const delay = retryDelayMs(response, attempt);
      if (Date.now() - startedAt + delay >= options.totalDeadlineMs) {
        if (response) return { response, body: await readBoundedBody(response, options.maxBodyBytes) };
        break;
      }
      await response?.body?.cancel().catch(() => undefined);
      await Bun.sleep(delay);
      continue;
    }
    if (networkFailure || !response) throw new SecureFetchError('The SimpleFIN server could not be reached.', 'network_error');
    return { response, body: await readBoundedBody(response, options.maxBodyBytes) };
  }
  throw new SecureFetchError('The SimpleFIN request deadline was exceeded.', 'timeout');
}
