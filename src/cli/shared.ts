// Shared CLI helpers: global-option access, output formatting (human vs JSON),
// argument parsing/coercion, and consistent error handling. Keeps stdout clean
// for data (the logger writes to stderr) so `--json` output is machine-parsable.

import process from 'node:process';

import type { Command } from 'commander';
import pc from 'picocolors';

import { isKundunError } from '../utils/errors.js';

/** Global options shared by every command, read via optsWithGlobals(). */
export interface GlobalOptions {
  projectRoot: string;
  json: boolean;
}

/**
 * Read the global `--project-root` / `--json` options merged with the command's
 * own options. Defaults projectRoot to the current working directory.
 */
export function getGlobalOptions(command: Command): GlobalOptions {
  const opts = command.optsWithGlobals<{ projectRoot?: string; json?: boolean }>();
  return {
    projectRoot: opts.projectRoot ?? process.cwd(),
    json: opts.json ?? false,
  };
}

/** Write a single machine-readable JSON line to stdout. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Write a plain line of human output to stdout. */
export function printLine(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Parse a comma-separated option value into a trimmed, non-empty string list.
 * Returns undefined when the value is absent so callers can omit optional keys
 * (exactOptionalPropertyTypes-friendly).
 */
export function parseCommaList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Coerce a CLI numeric option to a positive integer. Throws an Error when the
 * value is not a valid integer >= 1 so the top-level handler reports it.
 */
export function parsePositiveInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label} "${value}": expected a positive integer.`);
  }
  return parsed;
}

/**
 * Coerce a CLI numeric option to an integer in an inclusive range. Throws an
 * Error when out of range so the top-level handler reports it.
 */
export function parseIntInRange(
  value: string | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${label} "${value}": expected an integer between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * Report an error to stderr and set a failing exit code. Gives a friendly hint
 * to run `kundun init` for the not_initialized case; otherwise prints the
 * error message. Keeps stdout untouched so `--json` consumers see nothing.
 */
export function reportError(err: unknown): void {
  if (isKundunError(err) && err.code === 'not_initialized') {
    process.stderr.write(`${pc.red(err.message)}\n`);
    process.stderr.write(`${pc.yellow('Hint:')} run \`kundun init\` to set up this project.\n`);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${pc.red('Error:')} ${message}\n`);
  }
  process.exitCode = 1;
}

/** A header line for a human-readable section. */
export function sectionHeader(title: string): string {
  return pc.bold(pc.cyan(title));
}

/** Dim helper for secondary text (re-exported so commands import one place). */
export const dim = pc.dim;
