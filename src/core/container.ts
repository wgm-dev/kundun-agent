// Composition root for Kundun-Agent. This is the single wiring point every CLI
// command uses: it loads config, opens the database, runs migrations, mirrors
// the schema version into project_meta (D2), builds the logger, and constructs
// every repository. Thin `build*` factories assemble the core engines from the
// resulting context so callers never wire dependencies by hand.
//
// better-sqlite3 is fully synchronous — nothing here is async.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { KundunConfig } from '../config/config-schema.js';
import { configExists, loadConfig } from '../config/config-loader.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../storage/migrations.js';
import { openDatabase } from '../storage/sqlite.js';
import type { KundunDb } from '../storage/types.js';

import { ChunkRepository } from '../storage/repositories/chunk.repository.js';
import { FileRepository } from '../storage/repositories/file.repository.js';
import { MemoryRepository } from '../storage/repositories/memory.repository.js';
import { MetaRepository } from '../storage/repositories/meta.repository.js';
import { RunRepository } from '../storage/repositories/run.repository.js';
import { SymbolRepository } from '../storage/repositories/symbol.repository.js';
import { TaskRepository } from '../storage/repositories/task.repository.js';
import { SessionRepository } from '../storage/repositories/session.repository.js';
import { HealthRepository } from '../storage/repositories/health.repository.js';
import { MetricsRepository } from '../storage/repositories/metrics.repository.js';

