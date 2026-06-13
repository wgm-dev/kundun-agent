// Importance scoring (D5). A single 0..100 INTEGER scale shared by the memory,
// cleanup, and indexer subsystems. Defined ONCE here; everyone imports from
// '../core/importance.js'. Pure functions only; no I/O.

import type { SupportedLanguage } from '../storage/types.js';

/** Memories/files at or above this score are treated as "important". */
export const HIGH_IMPORTANCE_THRESHOLD = 80;

/** Inclusive lower bound of the importance scale. */
export const MIN_IMPORTANCE = 0;

/** Inclusive upper bound of the importance scale. */
export const MAX_IMPORTANCE = 100;

/** Amount added on a promotion event. */
export const PROMOTE_STEP = 10;

/** Amount subtracted on a demotion event. */
export const DEMOTE_STEP = 10;

/**
 * Clamp an arbitrary number into the [MIN_IMPORTANCE, MAX_IMPORTANCE] range and
 * round to an integer. Non-finite input falls back to MIN_IMPORTANCE.
 */
export function clampImportance(n: number): number {
  if (!Number.isFinite(n)) {
    return MIN_IMPORTANCE;
  }
  const rounded = Math.round(n);
  if (rounded < MIN_IMPORTANCE) {
    return MIN_IMPORTANCE;
  }
  if (rounded > MAX_IMPORTANCE) {
    return MAX_IMPORTANCE;
  }
  return rounded;
}

/** Raise a score by PROMOTE_STEP, clamped to the valid range. */
export function promote(n: number): number {
  return clampImportance(n + PROMOTE_STEP);
}

/** Lower a score by DEMOTE_STEP, clamped to the valid range. */
export function demote(n: number): number {
  return clampImportance(n - DEMOTE_STEP);
}

// Path keyword groups (lowercased) used by computeFileImportance. Matching is by
// substring against the lowercased relative path, so directory- and file-name
// hints both contribute.

/** High-value keywords: core domain, security, and other load-bearing code. */
const HIGH_KEYWORDS: readonly string[] = [
  'controller',
  'service',
  'repository',
  'route',
  'middleware',
  'migration',
  'schema',
  'auth',
  'payment',
  'security',
  'domain',
  'test',
  'spec',
  'config',
];

/** Low-value keywords: generated, vendored, or otherwise disposable artifacts. */
const LOW_KEYWORDS: readonly string[] = [
  'asset',
  'generated',
  '.min.',
  'lock',
  'snapshot',
  'dist/',
  'build/',
  'cache',
  'log',
  'node_modules',
  'vendor',
  '.css',
  '.map',
];

const HIGH_SCORE = 80;
const LOW_SCORE = 10;
const DEFAULT_SCORE = 40;

/**
 * Heuristic file-importance score (README §12). Uses lowercased path-keyword
 * matching. Low-value artifacts win over high-value hints (e.g. a generated,
 * minified bundle stays low even if its name contains "service"). SQL files are
 * nudged toward the high band since they are typically schema/migrations.
 * Returns an integer in [0, 100].
 */
export function computeFileImportance(
  relativePath: string,
  language: SupportedLanguage | null,
): number {
  const path = relativePath.toLowerCase();

  // Disposable artifacts take precedence: never rank generated/vendored high.
  for (const kw of LOW_KEYWORDS) {
    if (path.includes(kw)) {
      return clampImportance(LOW_SCORE);
    }
  }

  for (const kw of HIGH_KEYWORDS) {
    if (path.includes(kw)) {
      return clampImportance(HIGH_SCORE);
    }
  }

  // SQL outside the keyword hits is still usually schema-relevant.
  if (language === 'sql') {
    return clampImportance(HIGH_SCORE - 10);
  }

  return clampImportance(DEFAULT_SCORE);
}
