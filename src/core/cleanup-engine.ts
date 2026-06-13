// Cleanup engine (README §13). Applies the retention policy from
// `config.cleanup`: hard-delete long-soft-deleted files (cascading their chunks
// and symbols), purge orphaned chunks/symbols, archive old completed tasks,
// hard-delete expired low-importance memories, prune old log files, and
// optionally VACUUM.
//
// D7: a dry run writes NOTHING — it gathers candidates, computes counts, and
// returns without inserting a `cleanup_runs` row. A real run wraps all DB
// mutations in ONE transaction, then prunes log files and VACUUMs OUTSIDE any
// transaction, and finally records a single `cleanup_runs` row.
//
// better-sqlite3 is fully synchronous — nothing here is async.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { HIGH_IMPORTANCE_THRESHOLD } from './importance.js';
import type { KundunConfig } from '../config/config-schema.js';
import type { ChunkRepository } from '../storage/repositories/chunk.repository.js';
import type { FileRepository } from '../storage/repositories/file.repository.js';
import type { MemoryRepository } from '../storage/repositories/memory.repository.js';
import type { RunRepository } from '../storage/repositories/run.repository.js';
import type { SymbolRepository } from '../storage/repositories/symbol.repository.js';
import type { TaskRepository } from '../storage/repositories/task.repository.js';
import { transaction } from '../storage/sqlite.js';
import type { KundunDb } from '../storage/types.js';
import type { Logger } from '../utils/logger.js';
import { isoMinusDays, nowIso } from '../utils/time.js';

/** Outcome of a cleanup run (counts reflect what was / would be removed). */
export interface CleanupResult {
  dryRun: boolean;
  removedChunks: number;
  removedFiles: number;
  removedMemories: number;
  archivedTasks: number;
  removedSymbols: number;
  removedLogs: number;
  vacuumExecuted: boolean;
  durationMs: number;
  /** Set only on a real run (D7: dry runs never record a cleanup_runs row). */
  cleanupRunId?: number;
}

/** Collaborators the cleanup engine needs. Supplied once by the wiring layer. */
export interface CleanupEngineDeps {
  kdb: KundunDb;
  config: KundunConfig;
  /** Absolute path to the `.kundun` directory (logs live under `<kundunDir>/logs`). */
  kundunDir: string;
  fileRepo: FileRepository;
  chunkRepo: ChunkRepository;
  symbolRepo: SymbolRepository;
  memoryRepo: MemoryRepository;
  taskRepo: TaskRepository;
  runRepo: RunRepository;
  logger: Logger;
  /** Clock override for tests; defaults to utils/time.nowIso. */
  now?: () => string;
}

/** Options for {@link CleanupEngine.run}. */
export interface CleanupRunOptions {
  dryRun?: boolean;
}

/** Public surface returned by {@link createCleanupEngine}. */
export interface CleanupEngine {
  run(opts?: CleanupRunOptions): CleanupResult;
}

/** A log file selected for pruning, with its absolute path. */
interface LogCandidate {
  absPath: string;
}

/** Read-only snapshot of everything cleanup would touch. */
interface CleanupCandidates {
  fileIds: number[];
  /** Chunks/symbols cascaded by deleting the old files (counted before delete). */
  cascadedChunks: number;
  cascadedSymbols: number;
  orphanChunkIds: number[];
  orphanSymbolIds: number[];
  completedTaskIds: number[];
  expiredMemoryIds: number[];
  logCandidates: LogCandidate[];
}

/**
 * Create a cleanup engine bound to the given dependencies.
 */
export function createCleanupEngine(deps: CleanupEngineDeps): CleanupEngine {
  const now = deps.now ?? nowIso;
  const log = deps.logger.child('cleanup');

  return {
    run(opts: CleanupRunOptions = {}): CleanupResult {
      const dryRun = opts.dryRun ?? false;
      const startedAtIso = now();

      const candidates = gatherCandidates(deps, now());

      if (dryRun) {
        // D7: dry run writes NOTHING (no cleanup_runs row, no fs/db mutation).
        const result: CleanupResult = {
          dryRun: true,
          removedChunks: candidates.cascadedChunks + candidates.orphanChunkIds.length,
          removedFiles: candidates.fileIds.length,
          removedMemories: candidates.expiredMemoryIds.length,
          archivedTasks: candidates.completedTaskIds.length,
          removedSymbols: candidates.cascadedSymbols + candidates.orphanSymbolIds.length,
          removedLogs: candidates.logCandidates.length,
          vacuumExecuted: false,
          durationMs: elapsed(startedAtIso, now()),
        };
        log.info('cleanup dry-run computed', {
          removedFiles: result.removedFiles,
          removedChunks: result.removedChunks,
          removedSymbols: result.removedSymbols,
          removedMemories: result.removedMemories,
          archivedTasks: result.archivedTasks,
          removedLogs: result.removedLogs,
        });
        return result;
      }

      return runReal(deps, candidates, startedAtIso, now, log);
    },
  };
}

