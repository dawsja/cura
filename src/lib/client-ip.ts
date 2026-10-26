/**
 * Client IP resolution for rate limiting.
 *
 * Forwarding headers are only as trustworthy as the hop that wrote them, so
 * the TCP peer is the starting point. `X-Forwarded-For` is read only when the
 * peer is a trusted proxy (`TRUSTED_PROXIES`), walking the chain from the
 * right and stopping at the first address that isn't one: anything to its
 * left was written by the client and can be forged.
 *
 * Better Auth would otherwise trust `X-Forwarded-For` from anyone, letting a
 * client rotate it to escape the sign-in limit, and put every request without
 * a usable header into one shared bucket that a few bad logins lock for
 * everybody. The resolved address is handed to it in `CLIENT_IP_HEADER`.
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { BlockList, isIP } from 'node:net';
import { env } from './env';

/** Request header that carries the resolved client IP into Better Auth. */
export const CLIENT_IP_HEADER = 'x-cura-client-ip';

// Loopback and private networks: where a same-host or Compose-network reverse
// proxy connects from. Public peers are never trusted unless listed.
const DEFAULT_TRUSTED_PROXIES = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7'];

function unmapIpv4(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1]! : address;
}

// One list per family: Bun's BlockList matches IPv4 addresses against IPv6
// entries (see oidc-url.ts).
const trustedIpv4 = new BlockList();
const trustedIpv6 = new BlockList();
const configured = env.TRUSTED_PROXIES.trim();
const entries = configured === 'none'
  ? []
  : configured
    ? configured.split(',').map((entry) => entry.trim()).filter(Boolean)
    : DEFAULT_TRUSTED_PROXIES;
for (const entry of entries) {
  const [network = '', prefix] = entry.split('/');
  const address = unmapIpv4(network);
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
  const list = family === 'ipv6' ? trustedIpv6 : trustedIpv4;
  if (prefix === undefined) list.addAddress(address, family);
  else list.addSubnet(address, Number(prefix), family);
}

function isTrustedProxy(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return trustedIpv4.check(address, 'ipv4');
  if (family === 6) return trustedIpv6.check(address, 'ipv6');
  return false;
}

function peerAddress(c: Context): string | null {
  try {
    const address = getConnInfo(c).remote.address;
    return address ? unmapIpv4(address) : null;
  } catch {
    // No Node socket, e.g. tests calling app.fetch directly.
    return null;
  }
}

/** The client's IP address, or null when the connection has no peer address. */
export function clientIp(c: Context): string | null {
  const peer = peerAddress(c);
  if (!peer || !isTrustedProxy(peer)) return peer;
  const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
  let candidate = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = unmapIpv4(hops[i]!);
    // A malformed entry ends the verifiable part of the chain.
    if (!isIP(hop)) break;
    if (!isTrustedProxy(hop)) return hop;
    candidate = hop;
  }
  return candidate;
}

/**
 * Copy of the request with `CLIENT_IP_HEADER` set to the resolved address
 * (or removed), so a client can't supply its own.
 */
export function withClientIp(request: Request, ip: string | null): Request {
  const headers = new Headers(request.headers);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  else headers.delete(CLIENT_IP_HEADER);
  return new Request(request, { headers });
}
