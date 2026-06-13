// MetricsRepository tests: insertSnapshot stamps created_at and persists the
// caller-supplied counts (including nullable fields); latest returns the most
// recent row; recent returns up to `limit` newest-first; deleteOlderThan prunes
// by created_at and reports the row count.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MetricsRepository } from '../../../src/storage/repositories/metrics.repository.js';
import { createTestDb, type TestDb } from '../../helpers/test-db.js';
import type { NewMetricsSnapshotRow } from '../../../src/storage/types.js';

const T1 = '2026-06-13T10:00:00.000Z';
const T2 = '2026-06-13T11:00:00.000Z';
const T3 = '2026-06-13T12:00:00.000Z';

function makeSnapshot(overrides: Partial<NewMetricsSnapshotRow> = {}): NewMetricsSnapshotRow {
  return {
    active_sessions: 1,
    indexed_files: 10,
    indexed_chunks: 100,
    memory_count: 5,
    task_count: 3,
    diagnostics_count: 2,
    db_size_bytes: 4096,
    avg_tool_latency_ms: 12.5,
    scan_duration_ms: 250,
    cleanup_duration_ms: 80,
    errors_last_24h: 0,
    ...overrides,
  };
}

describe('MetricsRepository', () => {
  let t: TestDb;
  let repo: MetricsRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new MetricsRepository(t.kdb);
  });

  afterEach(() => {
    t.cleanup();
  });

  it('insertSnapshot stamps created_at and persists all supplied fields', () => {
    const id = repo.insertSnapshot(makeSnapshot(), T1);
    expect(id).toBeGreaterThan(0);

    const row = repo.latest();
    expect(row?.id).toBe(id);
    expect(row?.created_at).toBe(T1);
    expect(row?.active_sessions).toBe(1);
    expect(row?.indexed_files).toBe(10);
    expect(row?.indexed_chunks).toBe(100);
    expect(row?.memory_count).toBe(5);
    expect(row?.task_count).toBe(3);
    expect(row?.diagnostics_count).toBe(2);
    expect(row?.db_size_bytes).toBe(4096);
    expect(row?.avg_tool_latency_ms).toBe(12.5);
    expect(row?.scan_duration_ms).toBe(250);
    expect(row?.cleanup_duration_ms).toBe(80);
    expect(row?.errors_last_24h).toBe(0);
  });

  it('insertSnapshot persists nullable fields as null', () => {
    repo.insertSnapshot(
      makeSnapshot({
        avg_tool_latency_ms: null,
        scan_duration_ms: null,
        cleanup_duration_ms: null,
      }),
      T1,
    );
    const row = repo.latest();
    expect(row?.avg_tool_latency_ms).toBeNull();
    expect(row?.scan_duration_ms).toBeNull();
    expect(row?.cleanup_duration_ms).toBeNull();
  });

  it('latest returns the most recently created snapshot', () => {
    repo.insertSnapshot(makeSnapshot({ indexed_files: 1 }), T1);
    repo.insertSnapshot(makeSnapshot({ indexed_files: 2 }), T2);
    repo.insertSnapshot(makeSnapshot({ indexed_files: 3 }), T3);

    expect(repo.latest()?.indexed_files).toBe(3);
  });

  it('latest returns undefined when there are no snapshots', () => {
    expect(repo.latest()).toBeUndefined();
  });

  it('recent returns up to `limit` snapshots newest-first', () => {
    repo.insertSnapshot(makeSnapshot({ indexed_files: 1 }), T1);
    repo.insertSnapshot(makeSnapshot({ indexed_files: 2 }), T2);
    repo.insertSnapshot(makeSnapshot({ indexed_files: 3 }), T3);

    const rows = repo.recent(2);
    expect(rows.map((r) => r.indexed_files)).toEqual([3, 2]);
  });

  it('deleteOlderThan removes snapshots strictly older than the cutoff and returns the count', () => {
    repo.insertSnapshot(makeSnapshot(), T1);
    repo.insertSnapshot(makeSnapshot(), T2);
    repo.insertSnapshot(makeSnapshot(), T3);

    const removed = repo.deleteOlderThan(T3);
    expect(removed).toBe(2);

    const rows = repo.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_at).toBe(T3);
  });
});
