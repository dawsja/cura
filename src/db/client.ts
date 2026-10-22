/**
 * SQLite database access.
 *
 * One `bun:sqlite` connection serves the whole process; drizzle talks to it
 * through the async `sqlite-proxy` driver so the app keeps its async query
 * style. `bun:sqlite` itself is synchronous, so each statement runs to
 * completion before anything else touches the database.
 *
 * Transactions are async (callbacks await queries, and Better Auth may run
 * inside one), so they are serialized here instead:
 *   - `db.transaction(fn)` waits for any open transaction, then runs `fn`
 *     inside an AsyncLocalStorage context between BEGIN IMMEDIATE and
 *     COMMIT / ROLLBACK.
 *   - While a transaction is open, statements issued from its async context
 *     run immediately (including ones made on `db` rather than `tx`), and
 *     every other statement waits until it finishes. Nothing from another
 *     request can interleave with an open transaction.
 *   - A `db.transaction` call inside an open transaction joins it.
 *
 * The connection opens lazily on first use so the startup migration step
 * (src/db/migrate.ts) can import a Postgres database into the file first.
 */
import { Database as SqliteDatabase, type SQLQueryBindings } from 'bun:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SQL } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';
import { env } from '@/lib/env';

type Method = 'run' | 'all' | 'values' | 'get';

interface TxFrame {
  done: Promise<void>;
  finish: () => void;
}

/** Open a SQLite file with the pragmas the app relies on. */
export function openSqlite(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const database = new SqliteDatabase(path, { create: true, strict: true });
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA foreign_keys = ON');
  // Backups made from another process (scripts/backup.ts) briefly lock the file.
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

let sqlite: SqliteDatabase | null = null;

/** The process-wide connection, opened on first use. */
export function getSqlite(): SqliteDatabase {
  sqlite ??= openSqlite(env.DATABASE_PATH);
  return sqlite;
}

/** bun:sqlite binds numbers, strings, bigints, blobs and null only. */
function toBinding(value: unknown): SQLQueryBindings {
  if (value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as SQLQueryBindings;
}

const txContext = new AsyncLocalStorage<TxFrame>();
let activeTx: TxFrame | null = null;

/** Wait until no transaction other than the caller's own is open. */
async function enterGate(): Promise<void> {
  while (activeTx && txContext.getStore() !== activeTx) await activeTx.done;
}

function execute(sqlText: string, params: unknown[], method: Method): { rows: unknown[] } {
  const statement = getSqlite().query(sqlText);
  const bindings = params.map(toBinding);
  if (method === 'run') {
    statement.run(...bindings);
    return { rows: [] };
  }
  const rows = statement.values(...bindings);
  // drizzle expects the first row itself (or undefined) for `get`.
  return { rows: method === 'get' ? (rows[0] as unknown[]) : rows };
}

const proxyDb = drizzle(
  async (sqlText, params, method) => {
    await enterGate();
    return execute(sqlText, params, method);
  },
  { schema },
);

async function runTransaction<T>(fn: (tx: typeof proxyDb) => Promise<T>): Promise<T> {
  const current = txContext.getStore();
  if (current && current === activeTx) return fn(proxyDb);
  while (activeTx) await activeTx.done;
  let finish!: () => void;
  const frame: TxFrame = { done: new Promise<void>((resolve) => { finish = resolve; }), finish };
  activeTx = frame;
  try {
    return await txContext.run(frame, async () => {
      getSqlite().exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(proxyDb);
        getSqlite().exec('COMMIT');
        return result;
      } catch (err) {
        getSqlite().exec('ROLLBACK');
        throw err;
      }
    });
  } finally {
    activeTx = null;
    frame.finish();
  }
}

// Route every transaction through the serializer. Callbacks receive the
// database itself: its query builders are the same as a transaction's.
(proxyDb as { transaction: unknown }).transaction = runTransaction;

export const db = proxyDb as SqliteRemoteDatabase<typeof schema>;
export type Database = typeof db;

const dialect = new SQLiteAsyncDialect();

/** Run a raw query and return its rows as objects keyed by column name. */
export async function sqlAll<T>(query: SQL): Promise<T[]> {
  await enterGate();
  const { sql: sqlText, params } = dialect.sqlToQuery(query);
  return getSqlite().query(sqlText).all(...params.map(toBinding)) as T[];
}

/** Run a raw query and return its first row, if any. */
export async function sqlGet<T>(query: SQL): Promise<T | undefined> {
  const [row] = await sqlAll<T>(query);
  return row;
}

/** Run a raw statement and return how many rows it changed. */
export async function sqlRun(query: SQL): Promise<{ changes: number }> {
  await enterGate();
  const { sql: sqlText, params } = dialect.sqlToQuery(query);
  const result = getSqlite().query(sqlText).run(...params.map(toBinding));
  return { changes: result.changes };
}

/**
 * Verify the database answers, without letting readiness hang behind a long
 * transaction.
 */
export async function checkDb(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      enterGate(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`database readiness check timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  getSqlite().query('SELECT 1').get();
}

/** Close the connection. Call from process exit handlers. */
export async function closeDb(): Promise<void> {
  await enterGate();
  sqlite?.close();
  sqlite = null;
}
