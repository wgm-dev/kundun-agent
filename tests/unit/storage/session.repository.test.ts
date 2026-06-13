// SessionRepository tests: register (insert) then re-register (upsert) keeps a
// stable id resolved via SELECT (not lastInsertRowid); heartbeat / counter
// increments / end transitions; markStaleIdle demotes active -> idle ->
// disconnected by the two cutoffs; listActive excludes ended sessions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRepository } from '../../../src/storage/repositories/session.repository.js';
import { createTestDb, type TestDb } from '../../helpers/test-db.js';

// Fixed, distinct ISO instants used throughout so ordering is deterministic.
const T0 = '2026-06-13T12:00:00.000Z';
const T1 = '2026-06-13T12:05:00.000Z';
const T2 = '2026-06-13T12:10:00.000Z';

describe('SessionRepository', () => {
  let t: TestDb;
  let repo: SessionRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new SessionRepository(t.kdb);
  });

  afterEach(() => {
    t.cleanup();
  });

  it('register inserts a new active session and returns its row id', () => {
    const id = repo.register({ sessionId: 's1', clientName: 'claude', transport: 'stdio' }, T0);
    expect(id).toBeGreaterThan(0);

    const row = repo.getBySessionId('s1');
    expect(row?.id).toBe(id);
    expect(row?.status).toBe('active');
    expect(row?.client_name).toBe('claude');
    expect(row?.transport).toBe('stdio');
    expect(row?.started_at).toBe(T0);
    expect(row?.last_activity_at).toBe(T0);
    expect(row?.tools_called).toBe(0);
    expect(row?.errors_count).toBe(0);
  });

  it('re-registering the same session_id updates in place with a STABLE id (via SELECT, not lastInsertRowid)', () => {
    const firstId = repo.register({ sessionId: 's1', clientName: 'claude' }, T0);
    // Insert an unrelated session so lastInsertRowid would differ from firstId
    // if the upsert path mistakenly trusted it.
    repo.register({ sessionId: 'other', clientName: 'x' }, T0);

    // End s1, then re-register: the ON CONFLICT path must reactivate the same row.
    repo.end('s1', 'closed', T1);
    const secondId = repo.register({ sessionId: 's1', clientVersion: '2.0' }, T2);

    expect(secondId).toBe(firstId);

    const row = repo.getBySessionId('s1');
    expect(row?.id).toBe(firstId);
    expect(row?.status).toBe('active'); // reactivated
    expect(row?.ended_at).toBeNull(); // cleared on re-register
    expect(row?.last_activity_at).toBe(T2);
    // COALESCE keeps the prior client_name and merges the new client_version.
    expect(row?.client_name).toBe('claude');
    expect(row?.client_version).toBe('2.0');

    // Exactly one row for s1 (upsert, not a second insert).
    const count = t.kdb.db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?')
      .get('s1');
    expect(count?.n).toBe(1);
  });

  it('heartbeat updates last_activity_at and revives idle/disconnected sessions', () => {
    repo.register({ sessionId: 's1' }, T0);
    repo.end('s1', 'disconnected', T1);

    repo.heartbeat('s1', T2);
    const row = repo.getBySessionId('s1');
    expect(row?.status).toBe('active');
    expect(row?.last_activity_at).toBe(T2);
  });

  it('heartbeat does NOT resurrect a closed session', () => {
    repo.register({ sessionId: 's1' }, T0);
    repo.end('s1', 'closed', T1);

    repo.heartbeat('s1', T2);
    const row = repo.getBySessionId('s1');
    // 'closed' is filtered out of the heartbeat WHERE clause.
    expect(row?.status).toBe('closed');
    expect(row?.last_activity_at).toBe(T1);
  });

  it('incrementToolCall and incrementError bump counters and mark active', () => {
    repo.register({ sessionId: 's1' }, T0);
    repo.incrementToolCall('s1', T1);
    repo.incrementToolCall('s1', T2);
    repo.incrementError('s1', T2);

    const row = repo.getBySessionId('s1');
    expect(row?.tools_called).toBe(2);
    expect(row?.errors_count).toBe(1);
    expect(row?.status).toBe('active');
    expect(row?.last_activity_at).toBe(T2);
  });

  it('setCurrentOperation sets then clears the current_operation label', () => {
    repo.register({ sessionId: 's1' }, T0);
    repo.setCurrentOperation('s1', 'scan', T1);
    expect(repo.getBySessionId('s1')?.current_operation).toBe('scan');

    repo.setCurrentOperation('s1', null, T2);
    expect(repo.getBySessionId('s1')?.current_operation).toBeNull();
  });

  it('end sets a terminal status, ended_at, and clears current_operation', () => {
    repo.register({ sessionId: 's1' }, T0);
    repo.setCurrentOperation('s1', 'index', T0);

    repo.end('s1', 'crashed', T1);
    const row = repo.getBySessionId('s1');
    expect(row?.status).toBe('crashed');
    expect(row?.ended_at).toBe(T1);
    expect(row?.last_activity_at).toBe(T1);
    expect(row?.current_operation).toBeNull();
  });

  it('end defaults to the closed status', () => {
    repo.register({ sessionId: 's1' }, T0);
    repo.end('s1', undefined, T1);
    expect(repo.getBySessionId('s1')?.status).toBe('closed');
  });

  it('markStaleIdle demotes active -> idle, then idle -> disconnected by the two cutoffs', () => {
    // Three sessions with increasing last_activity_at staleness.
    repo.register({ sessionId: 'fresh' }, '2026-06-13T12:00:00.000Z');
    repo.register({ sessionId: 'stale' }, '2026-06-13T11:30:00.000Z');
    repo.register({ sessionId: 'veryStale' }, '2026-06-13T10:00:00.000Z');

    // idleCutoff = 11:45 -> 'stale' and 'veryStale' (activity before it) go idle.
    // disconnectCutoff = 10:30 -> only 'veryStale' (now idle, before it) drops.
    const result = repo.markStaleIdle('2026-06-13T11:45:00.000Z', '2026-06-13T10:30:00.000Z');
    expect(result.idled).toBe(2);
    expect(result.disconnected).toBe(1);

    expect(repo.getBySessionId('fresh')?.status).toBe('active');
    expect(repo.getBySessionId('stale')?.status).toBe('idle');
    expect(repo.getBySessionId('veryStale')?.status).toBe('disconnected');
  });

  it('markStaleIdle disconnect step only affects rows already (or just) idle, not fresh active ones', () => {
    repo.register({ sessionId: 'fresh' }, '2026-06-13T12:00:00.000Z');
    repo.register({ sessionId: 'old' }, '2026-06-13T09:00:00.000Z');

    // Both cutoffs are very recent: 'old' becomes idle then disconnected; 'fresh' stays active.
    const result = repo.markStaleIdle('2026-06-13T11:00:00.000Z', '2026-06-13T11:00:00.000Z');
    expect(result.idled).toBe(1);
    expect(result.disconnected).toBe(1);
    expect(repo.getBySessionId('fresh')?.status).toBe('active');
    expect(repo.getBySessionId('old')?.status).toBe('disconnected');
  });

  it('listActive returns active sessions newest-active-first and excludes ended ones', () => {
    repo.register({ sessionId: 'a' }, '2026-06-13T12:00:00.000Z');
    repo.register({ sessionId: 'b' }, '2026-06-13T12:05:00.000Z');
    repo.register({ sessionId: 'c' }, '2026-06-13T12:10:00.000Z');

    // End one: it must drop out of listActive.
    repo.end('b', 'closed', '2026-06-13T12:20:00.000Z');

    const active = repo.listActive();
    const ids = active.map((s) => s.session_id);
    expect(ids).not.toContain('b');
    // Ordered by last_activity_at DESC: c (12:10) before a (12:00).
    expect(ids).toEqual(['c', 'a']);
    expect(repo.activeCount()).toBe(2);
  });

  it('listRecent returns up to `limit` sessions newest-started-first, including ended ones', () => {
    repo.register({ sessionId: 'a' }, '2026-06-13T12:00:00.000Z');
    repo.register({ sessionId: 'b' }, '2026-06-13T12:05:00.000Z');
    repo.register({ sessionId: 'c' }, '2026-06-13T12:10:00.000Z');
    repo.end('c', 'closed', '2026-06-13T12:30:00.000Z');

    const recent = repo.listRecent(2);
    expect(recent.map((s) => s.session_id)).toEqual(['c', 'b']);
  });

  it('getBySessionId returns undefined for an unknown session', () => {
    expect(repo.getBySessionId('nope')).toBeUndefined();
  });
});