import { KundunError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

import { createProjectScanner } from './project-scanner.js';
import type { ProjectScanner } from './project-scanner.js';
import { createIndexer } from './indexer.js';
import type { Indexer } from './indexer.js';
import { createMemoryEngine } from './memory-engine.js';
import type { MemoryEngine } from './memory-engine.js';
import { createTaskEngine } from './task-engine.js';
import type { TaskEngine } from './task-engine.js';
import { createCleanupEngine } from './cleanup-engine.js';
import type { CleanupEngine } from './cleanup-engine.js';
import { createSearchProvider } from './search-provider.js';
import type { SearchProvider } from './search-provider.js';
import { createEventBus } from './event-bus.js';
import type { EventBus } from './event-bus.js';
import { createSessionRegistry } from './session-registry.js';
import type { SessionRegistry } from './session-registry.js';
import { createHealthMonitor } from './health-monitor.js';
import type { HealthMonitor } from './health-monitor.js';
import { createMetricsEngine } from './metrics-engine.js';
import type { MetricsEngine } from './metrics-engine.js';

/** The repositories bundled on an {@link AppContext}. */
export interface Repositories {
  meta: MetaRepository;
  run: RunRepository;
  file: FileRepository;
  chunk: ChunkRepository;
  symbol: SymbolRepository;
  memory: MemoryRepository;
  task: TaskRepository;
  session: SessionRepository;
  health: HealthRepository;
  metrics: MetricsRepository;
}

/**
 * Fully-wired application context shared by every CLI command. Holds the loaded
 * config, resolved paths, the open database handle, a logger, and all
 * repositories. `close()` releases the database (and checkpoints the WAL).
 */
export interface AppContext {
  config: KundunConfig;
  projectRoot: string;
  kundunDir: string;
  kdb: KundunDb;
  logger: Logger;
  repos: Repositories;
  close(): void;
}

/** Options for {@link createAppContext}. */
export interface CreateAppContextOptions {
  projectRoot: string;
}

/**
 * Build the application context for a project root.
 *
 * Order: load+resolve config -> open database -> run migrations -> mirror the
 * authoritative schema version into project_meta (D2) -> build logger ->
 * construct repositories. Throws KundunError('not_initialized') when the project
 * has no config or no database file yet, so the caller can suggest `kundun init`.
 */
export function createAppContext(opts: CreateAppContextOptions): AppContext {
  const { projectRoot } = opts;

  if (!configExists(projectRoot)) {
    throw new KundunError(
      'not_initialized',
      `Kundun is not initialized in ${projectRoot}. Run \`kundun init\` first.`,
    );
  }

  // loadConfig throws config_not_found/parse/invalid; translate the missing-file
  // case to not_initialized so callers can give the consistent init hint.
  let loaded;
  try {
    loaded = loadConfig(projectRoot);
  } catch (err) {
    if (err instanceof KundunError && err.code === 'config_not_found') {
      throw new KundunError(
        'not_initialized',
        `Kundun is not initialized in ${projectRoot}. Run \`kundun init\` first.`,
      );
    }
    throw err;
  }

  const { config, kundunDir, databasePathAbs } = loaded;

  // A resolved config without a database file means init has not finished.
  if (!existsSync(databasePathAbs)) {
    throw new KundunError(
      'not_initialized',
      `Kundun database not found at ${databasePathAbs}. Run \`kundun init\` first.`,
    );
  }

  const kdb = openDatabase(databasePathAbs);

  try {
    // Apply any pending migrations, then mirror the authoritative version (D2).
    runMigrations(kdb.db, kdb.hasFts5);

    const meta = new MetaRepository(kdb);
    meta.setSchemaVersion(LATEST_SCHEMA_VERSION);

    const logger = createLogger({ logDir: join(kundunDir, 'logs') }).child('kundun');

    const repos: Repositories = {
      meta,
      run: new RunRepository(kdb),
      file: new FileRepository(kdb),
      chunk: new ChunkRepository(kdb),
      symbol: new SymbolRepository(kdb),
      memory: new MemoryRepository(kdb),
      task: new TaskRepository(kdb),
      session: new SessionRepository(kdb),
      health: new HealthRepository(kdb),
      metrics: new MetricsRepository(kdb),
    };

    return {
      config,
      projectRoot: loaded.projectRoot,
      kundunDir,
      kdb,
      logger,
      repos,
      close(): void {
        kdb.close();
      },
    };
  } catch (err) {
    // Never leak the open handle if wiring fails after the DB was opened.
    kdb.close();
    throw err;
  }
}

// --- Thin engine/provider builders (wire deps from a ready context) ---

/** Build the project scanner from a context. */
export function buildScanner(ctx: AppContext): ProjectScanner {
  return createProjectScanner({
    kdb: ctx.kdb,
    config: ctx.config,
    projectRoot: ctx.projectRoot,
    fileRepo: ctx.repos.file,
    runRepo: ctx.repos.run,
    logger: ctx.logger,
  });
}

/** Build the file indexer from a context. */
export function buildIndexer(ctx: AppContext): Indexer {
  return createIndexer({
    kdb: ctx.kdb,
    config: ctx.config,
    projectRoot: ctx.projectRoot,
    fileRepo: ctx.repos.file,
    chunkRepo: ctx.repos.chunk,
    symbolRepo: ctx.repos.symbol,
    logger: ctx.logger,
  });
}

/** Build the memory engine from a context (search path keyed off hasFts5, D1). */
export function buildMemoryEngine(ctx: AppContext): MemoryEngine {
  return createMemoryEngine({
    memoryRepo: ctx.repos.memory,
    hasFts5: ctx.kdb.hasFts5,
    logger: ctx.logger,
  });
}

/** Build the task engine from a context. */
export function buildTaskEngine(ctx: AppContext): TaskEngine {
  return createTaskEngine({
    taskRepo: ctx.repos.task,
  });
}

/** Build the cleanup engine from a context. */
export function buildCleanupEngine(ctx: AppContext): CleanupEngine {
  return createCleanupEngine({
    kdb: ctx.kdb,
    config: ctx.config,
    kundunDir: ctx.kundunDir,
    fileRepo: ctx.repos.file,
    chunkRepo: ctx.repos.chunk,
    symbolRepo: ctx.repos.symbol,
    memoryRepo: ctx.repos.memory,
    taskRepo: ctx.repos.task,
    runRepo: ctx.repos.run,
    logger: ctx.logger,
  });
}

/** Build the code-search provider from a context (FTS5 vs LIKE picked by D1). */
export function buildSearchProvider(ctx: AppContext): SearchProvider {
  return createSearchProvider(ctx.kdb, ctx.repos.chunk);
}

// --- Process-singleton runtime builders (MVP3 daemon / MCP) ---
//
// CRITICAL PROCESS-SINGLETON CONTRACT
// -----------------------------------
// The EventBus and the SessionRegistry are stateful, in-process singletons:
// - The EventBus holds listener sets (and, with history enabled, a bounded ring
//   of recent events). Two buses means split history and listeners that never
//   see each other's events.
// - The SessionRegistry holds the rolling tool-latency ring used to compute
//   avg_tool_latency_ms. Two registries means latency samples are split and the
//   metric is wrong.
// Therefore a long-running host (daemon / MCP server) MUST construct EXACTLY ONE
// EventBus and EXACTLY ONE SessionRegistry at startup and pass those same
// instances down to the health monitor, metrics engine, local API server, and
// tool layer. NEVER call these builders per-request/per-call. The helpers below
// are thin factories: when an optional `eventBus`/`sessionRegistry` is omitted
// they would each construct a fresh one, which is correct ONLY for one-shot CLI
// commands and isolated tests — not for a daemon. Use {@link createProcessRuntime}
// to mint the single shared pair, then thread it through the build* helpers.

/** The per-process shared runtime: the one EventBus and one SessionRegistry. */
export interface ProcessRuntime {
  eventBus: EventBus;
  sessionRegistry: SessionRegistry;
}

/**
 * Mint the single shared {@link ProcessRuntime} for a long-running host. Call
 * this ONCE at daemon/MCP startup and pass `eventBus` + `sessionRegistry` down to
 * every build* helper below so the whole process shares one bus and one registry.
 */
export function createProcessRuntime(ctx: AppContext): ProcessRuntime {
  const eventBus = createEventBus();
  const sessionRegistry = createSessionRegistry({
    sessionRepo: ctx.repos.session,
    eventBus,
  });
  return { eventBus, sessionRegistry };
}

/**
 * Build the in-process session registry from a context.
 *
 * Pass the process-shared {@link EventBus} so session lifecycle events reach the
 * one bus. Omitting it constructs a registry with no event emission — acceptable
 * only for isolated tests/one-shot use. PROCESS-SINGLETON: a daemon/MCP must build
 * this ONCE (prefer {@link createProcessRuntime}) and reuse the instance.
 */
export function buildSessionRegistry(ctx: AppContext, eventBus?: EventBus): SessionRegistry {
  return createSessionRegistry(
    eventBus === undefined
      ? { sessionRepo: ctx.repos.session }
      : { sessionRepo: ctx.repos.session, eventBus },
  );
}

/**
 * Build the health monitor from a context.
 *
 * Pass the process-shared {@link SessionRegistry} and {@link EventBus} so the
 * monitor reads live session state and emits onto the one bus. Both are optional
 * for isolated tests; in a daemon they MUST be the single shared instances
 * (PROCESS-SINGLETON — see {@link createProcessRuntime}).
 */
export function buildHealthMonitor(
  ctx: AppContext,
  sessionRegistry?: SessionRegistry,
  eventBus?: EventBus,
): HealthMonitor {
  // The health monitor's SessionRegistryLike expects `averageToolLatencyMs()`,
  // while SessionRegistry exposes `avgToolLatencyMs()`. Bridge the two with a thin
  // adapter so the monitor actually reads live latency (and the weak structural
  // type matches under exactOptionalPropertyTypes) without per-call coupling.
  return createHealthMonitor({
    ctx,
    healthRepo: ctx.repos.health,
    ...(sessionRegistry === undefined
      ? {}
      : { sessionRegistry: { averageToolLatencyMs: () => sessionRegistry.avgToolLatencyMs() } }),
    ...(eventBus === undefined ? {} : { eventBus }),
  });
}

/**
 * Build the metrics engine from a context.
 *
 * The metrics engine REQUIRES the process-shared {@link SessionRegistry}: it reads
 * active_sessions and avg_tool_latency_ms from the live registry's rolling ring,
 * so a fresh per-call registry would report zeroed/empty metrics. The
 * {@link EventBus} is optional. PROCESS-SINGLETON — pass the single shared
 * instances (see {@link createProcessRuntime}); never construct per-call.
 */
export function buildMetricsEngine(
  ctx: AppContext,
  sessionRegistry: SessionRegistry,
  eventBus?: EventBus,
): MetricsEngine {
  // The engine reads a structural `MetricsRepos` subset ({file,chunk,memory,run,
  // health}); the full Repositories bundle satisfies it. It builds its own
  // DiagnosticRepository from `kdb` for the diagnostics count and probes the live
  // PRAGMA size, so AppContext.repos stays unchanged. `eventBus` is accepted here
  // for a uniform builder signature even though the current engine does not use it.
  void eventBus;
  return createMetricsEngine({
    repos: ctx.repos,
    kdb: ctx.kdb,
    metricsRepo: ctx.repos.metrics,
    sessionRegistry,
  });
}
