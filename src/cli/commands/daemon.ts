// `kundun daemon` — run the long-running foreground daemon: a single shared
// AppContext + EventBus + SessionRegistry + HealthMonitor + MetricsEngine, the
// loopback-only local HTTP/WS API, and the background timers (auto-scan, periodic
// metrics/idle-sweep, cleanup-after-N-scans). This is NOT the stdio MCP server,
// so writing the listening URL to stdout is fine here.
//
// PROCESS-SINGLETON: the EventBus and SessionRegistry are minted ONCE (via
// createProcessRuntime) and threaded into every collaborator so history/listeners
// and the latency ring are shared across the whole process.
//
// LIFECYCLE (locked):
// - Refuse to start if a live daemon already owns the pid file (process.kill 0).
// - Ensure the API token exists (createTokenStore.getToken()).
// - Start the local server, then write .kundun/runtime/daemon.pid (token NOT stored).
// - 'restart' is an in-process reload (re-read config, reset timers, emit a health
//   event), NEVER a re-exec.
// - SIGINT/SIGTERM: clear timers -> server.stop() -> emit 'daemon.stopped' health
//   event -> unlink pid -> ctx.close() -> exit 0.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import type { Command } from 'commander';
import pc from 'picocolors';

import {
  buildCleanupEngine,
  buildHealthMonitor,
  buildIndexer,
  buildMetricsEngine,
  buildScanner,
  createAppContext,
  createProcessRuntime,
} from '../../core/container.js';
import type { AppContext } from '../../core/container.js';
import type { HealthMonitor } from '../../core/health-monitor.js';
import type { MetricsEngine } from '../../core/metrics-engine.js';
import { createLocalServer } from '../../api/local-server.js';
import type { LocalServer, LocalServerAddress } from '../../api/local-server.js';
import { createTokenStore } from '../../api/auth.js';
import type { HealthRepository } from '../../storage/repositories/health.repository.js';
import type { HealthSeverity } from '../../storage/types.js';
import { nowIso } from '../../utils/time.js';
import { getGlobalOptions, printLine, reportError } from '../shared.js';

/** Shape of the daemon pid file (token is NEVER stored). */
interface DaemonPidFile {
  pid: number;
  startedAt: string;
  host: string;
  port: number;
}

/** How often the metrics/idle-sweep timer fires (ms). */
const METRICS_INTERVAL_MS = 60_000;

/** Run a cleanup pass after this many auto-scans. */
const CLEANUP_AFTER_SCANS = 6;

/** Idle/disconnect cutoffs for the periodic session sweep (ms). */
const IDLE_AFTER_MS = 5 * 60_000;
const DISCONNECT_AFTER_MS = 30 * 60_000;

/** Options parsed for `kundun daemon`. */
interface DaemonOptions {
  /** Commander's `--no-dashboard`: true by default, false when the flag is set. */
  dashboard?: boolean;
}

/** Register `kundun daemon` on the program. */
export function registerDaemonCommand(program: Command): void {
  program
    .command('daemon')
    .description('Run the long-running local daemon (HTTP/WS API + background timers)')
    .option('--no-dashboard', 'Disable serving the bundled web dashboard (API only)')
    .action(async (options: DaemonOptions, command: Command) => {
      const { projectRoot } = getGlobalOptions(command);
      // `--no-dashboard` makes commander set `dashboard` to false; default is true.
      const serveDashboard = options.dashboard ?? true;
      try {
        await runDaemon(projectRoot, serveDashboard);
      } catch (err) {
        reportError(err);
      }
    });
}

