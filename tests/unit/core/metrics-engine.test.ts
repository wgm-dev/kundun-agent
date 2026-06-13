// MetricsEngine tests: snapshot() samples the live database and the in-memory
// session registry, persists a metrics_snapshots row, and returns it. Asserts the
// counts (files/chunks/memory/tasks/diagnostics), db_size_bytes > 0 (the PRAGMA
// page_count * page_size probe), and errors_last_24h sourced from the shared
// helper. The persisted row equals what latest() returns. Clock injected.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMetricsEngine } from '../../../src/core/metrics-engine.js';
import { FileRepository } from '../../../src/storage/repositories/file.repository.js';
import { ChunkRepository } from '../../../src/storage/repositories/chunk.repository.js';
import { MemoryRepository } from '../../../src/storage/repositories/memory.repository.js';
import { RunRepository } from '../../../src/storage/repositories/run.repository.js';
import { HealthRepository } from '../../../src/storage/repositories/health.repository.js';
import { MetricsRepository } from '../../../src/storage/repositories/metrics.repository.js';
import { DiagnosticRepository } from '../../../src/storage/repositories/diagnostic.repository.js';
import { createTestDb, insertFile, type TestDb } from '../../helpers/test-db.js';
import { nowIso } from '../../../src/utils/time.js';
import type { NewChunkRow, NewMemoryRow } from '../../../src/storage/types.js';

/** A stub session registry exposing just the two methods the engine reads. */
function stubRegistry(active: number, avgLatency: number | null) {
  return {
    activeCount: () => active,
    avgToolLatencyMs: () => avgLatency,
  };
}

function makeChunk(fileId: number, idx: number): NewChunkRow {
  const iso = nowIso();
  return {
    file_id: fileId,
    chunk_index: idx,
    content: `chunk-${idx}`,
    content_hash: `h${idx}`,
    token_estimate: 1,
    start_line: 1,
    end_line: 2,
    created_at: iso,
    updated_at: iso,
  };
}

function makeMemory(title: string): NewMemoryRow {
  const iso = nowIso();
  return {
    type: 'decision',
    title,
    content: 'body',
    tags: null,
    source: null,
    confidence: 1,
    importance_score: 0,
    created_at: iso,
    updated_at: iso,
    last_used_at: null,
    expires_at: null,
    archived_at: null,
  };
}

