#!/usr/bin/env bun
/**
 * Back up or restore the SQLite database.
 *
 * Backups are consistent copies taken with `VACUUM INTO` while the app keeps
 * running. Each one is checked with SQLite's integrity check before this
 * script reports success.
 *
 * Usage (inside the `app` container):
 *   docker compose exec app bun scripts/backup.ts
 *       → /data/backups/cura-<UTC timestamp>.db
 *   docker compose exec app bun scripts/backup.ts /data/backups/before-update.db
 *
 * Restoring replaces the live database, so stop the app first and run the
 * restore in a one-off container (the previous file is kept beside it as
 * cura.db.before-restore):
 *   docker compose stop app
 *   docker compose run --rm --no-deps --entrypoint bun app scripts/backup.ts --restore /data/backups/<file>.db
 *   docker compose start app
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const databasePath = process.env.DATABASE_PATH
  || (process.env.NODE_ENV === 'production' ? '/data/cura.db' : './data/cura.db');

function fail(message: string): never {
  console.error(`[backup] ${message}`);
  process.exit(1);
}

function assertIntact(path: string): void {
  const database = new Database(path, { readonly: true });
  try {
    const rows = database.query('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      fail(`${path} failed the integrity check: ${rows.map((row) => row.integrity_check).join('; ')}`);
    }
  } finally {
    database.close();
  }
}

function backup(target: string | undefined): void {
  if (!existsSync(databasePath)) fail(`no database at ${databasePath}`);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const output = target ?? join(dirname(databasePath), 'backups', `cura-${timestamp}.db`);
  if (existsSync(output)) fail(`${output} already exists`);
  mkdirSync(dirname(output), { recursive: true });

  const database = new Database(databasePath, { readwrite: true, create: false });
  try {
    database.query('VACUUM INTO ?').run(output);
  } finally {
    database.close();
  }
  assertIntact(output);
  const megabytes = (statSync(output).size / 1024 / 1024).toFixed(1);
  console.log(`[backup] wrote ${output} (${megabytes} MB)`);
}

function restore(source: string): void {
  if (!existsSync(source)) fail(`no backup at ${source}`);
  assertIntact(source);

  const staged = `${databasePath}.restoring`;
  copyFileSync(source, staged);
  if (existsSync(databasePath)) renameSync(databasePath, `${databasePath}.before-restore`);
  // A write-ahead log left by the old file must not be applied to the new one.
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${databasePath}${suffix}`, { force: true });
  renameSync(staged, databasePath);
  console.log(`[backup] restored ${source} to ${databasePath}; the previous file is ${databasePath}.before-restore`);
}

const args = process.argv.slice(2);
if (args[0] === '--restore') {
  if (!args[1]) fail('usage: bun scripts/backup.ts --restore <backup file>');
  restore(args[1]);
} else {
  backup(args[0]);
}
