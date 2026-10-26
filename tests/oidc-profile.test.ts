import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createAuth } from '@/auth/config';
import { mapOidcProfileToUser } from '@/auth/oidc-profile';
import { CLIENT_IP_HEADER } from '@/lib/client-ip';
import { db } from '@/db/client';
import { user } from '@/db/schema/auth';
import { createTestUser } from './helpers';

const PROVIDER_ID = 'authentik';
const IDP = 'https://idp.example.test';

function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

// The IdP's discovery document and token endpoint are mocked; the ID token
// carries whatever profile the current test sets.
let idTokenClaims: Record<string, unknown> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === `${IDP}/.well-known/openid-configuration`) {
    return Response.json({
      issuer: IDP,
      authorization_endpoint: `${IDP}/authorize`,
      token_endpoint: `${IDP}/token`,
      userinfo_endpoint: `${IDP}/userinfo`,
    });
  }
  if (url === `${IDP}/token`) {
    return Response.json({
      access_token: 'access-token',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: unsignedJwt({ iss: IDP, aud: 'cura', ...idTokenClaims }),
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

const auth = createAuth([{
  providerId: PROVIDER_ID,
  discoveryUrl: `${IDP}/.well-known/openid-configuration`,
  clientId: 'cura',
  clientSecret: 'secret',
}]);

// Better Auth rate-limits sign-in per client IP; give each sign-in its own.
// This calls the handler directly, so it sets the header src/index.ts would.
let clientIp = 0;

async function signInWithOidc(claims: Record<string, unknown>): Promise<void> {
  idTokenClaims = claims;
  const ip = `203.0.113.${++clientIp}`;
  const start = await auth.handler(new Request('http://localhost/api/auth/sign-in/oauth2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', [CLIENT_IP_HEADER]: ip },
    body: JSON.stringify({ providerId: PROVIDER_ID, callbackURL: '/' }),
  }));
  expect(start.status).toBe(200);
  const { url } = await start.json() as { url: string };
  const state = new URL(url).searchParams.get('state');
  const cookie = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const callback = await auth.handler(new Request(
    `http://localhost/api/auth/oauth2/callback/${PROVIDER_ID}?code=code&state=${state}`,
    { headers: { cookie, host: 'localhost', [CLIENT_IP_HEADER]: ip } },
  ));
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).not.toContain('error');
}

async function loadUser(id: string) {
  const [row] = await db.select().from(user).where(eq(user.id, id));
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

describe('OIDC profile refresh', () => {
  test('refreshes the name on every sign-in without touching email or id', async () => {
    const userId = await createTestUser();
    const { email } = await loadUser(userId);
    const sub = `sub-${randomUUID()}`;

    await signInWithOidc({ sub, email, email_verified: true, name: 'A' });
    expect(await loadUser(userId)).toMatchObject({ id: userId, email, name: 'A' });

    await signInWithOidc({ sub, email, email_verified: true, name: 'B' });
    expect(await loadUser(userId)).toMatchObject({ id: userId, email, name: 'B' });
  });

  test('never overwrites the local email when the IdP email changes', async () => {
    const userId = await createTestUser();
    const { email } = await loadUser(userId);
    const sub = `sub-${randomUUID()}`;

    await signInWithOidc({ sub, email, email_verified: true, name: 'A' });
    await signInWithOidc({ sub, email: `changed-${randomUUID()}@example.test`, email_verified: true, name: 'B' });
    expect(await loadUser(userId)).toMatchObject({ id: userId, email, emailVerified: true, name: 'B' });
  });
});

describe('mapOidcProfileToUser', () => {
  test('uses the name claim', async () => {
    const mapped = await mapOidcProfileToUser(PROVIDER_ID, { sub: 'x', name: 'Dawson', preferred_username: 'dawson' });
    expect(mapped.name).toBe('Dawson');
  });

  test('falls back to preferred_username only when name is empty', async () => {
    expect((await mapOidcProfileToUser(PROVIDER_ID, { sub: 'x', name: '  ', preferred_username: 'dawson' })).name).toBe('dawson');
    expect((await mapOidcProfileToUser(PROVIDER_ID, { sub: 'x', preferred_username: 'dawson' })).name).toBe('dawson');
  });

  test('leaves the email to the IdP for unlinked subjects', async () => {
    const mapped = await mapOidcProfileToUser(PROVIDER_ID, { sub: `unlinked-${randomUUID()}`, email: 'a@example.test', name: 'A' });
    expect(mapped.email).toBeUndefined();
  });
});
