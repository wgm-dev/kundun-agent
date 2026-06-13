// Structured ndjson logger.
// - Always writes one JSON object per line to process.stderr (stdout stays clean for CLI output).
// - Optionally appends the same lines to {logDir}/kundun-YYYY-MM-DD.log.
// - Level filtering: debug < info < warn < error (default 'info').
// SECURITY: never log raw file content bodies; only metadata about files.

import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './time.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(namespace: string): Logger;
}

export interface LoggerOptions {
  logDir?: string;
  level?: LogLevel;
  namespace?: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Build the daily log filename for a given date (defaults to now). */
function logFileName(date = new Date()): string {
  // Use the UTC date portion of the ISO string to keep filenames stable across timezones.
  const iso = date.toISOString();
  const day = iso.slice(0, 10); // YYYY-MM-DD
  return `kundun-${day}.log`;
}

/** Return existing kundun-*.log filenames in logDir (empty if dir missing/unreadable). */
export function getLogFiles(logDir: string): string[] {
  try {
    return readdirSync(logDir)
      .filter((name) => name.startsWith('kundun-') && name.endsWith('.log'))
      .sort();
  } catch {
    return [];
  }
}

/** Append a line to today's log file, creating logDir if needed. Swallows all fs errors. */
function appendToLogFile(logDir: string, line: string): void {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, logFileName()), line);
  } catch {
    // Logging must never throw; ignore fs failures (read-only dir, quota, etc.).
  }
}

/**
 * Create a logger. The returned logger and any children share the same options
 * except for the namespace, which children extend with a dotted suffix.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level: LogLevel = opts.level ?? 'info';
  const threshold = LEVEL_ORDER[level];
  const namespace = opts.namespace;
  const logDir = opts.logDir;

  function emit(entryLevel: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[entryLevel] < threshold) return;

    const record: Record<string, unknown> = {
      ts: nowIso(),
      level: entryLevel,
      msg,
    };
    if (namespace !== undefined) record['ns'] = namespace;
    if (meta !== undefined) record['meta'] = meta;

    const line = `${JSON.stringify(record)}\n`;

    // Always to stderr; stdout is reserved for user-facing CLI output.
    process.stderr.write(line);

    if (logDir !== undefined) appendToLogFile(logDir, line);
  }

  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child(childNamespace: string): Logger {
      const nextNamespace =
        namespace !== undefined ? `${namespace}.${childNamespace}` : childNamespace;
      // Spread base options, then override namespace. exactOptionalPropertyTypes:
      // only include logDir/level keys when defined.
      const childOpts: LoggerOptions = { namespace: nextNamespace };
      if (logDir !== undefined) childOpts.logDir = logDir;
      childOpts.level = level;
      return createLogger(childOpts);
    },
  };
}
