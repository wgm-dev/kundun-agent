import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCleanupEngine } from '../../src/core/cleanup-engine.js';
import { HIGH_IMPORTANCE_THRESHOLD } from '../../src/core/importance.js';
import { buildDefaultConfig } from '../../src/config/default-config.js';
import { FileRepository } from '../../src/storage/repositories/file.repository.js';
import { ChunkRepository } from '../../src/storage/repositories/chunk.repository.js';
import { SymbolRepository } from '../../src/storage/repositories/symbol.repository.js';
import { MemoryRepository } from '../../src/storage/repositories/memory.repository.js';
import { TaskRepository } from '../../src/storage/repositories/task.repository.js';
import { RunRepository } from '../../src/storage/repositories/run.repository.js';
import type { KundunDb, NewChunkRow, NewFileRow } from '../../src/storage/types.js';
import { makeTestDb } from '../helpers/db.js';
import { makeTempProject } from '../helpers/temp-project.js';
import type { TempProject } from '../helpers/temp-project.js';
import { makeSilentLogger } from '../helpers/logger.js';
import { makeClock } from '../helpers/clock.js';

// "Long ago" timestamps for the file/task time gates, which use the REAL clock
// via isoMinusDays() inside the cleanup engine. Year 2000 is comfortably past
// any default retention window (7-day files, 30-day tasks).
const LONG_AGO = '2000-01-01T00:00:00.000Z';
const RECENT = '2099-01-01T00:00:00.000Z'; // far future: never older than any cutoff

function fileRow(over: Partial<NewFileRow> & Pick<NewFileRow, 'relative_path'>): NewFileRow {
  return {
    extension: 'ts',
    language: 'typescript',
    size_bytes: 10,
    last_modified_at: RECENT,
    indexed_at: null,
    is_deleted: 0,
    importance_score: 0,
    ...over,
    // Derived from the (possibly overridden) relative_path; kept after the spread.
    path: `/abs/${over.relative_path}`,
    hash: `hash-${over.relative_path}`,
  };
}

function chunkRow(over: Partial<NewChunkRow>): NewChunkRow {
  return {
    file_id: 0,
    chunk_index: 0,
    content: 'some content',
    content_hash: `c-${Math.random()}`,
    token_estimate: 1,
    start_line: 1,
    end_line: 1,
    created_at: LONG_AGO,
    updated_at: LONG_AGO,
    ...over,
  };
}

