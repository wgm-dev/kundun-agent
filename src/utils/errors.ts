// Centralized error type and error-code union for Kundun.
// Every domain error should be a KundunError carrying a machine-readable code.

/**
 * Machine-readable error codes used across Kundun.
 * Keep this union the single source of truth for KundunError.code.
 */
export type KundunErrorCode =
  | 'config_not_found'
  | 'config_parse'
  | 'config_invalid'
  | 'path_traversal_blocked'
  | 'symlink_escape'
  | 'storage_locked'
  | 'not_initialized'
  | 'not_found'
  | 'invalid_argument';

/**
 * Base error for all Kundun domain failures.
 * The `code` is a stable identifier callers can switch on without parsing messages.
 */
export class KundunError extends Error {
  constructor(
    public code: KundunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KundunError';
    // Restore prototype chain for reliable `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, KundunError.prototype);
  }
}

/** Narrowing helper for unknown caught values. */
export function isKundunError(value: unknown): value is KundunError {
  return value instanceof KundunError;
}
