import { describe, expect, it, vi } from 'vitest';

import { createEventBus } from '../../../src/core/event-bus.js';
import type { EventPayload } from '../../../src/core/event-bus.js';

describe('EventBus', () => {
  it('invokes listeners that match the emitted type', () => {
    const bus = createEventBus();
    const received: EventPayload[] = [];
    bus.on('scan.started', (e) => {
      received.push(e);
    });

    bus.emit('scan.started', { scanId: 7 });

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('scan.started');
    expect(received[0]?.data).toEqual({ scanId: 7 });
  });

  it('does not invoke listeners for a non-matching type', () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on('scan.completed', handler);

    bus.emit('scan.started');

    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes wildcard ('*') listeners for every emitted type", () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.on('*', (e) => {
      seen.push(e.type);
    });

    bus.emit('scan.started');
    bus.emit('memory.created', { id: 1 });
    bus.emit('task.updated', { id: 2 });

    expect(seen).toEqual(['scan.started', 'memory.created', 'task.updated']);
  });

  it('invokes both the matching listener and the wildcard listener for one emit', () => {
    const bus = createEventBus();
    const direct = vi.fn();
    const wildcard = vi.fn();
    bus.on('diagnostics.completed', direct);
    bus.on('*', wildcard);

    bus.emit('diagnostics.completed', { findings: 3 });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(wildcard).toHaveBeenCalledTimes(1);
  });

  it('every payload carries a type and an ISO-8601 `at` timestamp', () => {
    // Inject a deterministic clock to assert the exact `at` value.
    const fixed = '2026-06-13T12:00:00.000Z';
    const bus = createEventBus(() => fixed);
    let payload: EventPayload | undefined;
    bus.on('*', (e) => {
      payload = e;
    });

    bus.emit('cleanup.completed');

    expect(payload).toBeDefined();
    expect(payload?.type).toBe('cleanup.completed');
    expect(payload?.at).toBe(fixed);
    // With no data argument, the optional `data` key is omitted entirely.
    expect(payload && 'data' in payload).toBe(false);
  });

  it('unsubscribe stops further delivery to that listener', () => {
    const bus = createEventBus();
    const handler = vi.fn();
    const off = bus.on('memory.created', handler);

    bus.emit('memory.created', { id: 1 });
    off();
    bus.emit('memory.created', { id: 2 });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not break emit or stop sibling listeners', () => {
    const bus = createEventBus();
    const after = vi.fn();
    bus.on('health.error', () => {
      throw new Error('listener boom');
    });
    bus.on('health.error', after);

    // The throwing listener is isolated; emit must not propagate the error.
    expect(() => bus.emit('health.error', { reason: 'x' })).not.toThrow();
    // The sibling listener still runs.
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('supports multiple listeners on the same type, each invoked once', () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('task.created', a);
    bus.on('task.created', b);

    bus.emit('task.created', { id: 9 });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