/**
 * Gather all cleanup candidates read-only. Time gates come from `config.cleanup`
 * via isoMinusDays(); orphan chunks/symbols have no time gate.
 */
function gatherCandidates(deps: CleanupEngineDeps, nowStr: string): CleanupCandidates {
  const { config, fileRepo, chunkRepo, symbolRepo, memoryRepo, taskRepo, kundunDir } = deps;
  const cleanup = config.cleanup;

  const deletedFilesCutoff = isoMinusDays(cleanup.deleteDeletedFilesAfterDays);
  const completedTasksCutoff = isoMinusDays(cleanup.archiveCompletedTasksAfterDays);
  const logsCutoff = isoMinusDays(cleanup.deleteLogsAfterDays);

  // Old soft-deleted files: their chunks/symbols are removed by ON DELETE CASCADE
  // when the file row is hard-deleted. Count them now (before any delete) so the
  // reported totals include cascaded rows.
  const oldDeletedFiles = fileRepo.listDeletedOlderThan(deletedFilesCutoff);
  const fileIds = oldDeletedFiles.map((f) => f.id);

  const cascadedFileIds = new Set(fileIds);
  const cascadedChunkIds = new Set<number>();
  let cascadedSymbols = 0;
  for (const id of fileIds) {
    for (const chunk of chunkRepo.getByFile(id)) {
      cascadedChunkIds.add(chunk.id);
    }
    cascadedSymbols += countSymbolsForFile(deps, id);
  }
  const cascadedChunks = cascadedChunkIds.size;

  // Orphan chunks/symbols of the files we're about to hard-delete are ALREADY
  // counted as cascaded (the real run cascades first, then finds 0 orphans for
  // them). Exclude that overlap so dry-run counts match the real run exactly.
  const orphanChunkIds = chunkRepo.listOrphanIds().filter((id) => !cascadedChunkIds.has(id));
  const orphanSymbolIds = symbolRepo
    .listOrphanIds()
    .filter((id) => !symbolBelongsToFiles(deps, id, cascadedFileIds));

  // listExpiredLowImportance NEVER returns importance_score >= threshold, so
  // high-importance memories are preserved by construction.
  const expiredMemoryIds = memoryRepo
    .listExpiredLowImportance(nowStr, HIGH_IMPORTANCE_THRESHOLD)
    .map((m) => m.id);

  const completedTaskIds = taskRepo.listCompletedOlderThan(completedTasksCutoff).map((t) => t.id);

  const logCandidates = gatherOldLogs(join(kundunDir, 'logs'), logsCutoff);

  return {
    fileIds,
    cascadedChunks,
    cascadedSymbols,
    orphanChunkIds,
    orphanSymbolIds,
    completedTaskIds,
    expiredMemoryIds,
    logCandidates,
  };
}

/**
 * Execute the real cleanup: DB mutations in one transaction, then log pruning
 * and VACUUM outside any transaction, then record the run. Counts are derived
 * from the actual `.changes` returned by each delete so they reflect reality.
 */
