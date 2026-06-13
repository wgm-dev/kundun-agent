// Repository for the `metrics_snapshots` table (migration v5). Stores periodic
// point-in-time metrics samples produced by the metrics engine. better-sqlite3
// is synchronous: no async/await here. The `created_at` stamp comes from
// utils/time.ts (caller may pass the engine's `now()`); the row's own data
// fields are supplied by the caller.

import type { Statement } from 'better-sqlite3';
import type { KundunDb, MetricsSnapshotRow, NewMetricsSnapshotRow } from '../types.js';
import { nowIso } from '../../utils/time.js';

export class MetricsRepository {
  private readonly insertStmt: Statement;
  private readonly latestStmt: Statement;
  private readonly recentStmt: Statement;
  private readonly deleteOlderThanStmt: Statement;

  constructor(kdb: KundunDb) {
    const { db } = kdb;

    this.insertStmt = db.prepare(
      `INSERT INTO metrics_snapshots
         (created_at, active_sessions, indexed_files, indexed_chunks, memory_count,
          task_count, diagnostics_count, db_size_bytes, avg_tool_latency_ms,
          scan_duration_ms, cleanup_duration_ms, errors_last_24h)
       VALUES
         (@createdAt, @activeSessions, @indexedFiles, @indexedChunks, @memoryCount,
          @taskCount, @diagnosticsCount, @dbSizeBytes, @avgToolLatencyMs,
          @scanDurationMs, @cleanupDurationMs, @errorsLast24h)`,
    );

    this.latestStmt = db.prepare(
      'SELECT * FROM metrics_snapshots ORDER BY created_at DESC, id DESC LIMIT 1',
    );

    this.recentStmt = db.prepare(
      'SELECT * FROM metrics_snapshots ORDER BY created_at DESC, id DESC LIMIT @limit',
    );

    this.deleteOlderThanStmt = db.prepare('DELETE FROM metrics_snapshots WHERE created_at < @iso');
  }

  /** Insert a metrics snapshot; returns the new id. `created_at` is stamped here. */
  insertSnapshot(row: NewMetricsSnapshotRow, iso: string = nowIso()): number {
    const info = this.insertStmt.run({
      createdAt: iso,
      activeSessions: row.active_sessions,
      indexedFiles: row.indexed_files,
      indexedChunks: row.indexed_chunks,
      memoryCount: row.memory_count,
      taskCount: row.task_count,
      diagnosticsCount: row.diagnostics_count,
      dbSizeBytes: row.db_size_bytes,
      avgToolLatencyMs: row.avg_tool_latency_ms,
      scanDurationMs: row.scan_duration_ms,
      cleanupDurationMs: row.cleanup_duration_ms,
      errorsLast24h: row.errors_last_24h,
    });
    return Number(info.lastInsertRowid);
  }

  /** Most recent snapshot, or undefined when none exists. */
  latest(): MetricsSnapshotRow | undefined {
    return this.latestStmt.get() as MetricsSnapshotRow | undefined;
  }

  /** Up to `limit` most recent snapshots, newest first. */
  recent(limit: number): MetricsSnapshotRow[] {
    return this.recentStmt.all({ limit }) as MetricsSnapshotRow[];
  }

  /** Delete snapshots older than `iso`; returns the number of rows removed. */
  deleteOlderThan(iso: string): number {
    return this.deleteOlderThanStmt.run({ iso }).changes;
  }
}
