// Migration tests: the schema is fully created, idempotent on re-run, and the
// FTS5 virtual tables exist when the build supports FTS5 (it does here).
// As of migration v2 the diagnostics table is also created.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runMigrations,
  getCurrentVersion,
  LATEST_SCHEMA_VERSION,
} from '../../../src/storage/migrations.js';
import { createTestDb, type TestDb } from '../../helpers/test-db.js';

/** Base tables (excluding _migrations and FTS virtual tables). */
const EXPECTED_TABLES = [
  'project_meta',
  'files',
  'file_chunks',
  'symbols',
  'memories',
  'tasks',
  'scan_runs',
  'cleanup_runs',
  'diagnostics',
] as const;

/** Names of all tables present in the database. */
function tableNames(db: TestDb['kdb']['db']): Set<string> {
  const rows = db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  return new Set(rows.map((r) => r.name));
}

describe('migrations', () => {
  let t: TestDb;

  beforeEach(() => {
    // createTestDb already runs migrations once.
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it('creates all base tables plus _migrations', () => {
    const names = tableNames(t.kdb.db);
    for (const name of EXPECTED_TABLES) {
      expect(names.has(name), `expected table "${name}" to exist`).toBe(true);
    }
    expect(names.has('_migrations')).toBe(true);
  });

  it('records the latest version in _migrations as the authoritative version', () => {
    expect(getCurrentVersion(t.kdb.db)).toBe(LATEST_SCHEMA_VERSION);
    const row = t.kdb.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM _migrations').get();
    // One bookkeeping row per applied migration.
    expect(row?.n).toBe(LATEST_SCHEMA_VERSION);
  });

  it('is idempotent: running migrations again applies nothing and keeps the version', () => {
    const result = runMigrations(t.kdb.db, t.kdb.hasFts5);
    expect(result.from).toBe(LATEST_SCHEMA_VERSION);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied).toEqual([]);
    expect(getCurrentVersion(t.kdb.db)).toBe(LATEST_SCHEMA_VERSION);

    // Still exactly one bookkeeping row per migration.
    const row = t.kdb.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM _migrations').get();
    expect(row?.n).toBe(LATEST_SCHEMA_VERSION);
  });

  it('creates the FTS5 virtual tables when FTS5 is available', () => {
    // sqlite shipped with better-sqlite3 has FTS5; assert that precondition.
    expect(t.kdb.hasFts5).toBe(true);

    const names = tableNames(t.kdb.db);
    expect(names.has('chunks_fts')).toBe(true);
    expect(names.has('memories_fts')).toBe(true);
  });

  it('records the migration with a non-empty applied_at timestamp', () => {
    const row = t.kdb.db
      .prepare<
        [number],
        { applied_at: string }
      >('SELECT applied_at FROM _migrations WHERE version = ?')
      .get(1);
    expect(typeof row?.applied_at).toBe('string');
    expect(row?.applied_at.length ?? 0).toBeGreaterThan(0);
  });
});