function runReal(
  deps: CleanupEngineDeps,
  candidates: CleanupCandidates,
  startedAtIso: string,
  now: () => string,
  log: Logger,
): CleanupResult {
  const { kdb, fileRepo, chunkRepo, symbolRepo, memoryRepo, taskRepo, runRepo, config } = deps;

  let removedFiles = 0;
  let removedChunks = 0;
  let removedSymbols = 0;
  let removedMemories = 0;
  let archivedTasks = 0;

  // All DB mutations share ONE transaction so a failure rolls everything back.
  transaction(kdb.db, () => {
    // 1. Hard-delete old soft-deleted files. ON DELETE CASCADE removes their
    //    chunks and symbols; we already counted those as cascaded above.
    removedFiles = fileRepo.deleteHard(candidates.fileIds);
    removedChunks += candidates.cascadedChunks;
    removedSymbols += candidates.cascadedSymbols;

    // 2. Purge remaining orphaned chunks/symbols (file missing or soft-deleted).
    removedChunks += chunkRepo.deleteOrphans();
    removedSymbols += symbolRepo.deleteOrphans();

    // 3. Archive old completed tasks (status -> 'archived'). taskRepo.update
    //    stamps updated_at internally from utils/time.
    for (const taskId of candidates.completedTaskIds) {
      taskRepo.update(taskId, { status: 'archived' });
      archivedTasks += 1;
    }

    // 4. Hard-delete expired low-importance memories (high importance preserved).
    for (const memoryId of candidates.expiredMemoryIds) {
      memoryRepo.deleteHard(memoryId);
      removedMemories += 1;
    }
  });

  // 5. Prune old log FILES (fs, OUTSIDE the DB transaction).
  const removedLogs = pruneLogs(candidates.logCandidates, log);

  // 6. VACUUM OUTSIDE any transaction; only when configured. A locked DB must
  //    not fail the cleanup — record vacuumExecuted=false and continue.
  let vacuumExecuted = false;
  if (config.cleanup.vacuumAfterCleanup) {
    try {
      kdb.db.exec('VACUUM');
      vacuumExecuted = true;
    } catch (err) {
      vacuumExecuted = false;
      log.warn('VACUUM skipped (database busy or locked)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const finishedAtIso = now();
  const cleanupRunId = runRepo.recordCleanup({
    startedAtIso,
    finishedAtIso,
    removedChunks,
    removedFiles,
    removedMemories,
    vacuumExecuted,
    status: 'completed',
  });

  log.info('cleanup completed', {
    removedFiles,
    removedChunks,
    removedSymbols,
    removedMemories,
    archivedTasks,
    removedLogs,
    vacuumExecuted,
    cleanupRunId,
  });

  return {
    dryRun: false,
    removedChunks,
    removedFiles,
    removedMemories,
    archivedTasks,
    removedSymbols,
    removedLogs,
    vacuumExecuted,
    durationMs: elapsed(startedAtIso, finishedAtIso),
    cleanupRunId,
  };
}

/**
 * List old `kundun-*.log` files under `logsDir` whose mtime is strictly older
 * than `cutoffIso`. Missing/unreadable dirs and entries are skipped silently.
 */
function gatherOldLogs(logsDir: string, cutoffIso: string): LogCandidate[] {
  if (!existsSync(logsDir)) {
    return [];
  }

  let names: string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    return [];
  }

  const cutoffMs = new Date(cutoffIso).getTime();
  const out: LogCandidate[] = [];

  for (const name of names) {
    if (!name.startsWith('kundun-') || !name.endsWith('.log')) {
      continue;
    }
    const absPath = join(logsDir, name);
    try {
      const stat = statSync(absPath);
      if (stat.isFile() && stat.mtimeMs < cutoffMs) {
        out.push({ absPath });
      }
    } catch {
      // Skip entries we cannot stat (race with rotation, permissions, etc.).
    }
  }

  return out;
}

/** Delete the given log files; count only the ones actually removed. */
function pruneLogs(candidates: LogCandidate[], log: Logger): number {
  let removed = 0;
  for (const candidate of candidates) {
    try {
      rmSync(candidate.absPath, { force: true });
      removed += 1;
    } catch (err) {
      log.warn('failed to delete log file', {
        path: candidate.absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return removed;
}

/** Count symbols belonging to a file (no dedicated repo method; query directly). */
function countSymbolsForFile(deps: CleanupEngineDeps, fileId: number): number {
  const row = deps.kdb.db
    .prepare('SELECT COUNT(*) AS n FROM symbols WHERE file_id = ?')
    .get(fileId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** True when a symbol's owning file_id is one of the cascade-deleted files. */
function symbolBelongsToFiles(
  deps: CleanupEngineDeps,
  symbolId: number,
  fileIds: ReadonlySet<number>,
): boolean {
  const row = deps.kdb.db.prepare('SELECT file_id FROM symbols WHERE id = ?').get(symbolId) as
    | { file_id: number }
    | undefined;
  return row !== undefined && fileIds.has(row.file_id);
}

/** Non-negative elapsed milliseconds between two ISO timestamps. */
function elapsed(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return ms < 0 ? 0 : ms;
}
