// `kundun health` — print the daemon's on-demand health report (component
// statuses + headline signals) from the health monitor, or as JSON with --json.
// Read-only: opens a short-lived AppContext like `summary`, builds the health
// monitor (with the in-process session registry for live tool latency), and
// always closes the context in `finally`. A pure read — never records events.

import type { Command } from 'commander';
import pc from 'picocolors';

import {
  buildHealthMonitor,
  buildSessionRegistry,
  createAppContext,
} from '../../core/container.js';
import type { ComponentStatus, HealthReport } from '../../core/health-monitor.js';
import {
  dim,
  getGlobalOptions,
  printJson,
  printLine,
  reportError,
  sectionHeader,
} from '../shared.js';

/** Register `kundun health` on the program. */
export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Show the daemon health report')
    .action((_options: unknown, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        ctx = createAppContext({ projectRoot });
        const registry = buildSessionRegistry(ctx);
        const monitor = buildHealthMonitor(ctx, registry);
        const report = monitor.check();
        if (json) {
          printJson({ ok: true, health: report });
        } else {
          renderHealth(report);
        }
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** Render the health report as readable sections. */
function renderHealth(report: HealthReport): void {
  printLine(sectionHeader('Components'));
  for (const [component, status] of Object.entries(report.components)) {
    printLine(`  ${component.padEnd(12)} ${colorComponentStatus(status)}`);
  }
  printLine();

  printLine(sectionHeader('Signals'));
  printLine(`  errors (24h):   ${colorErrors(report.errorsLast24h)}`);
  printLine(`  avg latency:    ${formatLatency(report.avgToolLatencyMs)}`);
  printLine(`  search mode:    ${report.searchMode}`);
  printLine(`  schema version: ${report.schemaVersion}`);
  printLine(`  generated at:   ${dim(report.generatedAt)}`);
}

/** Colorize a component status tag. */
function colorComponentStatus(status: ComponentStatus): string {
  switch (status) {
    case 'ok':
      return pc.green(status);
    case 'degraded':
      return pc.yellow(status);
    case 'down':
      return pc.red(status);
    default:
      return dim(status);
  }
}

/** Colorize the 24h error count (0 is dimmed, >0 is red). */
function colorErrors(count: number): string {
  return count > 0 ? pc.red(String(count)) : dim('0');
}

/** Format a nullable average latency in milliseconds. */
function formatLatency(ms: number | null): string {
  return ms === null ? dim('(n/a)') : `${ms.toFixed(1)}ms`;
}
