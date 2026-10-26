import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getAuth } from '@/auth';
import { db } from '@/db/client';
import { createMcpAccessToken } from '@/db/mcp-access';
import { user } from '@/db/schema/auth';
import { app } from '@/index';
import { authenticatedRequest } from './http-helpers';

const PASSWORD = 'test-password-123';

/** Call the app as if over a socket from `peer`, as @hono/node-server does. */
function fetchFrom(peer: string, request: Request): Promise<Response> {
  return Promise.resolve(app.fetch(request, { incoming: { socket: { remoteAddress: peer } } }));
}

function signIn(peer: string, email: string, password: string, forwardedFor?: string): Promise<Response> {
  return fetchFrom(peer, new Request('http://localhost/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    body: JSON.stringify({ email, password }),
  }));
}

async function createUser(role: 'admin' | null = null): Promise<{ id: string; email: string }> {
  const email = `hardening-${randomUUID()}@example.test`;
  const result = await getAuth().api.signUpEmail({
    body: { email, password: PASSWORD, name: 'Hardening Test User' },
    headers: new Headers(),
  });
  if (role) await db.update(user).set({ role }).where(eq(user.id, result.user.id));
  return { id: result.user.id, email };
}

async function sessionCookie(peer: string, email: string): Promise<string> {
  const response = await signIn(peer, email, PASSWORD);
  expect(response.status).toBe(200);
  const cookie = /better-auth\.session_token=[^;]+/.exec(response.headers.get('set-cookie') ?? '')?.[0];
  if (!cookie) throw new Error('sign-in did not return a session cookie');
  return cookie;
}

function mcpListTools(token: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })));
}

describe('sign-in rate limiting', () => {
  test('a client cannot escape the limit by rotating X-Forwarded-For', async () => {
    const { email } = await createUser();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await signIn('203.0.113.10', email, 'wrong-password-000', `198.51.100.${i}`)).status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429, 429]);
  });

  test('one client hitting the limit does not lock out another', async () => {
    const { email } = await createUser();
    for (let i = 0; i < 4; i++) await signIn('203.0.113.20', email, 'wrong-password-000');
    expect((await signIn('203.0.113.21', email, PASSWORD)).status).toBe(200);
  });

  test('clients behind a trusted proxy get their own buckets', async () => {
    const { email } = await createUser();
    for (let i = 0; i < 4; i++) {
      await signIn('172.18.0.2', email, 'wrong-password-000', 'spoofed, 198.51.100.30');
    }
    // Same proxy, different client; the forged leftmost entry is ignored.
    expect((await signIn('172.18.0.2', email, PASSWORD, '198.51.100.30, 198.51.100.31')).status).toBe(200);
  });
});

describe('credential revocation', () => {
  test('MCP tokens stop working while their owner is banned', async () => {
    const { id } = await createUser();
    const { token } = await createMcpAccessToken(id, { name: 'Ban test', expiresAt: null, access: 'read' });
    expect((await mcpListTools(token)).status).toBe(200);

    await db.update(user).set({ banned: true, banExpires: null }).where(eq(user.id, id));
    expect((await mcpListTools(token)).status).toBe(401);

    await db.update(user).set({ banExpires: new Date(Date.now() - 1_000) }).where(eq(user.id, id));
    expect((await mcpListTools(token)).status).toBe(200);
  });

  test('an admin password reset ends the user\'s sessions and MCP tokens', async () => {
    const admin = await createUser('admin');
    const target = await createUser();
    const adminCookie = await sessionCookie('203.0.113.40', admin.email);
    const targetCookie = await sessionCookie('203.0.113.41', target.email);
    const { token } = await createMcpAccessToken(target.id, { name: 'Reset test', expiresAt: null, access: 'read' });
    expect((await app.fetch(authenticatedRequest('/api/accounts', targetCookie))).status).toBe(200);

    const reset = await app.fetch(authenticatedRequest(`/api/admin/users/${target.id}/password`, adminCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a-brand-new-password-456' }),
    }));
    expect(reset.status).toBe(200);

    expect((await app.fetch(authenticatedRequest('/api/accounts', targetCookie))).status).toBe(401);
    expect((await mcpListTools(token)).status).toBe(401);
    expect((await app.fetch(authenticatedRequest('/api/accounts', adminCookie))).status).toBe(200);
  });

  test('an admin resetting their own password keeps the current session', async () => {
    const admin = await createUser('admin');
    const current = await sessionCookie('203.0.113.50', admin.email);
    const other = await sessionCookie('203.0.113.51', admin.email);

    const reset = await app.fetch(authenticatedRequest(`/api/admin/users/${admin.id}/password`, current, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a-brand-new-password-456' }),
    }));
    expect(reset.status).toBe(200);

    expect((await app.fetch(authenticatedRequest('/api/accounts', current))).status).toBe(200);
    expect((await app.fetch(authenticatedRequest('/api/accounts', other))).status).toBe(401);
  });
});
