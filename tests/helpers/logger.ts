// Test helper: a no-op logger satisfying the Logger interface. Keeps test output
// clean (the real logger writes ndjson to stderr) while still letting engines
// call .child() and the level methods freely.

import type { Logger } from '../../src/utils/logger.js';

/** Create a logger that discards everything. `child()` returns another silent logger. */
export function makeSilentLogger(): Logger {
  const logger: Logger = {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    child(): Logger {
      return logger;
    },
  };
  return logger;
}
