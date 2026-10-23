import { randomUUID } from 'node:crypto';
import { getAuth } from '@/auth';
import { app } from '@/index';

export async function createSignedInUser(): Promise<{ userId: string; cookie: string }> {
  const suffix = randomUUID();
  const email = `http-${suffix}@example.test`;
  const password = 'test-password-123';
  const result = await getAuth().api.signUpEmail({
    body: { email, password, name: 'HTTP Test User' },
    headers: new Headers(),
  });
  const response = await app.fetch(new Request('http://localhost/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }));
  if (!response.ok) throw new Error(`test sign-in failed with ${response.status}`);
  const cookie = /better-auth\.session_token=[^;]+/.exec(response.headers.get('set-cookie') ?? '')?.[0];
  if (!cookie) throw new Error('test sign-in did not return a session cookie');
  return { userId: result.user.id, cookie };
}

export function authenticatedRequest(path: string, cookie: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { cookie, ...(init.headers ?? {}) },
  });
}
