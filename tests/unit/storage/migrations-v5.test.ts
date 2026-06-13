// Migration v5 tests: a fresh database is at schema version 5, the three MVP3
// observability tables (sessions, health_events, metrics_snapshots) exist, the
// authoritative `_migrations` table has exactly 5 rows (one per applied
// migration), and re-running migrations is a no-op (idempotent).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runMigrations,
  getCurrentVersion,
  LATEST_SCHEMA_VERSION,
} from '../../../src/storage/migrations.js';
import { createTestDb, type TestDb } from '../../helpers/test-db.js';

/** The tables introduced by migration v5. */
const V5_TABLES = ['sessions', 'health_events', 'metrics_snapshots'] as const;

/** Names of all tables present in the database. */
function tableNames(db: TestDb['kdb']['db']): Set<string> {
  const rows = db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  return new Set(rows.map((r) => r.name));
}

describe('migrations v5 (MVP3 observability)', () => {
  let t: TestDb;

  beforeEach(() => {
    // createTestDb already runs all migrations once.
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it('reports schema version 5 as the latest and authoritative version', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(5);
    expect(getCurrentVersion(t.kdb.db)).toBe(5);
  });

  it('creates the sessions, health_events and metrics_snapshots tables', () => {
    const names = tableNames(t.kdb.db);
    for (const name of V5_TABLES) {
      expect(names.has(name), `expected table "${name}" to exist`).toBe(true);
    }
  });

  it('records exactly 5 rows in _migrations (one per applied migration)', () => {
    const row = t.kdb.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM _migrations').get();
    expect(row?.n).toBe(5);

    const versions = t.kdb.db
      .prepare<[], { version: number }>('SELECT version FROM _migrations ORDER BY version')
      .all()
      .map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
  });

  it('creates the v5 indexes on the new tables', () => {
    const indexes = t.kdb.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name);
    const names = new Set(indexes);
    for (const idx of [
      'idx_sessions_session_id',
      'idx_sessions_client_name',
      'idx_sessions_project_root',
      'idx_sessions_status',
      'idx_sessions_last_activity_at',
      'idx_health_events_source',
      'idx_health_events_severity',
      'idx_health_events_created_at',
      'idx_metrics_snapshots_created_at',
    ]) {
      expect(names.has(idx), `expected index "${idx}" to exist`).toBe(true);
    }
  });

  it('is idempotent: re-running migrations applies nothing and keeps version 5', () => {
    const result = runMigrations(t.kdb.db, t.kdb.hasFts5);
    expect(result.from).toBe(LATEST_SCHEMA_VERSION);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied).toEqual([]);
    expect(getCurrentVersion(t.kdb.db)).toBe(5);

    // Still exactly one bookkeeping row per migration after a second run.
    const row = t.kdb.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM _migrations').get();
    expect(row?.n).toBe(5);
  });
});
