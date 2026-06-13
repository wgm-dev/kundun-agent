// HealthRepository tests: record returns an id; recentEvents is newest-first and
// honours the severity/source filters and the limit; countSince counts rows at or
// after a cutoff; deleteOlderThan prunes by created_at and reports the row count.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthRepository } from '../../../src/storage/repositories/health.repository.js';
import { createTestDb, type TestDb } from '../../helpers/test-db.js';

const T1 = '2026-06-13T10:00:00.000Z';
const T2 = '2026-06-13T11:00:00.000Z';
const T3 = '2026-06-13T12:00:00.000Z';

describe('HealthRepository', () => {
  let t: TestDb;
  let repo: HealthRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new HealthRepository(t.kdb);
  });

  afterEach(() => {
    t.cleanup();
  });

  it('record inserts an event and returns a positive id', () => {
    const id = repo.record({ source: 'scanner', severity: 'warning', message: 'slow scan' }, T1);
    expect(id).toBeGreaterThan(0);

    const rows = repo.recentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('scanner');
    expect(rows[0]?.severity).toBe('warning');
    expect(rows[0]?.message).toBe('slow scan');
    expect(rows[0]?.created_at).toBe(T1);
    expect(rows[0]?.details_json).toBeNull();
  });

  it('record stores details_json when provided', () => {
    repo.record(
      { source: 'indexer', severity: 'error', message: 'boom', detailsJson: '{"k":1}' },
      T1,
    );
    const rows = repo.recentEvents(10);
    expect(rows[0]?.details_json).toBe('{"k":1}');
  });

  it('recentEvents returns events newest-first and respects the limit', () => {
    repo.record({ source: 'scanner', severity: 'info', message: 'a' }, T1);
    repo.record({ source: 'scanner', severity: 'info', message: 'b' }, T2);
    repo.record({ source: 'scanner', severity: 'info', message: 'c' }, T3);

    const rows = repo.recentEvents(2);
    expect(rows.map((r) => r.message)).toEqual(['c', 'b']);
  });

  it('recentEvents filters by severity and by source', () => {
    repo.record({ source: 'scanner', severity: 'error', message: 'scan-err' }, T1);
    repo.record({ source: 'indexer', severity: 'warning', message: 'idx-warn' }, T2);
    repo.record({ source: 'indexer', severity: 'error', message: 'idx-err' }, T3);

    const errors = repo.recentEvents(10, { severity: 'error' });
    expect(errors.map((r) => r.message)).toEqual(['idx-err', 'scan-err']);

    const idx = repo.recentEvents(10, { source: 'indexer' });
    expect(idx.map((r) => r.message)).toEqual(['idx-err', 'idx-warn']);

    const idxErrors = repo.recentEvents(10, { source: 'indexer', severity: 'error' });
    expect(idxErrors.map((r) => r.message)).toEqual(['idx-err']);
  });

  it('countSince counts only events at or after the cutoff', () => {
    repo.record({ source: 'scanner', severity: 'info', message: 'a' }, T1);
    repo.record({ source: 'scanner', severity: 'info', message: 'b' }, T2);
    repo.record({ source: 'scanner', severity: 'info', message: 'c' }, T3);

    expect(repo.countSince(T1)).toBe(3);
    expect(repo.countSince(T2)).toBe(2);
    expect(repo.countSince('2026-06-13T12:30:00.000Z')).toBe(0);
  });

  it('deleteOlderThan removes events strictly older than the cutoff and returns the count', () => {
    repo.record({ source: 'scanner', severity: 'info', message: 'a' }, T1);
    repo.record({ source: 'scanner', severity: 'info', message: 'b' }, T2);
    repo.record({ source: 'scanner', severity: 'info', message: 'c' }, T3);

    // Cutoff T3: T1 and T2 are older; T3 itself is kept (not "< T3").
    const removed = repo.deleteOlderThan(T3);
    expect(removed).toBe(2);

    const rows = repo.recentEvents(10);
    expect(rows.map((r) => r.message)).toEqual(['c']);
  });
});
