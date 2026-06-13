// `kundun restart` — ask a running daemon to reload in-process via the local API
// (POST /mcp/restart with the Bearer token). When no daemon is running, print
// that fact and exit cleanly. Read-only with respect to the database: opens a
// short-lived AppContext like `summary` (for the runtime dir + token + config)
// and closes it in `finally`. The HTTP call is the only async work.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import type { Command } from 'commander';
import pc from 'picocolors';

import { createAppContext } from '../../core/container.js';
import type { AppContext } from '../../core/container.js';
import { createTokenStore } from '../../api/auth.js';
import { getGlobalOptions, printJson, printLine, reportError } from '../shared.js';

/** Daemon coordinates read from the pid file. */
interface DaemonTarget {
  pid: number;
  host: string;
  port: number;
}

/** Register `kundun restart` on the program. */
export function registerRestartCommand(program: Command): void {
  program
    .command('restart')
    .description('Ask a running daemon to reload its configuration in-process')
    .action(async (_options: unknown, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx: AppContext | undefined;
      try {
        ctx = createAppContext({ projectRoot });
        await runRestart(ctx, json);
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** Read the daemon pid file into a target, or undefined when absent/malformed. */
function readDaemonTarget(pidPath: string): DaemonTarget | undefined {
  if (!existsSync(pidPath)) {
    return undefined;
  }
  let parsed: Partial<DaemonTarget>;
  try {
    parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as Partial<DaemonTarget>;
  } catch {
    return undefined;
  }
  if (
    typeof parsed.pid !== 'number' ||
    typeof parsed.host !== 'string' ||
    typeof parsed.port !== 'number'
  ) {
    return undefined;
  }
  return { pid: parsed.pid, host: parsed.host, port: parsed.port };
}

/** Whether a pid identifies a live process (signal 0 probe; never kills). */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Core restart flow: probe the daemon, POST /mcp/restart with the token. */
async function runRestart(ctx: AppContext, json: boolean): Promise<void> {
  const runtimeDir = join(ctx.kundunDir, 'runtime');
  const target = readDaemonTarget(join(runtimeDir, 'daemon.pid'));

  if (target === undefined || !isProcessAlive(target.pid)) {
    if (json) {
      printJson({ ok: true, restarted: false, reason: 'no daemon running' });
    } else {
      printLine(pc.yellow('No daemon is running.'));
    }
    return;
  }

  const tokenStore = createTokenStore({ runtimeDir, logger: ctx.logger });
  const token = tokenStore.getToken();
  const url = `http://${target.host}:${target.port}/mcp/restart`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });

  // The route returns 200 with {restarted:boolean,...} when allowed, or 403 when
  // config.allowRestartFromMcp is false. Surface the body either way.
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (json) {
    printJson({ ok: response.ok, status: response.status, response: payload });
    return;
  }

  if (response.status === 403) {
    printLine(
      pc.red('Restart refused: ') +
        'restart-from-MCP is disabled (config.allowRestartFromMcp = false).',
    );
    return;
  }

  if (response.ok && payload['restarted'] === true) {
    printLine(pc.green('Daemon reloaded.'));
    return;
  }

  const reason = typeof payload['reason'] === 'string' ? payload['reason'] : 'unknown';
  printLine(pc.yellow(`Daemon did not restart (${reason}).`));
}
