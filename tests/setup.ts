import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const testTempDir = mkdtempSync(join(tmpdir(), 'cura-money-tests-'));
export const testDatabasePath = join(testTempDir, 'cura.db');

process.env.NODE_ENV = 'test';
process.env.TZ = 'UTC';
process.env.LOG_LEVEL = 'fatal';
process.env.DATABASE_PATH = testDatabasePath;
process.env.BETTER_AUTH_SECRET = 'cura-test-auth-secret-at-least-32-characters';
process.env.DATA_ENCRYPTION_KEY = 'cura-test-data-key-at-least-32-characters';
process.env.DATA_ENCRYPTION_KEY_PREVIOUS = '';
process.env.DEMO_MODE = 'false';
process.env.RUN_CRON = 'false';
process.env.MCP_ENABLED = 'true';
process.env.AUTH_SECURE_COOKIES = 'false';
process.env.APP_URL = '';
process.env.BETTER_AUTH_URL = '';
process.env.OIDC_REDIRECT_BASE = '';
delete process.env.DATABASE_URL;

const [{ runMigrations }, { db }, { setupState }, { initAuth }] = await Promise.all([
  import('@/db/migrate'),
  import('@/db/client'),
  import('@/db/schema/setup_state'),
  import('@/auth'),
]);

await runMigrations();
await db.insert(setupState).values({
  id: 1,
  needsAdmin: false,
  bootstrapCompleted: true,
}).onConflictDoNothing();
await initAuth();

process.on('exit', () => {
  rmSync(testTempDir, { recursive: true, force: true });
});
