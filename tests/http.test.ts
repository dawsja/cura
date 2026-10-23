import { describe, expect, test } from 'bun:test';
import { db } from '@/db/client';
import { settings } from '@/db/schema/settings';
import { transactionSplits } from '@/db/schema/transaction_splits';
import { createMcpAccessToken } from '@/db/mcp-access';
import { app } from '@/index';
import { createTestAccount, createTestTransaction, createTestUser } from './helpers';
import { authenticatedRequest, createSignedInUser } from './http-helpers';

describe('HTTP API contracts', () => {
  test('requires authentication and returns JSON 404s instead of the SPA fallback', async () => {
    const unauthenticated = await app.fetch(new Request('http://localhost/api/accounts'));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('cache-control')).toContain('no-store');

    const { cookie } = await createSignedInUser();
    const response = await app.fetch(authenticatedRequest('/api/not-a-real-route', cookie));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ error: 'not found', code: 'not_found' });
  });

  test('exports one tenant with splits and without sensitive settings', async () => {
    const { userId, cookie } = await createSignedInUser();
    const otherUser = await createTestUser();
    const accountId = await createTestAccount(userId);
    const otherAccount = await createTestAccount(otherUser, { name: 'Other account' });
    const transactionId = await createTestTransaction(userId, accountId, { merchant: '=1+1', amountCents: 1_234 });
    await createTestTransaction(otherUser, otherAccount, { merchant: 'Other tenant merchant' });
    await db.insert(transactionSplits).values({
      id: `export-split-${transactionId}`, userId, transactionId, amountCents: 1_234,
      category: 'Food', subCategory: 'Groceries', type: 'expense', sortOrder: 0,
    });
    await db.insert(settings).values([
      { userId, key: 'display_currency', value: 'EUR' },
      { userId, key: 'simplefin_access_url', value: 'https://secret.invalid/credential' },
    ]);

    const jsonResponse = await app.fetch(authenticatedRequest('/api/data/export.json', cookie));
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.headers.get('cache-control')).toContain('no-store');
    const exported = await jsonResponse.json();
    expect(exported.version).toBe(2);
    expect(exported.user.id).toBe(userId);
    expect(exported.data.transactions).toHaveLength(1);
    expect(exported.data.transactions[0].splits).toHaveLength(1);
    expect(exported.data.settings.map((setting: { key: string }) => setting.key)).toEqual(['display_currency']);
    expect(JSON.stringify(exported)).not.toContain('Other tenant merchant');
    expect(JSON.stringify(exported)).not.toContain('secret.invalid');

    const csvResponse = await app.fetch(authenticatedRequest('/api/data/transactions.csv', cookie));
    const csv = await csvResponse.text();
    expect(csvResponse.status).toBe(200);
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('export-split-');
    expect(csv).not.toContain('Other tenant merchant');
  });
});

describe('MCP access', () => {
  test('lists write tools only for write-scoped tokens', async () => {
    const userId = await createTestUser();
    const readToken = await createMcpAccessToken(userId, { name: 'Read', expiresAt: null, access: 'read' });
    const writeToken = await createMcpAccessToken(userId, { name: 'Write', expiresAt: null, access: 'read_write' });

    const listTools = async (token: string) => {
      const response = await app.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const body = await response.json();
      return body.result.tools.map((tool: { name: string }) => tool.name) as string[];
    };

    const readTools = await listTools(readToken.token);
    const writeTools = await listTools(writeToken.token);
    expect(readTools).toContain('list_accounts');
    expect(readTools).not.toContain('set_budget');
    expect(readTools).not.toContain('categorize_transaction');
    expect(writeTools).toContain('set_budget');
    expect(writeTools).toContain('categorize_transaction');
  });
});
