// Repository for the `files` table. Owns all CRUD/upsert/soft-delete/hard-delete
// SQL for tracked files. Statements are prepared once in the constructor.
//
// better-sqlite3 is fully synchronous — no async/await anywhere in this file.

import type { KundunDb, FileRow, NewFileRow } from '../types.js';
import { nowIso } from '../../utils/time.js';

// SQLite has a hard limit of 999 bind parameters per statement (SQLITE_MAX_VARIABLE_NUMBER
// on older builds). Keep batched IN(...) clauses well under that.
const MAX_PARAMS_PER_CHUNK = 500;

/** Lightweight projection used by listAllRelativePaths for cheap diffing. */
interface RelativePathInfoRow {
  relative_path: string;
  id: number;
  hash: string;
  is_deleted: number;
}

/** Persistence for the `files` table. */
export class FileRepository {
  private readonly db: KundunDb['db'];

  // Prepared statements (created once; reused per call).
  private readonly stmtGetByRelativePath;
  private readonly stmtGetById;
  private readonly stmtUpsert;
  private readonly stmtListActive;
  private readonly stmtListAllRelativePaths;
  private readonly stmtSetIndexedAt;
  private readonly stmtUpdateImportance;
  private readonly stmtListDeletedOlderThan;
  private readonly stmtCountActive;

  constructor(kdb: KundunDb) {
    this.db = kdb.db;

    this.stmtGetByRelativePath = this.db.prepare<[string], FileRow>(
      'SELECT * FROM files WHERE relative_path = ?',
    );

    this.stmtGetById = this.db.prepare<[number], FileRow>('SELECT * FROM files WHERE id = ?');

    // Insert or update by the UNIQUE relative_path. On conflict, refresh the
    // mutable columns and clear the soft-delete flag (a re-seen file is active).
    this.stmtUpsert = this.db.prepare<
      [string, string, string | null, string | null, number, string, string],
      unknown
    >(
      `INSERT INTO files (
         path, relative_path, extension, language, size_bytes, hash,
         last_modified_at, is_deleted, importance_score
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
       ON CONFLICT(relative_path) DO UPDATE SET
         path = excluded.path,
         extension = excluded.extension,
         language = excluded.language,
         size_bytes = excluded.size_bytes,
         hash = excluded.hash,
         last_modified_at = excluded.last_modified_at,
         is_deleted = 0,
         deleted_at = NULL`,
    );

    this.stmtListActive = this.db.prepare<[], FileRow>('SELECT * FROM files WHERE is_deleted = 0');

    this.stmtListAllRelativePaths = this.db.prepare<[], RelativePathInfoRow>(
      'SELECT relative_path, id, hash, is_deleted FROM files',
    );

    this.stmtSetIndexedAt = this.db.prepare<[string, number], unknown>(
      'UPDATE files SET indexed_at = ? WHERE id = ?',
    );

    this.stmtUpdateImportance = this.db.prepare<[number, number], unknown>(
      'UPDATE files SET importance_score = ? WHERE id = ?',
    );

    // Soft-deleted files whose DELETION predates `iso`. deleted_at is the
    // authoritative retention key; legacy rows soft-deleted before the
    // deleted_at column existed have NULL and fall back to last_modified_at so
    // they still eventually clean up.
    this.stmtListDeletedOlderThan = this.db.prepare<[string], FileRow>(
      `SELECT * FROM files
        WHERE is_deleted = 1
          AND COALESCE(deleted_at, last_modified_at) < ?`,
    );

    this.stmtCountActive = this.db.prepare<[], { n: number }>(
      'SELECT COUNT(*) AS n FROM files WHERE is_deleted = 0',
    );
  }

