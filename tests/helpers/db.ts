// Test helper: open an in-memory Kundun database with the v1 schema applied.
// Mirrors the production open path (pragmas + one-time FTS5 detection + migrate)
// but stays entirely in memory so each test gets an isolated, fast database.

import Database from 'better-sqlite3';

import { applyPragmas, detectFts5 } from '../../src/storage/sqlite.js';
import { runMigrations } from '../../src/storage/migrations.js';
import type { KundunDb } from '../../src/storage/types.js';

/** Open a fresh in-memory KundunDb with migrations applied. */
export function makeTestDb(): KundunDb {
  const db = new Database(':memory:');
  applyPragmas(db);
  const hasFts5 = detectFts5(db);
  runMigrations(db, hasFts5);

  return {
    db,
    hasFts5,
    close(): void {
      db.close();
    },
  };
}
