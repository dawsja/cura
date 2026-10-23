import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '..');
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('database backup and restore', () => {
  test('creates an intact live backup and restores it over newer data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cura-backup-test-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'cura.db');
    const backupPath = join(dir, 'backup.db');
    const source = new Database(databasePath);
    source.exec('PRAGMA journal_mode = WAL');
    source.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    source.query('INSERT INTO entries (value) VALUES (?)').run('original');

    const runBackupScript = (args: string[]) => spawnSync(
      process.execPath,
      ['scripts/backup.ts', ...args],
      {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_PATH: databasePath },
        encoding: 'utf8',
      },
    );

    const backup = runBackupScript([backupPath]);
    expect(backup.status, backup.stderr).toBe(0);
    source.query('INSERT INTO entries (value) VALUES (?)').run('changed after backup');
    source.close();

    const restore = runBackupScript(['--restore', backupPath]);
    expect(restore.status, restore.stderr).toBe(0);

    const restored = new Database(databasePath, { readonly: true });
    expect(restored.query('SELECT value FROM entries ORDER BY id').all()).toEqual([{ value: 'original' }]);
    expect(restored.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    restored.close();

    const previous = new Database(`${databasePath}.before-restore`, { readonly: true });
    expect(previous.query('SELECT value FROM entries ORDER BY id').all()).toEqual([
      { value: 'original' }, { value: 'changed after backup' },
    ]);
    previous.close();
  });
});
