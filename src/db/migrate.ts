/**
 * Standalone migration runner. Idempotent.
 *
 * Runs from:
 *   - `bun run db:migrate` (dev, CLI)
 *   - `src/index.ts` on app startup (production)
 *
 * The migrator tracks applied migrations in the `__drizzle_migrations` table
 * inside the same database. Re-running is safe.
 *
 * When the database file does not exist yet and DATABASE_URL points at the
 * Postgres database of an older release, the data is first copied into a
 * new SQLite file (see ./import-postgres.ts).
 */
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getSqlite } from './client';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export const SQLITE_MIGRATIONS_FOLDER = './drizzle/sqlite';

/** Apply pending SQLite migrations to an open database. */
export function applySqliteMigrations(database: SqliteDatabase): void {
  migrate(drizzle(database), { migrationsFolder: SQLITE_MIGRATIONS_FOLDER });
}

/** Import from Postgres when needed, then apply all pending migrations. */
export async function runMigrations(): Promise<void> {
  if (!existsSync(env.DATABASE_PATH) && env.DATABASE_URL) {
    const { importFromPostgres } = await import('./import-postgres');
    await importFromPostgres(env.DATABASE_URL, env.DATABASE_PATH);
  } else if (env.DATABASE_URL) {
    logger.warn(
      { databasePath: env.DATABASE_PATH },
      'migrate: DATABASE_URL is set but the data already lives in SQLite; remove DATABASE_URL and the Postgres service',
    );
  }

  logger.info({ databasePath: env.DATABASE_PATH }, 'migrate: applying migrations...');
  const start = Date.now();
  applySqliteMigrations(getSqlite());
  logger.info({ ms: Date.now() - start }, 'migrate: migrations done');
}

if (import.meta.main) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err);
      process.exit(1);
    });
}
