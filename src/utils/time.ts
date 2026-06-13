// Time utilities. The single source of truth for ISO-8601 UTC timestamps.
// All timestamps in the project are produced ONLY by this module.
// Stored as ISO-8601 UTC TEXT (e.g. "2026-06-13T11:00:00.000Z").

/**
 * Current instant as an ISO-8601 UTC string.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Convert a Date to an ISO-8601 UTC string.
 */
export function toIso(d: Date): string {
  return d.toISOString();
}

/**
 * Parse an ISO-8601 string into a Date.
 */
export function parseIso(s: string): Date {
  return new Date(s);
}

/**
 * Add `n` days to an ISO timestamp and return the resulting ISO string.
 * `n` may be negative to subtract days.
 */
export function addDays(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString();
}

/**
 * ISO timestamp for `now - n days`.
 */
export function isoMinusDays(n: number): string {
  return addDays(nowIso(), -n);
}

/**
 * Whole days between two ISO timestamps: floor((b - a) / 1 day).
 */
export function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * Whether an expiry timestamp is in the past relative to `now`.
 * A null/undefined value is treated as "never expires" -> false.
 * Lexicographic comparison of ISO-8601 UTC strings is valid because the
 * fixed-width format orders chronologically.
 */
export function isExpired(value: string | null, now: string = nowIso()): boolean {
  return value != null && value < now;
}

/**
 * Elapsed milliseconds between `startIso` and `endIso` (defaults to now).
 */
export function durationMs(startIso: string, endIso: string = nowIso()): number {
  return new Date(endIso).getTime() - new Date(startIso).getTime();
}
