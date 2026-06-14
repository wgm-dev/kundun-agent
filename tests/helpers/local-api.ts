// Test helper: stand up a fully-wired local API server over a throwaway temp
// project, mirroring how `kundun daemon` wires it in production. Everything is
// minted ONCE per harness (one AppContext, one EventBus, one SessionRegistry,
// one HealthMonitor, one MetricsEngine, one TokenStore) and the server listens on
// port 0 so the OS assigns a free port that the test reads back.
//
// close() tears everything down in order: stop the HTTP server (awaits 'close' +
// the ws closeAll the server performs internally), close the AppContext (releases
// the DB), then remove the temp tree — retrying the rmdir on EBUSY because the
// SQLite handle/WAL can momentarily hold the directory on Windows.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeConfig } from '../../src/config/config-loader.js';
import { buildDefaultConfig } from '../../src/config/default-config.js';
import type { KundunConfig } from '../../src/config/config-schema.js';
import {
  buildHealthMonitor,
  buildMetricsEngine,
  createAppContext,
  createProcessRuntime,
} from '../../src/core/container.js';
import type { AppContext } from '../../src/core/container.js';
import type { EventBus } from '../../src/core/event-bus.js';
import type { SessionRegistry } from '../../src/core/session-registry.js';
import { createLocalServer } from '../../src/api/local-server.js';
import { createTokenStore } from '../../src/api/auth.js';
import type { TokenStore } from '../../src/api/auth.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';
import { MetaRepository } from '../../src/storage/repositories/meta.repository.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { makeTempProject } from './temp-project.js';
import type { TempProject } from './temp-project.js';

/** Overrides applied to the default config before the project is initialized. */
export interface StartTestApiOptions {
  /** Bind host (defaults to 127.0.0.1). Pass '0.0.0.0' to assert start() throws. */
  host?: string;
  /** Mutate/override the default config (e.g. flip allowRestartFromMcp). */
  config?: Partial<KundunConfig>;
  /** Install a reload hook on the route context (POST /mcp/restart path). */
  requestReload?: () => void;
  /**
   * Explicit static dashboard directory. In tests the source is NOT built, so
   * the auto-resolution in createLocalServer (relative to the compiled module)
   * cannot find the packaged `dashboard/` dir; the static-dashboard test passes
   * the repo's real `dashboard/` here to make serving deterministic. When omitted
   * the server falls back to its own resolution (and disables static serving if
   * no candidate exists), preserving the behavior every other test relies on.
   */
  dashboardDir?: string;
}

/** Everything a test needs from a started harness. */
export interface TestApi {
  /** Base URL of the listening server, e.g. http://127.0.0.1:54321. */
  url: string;
  /** The host the server reported (echoes the requested/default host). */
  host: string;
  /** The OS-assigned port. */
  port: number;
  /** The ONE shared event bus (emit on it to drive WS / recent-events tests). */
  eventBus: EventBus;
  /** The ONE shared session registry (register a session to populate /sessions). */
  sessionRegistry: SessionRegistry;
  /** The token store (read getToken() to authenticate a request). */
  tokenStore: TokenStore;
  /** The shared app context (repos, config, kdb). */
  ctx: AppContext;
  /** Tear down the server, the context, and the temp tree (idempotent). */
  close(): Promise<void>;
}

/**
 * Initialize a Kundun project on disk exactly as `kundun init` does so that
 * createAppContext succeeds: write config, create the .kundun tree, open the DB,
 * migrate to the latest schema, and seed project_meta.
 */
function initProject(project: TempProject, config: KundunConfig): void {
  writeConfig(project.root, config);
  mkdirSync(join(project.root, '.kundun'), { recursive: true });

  const dbPath = join(project.root, '.kundun', 'kundun.sqlite');
  const kdb = openDatabase(dbPath);
  try {
    runMigrations(kdb.db, kdb.hasFts5);
    const meta = new MetaRepository(kdb);
    meta.ensure(project.root, config.projectName, LATEST_SCHEMA_VERSION);
    meta.setSchemaVersion(LATEST_SCHEMA_VERSION);
  } finally {
    kdb.close();
  }
}

/** Remove a directory tree, retrying a few times on a transient EBUSY (Windows). */
function rmTreeWithRetry(root: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
        return; // Non-retryable (e.g. already gone): give up silently.
      }
      // Busy-wait briefly: the SQLite handle may still be releasing the dir.
      const until = Date.now() + 50;
      while (Date.now() < until) {
        // spin
      }
    }
  }
}

/**
 * Build an initialized temp project, wire one of every process singleton, and
 * start the local server on port 0. Returns the resolved URL plus the shared
 * collaborators a test needs and a close() that releases everything.
 *
 * When `opts.host` is non-loopback the server's start() throws BEFORE listen, so
 * this helper propagates that throw — the temp project is still cleaned up.
 */
export async function startTestApi(opts: StartTestApiOptions = {}): Promise<TestApi> {
  const project = makeTempProject();

  const config: KundunConfig = {
    ...buildDefaultConfig('local-api-test'),
    ...(opts.config ?? {}),
  };
  initProject(project, config);

  const ctx: AppContext = createAppContext({ projectRoot: project.root });

  // PROCESS-SINGLETON: exactly one EventBus + one SessionRegistry, threaded into
  // every collaborator (health monitor, metrics engine, local server).
  const { eventBus, sessionRegistry } = createProcessRuntime(ctx);
  const healthMonitor = buildHealthMonitor(ctx, sessionRegistry, eventBus);
  const metricsEngine = buildMetricsEngine(ctx, sessionRegistry, eventBus);

  const runtimeDir = join(ctx.kundunDir, 'runtime');
  const tokenStore = createTokenStore({ runtimeDir, logger: ctx.logger });
  // Force the token to exist up front so verify() has something to compare against.
  tokenStore.getToken();

  const host = opts.host ?? '127.0.0.1';
  const server = createLocalServer({
    ctx,
    eventBus,
    sessionRegistry,
    healthMonitor,
    metricsEngine,
    logger: ctx.logger,
    tokenStore,
    host,
    port: 0,
    ...(opts.requestReload === undefined ? {} : { requestReload: opts.requestReload }),
    ...(opts.dashboardDir === undefined ? {} : { dashboardDir: opts.dashboardDir }),
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      // server.stop() tears down the ws hub (closeAll) then awaits HTTP 'close'.
      await server.stop();
    } catch {
      // A failed stop must not block context/temp teardown.
    }
    try {
      ctx.close();
    } catch {
      // Closing the DB must never block temp removal.
    }
    rmTreeWithRetry(project.root);
  };

  let address;
  try {
    // Throws synchronously on a non-loopback host (before listen).
    address = await server.start();
  } catch (err) {
    // Clean up the temp project even when start refuses to bind.
    await close();
    throw err;
  }

  return {
    url: address.url,
    host: address.host,
    port: address.port,
    eventBus,
    sessionRegistry,
    tokenStore,
    ctx,
    close,
  };
}
