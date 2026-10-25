import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { secureFetch, SecureFetchError } from '@/lib/secure-fetch';

const options = { method: 'GET', timeoutMs: 1_000, totalDeadlineMs: 2_000, maxBodyBytes: 1_024 } as const;

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
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
      expect((error as SecureFetchError).code).toBe('unsupported_encoding');
    }
  });
});
