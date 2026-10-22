/**
 * One-time move of an existing install from Postgres to SQLite.
 *
 * Runs at startup (from ./migrate.ts) when DATABASE_PATH does not exist and
 * DATABASE_URL is set:
 *   1. Bring the Postgres schema up to date with the frozen migrations in
 *      drizzle/postgres, so older releases import from the final layout.
 *   2. Refuse to run if Postgres records an earlier import. A missing SQLite
 *      file then almost always means a missing volume, and importing again
 *      would silently drop everything changed since. SQLITE_REIMPORT=true
 *      overrides this.
 *   3. Build `<DATABASE_PATH>.importing`, copy every table from one
 *      read-only snapshot, and verify the copy: per-column checksums, foreign
 *      keys and SQLite's integrity check.
 *   4. Rename the file into place and record the import in Postgres.
 *
 * Postgres is only read (apart from pending migrations and the record), so
 * a failed import leaves it untouched and the previous release still works.
 */
import { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { getTableColumns, is } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/bun-sqlite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { getTableConfig, SQLiteTable, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import postgres from 'postgres';
import { applySqliteMigrations } from './migrate';
import * as schema from './schema';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

const POSTGRES_MIGRATIONS_FOLDER = './drizzle/postgres';
const MARKER_TABLE = 'cura_sqlite_migration';
const BATCH_ROWS = 250;

const tables = (Object.values(schema) as unknown[]).filter((value): value is SQLiteTable => is(value, SQLiteTable));

interface ColumnCheck {
  column: string;
  postgres: string;
  sqlite: string;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/** Columns the import writes: everything except generated columns. */
function copiedColumns(table: SQLiteTable): [key: string, column: SQLiteColumn][] {
  return Object.entries(getTableColumns(table)).filter(([, column]) => !column.generated);
}

/**
 * One checksum per column, computed on both sides as an exact integer:
 * sums for numbers, cents, timestamps (ms) and booleans, total length for
 * text, and a non-null count where a float or JSON comparison would be
 * inexact.
 */
function columnChecks(table: SQLiteTable): ColumnCheck[] {
  return copiedColumns(table).map(([, column]) => {
    const name = quote(column.name);
    switch (column.columnType) {
      case 'SQLiteTimestamp':
        return { column: column.name, postgres: `sum(floor(extract(epoch from ${name}) * 1000))`, sqlite: `sum(${name})` };
      case 'SQLiteBoolean':
        return { column: column.name, postgres: `sum(${name}::int)`, sqlite: `sum(${name})` };
      case 'SQLiteInteger':
        return { column: column.name, postgres: `sum(${name})`, sqlite: `sum(${name})` };
      case 'SQLiteCustomColumn':
        // Dollar amounts: numeric(16,2) in Postgres, integer cents here.
        return { column: column.name, postgres: `sum(round(${name} * 100))`, sqlite: `sum(${name})` };
      case 'SQLiteText':
        return { column: column.name, postgres: `sum(length(${name}::text))`, sqlite: `sum(length(${name}))` };
      default:
        return { column: column.name, postgres: `count(${name})`, sqlite: `count(${name})` };
    }
  });
}

/** Turn a `row_to_json` row into drizzle insert values for the SQLite table. */
function toSqliteValues(columns: [string, SQLiteColumn][], row: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, column] of columns) {
    // Columns added after the move (e.g. monthly_budgets.revision) keep their default.
    if (!(column.name in row)) continue;
    const value = row[column.name];
    values[key] = column.columnType === 'SQLiteTimestamp' && typeof value === 'string' ? new Date(value) : value;
  }
  return values;
}

function removeDatabaseFiles(path: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

async function previousImport(sql: postgres.Sql): Promise<{ migrated_at: string; database_path: string } | undefined> {
  const [exists] = await sql<{ present: boolean }[]>`SELECT to_regclass(${`public.${MARKER_TABLE}`}) IS NOT NULL AS present`;
  if (!exists?.present) return undefined;
  const [row] = await sql<{ migrated_at: string; database_path: string }[]>`
    SELECT migrated_at::text AS migrated_at, database_path FROM ${sql(MARKER_TABLE)}
    ORDER BY migrated_at DESC LIMIT 1
  `;
  return row;
}

/** Copy the Postgres database at `url` into a new SQLite file at `path`. */
export async function importFromPostgres(url: string, path: string): Promise<void> {
  const started = Date.now();
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
  const temporaryPath = `${path}.importing`;
  try {
    logger.info({ databasePath: path }, 'import: moving data from Postgres to SQLite');
    await migratePostgres(drizzlePostgres(sql), { migrationsFolder: POSTGRES_MIGRATIONS_FOLDER });

    const earlier = await previousImport(sql);
    if (earlier && !env.SQLITE_REIMPORT) {
      throw new Error(
        `Data was moved from Postgres to SQLite on ${earlier.migrated_at}, but ${path} does not exist. ` +
        'Mount the volume that holds it. To import from Postgres again and lose every change made since, ' +
        'set SQLITE_REIMPORT=true for one start.',
      );
    }

    mkdirSync(dirname(path), { recursive: true });
    removeDatabaseFiles(temporaryPath);
    const sqlite = new SqliteDatabase(temporaryPath, { create: true, strict: true });
    const counts: Record<string, number> = {};
    try {
      applySqliteMigrations(sqlite);
      const target = drizzleSqlite(sqlite);

      await sql.begin('isolation level repeatable read read only', async (tx) => {
        const known = new Set(tables.map((table) => getTableConfig(table).name));
        const extra = await tx<{ tablename: string }[]>`
          SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
        `;
        // Leftovers such as the archive tables older migrations created.
        const skipped: Record<string, number> = {};
        for (const { tablename } of extra) {
          if (known.has(tablename) || tablename === MARKER_TABLE) continue;
          const [row] = await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM ${tx(tablename)}`;
          skipped[tablename] = Number(row?.count ?? 0);
        }
        if (Object.keys(skipped).length > 0) {
          logger.warn({ tables: skipped }, 'import: Postgres tables Cura no longer uses were not copied; they stay in Postgres');
        }

        // Constraints are verified as a whole afterwards; rows go in table by table.
        sqlite.exec('PRAGMA foreign_keys = OFF');
        sqlite.exec('BEGIN');
        try {
          for (const table of tables) {
            const name = getTableConfig(table).name;
            const columns = copiedColumns(table);
            let copied = 0;
            await tx`SELECT row_to_json(t) AS row FROM ${tx(name)} t`.cursor(BATCH_ROWS, (rows) => {
              const values = rows.map(({ row }) => toSqliteValues(columns, row as Record<string, unknown>));
              target.insert(table).values(values).run();
              copied += values.length;
            });
            counts[name] = copied;
          }
          sqlite.exec('COMMIT');
        } catch (err) {
          sqlite.exec('ROLLBACK');
          throw err;
        }

        const postgresColumns = new Set((await tx<{ column: string }[]>`
          SELECT table_name || '.' || column_name AS column
          FROM information_schema.columns WHERE table_schema = 'public'
        `).map((row) => row.column));
        for (const table of tables) {
          const name = getTableConfig(table).name;
          // Columns added after the move have nothing to compare against.
          const checks = columnChecks(table).filter((check) => postgresColumns.has(`${name}.${check.column}`));
          const pgSelect = ['count(*)', ...checks.map((check) => check.postgres)]
            .map((expression, index) => `coalesce(${expression}, 0)::text AS c${index}`).join(', ');
          const liteSelect = ['count(*)', ...checks.map((check) => check.sqlite)]
            .map((expression, index) => `cast(coalesce(${expression}, 0) as text) AS c${index}`).join(', ');
          const [expected] = await tx.unsafe<Record<string, string>[]>(`SELECT ${pgSelect} FROM ${quote(name)}`);
          const actual = sqlite.query(`SELECT ${liteSelect} FROM ${quote(name)}`).get() as Record<string, string>;
          const labels = ['rows', ...checks.map((check) => check.column)];
          const mismatches = labels
            .map((label, index) => ({ label, expected: expected?.[`c${index}`], actual: actual[`c${index}`] }))
            .filter((entry) => entry.expected !== entry.actual);
          if (mismatches.length > 0) {
            logger.error({ table: name, mismatches }, 'import: copied data does not match Postgres');
            throw new Error(`import verification failed for table ${name}`);
          }
        }
      });

      const brokenReferences = sqlite.query('PRAGMA foreign_key_check').all();
      if (brokenReferences.length > 0) {
        logger.error({ brokenReferences: brokenReferences.slice(0, 20) }, 'import: foreign key check failed');
        throw new Error('import verification failed: foreign key check');
      }
      const integrity = sqlite.query('PRAGMA integrity_check').all() as { integrity_check: string }[];
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        logger.error({ integrity }, 'import: SQLite integrity check failed');
        throw new Error('import verification failed: integrity check');
      }
    } catch (err) {
      sqlite.close();
      removeDatabaseFiles(temporaryPath);
      throw err;
    }
    sqlite.close();
    renameSync(temporaryPath, path);

    const rows = Object.values(counts).reduce((total, count) => total + count, 0);
    try {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${quote(MARKER_TABLE)} (
          migrated_at timestamptz NOT NULL DEFAULT now(),
          database_path text NOT NULL,
          row_count bigint NOT NULL
        )
      `);
      await sql`INSERT INTO ${sql(MARKER_TABLE)} (database_path, row_count) VALUES (${path}, ${rows})`;
    } catch (err) {
      logger.warn({ err }, 'import: could not record the move in Postgres; the SQLite copy is complete');
    }

    logger.info(
      { rows, tables: counts, ms: Date.now() - started, databasePath: path },
      'import: copied and verified all data from Postgres. Remove DATABASE_URL and the Postgres service; Cura now uses only the SQLite file',
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
