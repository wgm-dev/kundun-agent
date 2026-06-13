// `kundun logs [--lines N]` — tail the most recent daemon log file
// (`<kundunDir>/logs/kundun-YYYY-MM-DD.log`). Each line is ndjson; in human mode
// we print them verbatim (newest at the bottom), and with --json we emit the tail
// as an array of parsed records (falling back to a raw string for any bad line).
// Read-only: opens a short-lived AppContext like `summary` and closes it in
// `finally`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { createAppContext } from '../../core/container.js';
import { getLogFiles } from '../../utils/logger.js';
import {
  dim,
  getGlobalOptions,
  parsePositiveInt,
  printJson,
  printLine,
  reportError,
  sectionHeader,
} from '../shared.js';

/** Options accepted by the logs command. */
interface LogsOptions {
  lines?: string;
}

/** Default number of trailing lines to show. */
const DEFAULT_LINES = 50;

/** Register `kundun logs` on the program. */
export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Tail the most recent daemon log file')
    .option('--lines <n>', 'number of trailing lines to show')
    .action((options: LogsOptions, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        ctx = createAppContext({ projectRoot });
        const count = parsePositiveInt(options.lines, 'lines') ?? DEFAULT_LINES;
        const logDir = join(ctx.kundunDir, 'logs');
        const tail = tailLatestLog(logDir, count);

        if (json) {
          printJson({
            ok: true,
            file: tail.file,
            lines: tail.lines.map(parseLogLine),
          });
        } else {
          renderLogs(tail.file, tail.lines);
        }
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** The last `count` lines of the newest log file, plus its name (null if none). */
function tailLatestLog(logDir: string, count: number): { file: string | null; lines: string[] } {
  const files = getLogFiles(logDir);
  // getLogFiles sorts ascending by name (date), so the newest is last.
  const latest = files[files.length - 1];
  if (latest === undefined) {
    return { file: null, lines: [] };
  }
  let content: string;
  try {
    content = readFileSync(join(logDir, latest), 'utf8');
  } catch {
    return { file: latest, lines: [] };
  }
  const allLines = content.split('\n').filter((line) => line.length > 0);
  const start = Math.max(0, allLines.length - count);
  return { file: latest, lines: allLines.slice(start) };
}

/** Parse one ndjson log line; fall back to a raw wrapper for malformed input. */
function parseLogLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { raw: line };
  }
}

/** Render the tail in human mode (verbatim ndjson, newest at the bottom). */
function renderLogs(file: string | null, lines: string[]): void {
  if (file === null) {
    printLine(sectionHeader('Logs'));
    printLine(`  ${dim('(no log files found)')}`);
    return;
  }
  printLine(sectionHeader(`Logs — ${file}`));
  if (lines.length === 0) {
    printLine(`  ${dim('(empty)')}`);
    return;
  }
  for (const line of lines) {
    printLine(line);
  }
}
