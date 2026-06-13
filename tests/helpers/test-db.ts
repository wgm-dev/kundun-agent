// Shared test helpers: a fresh, migrated Kundun SQLite database and a temporary
// project tree on disk.
//
// A real temp FILE (not :memory:) is used so FTS5, WAL, and VACUUM behavior
// match production. Each call gets a unique directory under the OS temp dir.
//
// better-sqlite3 is fully synchronous; nothing here is async.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/storage/sqlite.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { FileRepository } from '../../src/storage/repositories/file.repository.js';
import { nowIso } from '../../src/utils/time.js';
import type { KundunDb, NewFileRow } from '../../src/storage/types.js';

// makeTempProject lives in temp-project.ts (richer API used by scanner/indexer
// tests). Re-export it here so a single import path exposes both helpers.
export { makeTempProject } from './temp-project.js';
export type { TempProject } from './temp-project.js';

/** A migrated test database plus its scratch dir and a disposer. */
export interface TestDb {
  kdb: KundunDb;
  /** Absolute path to the temp directory holding the .sqlite file. */
  dir: string;
  /** Close the connection (folding the WAL back) and delete the temp dir. */
  cleanup(): void;
}

/**
 * Remove a directory recursively, retrying a few times on Windows where a
 * just-closed SQLite WAL/SHM handle can briefly keep the file locked
 * (EBUSY/EPERM/ENOTEMPTY).
 */
function rmWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
        throw err;
      }
      // Briefly spin to let the OS release the handle, then retry.
      const until = Date.now() + 50;
      while (Date.now() < until) {
        // intentional short busy-wait
      }
    }
  }
  // Final attempt: let any error surface so the test fails loudly.
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a fresh temp-file database with migration v1 already applied.
 * The caller MUST invoke the returned `cleanup()` (e.g. in afterEach).
 */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'kundun-db-'));
  const dbPath = path.join(dir, 'kundun.sqlite');
  const kdb = openDatabase(dbPath);
  runMigrations(kdb.db, kdb.hasFts5);

  return {
    kdb,
    dir,
    cleanup(): void {
      try {
        kdb.close();
      } catch {
        // Ignore double-close / already-closed handles.
      }
      // Removes the .sqlite plus any -wal/-shm sidecar files.
      rmWithRetry(dir);
    },
  };
}

/**
 * Build a NewFileRow with sensible defaults, overridable per field. Chunks and
 * symbols require an existing file row, so tests use this to seed one first.
 */
export function makeFileRow(overrides: Partial<NewFileRow> = {}): NewFileRow {
  const iso = nowIso();
  return {
    path: '/abs/src/example.ts',
    relative_path: 'src/example.ts',
    extension: '.ts',
    language: 'typescript',
    size_bytes: 100,
    hash: 'hash-default',
    last_modified_at: iso,
    indexed_at: null,
    is_deleted: 0,
    importance_score: 0,
    ...overrides,
  };
}

/**
 * Insert a file via FileRepository (the supported path) and return its id.
 * Use before inserting chunks/symbols, which reference files(id).
 */
export function insertFile(kdb: KundunDb, overrides: Partial<NewFileRow> = {}): number {
  const repo = new FileRepository(kdb);
  const { id } = repo.upsertByRelativePath(makeFileRow(overrides));
  return id;
}