describe('MetricsEngine', () => {
  let t: TestDb;
  let fileRepo: FileRepository;
  let chunkRepo: ChunkRepository;
  let memoryRepo: MemoryRepository;
  let runRepo: RunRepository;
  let healthRepo: HealthRepository;
  let metricsRepo: MetricsRepository;
  let diagnosticRepo: DiagnosticRepository;

  beforeEach(() => {
    t = createTestDb();
    fileRepo = new FileRepository(t.kdb);
    chunkRepo = new ChunkRepository(t.kdb);
    memoryRepo = new MemoryRepository(t.kdb);
    runRepo = new RunRepository(t.kdb);
    healthRepo = new HealthRepository(t.kdb);
    metricsRepo = new MetricsRepository(t.kdb);
    diagnosticRepo = new DiagnosticRepository(t.kdb);
  });

  afterEach(() => {
    t.cleanup();
  });

  it('snapshot() captures live counts, db_size_bytes>0, errors from the shared helper, and persists the row', () => {
    const iso = '2026-06-13T12:00:00.000Z';

    // Seed two active files; one carries chunks.
    const f1 = insertFile(t.kdb, { relative_path: 'src/a.ts' });
    insertFile(t.kdb, { relative_path: 'src/b.ts' });
    chunkRepo.replaceForFile(f1, [makeChunk(f1, 0), makeChunk(f1, 1)]);

    // Two memories, one task, one diagnostic.
    memoryRepo.add(makeMemory('m1'));
    memoryRepo.add(makeMemory('m2'));
    t.kdb.db
      .prepare(
        `INSERT INTO tasks (title, status, priority, created_at, updated_at)
         VALUES ('task-1', 'pending', 'medium', ?, ?)`,
      )
      .run(iso, iso);
    diagnosticRepo.insertGlobal({
      file_id: null,
      language: null,
      severity: 'error',
      code: null,
      message: 'global diag',
      line: null,
      column: null,
      source: 'test',
      resolved_at: null,
    });

    // One error health event inside the 24h window feeds errors_last_24h.
    healthRepo.record({ source: 'scanner', severity: 'error', message: 'boom' }, iso);

    const engine = createMetricsEngine({
      repos: {
        file: fileRepo,
        chunk: chunkRepo,
        memory: memoryRepo,
        run: runRepo,
        health: healthRepo,
      },
      kdb: t.kdb,
      sessionRegistry: stubRegistry(3, 17.5),
      metricsRepo,
      now: () => iso,
    });

    const snap = engine.snapshot();

    expect(snap.created_at).toBe(iso);
    expect(snap.active_sessions).toBe(3);
    expect(snap.indexed_files).toBe(2);
    expect(snap.indexed_chunks).toBe(2);
    expect(snap.memory_count).toBe(2);
    expect(snap.task_count).toBe(1);
    expect(snap.diagnostics_count).toBe(1);
    expect(snap.db_size_bytes).toBeGreaterThan(0);
    expect(snap.avg_tool_latency_ms).toBe(17.5);
    // One error health event in window; no scan runs with errors.
    expect(snap.errors_last_24h).toBe(1);

    // The returned row equals the persisted latest() row.
    const latest = metricsRepo.latest();
    expect(latest?.id).toBe(snap.id);
    expect(latest?.indexed_files).toBe(2);
    expect(latest?.indexed_chunks).toBe(2);
    expect(latest?.errors_last_24h).toBe(1);
    expect(latest?.db_size_bytes).toBe(snap.db_size_bytes);
  });

  it('db_size_bytes uses the live PRAGMA probe (page_count * page_size)', () => {
    const iso = '2026-06-13T12:00:00.000Z';
    const engine = createMetricsEngine({
      repos: {
        file: fileRepo,
        chunk: chunkRepo,
        memory: memoryRepo,
        run: runRepo,
        health: healthRepo,
      },
      kdb: t.kdb,
      sessionRegistry: stubRegistry(0, null),
      metricsRepo,
      now: () => iso,
    });

    const pageCount = t.kdb.db.pragma('page_count', { simple: true }) as number;
    const pageSize = t.kdb.db.pragma('page_size', { simple: true }) as number;

    expect(engine.snapshot().db_size_bytes).toBe(pageCount * pageSize);
  });

  it('uses an injected errorsLast24h helper when provided', () => {
    const iso = '2026-06-13T12:00:00.000Z';
    let calledWithNow: string | undefined;
    const engine = createMetricsEngine({
      repos: {
        file: fileRepo,
        chunk: chunkRepo,
        memory: memoryRepo,
        run: runRepo,
        health: healthRepo,
      },
      kdb: t.kdb,
      sessionRegistry: stubRegistry(0, null),
      metricsRepo,
      errorsLast24h: (_deps, now) => {
        calledWithNow = now;
        return 42;
      },
      now: () => iso,
    });

    const snap = engine.snapshot();
    expect(snap.errors_last_24h).toBe(42);
    expect(calledWithNow).toBe(iso);
  });

  it('reports null scan/cleanup durations and zero counts on an empty database', () => {
    const iso = '2026-06-13T12:00:00.000Z';
    const engine = createMetricsEngine({
      repos: {
        file: fileRepo,
        chunk: chunkRepo,
        memory: memoryRepo,
        run: runRepo,
        health: healthRepo,
      },
      kdb: t.kdb,
      sessionRegistry: stubRegistry(0, null),
      metricsRepo,
      now: () => iso,
    });

    const snap = engine.snapshot();
    expect(snap.indexed_files).toBe(0);
    expect(snap.indexed_chunks).toBe(0);
    expect(snap.memory_count).toBe(0);
    expect(snap.task_count).toBe(0);
    expect(snap.diagnostics_count).toBe(0);
    expect(snap.scan_duration_ms).toBeNull();
    expect(snap.cleanup_duration_ms).toBeNull();
    expect(snap.avg_tool_latency_ms).toBeNull();
    expect(snap.errors_last_24h).toBe(0);
  });
});
