// Repository for the `scan_runs` and `cleanup_runs` audit tables. Records the
// lifecycle of scan and cleanup operations. better-sqlite3 is synchronous: no
// async/await here. All timestamps come from utils/time.ts.

import type { Statement } from 'better-sqlite3';
import type { CleanupRunRow, KundunDb, ScanRunRow } from '../types.js';
import { durationMs, nowIso } from '../../utils/time.js';

/** Fields recorded when a scan finishes. */
export interface FinishScanFields {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  errorsCount: number;
  status: string;
  startedAtIso: string;
}

/** Fields recorded when a cleanup finishes (start/finish form). */
export interface FinishCleanupFields {
  removedChunks: number;
  removedFiles: number;
  removedMemories: number;
  vacuumExecuted: boolean;
  status: string;
  startedAtIso: string;
}

/** Fields for recording an already-finished cleanup in a single INSERT. */
export interface RecordCleanupFields {
  startedAtIso: string;
  finishedAtIso: string;
  removedChunks: number;
  removedFiles: number;
  removedMemories: number;
  vacuumExecuted: boolean;
  status: string;
}

/**
 * Reads and writes scan/cleanup run rows. A scan/cleanup typically calls
 * `start*` to open a 'running' row, then `finish*` to fill in counts and
 * duration. The real cleanup engine that computes everything up front may
 * instead call {@link RunRepository.recordCleanup} for a single write (D7).
 */
export class RunRepository {
  private readonly startScanStmt: Statement;
  private readonly finishScanStmt: Statement;
  private readonly startCleanupStmt: Statement;
  private readonly finishCleanupStmt: Statement;
  private readonly recordCleanupStmt: Statement;
  private readonly lastScanStmt: Statement;
  private readonly lastCleanupStmt: Statement;
  private readonly recentScansStmt: Statement;

  constructor(kdb: KundunDb) {
    const { db } = kdb;

    this.startScanStmt = db.prepare(
      `INSERT INTO scan_runs (started_at, status) VALUES (@startedAt, 'running')`,
    );

    this.finishScanStmt = db.prepare(
      `UPDATE scan_runs
         SET finished_at = @finishedAt,
             files_scanned = @filesScanned,
             files_indexed = @filesIndexed,
             files_skipped = @filesSkipped,
             errors_count = @errorsCount,
             duration_ms = @durationMs,
             status = @status
       WHERE id = @id`,
    );

    this.startCleanupStmt = db.prepare(
      `INSERT INTO cleanup_runs (started_at, status) VALUES (@startedAt, 'running')`,
    );

    this.finishCleanupStmt = db.prepare(
      `UPDATE cleanup_runs
         SET finished_at = @finishedAt,
             removed_chunks = @removedChunks,
             removed_files = @removedFiles,
             removed_memories = @removedMemories,
             vacuum_executed = @vacuumExecuted,
             duration_ms = @durationMs,
             status = @status
       WHERE id = @id`,
    );

    this.recordCleanupStmt = db.prepare(
      `INSERT INTO cleanup_runs
         (started_at, finished_at, removed_chunks, removed_files, removed_memories,
          vacuum_executed, duration_ms, status)
       VALUES
         (@startedAt, @finishedAt, @removedChunks, @removedFiles, @removedMemories,
          @vacuumExecuted, @durationMs, @status)`,
    );

    this.lastScanStmt = db.prepare('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 1');
    this.lastCleanupStmt = db.prepare(
      'SELECT * FROM cleanup_runs ORDER BY started_at DESC LIMIT 1',
    );
    this.recentScansStmt = db.prepare(
      'SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT @limit',
    );
  }

  /** Open a 'running' scan row and return its id. */
  startScan(): number {
    const info = this.startScanStmt.run({ startedAt: nowIso() });
    return Number(info.lastInsertRowid);
  }

  /** Finalize a scan row: set counts, status, finished_at and computed duration. */
  finishScan(id: number, fields: FinishScanFields): void {
    this.finishScanStmt.run({
      id,
      finishedAt: nowIso(),
      filesScanned: fields.filesScanned,
      filesIndexed: fields.filesIndexed,
      filesSkipped: fields.filesSkipped,
      errorsCount: fields.errorsCount,
      durationMs: durationMs(fields.startedAtIso),
      status: fields.status,
    });
  }

  /** Open a 'running' cleanup row and return its id. */
  startCleanup(): number {
    const info = this.startCleanupStmt.run({ startedAt: nowIso() });
    return Number(info.lastInsertRowid);
  }

  /** Finalize a cleanup row: set counts, status, finished_at and computed duration. */
  finishCleanup(id: number, fields: FinishCleanupFields): void {
    this.finishCleanupStmt.run({
      id,
      finishedAt: nowIso(),
      removedChunks: fields.removedChunks,
      removedFiles: fields.removedFiles,
      removedMemories: fields.removedMemories,
      vacuumExecuted: fields.vacuumExecuted ? 1 : 0,
      durationMs: durationMs(fields.startedAtIso),
      status: fields.status,
    });
  }

  /**
   * Record an already-finished cleanup in a single INSERT and return its id.
   * Used by the real cleanup that computes everything then writes once (D7).
   */
  recordCleanup(fields: RecordCleanupFields): number {
    const info = this.recordCleanupStmt.run({
      startedAt: fields.startedAtIso,
      finishedAt: fields.finishedAtIso,
      removedChunks: fields.removedChunks,
      removedFiles: fields.removedFiles,
      removedMemories: fields.removedMemories,
      vacuumExecuted: fields.vacuumExecuted ? 1 : 0,
      durationMs: durationMs(fields.startedAtIso, fields.finishedAtIso),
      status: fields.status,
    });
    return Number(info.lastInsertRowid);
  }

  /** Most recent scan run, or undefined when none exists. */
  lastScan(): ScanRunRow | undefined {
    return this.lastScanStmt.get() as ScanRunRow | undefined;
  }

  /** Most recent cleanup run, or undefined when none exists. */
  lastCleanup(): CleanupRunRow | undefined {
    return this.lastCleanupStmt.get() as CleanupRunRow | undefined;
  }

  /** Up to `limit` most recent scan runs, newest first. */
  recentScans(limit: number): ScanRunRow[] {
    return this.recentScansStmt.all({ limit }) as ScanRunRow[];
  }
}
