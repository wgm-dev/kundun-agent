// Low-level SQLite connection management for Kundun.
// Owns: opening the database, applying connection pragmas, ONE-TIME FTS5
// detection (D1), a small synchronous transaction helper, and an on-disk size
// probe. Higher layers (migrations, repositories) build on the returned KundunDb.
//
// NOTE: better-sqlite3 is fully synchronous. Do NOT wrap any of this in
// async/await.

import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { KundunError } from '../utils/errors.js';
import type { KundunDb } from './types.js';

/** Sentinel path that opens a private, in-memory database (no file on disk). */
const IN_MEMORY_PATH = ':memory:';

/**
 * Apply the standard connection pragmas. WAL and busy_timeout improve
 * concurrent read/write behavior; foreign_keys must be enabled per-connection
 * (it is OFF by default in SQLite). On an in-memory database WAL is a harmless
 * no-op.
 */
export function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
}

/**
 * Detect FTS5 availability ONCE by attempting to create a temp virtual table.
 * The probe lives in the `temp` schema so it never touches the real database.
 * Returns true when FTS5 is compiled in, false otherwise.
 */
export function detectFts5(db: Database.Database): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x)');
    db.exec('DROP TABLE temp.__fts5_probe');
    return true;
  } catch {
    return false;
  }
}

/**
 * Open (or create) a Kundun SQLite database at `dbPath`.
 *
 * For file-backed databases the parent directory is created recursively. FTS5
 * support is probed exactly once and surfaced as `hasFts5` on the returned
 * handle (D1). A locked database (SQLITE_BUSY) is wrapped into a
 * `KundunError('storage_locked', ...)`.
 */
export function openDatabase(dbPath: string): KundunDb {
  if (dbPath !== IN_MEMORY_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    if (isSqliteBusy(err)) {
      throw new KundunError(
        'storage_locked',
        `Database is locked and could not be opened: ${dbPath}`,
      );
    }
    throw err;
  }

  applyPragmas(db);
  const hasFts5 = detectFts5(db);

  return {
    db,
    hasFts5,
    close(): void {
      // Best-effort checkpoint to fold the WAL back into the main file so the
      // on-disk size reflects committed data and no -wal/-shm lingers.
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Ignore: checkpoint is opportunistic (e.g. no-op on :memory:).
      }
      db.close();
    },
  };
}

/**
 * Run `fn` inside a single SQLite transaction and return its result.
 * better-sqlite3 commits on normal return and rolls back if `fn` throws.
 */
export function transaction<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn)();
}

/**
 * On-disk size of the database file in bytes. Returns 0 for the in-memory
 * database or when the file does not yet exist.
 */
export function getDbSizeBytes(dbPath: string): number {
  if (dbPath === IN_MEMORY_PATH) {
    return 0;
  }
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

/** Whether a caught value is a SQLITE_BUSY error from better-sqlite3. */
function isSqliteBusy(err: unknown): boolean {
  if (err instanceof Database.SqliteError) {
    return err.code === 'SQLITE_BUSY';
  }
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'SQLITE_BUSY';
}
