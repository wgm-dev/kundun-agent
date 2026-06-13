// `kundun sessions [--limit N]` — list the most recently started client
// sessions (active or historical) as a table, or as JSON with --json. Read-only:
// opens a short-lived AppContext like `summary`, builds the in-process session
// registry over it, and always closes the context in `finally`.

import type { Command } from 'commander';
import pc from 'picocolors';

import { buildSessionRegistry, createAppContext } from '../../core/container.js';
import type { SessionRow } from '../../storage/types.js';
import {
  dim,
  getGlobalOptions,
  parsePositiveInt,
  printJson,
  printLine,
  reportError,
  sectionHeader,
} from '../shared.js';

/** Options accepted by the sessions command. */
interface SessionsOptions {
  limit?: string;
}

/** Default number of sessions to list. */
const DEFAULT_LIMIT = 20;

/** Register `kundun sessions` on the program. */
export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('List recent client sessions')
    .option('--limit <n>', 'maximum number of sessions to show')
    .action((options: SessionsOptions, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        ctx = createAppContext({ projectRoot });
        const limit = parsePositiveInt(options.limit, 'limit') ?? DEFAULT_LIMIT;
        const registry = buildSessionRegistry(ctx);
        const rows = registry.recent(limit);
        if (json) {
          printJson({ ok: true, count: rows.length, sessions: rows });
        } else {
          renderSessions(rows);
        }
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** Render the sessions as a compact human-readable table. */
function renderSessions(rows: SessionRow[]): void {
  printLine(sectionHeader('Sessions'));
  if (rows.length === 0) {
    printLine(`  ${dim('(none)')}`);
    return;
  }
  for (const s of rows) {
    const id = pc.cyan(`#${s.id}`);
    const status = colorStatus(s.status);
    const client = s.client_name ?? dim('(unknown)');
    const transport = s.transport !== null ? dim(`/${s.transport}`) : '';
    const tools = dim(`tools ${s.tools_called}`);
    const errors = s.errors_count > 0 ? pc.red(`errors ${s.errors_count}`) : dim('errors 0');
    const activity = dim(s.last_activity_at ?? s.started_at);
    printLine(`  ${id} ${status} ${client}${transport}  ${tools}  ${errors}  ${activity}`);
  }
}

/** Colorize a session status tag. */
function colorStatus(status: string): string {
  switch (status) {
    case 'active':
      return pc.green(status.padEnd(12));
    case 'idle':
      return pc.yellow(status.padEnd(12));
    case 'disconnected':
    case 'crashed':
      return pc.red(status.padEnd(12));
    default:
      return dim(status.padEnd(12));
  }
}
