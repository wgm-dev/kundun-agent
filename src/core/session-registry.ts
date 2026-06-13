// Session registry (MVP3). In-process orchestration over SessionRepository:
// generates session ids, tracks a rolling tool-latency ring (last 100 samples),
// and exposes lifecycle/inspection methods used by the daemon and metrics engine.
// better-sqlite3 is synchronous, so nothing here is async. All timestamps come
// from utils/time.ts (caller may inject `now` so the engine's single clock wins).

import { randomUUID } from 'node:crypto';
import type {
  RegisterSessionInput,
  SessionRepository,
} from '../storage/repositories/session.repository.js';
import type { SessionRow, SessionStatus } from '../storage/types.js';
import type { EventBus } from './event-bus.js';
import { nowIso } from '../utils/time.js';

/** Maximum number of latency samples kept in the rolling ring. */
const LATENCY_RING_SIZE = 100;

/**
 * Input accepted by {@link SessionRegistry.register}. The `sessionId` is assigned
 * by the registry (via crypto.randomUUID), so callers supply only client metadata.
 */
export type RegisterInput = Omit<RegisterSessionInput, 'sessionId'>;

/** Dependencies for {@link createSessionRegistry}. */
export interface SessionRegistryDeps {
  sessionRepo: SessionRepository;
  now?: () => string;
  eventBus?: EventBus;
}

/** Public surface of the session registry. */
export interface SessionRegistry {
  register(input?: RegisterInput): { sessionId: string };
  heartbeat(sessionId: string): void;
  recordToolCall(sessionId: string, latencyMs?: number): void;
  recordError(sessionId: string): void;
  setOperation(sessionId: string, op: string | null): void;
  end(sessionId: string, status?: SessionStatus): void;
  sweepIdle(idleAfterMs: number, disconnectAfterMs: number): void;
  list(): SessionRow[];
  recent(limit: number): SessionRow[];
  activeCount(): number;
  avgToolLatencyMs(): number | null;
}

/**
 * Create a session registry over the given repository. `now` injects the
 * timestamp source (defaults to {@link nowIso}); `eventBus`, when provided, emits
 * session lifecycle events.
 */
export function createSessionRegistry(deps: SessionRegistryDeps): SessionRegistry {
  const { sessionRepo, eventBus } = deps;
  const now = deps.now ?? nowIso;

  // Rolling ring of recent tool-call latencies (ms), newest appended at the end.
  // Bounded to LATENCY_RING_SIZE; the oldest sample is dropped once full.
  const latencyRing: number[] = [];

  function pushLatency(latencyMs: number): void {
    latencyRing.push(latencyMs);
    if (latencyRing.length > LATENCY_RING_SIZE) {
      latencyRing.shift();
    }
  }

  function register(input: RegisterInput = {}): { sessionId: string } {
    const sessionId = randomUUID();
    sessionRepo.register({ ...input, sessionId }, now());
    eventBus?.emit('session.started', { sessionId });
    return { sessionId };
  }

  function heartbeat(sessionId: string): void {
    sessionRepo.heartbeat(sessionId, now());
  }

  function recordToolCall(sessionId: string, latencyMs?: number): void {
    const iso = now();
    sessionRepo.incrementToolCall(sessionId, iso);
    if (latencyMs !== undefined) {
      pushLatency(latencyMs);
    }
    sessionRepo.heartbeat(sessionId, iso);
  }

  function recordError(sessionId: string): void {
    sessionRepo.incrementError(sessionId, now());
  }

  function setOperation(sessionId: string, op: string | null): void {
    sessionRepo.setCurrentOperation(sessionId, op, now());
  }

  function end(sessionId: string, status: SessionStatus = 'closed'): void {
    sessionRepo.end(sessionId, status, now());
    eventBus?.emit('session.ended', { sessionId, status });
  }

  function sweepIdle(idleAfterMs: number, disconnectAfterMs: number): void {
    const nowMs = new Date(now()).getTime();
    const idleCutoffIso = new Date(nowMs - idleAfterMs).toISOString();
    const disconnectCutoffIso = new Date(nowMs - disconnectAfterMs).toISOString();
    sessionRepo.markStaleIdle(idleCutoffIso, disconnectCutoffIso);
  }

  function list(): SessionRow[] {
    return sessionRepo.listActive();
  }

  function recent(limit: number): SessionRow[] {
    return sessionRepo.listRecent(limit);
  }

  function activeCount(): number {
    return sessionRepo.activeCount();
  }

  function avgToolLatencyMs(): number | null {
    if (latencyRing.length === 0) {
      return null;
    }
    const sum = latencyRing.reduce((acc, ms) => acc + ms, 0);
    return sum / latencyRing.length;
  }

  return {
    register,
    heartbeat,
    recordToolCall,
    recordError,
    setOperation,
    end,
    sweepIdle,
    list,
    recent,
    activeCount,
    avgToolLatencyMs,
  };
}
