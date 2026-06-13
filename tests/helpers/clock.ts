// Test helper: a controllable clock that produces ISO-8601 UTC strings, matching
// the contract of utils/time.nowIso(). Engines accept a `now: () => string`
// dependency; inject one of these to make time-dependent behavior deterministic.

/** A mutable clock for tests. `now()` returns the current ISO instant. */
export interface TestClock {
  now(): string;
  /** Replace the current instant with the given Date. */
  set(when: Date): void;
  /** Advance the clock by `ms` milliseconds. */
  advanceMs(ms: number): void;
  /** Advance the clock by `days` days. */
  advanceDays(days: number): void;
}

/** Create a clock anchored at `start` (defaults to a fixed reference instant). */
export function makeClock(start: Date = new Date('2026-06-13T12:00:00.000Z')): TestClock {
  let current = start.getTime();
  return {
    now(): string {
      return new Date(current).toISOString();
    },
    set(when: Date): void {
      current = when.getTime();
    },
    advanceMs(ms: number): void {
      current += ms;
    },
    advanceDays(days: number): void {
      current += days * 86_400_000;
    },
  };
}
