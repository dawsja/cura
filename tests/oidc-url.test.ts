import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as realDns from 'node:dns/promises';

type LookupResult = Array<{ address: string; family: number }>;
let lookupResults: Record<string, LookupResult> = {};
const lookupMock = mock(async (hostname: string) => {
  const result = lookupResults[hostname];
  if (!result) throw new Error(`unexpected lookup: ${hostname}`);
  return result;
});
await mock.module('node:dns/promises', () => ({ ...realDns, lookup: lookupMock }));

const { assertPublicOidcUrl, fetchSecureOidcDiscovery, isBlockedAddress } = await import('@/lib/oidc-url');

const v4 = (address: string) => ({ address, family: 4 });
const v6 = (address: string) => ({ address, family: 6 });

afterEach(() => {
  lookupResults = {};
  lookupMock.mockClear();
});

describe('isBlockedAddress', () => {
  test('allows public IPv4', () => {
    for (const address of ['8.8.8.8', '38.28.114.28', '1.1.1.1']) {
      expect(isBlockedAddress(address)).toBe(false);
    }
  });

  test('blocks private and special-use IPv4', () => {
    for (const address of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.6.128',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '255.255.255.255',
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  test('judges IPv4-mapped IPv6 by the embedded IPv4 address', () => {
    for (const address of ['::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:192.168.1.1', '::ffff:a00:1']) {
      expect(isBlockedAddress(address)).toBe(true);
    }
    expect(isBlockedAddress('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('::ffff:808:808')).toBe(false);
  });

  test('allows only public global-unicast IPv6', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    for (const address of ['::1', 'fe80::1', 'fc00::1', '::', '2001:db8::1', '64:ff9b::a00:1', '2::1']) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  test('blocks anything that is not an IP address', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertPublicOidcUrl', () => {
  test('accepts a hostname whose addresses are all public', async () => {
    lookupResults['auth.example.com'] = [v4('38.28.114.28'), v6('2606:4700:4700::1111')];
    const url = await assertPublicOidcUrl('https://auth.example.com/.well-known/openid-configuration', 'discovery_url');
    expect(url.hostname).toBe('auth.example.com');
    expect(lookupMock).toHaveBeenCalledWith('auth.example.com', { all: true, verbatim: true });
  });

  test('rejects a hostname when any resolved address is private', async () => {
    lookupResults['mixed.example.com'] = [v4('8.8.8.8'), v4('10.0.0.5')];
    await expect(assertPublicOidcUrl('https://mixed.example.com/', 'discovery_url'))
      .rejects.toThrow('discovery_url_private_address');

    lookupResults['mapped.example.com'] = [v4('1.1.1.1'), v6('::ffff:127.0.0.1')];
    await expect(assertPublicOidcUrl('https://mapped.example.com/', 'discovery_url'))
      .rejects.toThrow('discovery_url_private_address');
  });

  test('rejects private IP literals, including mapped IPv6 literals', async () => {
    await expect(assertPublicOidcUrl('https://10.0.0.1/', 'jwks_uri')).rejects.toThrow('jwks_uri_private_address');
    await expect(assertPublicOidcUrl('https://[::ffff:10.0.0.1]/', 'jwks_uri')).rejects.toThrow('jwks_uri_private_address');
    await expect(assertPublicOidcUrl('https://[::1]/', 'jwks_uri')).rejects.toThrow('jwks_uri_private_address');
    expect((await assertPublicOidcUrl('https://8.8.8.8/', 'jwks_uri')).hostname).toBe('8.8.8.8');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test('rejects localhost names, plain http, and embedded credentials', async () => {
    await expect(assertPublicOidcUrl('https://localhost/', 'discovery_url')).rejects.toThrow('discovery_url_private_address');
    await expect(assertPublicOidcUrl('https://idp.localhost/', 'discovery_url')).rejects.toThrow('discovery_url_private_address');
    await expect(assertPublicOidcUrl('http://auth.example.com/', 'discovery_url')).rejects.toThrow('discovery_url_https_required');
    await expect(assertPublicOidcUrl('https://user:pass@auth.example.com/', 'discovery_url'))
      .rejects.toThrow('discovery_url_credentials_forbidden');
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('fetchSecureOidcDiscovery', () => {
  test('connects to the validated address while keeping the original Host and SNI', async () => {
    lookupResults['auth.example.com'] = [v4('38.28.114.28')];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://8.8.8.8/authorize',
      token_endpoint: 'https://8.8.8.8/token',
    })) as unknown as typeof fetch);
    try {
      await fetchSecureOidcDiscovery('https://auth.example.com/application/o/cura/.well-known/openid-configuration');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [input, init] = fetchSpy.mock.calls[0]! as [URL, RequestInit & { tls?: { serverName?: string } }];
      expect(String(input)).toBe('https://38.28.114.28/application/o/cura/.well-known/openid-configuration');
      expect(new Headers(init.headers).get('host')).toBe('auth.example.com');
      expect(init.tls?.serverName).toBe('auth.example.com');
      expect(init.redirect).toBe('manual');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('rejects advertised endpoints that resolve to private addresses', async () => {
    lookupResults['auth.example.com'] = [v4('38.28.114.28')];
    lookupResults['internal.example.com'] = [v4('192.168.1.10')];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://internal.example.com/token',
    })) as unknown as typeof fetch);
    try {
      await expect(fetchSecureOidcDiscovery('https://auth.example.com/.well-known/openid-configuration'))
        .rejects.toThrow('token_endpoint_private_address');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
