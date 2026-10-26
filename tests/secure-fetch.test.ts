import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as realDns from 'node:dns/promises';

let lookupResults: Record<string, Array<{ address: string; family: number }>> = {};
const lookupMock = mock(async (hostname: string) => {
  const result = lookupResults[hostname];
  if (!result) throw new Error(`unexpected lookup: ${hostname}`);
  return result;
});
await mock.module('node:dns/promises', () => ({ ...realDns, lookup: lookupMock }));

const { secureFetch, SecureFetchError } = await import('@/lib/secure-fetch');

const options = { method: 'GET', timeoutMs: 1_000, totalDeadlineMs: 2_000, maxBodyBytes: 1_024 } as const;

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  lookupResults = {};
  lookupMock.mockClear();
});

describe('secureFetch', () => {
  test('asks for an uncompressed body and disables runtime decompression', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ ok: true })) as unknown as typeof fetch);

    const { body } = await secureFetch('https://1.1.1.1/accounts', { ...options, headers: { Authorization: 'Basic x' } });

    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({ ok: true });
    const [, init] = fetchSpy.mock.calls[0]! as [URL, RequestInit & { decompress?: boolean }];
    expect(init.decompress).toBe(false);
    expect(init.headers).toEqual({ Authorization: 'Basic x', 'Accept-Encoding': 'identity' });
  });

  test('rejects compressed responses instead of decoding them', async () => {
    for (const encoding of ['br', 'gzip', ' BR ']) {
      fetchSpy?.mockRestore();
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(new Uint8Array([0xff, 0x00]), {
        headers: { 'Content-Encoding': encoding },
      })) as unknown as typeof fetch);

      const error = await secureFetch('https://1.1.1.1/accounts', options).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(SecureFetchError);
      expect((error as InstanceType<typeof SecureFetchError>).code).toBe('unsupported_encoding');
    }
  });

  test('connects to the validated address so a DNS rebind cannot redirect the request', async () => {
    lookupResults['bridge.example.com'] = [{ address: '1.1.1.1', family: 4 }];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ ok: true })) as unknown as typeof fetch);

    await secureFetch('https://bridge.example.com:8443/simplefin/accounts', options);

    expect(lookupMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0]! as [URL, RequestInit & { tls?: { serverName?: string } }];
    expect(input.toString()).toBe('https://1.1.1.1:8443/simplefin/accounts');
    expect((init.headers as Record<string, string>).Host).toBe('bridge.example.com:8443');
    expect(init.tls?.serverName).toBe('bridge.example.com');
  });

  test('rejects a hostname that resolves to any private address', async () => {
    lookupResults['rebind.example.com'] = [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }];
    fetchSpy = spyOn(globalThis, 'fetch');

    const error = await secureFetch('https://rebind.example.com/claim', options).catch((err: unknown) => err);
    expect((error as InstanceType<typeof SecureFetchError>).code).toBe('unsafe_destination');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
