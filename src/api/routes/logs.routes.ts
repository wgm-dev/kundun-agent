// GET /logs (TOKEN-required). Lists the daemon's daily log files and returns the
// tail of the most recent one. There is NO client-supplied path input: the log
// directory is fixed at `<kundunDir>/logs` and only `kundun-*.log` files are ever
// read (via the logger's getLogFiles allowlist), so this endpoint cannot be used
// to read arbitrary files. The tail is capped to a fixed number of lines.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getLogFiles } from '../../utils/logger.js';
import { jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';

/** Maximum number of trailing log lines returned in the tail. */
const MAX_TAIL_LINES = 500;

/**
 * Read the last `maxLines` lines of a UTF-8 text file. Returns an empty array
 * when the file is missing/unreadable so a transient log-rotation race never
 * fails the request.
 */
function tailLines(absPath: string, maxLines: number): string[] {
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  // Split on LF; drop a single trailing empty element produced by a final newline.
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
}

/** Build the GET /logs route. */
export function buildLogsRoutes(rc: RouteContext): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/logs',
      policy: 'token',
      handler: (_req, res) => {
        const logDir = join(rc.ctx.kundunDir, 'logs');
        // getLogFiles returns sorted, allowlisted kundun-*.log names (or []).
        const files = getLogFiles(logDir);
        const latest = files.length > 0 ? files[files.length - 1] : undefined;
        const tail = latest === undefined ? [] : tailLines(join(logDir, latest), MAX_TAIL_LINES);
        jsonOk(res, 200, {
          files,
          latest: latest ?? null,
          maxLines: MAX_TAIL_LINES,
          tail,
        });
      },
    },
  ];
}
