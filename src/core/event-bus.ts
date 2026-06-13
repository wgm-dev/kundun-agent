// Tiny in-memory event bus (README §23). No external dependencies.
// Listeners are stored per event type plus a wildcard ('*') bucket. Emitting
// builds a payload and invokes matching listeners; a throwing listener is
// isolated in try/catch so it never breaks the emit loop or sibling listeners.

import { nowIso } from '../utils/time.js';

/**
 * The set of event names the bus understands, as a string-literal union.
 */
export type KundunEvent =
  | 'session.started'
  | 'session.ended'
  | 'scan.started'
  | 'scan.progress'
  | 'scan.completed'
  | 'scan.failed'
  | 'index.started'
  | 'index.progress'
  | 'index.completed'
  | 'index.failed'
  | 'diagnostics.started'
  | 'diagnostics.completed'
  | 'cleanup.started'
  | 'cleanup.completed'
  | 'memory.created'
  | 'memory.updated'
  | 'task.created'
  | 'task.updated'
  | 'session.heartbeat'
  | 'health.warning'
  | 'health.error';

/**
 * A single emitted event: its type, an ISO-8601 UTC timestamp, and optional data.
 */
export interface EventPayload {
  type: KundunEvent;
  at: string;
  data?: Record<string, unknown>;
}

/**
 * The public bus surface: emit events and subscribe to them.
 * `on` returns an unsubscribe function; subscribing to '*' receives every event.
 */
export interface EventBus {
  emit(type: KundunEvent, data?: Record<string, unknown>): void;
  on(type: KundunEvent | '*', handler: (e: EventPayload) => void): () => void;
  /**
   * Return up to `limit` of the most recently emitted events in chronological
   * order (newest LAST). Returns a fresh copied array; mutating it is safe.
   * Omitting `limit` returns the whole retained history (capped at historyLimit).
   */
  history(limit?: number): EventPayload[];
  /**
   * Alias of {@link history} but newest-FIRST: up to `limit` of the most
   * recently emitted events in reverse-chronological order (newest at index 0).
   * Returns a fresh copied array; mutating it is safe.
   */
  recent(limit?: number): EventPayload[];
}

type Handler = (e: EventPayload) => void;

/**
 * Create an in-memory event bus. `now` injects the timestamp source (defaults to
 * `nowIso`) so callers/tests can control the `at` field. `opts.historyLimit`
 * bounds the ring buffer of retained events (defaults to 500). The existing
 * no-arg call `createEventBus()` keeps working with these defaults.
 */
export function createEventBus(
  now: () => string = nowIso,
  opts?: { historyLimit?: number },
): EventBus {
  const listeners = new Map<KundunEvent | '*', Set<Handler>>();
  const historyLimit = opts?.historyLimit ?? 500;
  // Bounded ring buffer of emitted payloads, oldest first. Capped at
  // historyLimit by dropping the oldest entry once the cap is exceeded.
  const buffer: EventPayload[] = [];

  function history(limit?: number): EventPayload[] {
    if (limit === undefined || limit >= buffer.length) {
      return buffer.slice();
    }
    if (limit <= 0) {
      return [];
    }
    // Newest-LAST: take the last `limit` entries, preserving chronological order.
    return buffer.slice(buffer.length - limit);
  }

  function recent(limit?: number): EventPayload[] {
    // Newest-FIRST: reverse the chronological slice.
    return history(limit).reverse();
  }

  function on(type: KundunEvent | '*', handler: Handler): () => void {
    let handlers = listeners.get(type);
    if (handlers === undefined) {
      handlers = new Set<Handler>();
      listeners.set(type, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  function emit(type: KundunEvent, data?: Record<string, unknown>): void {
    // Omit `data` entirely when undefined to respect exactOptionalPropertyTypes.
    const payload: EventPayload =
      data === undefined ? { type, at: now() } : { type, at: now(), data };
    // Push into the bounded ring buffer BEFORE dispatch; drop oldest past cap.
    buffer.push(payload);
    if (buffer.length > historyLimit) {
      buffer.shift();
    }
    // Snapshot to tolerate listeners that subscribe/unsubscribe during dispatch.
    const matching = [...(listeners.get(type) ?? []), ...(listeners.get('*') ?? [])];
    for (const handler of matching) {
      try {
        handler(payload);
      } catch {
        // A throwing listener must not break emit or sibling listeners.
      }
    }
  }

  return { emit, on, history, recent };
}
