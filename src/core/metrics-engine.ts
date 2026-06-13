// Metrics engine (MVP3). Builds a point-in-time metrics snapshot by sampling the
// live database and the in-memory session registry, then persists it via the
// MetricsRepository and returns the stored row (with its assigned id + created_at).
//
// Data sources (per locked decisions):
// - active_sessions      -> sessionRegistry.activeCount() (in-memory, authoritative)
// - indexed_files        -> file.countActive()
// - indexed_chunks       -> chunk.countAll()
// - memory_count         -> memory.countAll()
// - task_count           -> SELECT COUNT(*) FROM tasks (total, not just open)
// - diagnostics_count    -> DiagnosticRepository.countAll()
// - db_size_bytes        -> PRAGMA page_count * PRAGMA page_size on the LIVE
//                           connection (NOT the file-stat helper, which lags
//                           under WAL before a checkpoint)
// - avg_tool_latency_ms  -> sessionRegistry.avgToolLatencyMs() (nullable)
// - scan_duration_ms     -> run.lastScan()?.duration_ms ?? null
// - cleanup_duration_ms  -> run.lastCleanup()?.duration_ms ?? null
// - errors_last_24h      -> the SHARED errorsLast24h(deps, now) helper (the same
//                           one the health monitor uses) so both engines agree
//
// better-sqlite3 is fully synchronous — nothing here is async.

import type { KundunDb, MetricsSnapshotRow, NewMetricsSnapshotRow } from '../storage/types.js';
import type { FileRepository } from '../storage/repositories/file.repository.js';
import type { ChunkRepository } from '../storage/repositories/chunk.repository.js';
import type { MemoryRepository } from '../storage/repositories/memory.repository.js';
import type { RunRepository } from '../storage/repositories/run.repository.js';
import type { HealthRepository } from '../storage/repositories/health.repository.js';
import type { MetricsRepository } from '../storage/repositories/metrics.repository.js';
import { DiagnosticRepository } from '../storage/repositories/diagnostic.repository.js';
import { errorsLast24h as defaultErrorsLast24h } from './health-monitor.js';
import type { ErrorsLast24hDeps } from './health-monitor.js';
import { nowIso } from '../utils/time.js';

/**
 * The subset of repositories the metrics engine reads from. A structural type so
 * callers may pass the full {@link Repositories} bundle from the app context.
 * `health` and `run` also satisfy the shared errorsLast24h helper's deps.
 */
export interface MetricsRepos {
  file: FileRepository;
  chunk: ChunkRepository;
  memory: MemoryRepository;
  run: RunRepository;
  health: HealthRepository;
}

/**
 * In-memory session registry surface consumed by the metrics engine. Declared
 * structurally so this module does not depend on the registry's concrete module
 * (written elsewhere in MVP3); any object exposing these methods works.
 */
export interface SessionRegistryLike {
  /** Number of currently-active client sessions. */
  activeCount(): number;
  /** Mean tool-call latency across tracked sessions, or null when unknown. */
  avgToolLatencyMs(): number | null;
}

/**
 * Signature of the shared "errors in the last 24h" helper. The default
 * implementation is {@link defaultErrorsLast24h} from the health monitor; it is
 * injectable so the metrics engine and the health monitor can share one instance.
 */
export type ErrorsLast24hFn = (deps: ErrorsLast24hDeps, now: string) => number;

/** Dependencies for {@link createMetricsEngine}. */
export interface MetricsEngineDeps {
  /** Repositories the snapshot samples (file/chunk/memory/run/health). */
  repos: MetricsRepos;
  /** Live database handle (for the tasks count and the PRAGMA size probe). */
  kdb: KundunDb;
  /** In-memory session registry providing active count + avg tool latency. */
  sessionRegistry: SessionRegistryLike;
  /** Shared 24h error-count helper; defaults to the health monitor's export. */
  errorsLast24h?: ErrorsLast24hFn;
  /** Persistence for snapshots. */
  metricsRepo: MetricsRepository;
  /** Clock; defaults to nowIso. */
  now?: () => string;
}

/** Public surface returned by {@link createMetricsEngine}. */
export interface MetricsEngine {
  /**
   * Sample the current state, persist a metrics snapshot, and return the stored
   * row (including its assigned id and created_at).
   */
  snapshot(): MetricsSnapshotRow;
}

/**
 * Read the live database size as page_count * page_size on the OPEN connection.
 * This reflects WAL-pending pages, unlike a file-size stat which lags until the
 * next checkpoint.
 */
function liveDbSizeBytes(kdb: KundunDb): number {
  const pageCount = kdb.db.pragma('page_count', { simple: true }) as number;
  const pageSize = kdb.db.pragma('page_size', { simple: true }) as number;
  return pageCount * pageSize;
}

/** Total number of rows in the tasks table (not just open tasks). */
function totalTaskCount(kdb: KundunDb): number {
  const row = kdb.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * Create the metrics engine. `snapshot()` builds a {@link NewMetricsSnapshotRow}
 * from the current counts, persists it with the engine's single `now()` stamp,
 * and returns the full stored row.
 */
export function createMetricsEngine(deps: MetricsEngineDeps): MetricsEngine {
  const { repos, kdb, sessionRegistry, metricsRepo } = deps;
  const now = deps.now ?? nowIso;
  const errorsLast24h = deps.errorsLast24h ?? defaultErrorsLast24h;

  // The diagnostics count comes from a repository built over the same connection;
  // construct it once and reuse it across snapshots.
  const diagnosticRepo = new DiagnosticRepository(kdb);

  return {
    snapshot(): MetricsSnapshotRow {
      const iso = now();

      const newRow: NewMetricsSnapshotRow = {
        active_sessions: sessionRegistry.activeCount(),
        indexed_files: repos.file.countActive(),
        indexed_chunks: repos.chunk.countAll(),
        memory_count: repos.memory.countAll(),
        task_count: totalTaskCount(kdb),
        diagnostics_count: diagnosticRepo.countAll(),
        db_size_bytes: liveDbSizeBytes(kdb),
        avg_tool_latency_ms: sessionRegistry.avgToolLatencyMs(),
        scan_duration_ms: repos.run.lastScan()?.duration_ms ?? null,
        cleanup_duration_ms: repos.run.lastCleanup()?.duration_ms ?? null,
        errors_last_24h: errorsLast24h({ healthRepo: repos.health, runRepo: repos.run }, iso),
      };

      const id = metricsRepo.insertSnapshot(newRow, iso);

      return {
        id,
        created_at: iso,
        ...newRow,
      };
    },
  };
}