describe('cleanup engine (integration)', () => {
  let project: TempProject;
  let kdb: KundunDb;
  let fileRepo: FileRepository;
  let chunkRepo: ChunkRepository;
  let symbolRepo: SymbolRepository;
  let memoryRepo: MemoryRepository;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  const clock = makeClock(new Date('2026-06-13T12:00:00.000Z'));

  // Ids of the seeded fixtures so assertions can target survivors precisely.
  let lowMemoryId: number;
  let highMemoryId: number;
  let oldDeletedFileId: number;
  let activeFileId: number;
  let oldTaskId: number;

  /** Build a cleanup engine; vacuum disabled to keep the in-memory DB stable. */
  function buildEngine(): ReturnType<typeof createCleanupEngine> {
    const config = buildDefaultConfig('cleanup-test');
    config.cleanup.vacuumAfterCleanup = false;
    return createCleanupEngine({
      kdb,
      config,
      kundunDir: project.kundunDir,
      fileRepo,
      chunkRepo,
      symbolRepo,
      memoryRepo,
      taskRepo,
      runRepo,
      logger: makeSilentLogger(),
      now: () => clock.now(),
    });
  }

  beforeEach(() => {
    clock.set(new Date('2026-06-13T12:00:00.000Z'));
    project = makeTempProject();
    kdb = makeTestDb();
    fileRepo = new FileRepository(kdb);
    chunkRepo = new ChunkRepository(kdb);
    symbolRepo = new SymbolRepository(kdb);
    memoryRepo = new MemoryRepository(kdb);
    taskRepo = new TaskRepository(kdb);
    runRepo = new RunRepository(kdb);

    // 1) Old soft-deleted file with a chunk => hard-deleted, chunk cascaded.
    oldDeletedFileId = fileRepo.upsertByRelativePath(
      fileRow({ relative_path: 'src/old.ts', last_modified_at: LONG_AGO }),
    ).id;
    // Retention keys off deleted_at: stamp the deletion long ago so it is past
    // the cutoff and gets hard-deleted (chunk cascaded).
    fileRepo.markDeleted([oldDeletedFileId], LONG_AGO);
    chunkRepo.replaceForFile(oldDeletedFileId, [chunkRow({ content: 'cascaded chunk' })]);

    // 2) Recently soft-deleted file with a chunk => NOT cascaded (deleted just
    //    now, within the grace window), but an orphan chunk (its file is
    //    soft-deleted) => removed via the orphan path.
    const recentDeletedFileId = fileRepo.upsertByRelativePath(
      fileRow({ relative_path: 'src/recent-deleted.ts', last_modified_at: RECENT }),
    ).id;
    fileRepo.markDeleted([recentDeletedFileId], RECENT);
    chunkRepo.replaceForFile(recentDeletedFileId, [chunkRow({ content: 'orphan chunk' })]);

    // 3) Active file with a chunk => must survive untouched.
    activeFileId = fileRepo.upsertByRelativePath(
      fileRow({ relative_path: 'src/active.ts', last_modified_at: RECENT }),
    ).id;
    chunkRepo.replaceForFile(activeFileId, [chunkRow({ content: 'live chunk' })]);

    // 4) Expired low-importance memory => removed.
    const pastExpiry = new Date('2026-06-01T00:00:00.000Z').toISOString();
    lowMemoryId = memoryRepo.add({
      type: 'task',
      title: 'low',
      content: 'expired low importance',
      tags: null,
      source: null,
      confidence: 1,
      importance_score: 10,
      created_at: LONG_AGO,
      updated_at: LONG_AGO,
      last_used_at: null,
      expires_at: pastExpiry,
      archived_at: null,
    });

    // 5) Expired HIGH-importance memory => preserved by construction.
    highMemoryId = memoryRepo.add({
      type: 'task',
      title: 'high',
      content: 'expired high importance',
      tags: null,
      source: null,
      confidence: 1,
      importance_score: HIGH_IMPORTANCE_THRESHOLD,
      created_at: LONG_AGO,
      updated_at: LONG_AGO,
      last_used_at: null,
      expires_at: pastExpiry,
      archived_at: null,
    });

    // 6) Old completed task => archived.
    oldTaskId = taskRepo.create({
      title: 'old done',
      description: null,
      status: 'completed',
      priority: 'medium',
      related_files: null,
      related_memories: null,
      created_at: LONG_AGO,
      updated_at: LONG_AGO,
      completed_at: LONG_AGO,
    });
  });

  afterEach(() => {
    kdb.close();
    project.cleanup();
  });

  function countRows(table: string): number {
    const row = kdb.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  it('dry run reports candidates but mutates NOTHING', () => {
    const beforeFiles = countRows('files');
    const beforeChunks = countRows('file_chunks');
    const beforeMemories = countRows('memories');
    const beforeTasks = countRows('tasks');
    const beforeCleanupRuns = countRows('cleanup_runs');

    const result = buildEngine().run({ dryRun: true });

    // Candidate counts are positive.
    expect(result.dryRun).toBe(true);
    expect(result.removedFiles).toBeGreaterThan(0);
    expect(result.removedChunks).toBeGreaterThan(0);
    expect(result.removedMemories).toBeGreaterThan(0);
    expect(result.archivedTasks).toBeGreaterThan(0);
    expect(result.vacuumExecuted).toBe(false);
    expect(result.cleanupRunId).toBeUndefined();

    // DB is byte-for-byte unchanged (re-count every affected table).
    expect(countRows('files')).toBe(beforeFiles);
    expect(countRows('file_chunks')).toBe(beforeChunks);
    expect(countRows('memories')).toBe(beforeMemories);
    expect(countRows('tasks')).toBe(beforeTasks);

    // D7: a dry run writes NO cleanup_runs row.
    expect(countRows('cleanup_runs')).toBe(beforeCleanupRuns);
    expect(runRepo.lastCleanup()).toBeUndefined();
  });

  it('real run removes only eligible rows and records a cleanup_runs row', () => {
    const result = buildEngine().run({ dryRun: false });

    expect(result.dryRun).toBe(false);

    // Old soft-deleted file is hard-deleted; active and recently-deleted files remain.
    expect(fileRepo.getById(oldDeletedFileId)).toBeUndefined();
    expect(fileRepo.getById(activeFileId)).toBeDefined();
    expect(result.removedFiles).toBe(1);

    // Cascaded chunk + orphan chunk are gone; only the active file's chunk remains.
    const remainingChunks = chunkRepo.getByFile(activeFileId);
    expect(remainingChunks).toHaveLength(1);
    expect(countRows('file_chunks')).toBe(1);
    expect(result.removedChunks).toBe(2);

    // Regression (R1): hard-deleting files must also clear the contentless FTS
    // index — CASCADE does NOT cover chunks_fts. No ghost FTS rowids may remain.
    if (kdb.hasFts5) {
      expect(countRows('chunks_fts')).toBe(countRows('file_chunks'));
      const orphanFts = kdb.db
        .prepare(
          'SELECT COUNT(*) AS n FROM chunks_fts WHERE rowid NOT IN (SELECT id FROM file_chunks)',
        )
        .get() as { n: number };
      expect(orphanFts.n).toBe(0);
    }

    // Expired low-importance memory removed; HIGH-importance expired memory survives.
    expect(memoryRepo.getById(lowMemoryId)).toBeUndefined();
    expect(memoryRepo.getById(highMemoryId)).toBeDefined();
    expect(result.removedMemories).toBe(1);

    // Old completed task archived (not deleted).
    const archived = taskRepo.getById(oldTaskId);
    expect(archived?.status).toBe('archived');
    expect(result.archivedTasks).toBe(1);

    // A single cleanup_runs row is recorded with the engine's clock timestamps.
    expect(result.cleanupRunId).toBeDefined();
    expect(countRows('cleanup_runs')).toBe(1);
    const recorded = runRepo.lastCleanup();
    expect(recorded).toBeDefined();
    expect(recorded?.status).toBe('completed');
    expect(recorded?.removed_files).toBe(1);
    expect(recorded?.removed_memories).toBe(1);
    expect(recorded?.vacuum_executed).toBe(0);
  });
});
