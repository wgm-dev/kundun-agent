// In-process "operation in progress" guard shared by the mutating POST routes
// (/scan and /cleanup). The local server is a single process and better-sqlite3
// serializes writes, but a long scan and a cleanup must not interleave, so both
// routes acquire the SAME lock instance and a second concurrent attempt gets a
// 409 instead of running. The lock is process-local (one daemon) and is created
// once per server in buildRoutes-adjacent wiring (see local-server.ts).

/** A simple non-reentrant busy flag with the name of the in-flight operation. */
export interface OperationLock {
  /**
   * Try to begin `operation`. Returns true and marks the lock busy when it was
   * free; returns false (without changing state) when something is already
   * running. Callers that get true MUST call {@link release} in a finally block.
   */
  tryAcquire(operation: string): boolean;
  /** Release the lock. Safe to call even if not held (no-op when already free). */
  release(): void;
  /** The name of the currently-running operation, or null when idle. */
  current(): string | null;
}

/** Create a fresh, idle operation lock. */
export function createOperationLock(): OperationLock {
  let running: string | null = null;

  return {
    tryAcquire(operation: string): boolean {
      if (running !== null) {
        return false;
      }
      running = operation;
      return true;
    },
    release(): void {
      running = null;
    },
    current(): string | null {
      return running;
    },
  };
}