/** Read a daemon pid file, returning undefined when absent or unparseable. */
function readPidFile(pidPath: string): DaemonPidFile | undefined {
  if (!existsSync(pidPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as Partial<DaemonPidFile>;
    if (typeof parsed.pid !== 'number') {
      return undefined;
    }
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      host: typeof parsed.host === 'string' ? parsed.host : '',
      port: typeof parsed.port === 'number' ? parsed.port : 0,
    };
  } catch {
    return undefined;
  }
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
    // EPERM means the process exists but is owned by another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Record a health_event, swallowing any storage error (best-effort). */
function recordHealth(
  healthRepo: HealthRepository,
  input: { source: string; severity: HealthSeverity; message: string },
): void {
  try {
    healthRepo.record(input, nowIso());
  } catch {
    // Health recording is best-effort; never let it break the daemon lifecycle.
  }
}

/** The core daemon: wire singletons, start the server, install timers + signals. */
async function runDaemon(projectRoot: string, serveDashboard: boolean): Promise<void> {
  const ctx: AppContext = createAppContext({ projectRoot });

  const runtimeDir = join(ctx.kundunDir, 'runtime');
  const pidPath = join(runtimeDir, 'daemon.pid');
  const log = ctx.logger.child('daemon');

  // 1) Stale-pid check: refuse to start when a live daemon already owns the file.
  const existing = readPidFile(pidPath);
  if (existing !== undefined && isProcessAlive(existing.pid)) {
    ctx.close();
    throw new Error(
      `A Kundun daemon is already running (pid ${existing.pid} at ` +
        `${existing.host}:${existing.port}). Stop it first or remove ${pidPath}.`,
    );
  }

  // 2) Ensure the API token exists (generated on first read, never logged).
  const tokenStore = createTokenStore({ runtimeDir, logger: ctx.logger });
  tokenStore.getToken();

  // 3) Mint the ONE shared EventBus + SessionRegistry, then build collaborators.
  const { eventBus, sessionRegistry } = createProcessRuntime(ctx);
  const healthMonitor: HealthMonitor = buildHealthMonitor(ctx, sessionRegistry, eventBus);
  const metricsEngine: MetricsEngine = buildMetricsEngine(ctx, sessionRegistry, eventBus);

  // Timer handles live in this scope so the reload hook and shutdown can reset them.
  let timers: NodeJS.Timeout[] = [];
  let scanCounter = 0;

  /** Tear down every interval timer (used by reload and shutdown). */
  function clearTimers(): void {
    for (const t of timers) {
      clearInterval(t);
    }
    timers = [];
  }

  /** Log a health_event + emit a bus event for a non-fatal timer failure. */
  function handleTimerFailure(source: string, message: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    // SQLITE_BUSY (lock contention) is expected/transient and must not kill the daemon.
    const busy = /SQLITE_BUSY/i.test(detail);
    recordHealth(ctx.repos.health, {
      source,
      severity: busy ? 'warning' : 'error',
      message: `${message}: ${detail}`,
    });
    eventBus.emit(busy ? 'health.warning' : 'health.error', { source, message });
    log.warn(message, { source, busy });
  }

  /** One guarded cleanup pass (retention policy). Failures are non-fatal. */
  function runCleanupPass(): void {
    try {
      buildCleanupEngine(ctx).run({ dryRun: false });
    } catch (err) {
      handleTimerFailure('cleanup', 'auto-cleanup failed', err);
    }
  }

  /** One guarded auto-scan + index pass. SQLITE_BUSY is non-fatal. */
  function runScanPass(): void {
    try {
      const startedAtIso = nowIso();
      const scanner = buildScanner(ctx);
      const scanResult = scanner.scan({ force: false });
      const indexer = buildIndexer(ctx);
      const toIndex = [...scanResult.newFiles, ...scanResult.changedFiles];
      const indexResult = indexer.indexFiles(toIndex);
      ctx.repos.run.finishScan(scanResult.scanId, {
        filesScanned: scanResult.filesScanned,
        filesIndexed: indexResult.indexed,
        filesSkipped: scanResult.skippedFiles.length,
        errorsCount: scanResult.errors.length + indexResult.errors,
        status: 'completed',
        startedAtIso,
      });
      ctx.repos.meta.touchScanned(nowIso());

      // Cleanup-after-N-scans: every Nth successful scan, prune per the policy.
      scanCounter += 1;
      if (ctx.config.enableAutoCleanup && scanCounter % CLEANUP_AFTER_SCANS === 0) {
        runCleanupPass();
      }
    } catch (err) {
      handleTimerFailure('scanner', 'auto-scan failed', err);
    }
  }

  /** One guarded metrics snapshot + idle sweep. Failures are non-fatal. */
  function runMetricsPass(): void {
    try {
      metricsEngine.snapshot();
      sessionRegistry.sweepIdle(IDLE_AFTER_MS, DISCONNECT_AFTER_MS);
    } catch (err) {
      handleTimerFailure('health-monitor', 'metrics/idle sweep failed', err);
    }
  }

  /** Install the periodic timers (auto-scan optional; metrics always on). */
  function installTimers(): void {
    clearTimers();
    scanCounter = 0;

    if (ctx.config.autoScan.enabled) {
      const everyMs = Math.max(1, ctx.config.autoScan.intervalMinutes) * 60_000;
      const scanTimer = setInterval(runScanPass, everyMs);
      scanTimer.unref();
      timers.push(scanTimer);
    }

    const metricsTimer = setInterval(runMetricsPass, METRICS_INTERVAL_MS);
    metricsTimer.unref();
    timers.push(metricsTimer);
  }

  // 4) In-process reload (POST /mcp/restart): re-read config, reset timers, emit
  // a health event. NOT a re-exec. The live config object is mutated in place so
  // collaborators holding ctx.config observe the new values.
  function requestReload(): void {
    try {
      const reloaded = createAppContext({ projectRoot });
      Object.assign(ctx.config, reloaded.config);
      reloaded.close();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn('config reload failed; keeping current config', { detail });
    }
    installTimers();
    recordHealth(ctx.repos.health, {
      source: 'daemon',
      severity: 'info',
      message: 'daemon.reloaded',
    });
    eventBus.emit('health.warning', { source: 'daemon', message: 'daemon.reloaded' });
    log.info('daemon reloaded (in-process)');
  }

  // 5) Start the loopback-only local server (throws before listen on non-loopback).
  const server: LocalServer = createLocalServer({
    ctx,
    eventBus,
    sessionRegistry,
    healthMonitor,
    metricsEngine,
    logger: ctx.logger,
    tokenStore,
    host: ctx.config.desktop.localApiHost,
    port: ctx.config.desktop.localApiPort,
    requestReload,
    serveDashboard,
  });

  let address: LocalServerAddress;
  try {
    address = await server.start();
  } catch (err) {
    ctx.close();
    // EADDRINUSE almost always means another daemon already owns the port — and
    // because the port is shared across projects (default 37373), the stale-pid
    // check above (which is per-project) won't have caught a daemon started for a
    // DIFFERENT project. Give an actionable message instead of a raw stack.
    if (err instanceof Error && /EADDRINUSE/.test(err.message)) {
      const { localApiHost: h, localApiPort: p } = ctx.config.desktop;
      throw new Error(
        `Port ${h}:${p} is already in use — another Kundun daemon (possibly for ` +
          `a different project) is likely running there. Stop it first, or set a ` +
          `different "desktop.localApiPort" in kundun.config.json for this project.`,
      );
    }
    throw err;
  }

  // 6) Write the pid file (token NEVER stored) now that we are listening.
  const pidFile: DaemonPidFile = {
    pid: process.pid,
    startedAt: nowIso(),
    host: address.host,
    port: address.port,
  };
  writeFileSync(pidPath, `${JSON.stringify(pidFile)}\n`, 'utf8');

  installTimers();

  // 7) Clean shutdown on SIGINT/SIGTERM (guarded against double-invocation).
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearTimers();
    void server
      .stop()
      .catch(() => {
        // A failed server stop must not block the rest of the teardown.
      })
      .finally(() => {
        recordHealth(ctx.repos.health, {
          source: 'daemon',
          severity: 'info',
          message: 'daemon.stopped',
        });
        eventBus.emit('health.warning', { source: 'daemon', message: 'daemon.stopped' });
        try {
          if (existsSync(pidPath)) {
            unlinkSync(pidPath);
          }
        } catch {
          // A leftover pid file is harmless; the next start does a liveness check.
        }
        try {
          ctx.close();
        } catch {
          // Closing the database must never block a clean shutdown.
        }
        process.exit(0);
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // The HTTP server + timers keep the event loop alive; print the URL to stdout.
  printLine(`${pc.green('Kundun daemon listening on')} ${pc.cyan(address.url)}`);
  // Point the user at the bundled web dashboard (served at '/') unless disabled.
  if (serveDashboard) {
    printLine(`${pc.green('Dashboard:')} ${pc.cyan(`${address.url}/`)}`);
    printLine(
      pc.dim(`Paste the token from ${join(runtimeDir, 'token')} in the UI to unlock data.`),
    );
  }
  printLine(pc.dim(`pid ${process.pid} — Ctrl+C to stop`));
}
