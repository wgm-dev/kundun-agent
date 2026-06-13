// `kundun status` — a compact, at-a-glance snapshot: daemon liveness (from the
// pid file), the active session count, a one-line health summary (component
// states + 24h errors), and the latest persisted metrics snapshot. Read-only:
// opens a short-lived AppContext like `summary` and closes it in `finally`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import type { Command } from 'commander';
import pc from 'picocolors';

import {
  buildHealthMonitor,
  buildSessionRegistry,
  createAppContext,
} from '../../core/container.js';
import type { ComponentStatus, HealthReport } from '../../core/health-monitor.js';
import type { MetricsSnapshotRow } from '../../storage/types.js';
import {
  dim,
  getGlobalOptions,
  printJson,
  printLine,
  reportError,
  sectionHeader,
} from '../shared.js';

/** Daemon liveness, derived from the pid file + a signal-0 probe. */
interface DaemonStatus {
  running: boolean;
  pid: number | null;
  host: string | null;
  port: number | null;
  startedAt: string | null;
}

/** Register `kundun status` on the program. */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show a compact daemon + health + metrics snapshot')
    .action((_options: unknown, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        ctx = createAppContext({ projectRoot });
        const daemon = readDaemonStatus(join(ctx.kundunDir, 'runtime', 'daemon.pid'));
        const registry = buildSessionRegistry(ctx);
        const activeCount = registry.activeCount();
        const health = buildHealthMonitor(ctx, registry).check();
        const metrics = ctx.repos.metrics.latest();

        if (json) {
          printJson({
            ok: true,
            daemon,
            activeSessions: activeCount,
            health,
            metrics: metrics ?? null,
          });
        } else {
          renderStatus(daemon, activeCount, health, metrics);
        }
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** Read + probe the daemon pid file into a liveness summary. */
function readDaemonStatus(pidPath: string): DaemonStatus {
  const idle: DaemonStatus = { running: false, pid: null, host: null, port: null, startedAt: null };
  if (!existsSync(pidPath)) {
    return idle;
  }
  let parsed: Partial<{ pid: number; host: string; port: number; startedAt: string }>;
  try {
    parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as typeof parsed;
  } catch {
    return idle;
  }
  const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
  return {
    running: pid !== null && isProcessAlive(pid),
    pid,
    host: typeof parsed.host === 'string' ? parsed.host : null,
    port: typeof parsed.port === 'number' ? parsed.port : null,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
  };
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

/** Render the compact status block. */
function renderStatus(
  daemon: DaemonStatus,
  activeSessions: number,
  health: HealthReport,
  metrics: MetricsSnapshotRow | undefined,
): void {
  printLine(sectionHeader('Daemon'));
  if (daemon.running) {
    const where =
      daemon.host !== null && daemon.port !== null ? `${daemon.host}:${daemon.port}` : '';
    printLine(`  ${pc.green('running')}  ${dim(`pid ${daemon.pid ?? '?'}`)}  ${dim(where)}`);
    if (daemon.startedAt !== null) {
      printLine(`  started: ${dim(daemon.startedAt)}`);
    }
  } else {
    printLine(`  ${pc.yellow('not running')}`);
  }
  printLine();

  printLine(sectionHeader('Health'));
  printLine(`  ${summarizeComponents(health.components)}`);
  printLine(`  active sessions: ${activeSessions}`);
  printLine(
    `  errors (24h):    ${health.errorsLast24h > 0 ? pc.red(String(health.errorsLast24h)) : dim('0')}`,
  );
  printLine(`  search mode:     ${health.searchMode}`);
  printLine();

  printLine(sectionHeader('Latest metrics'));
  if (metrics === undefined) {
    printLine(`  ${dim('(no snapshot recorded yet)')}`);
    return;
  }
  printLine(
    `  files ${metrics.indexed_files}  chunks ${metrics.indexed_chunks}  ` +
      `memories ${metrics.memory_count}  tasks ${metrics.task_count}  ` +
      `diagnostics ${metrics.diagnostics_count}`,
  );
  printLine(
    `  db ${formatBytes(metrics.db_size_bytes)}  ` +
      `avg latency ${metrics.avg_tool_latency_ms === null ? dim('n/a') : `${metrics.avg_tool_latency_ms.toFixed(1)}ms`}`,
  );
  printLine(`  taken at: ${dim(metrics.created_at)}`);
}

/** Summarize components into a single "ok/degraded/down" headline line. */
function summarizeComponents(components: Record<string, ComponentStatus>): string {
  const entries = Object.entries(components);
  const down = entries.filter(([, s]) => s === 'down').map(([name]) => name);
  const degraded = entries.filter(([, s]) => s === 'degraded').map(([name]) => name);
  if (down.length > 0) {
    return `${pc.red('DOWN')} ${dim(down.join(', '))}`;
  }
  if (degraded.length > 0) {
    return `${pc.yellow('DEGRADED')} ${dim(degraded.join(', '))}`;
  }
  return pc.green('OK');
}

/** Human-readable byte size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] ?? 'B';
  return `${value.toFixed(1)}${unit}`;
}
