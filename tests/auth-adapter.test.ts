import { describe, expect, test } from 'bun:test';
import { getAuth } from '@/auth';
import { createTestUser } from './helpers';

describe('Better Auth adapter', () => {
  test('reports affected rows from SQLite writes', async () => {
    const userId = await createTestUser();
    const { adapter } = await getAuth().$context;

    const updated = await adapter.updateMany({ model: 'user', where: [{ field: 'id', value: userId }], update: { name: 'Renamed' } });
    expect(updated).toBe(1);
    expect(await adapter.deleteMany({ model: 'session', where: [{ field: 'userId', value: 'no-such-user' }] })).toBe(0);
  });
});