  /**
   * Insert a new file or update the existing one with the same relative_path.
   * Returns the current row id and whether anything meaningfully changed:
   * changed = brand-new row, OR stored hash differs, OR it was previously
   * soft-deleted (is_deleted = 1) and is now resurrected.
   */
  upsertByRelativePath(row: NewFileRow): { id: number; changed: boolean } {
    const existing = this.stmtGetByRelativePath.get(row.relative_path);
    const changed =
      existing === undefined || existing.hash !== row.hash || existing.is_deleted === 1;

    this.stmtUpsert.run(
      row.path,
      row.relative_path,
      row.extension,
      row.language,
      row.size_bytes,
      row.hash,
      row.last_modified_at,
    );

    if (existing !== undefined) {
      return { id: existing.id, changed };
    }

    // New row: read back its assigned id by relative_path (UNIQUE).
    const inserted = this.stmtGetByRelativePath.get(row.relative_path);
    if (inserted === undefined) {
      // Should be unreachable: we just inserted this row in the same connection.
      throw new Error(`Upserted file row not found by relative_path: ${row.relative_path}`);
    }
    return { id: inserted.id, changed };
  }

  /** Fetch a file by its (UNIQUE) relative path, or undefined when absent. */
  getByRelativePath(rel: string): FileRow | undefined {
    return this.stmtGetByRelativePath.get(rel);
  }

  /** Fetch a file by primary key, or undefined when absent. */
  getById(id: number): FileRow | undefined {
    return this.stmtGetById.get(id);
  }

  /** All non-deleted files. */
  listActive(): FileRow[] {
    return this.stmtListActive.all();
  }

  /**
   * Map of relative_path -> { id, hash, is_deleted } for every file (including
   * soft-deleted). Used by the indexer to diff the working tree against the DB.
   */
  listAllRelativePaths(): Map<string, { id: number; hash: string; is_deleted: number }> {
    const out = new Map<string, { id: number; hash: string; is_deleted: number }>();
    for (const r of this.stmtListAllRelativePaths.all()) {
      out.set(r.relative_path, { id: r.id, hash: r.hash, is_deleted: r.is_deleted });
    }
    return out;
  }

  /**
   * Soft-delete the given file ids (is_deleted = 1) and stamp deleted_at with
   * `iso`, batching to stay under the SQLite bind-parameter limit. deleted_at is
   * only set when not already present (COALESCE), so re-scanning an
   * already-deleted file does not reset its retention clock. Returns the total
   * number of affected rows.
   */
  markDeleted(ids: number[], iso: string = nowIso()): number {
    if (ids.length === 0) {
      return 0;
    }
    let affected = 0;
    for (let i = 0; i < ids.length; i += MAX_PARAMS_PER_CHUNK) {
      const chunk = ids.slice(i, i + MAX_PARAMS_PER_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const stmt = this.db.prepare(
        `UPDATE files
            SET is_deleted = 1,
                deleted_at = COALESCE(deleted_at, ?)
          WHERE id IN (${placeholders})`,
      );
      affected += stmt.run(iso, ...chunk).changes;
    }
    return affected;
  }

  /** Record when a file was last indexed (ISO-8601 UTC from utils/time). */
  setIndexedAt(id: number, iso: string): void {
    this.stmtSetIndexedAt.run(iso, id);
  }

  /** Overwrite a file's importance score (0..100 integer in a REAL column). */
  updateImportance(id: number, score: number): void {
    this.stmtUpdateImportance.run(score, id);
  }

  /**
   * Soft-deleted files whose last_modified_at is strictly older than `iso`.
   * Candidates for hard deletion during cleanup.
   */
  listDeletedOlderThan(iso: string): FileRow[] {
    return this.stmtListDeletedOlderThan.all(iso);
  }

  /**
   * Permanently delete the given file ids, batching to stay under the SQLite
   * bind-parameter limit. ON DELETE CASCADE removes dependent chunks/symbols.
   * Returns the total number of deleted rows.
   */
  deleteHard(ids: number[]): number {
    if (ids.length === 0) {
      return 0;
    }
    let deleted = 0;
    for (let i = 0; i < ids.length; i += MAX_PARAMS_PER_CHUNK) {
      const chunk = ids.slice(i, i + MAX_PARAMS_PER_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const stmt = this.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`);
      deleted += stmt.run(...chunk).changes;
    }
    return deleted;
  }

  /** Count of non-deleted files. */
  countActive(): number {
    const row = this.stmtCountActive.get();
    return row?.n ?? 0;
  }
}
