// EventBus history tests (MVP3 ring buffer). history() is newest-LAST, recent()
// is newest-FIRST, the ring caps at historyLimit (dropping the oldest), and
// emitting still dispatches to listeners alongside recording history. Clocks are
// injected so the `at` field is deterministic. This file does NOT touch the
// existing event-bus.test.ts behavioural suite.

import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../../../src/core/event-bus.js';

/**
 * A monotonically increasing clock so each emitted event has a distinct,
 * ordered `at` timestamp (one second apart starting at the anchor).
 */
function makeSteppingClock(startMs = Date.parse('2026-06-13T12:00:00.000Z')) {
  let current = startMs;
  return (): string => {
    const iso = new Date(current).toISOString();
    current += 1000;
    return iso;
  };
}

describe('EventBus history', () => {
  it('history() returns events newest-LAST (chronological order)', () => {
    const bus = createEventBus(makeSteppingClock());
    bus.emit('scan.started');
    bus.emit('scan.progress', { pct: 50 });
    bus.emit('scan.completed');

    const hist = bus.history();
    expect(hist.map((e) => e.type)).toEqual(['scan.started', 'scan.progress', 'scan.completed']);
    // Newest is the last entry.
    expect(hist[hist.length - 1]?.type).toBe('scan.completed');
  });

  it('recent() returns events newest-FIRST (reverse-chronological order)', () => {
    const bus = createEventBus(makeSteppingClock());
    bus.emit('scan.started');
    bus.emit('scan.progress');
    bus.emit('scan.completed');

    const rec = bus.recent();
    expect(rec.map((e) => e.type)).toEqual(['scan.completed', 'scan.progress', 'scan.started']);
    expect(rec[0]?.type).toBe('scan.completed');
  });

  it('history(limit) returns the last `limit` events, still newest-LAST', () => {
    const bus = createEventBus(makeSteppingClock());
    bus.emit('scan.started');
    bus.emit('scan.progress');
    bus.emit('scan.completed');

    expect(bus.history(2).map((e) => e.type)).toEqual(['scan.progress', 'scan.completed']);
  });

  it('recent(limit) returns the `limit` most recent events, newest-FIRST', () => {
    const bus = createEventBus(makeSteppingClock());
    bus.emit('scan.started');
    bus.emit('scan.progress');
    bus.emit('scan.completed');

    expect(bus.recent(2).map((e) => e.type)).toEqual(['scan.completed', 'scan.progress']);
  });

  it('the ring caps at historyLimit, dropping the oldest events', () => {
    const bus = createEventBus(makeSteppingClock(), { historyLimit: 3 });
    bus.emit('scan.started'); // 0 - dropped
    bus.emit('scan.progress'); // 1 - dropped
    bus.emit('scan.completed'); // 2
    bus.emit('memory.created'); // 3
    bus.emit('task.created'); // 4

    const hist = bus.history();
    expect(hist).toHaveLength(3);
    // Oldest two were evicted; the three newest remain in order.
    expect(hist.map((e) => e.type)).toEqual(['scan.completed', 'memory.created', 'task.created']);
  });

  it('emitting still dispatches to listeners while recording history', () => {
    const bus = createEventBus(makeSteppingClock());
    const direct = vi.fn();
    const wildcard = vi.fn();
    bus.on('memory.created', direct);
    bus.on('*', wildcard);

    bus.emit('memory.created', { id: 1 });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(wildcard).toHaveBeenCalledTimes(1);
    // And the same event is in history.
    expect(bus.history()).toHaveLength(1);
    expect(bus.history()[0]?.data).toEqual({ id: 1 });
  });

  it('history(0) returns an empty array and history() returns a fresh (safe-to-mutate) copy', () => {
    const bus = createEventBus(makeSteppingClock());
    bus.emit('scan.started');

    expect(bus.history(0)).toEqual([]);

    const copy = bus.history();
    copy.push({ type: 'task.updated', at: 'x' });
    // Mutating the returned array must not affect the bus's internal buffer.
    expect(bus.history()).toHaveLength(1);
  });

  it('defaults to a 500-event history limit', () => {
    const clock = makeSteppingClock();
    const bus = createEventBus(clock);
    for (let i = 0; i < 600; i += 1) {
      bus.emit('scan.progress', { i });
    }
    expect(bus.history()).toHaveLength(500);
    // The oldest retained event is the 100th emitted (indices 100..599).
    expect(bus.history()[0]?.data).toEqual({ i: 100 });
    expect(bus.history()[499]?.data).toEqual({ i: 599 });
  });
});
