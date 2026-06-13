// SessionRegistry tests: register returns a generated sessionId and writes a row;
// recordToolCall bumps tools_called and feeds the latency ring; avgToolLatencyMs
// is null when empty and the mean once samples arrive; sweepIdle demotes stale
// sessions through the repository. The clock is injected so timestamps and the
// sweep cutoffs are deterministic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionRegistry } from '../../../src/core/session-registry.js';
import type { SessionRegistry } from '../../../src/core/session-registry.js';
import { SessionRepository } from '../../../src/storage/repositories/session.repository.js';
import { createTestDb, type TestDb } from '../../helpers/test-db.js';
import { makeClock, type TestClock } from '../../helpers/clock.js';

describe('SessionRegistry', () => {
  let t: TestDb;
  let repo: SessionRepository;
  let clock: TestClock;
  let registry: SessionRegistry;

  beforeEach(() => {
    t = createTestDb();
    repo = new SessionRepository(t.kdb);
    clock = makeClock(new Date('2026-06-13T12:00:00.000Z'));
    registry = createSessionRegistry({ sessionRepo: repo, now: () => clock.now() });
  });

  afterEach(() => {
    t.cleanup();
  });

  it('register generates a sessionId and persists an active row stamped with the injected clock', () => {
    const { sessionId } = registry.register({ clientName: 'claude' });
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    const row = repo.getBySessionId(sessionId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('active');
    expect(row?.client_name).toBe('claude');
    expect(row?.started_at).toBe('2026-06-13T12:00:00.000Z');
    expect(registry.activeCount()).toBe(1);
  });

  it('register works with no input and generates distinct ids', () => {
    const a = registry.register();
    const b = registry.register();
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(registry.activeCount()).toBe(2);
  });

  it('recordToolCall increments tools_called and records latency into the ring', () => {
    const { sessionId } = registry.register();
    registry.recordToolCall(sessionId, 10);
    registry.recordToolCall(sessionId, 30);

    expect(repo.getBySessionId(sessionId)?.tools_called).toBe(2);
    // Mean of [10, 30].
    expect(registry.avgToolLatencyMs()).toBe(20);
  });

  it('recordToolCall without a latency still increments the counter but adds no sample', () => {
    const { sessionId } = registry.register();
    registry.recordToolCall(sessionId); // no latency
    expect(repo.getBySessionId(sessionId)?.tools_called).toBe(1);
    expect(registry.avgToolLatencyMs()).toBeNull();
  });

  it('avgToolLatencyMs is null before any latency sample is recorded', () => {
    registry.register();
    expect(registry.avgToolLatencyMs()).toBeNull();
  });

  it('recordError increments the error counter', () => {
    const { sessionId } = registry.register();
    registry.recordError(sessionId);
    registry.recordError(sessionId);
    expect(repo.getBySessionId(sessionId)?.errors_count).toBe(2);
  });

  it('setOperation sets the current operation label', () => {
    const { sessionId } = registry.register();
    registry.setOperation(sessionId, 'scan');
    expect(repo.getBySessionId(sessionId)?.current_operation).toBe('scan');
    registry.setOperation(sessionId, null);
    expect(repo.getBySessionId(sessionId)?.current_operation).toBeNull();
  });

  it('end transitions the session out of the active set', () => {
    const { sessionId } = registry.register();
    expect(registry.activeCount()).toBe(1);
    registry.end(sessionId);
    expect(repo.getBySessionId(sessionId)?.status).toBe('closed');
    expect(registry.activeCount()).toBe(0);
  });

  it('sweepIdle demotes active -> idle -> disconnected using cutoffs derived from the injected now', () => {
    // Register at the anchor, then register an older one, then advance the clock
    // so both look stale relative to `now`.
    const fresh = registry.register();

    // Move the clock back to register a stale session, then forward again.
    clock.set(new Date('2026-06-13T10:00:00.000Z'));
    const stale = registry.register();
    clock.set(new Date('2026-06-13T12:00:00.000Z'));

    // idleAfter 30min -> cutoff 11:30; disconnectAfter 90min -> cutoff 10:30.
    // 'fresh' (12:00) stays active; 'stale' (10:00) is before both cutoffs.
    registry.sweepIdle(30 * 60 * 1000, 90 * 60 * 1000);

    expect(repo.getBySessionId(fresh.sessionId)?.status).toBe('active');
    expect(repo.getBySessionId(stale.sessionId)?.status).toBe('disconnected');
  });

  it('list reflects active sessions and recent includes ended ones', () => {
    const a = registry.register();
    const b = registry.register();
    registry.end(b.sessionId);

    expect(registry.list().map((s) => s.session_id)).toContain(a.sessionId);
    expect(registry.list().map((s) => s.session_id)).not.toContain(b.sessionId);
    expect(registry.recent(10).map((s) => s.session_id)).toEqual(
      expect.arrayContaining([a.sessionId, b.sessionId]),
    );
  });
});
