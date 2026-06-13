// Repository for `file_chunks` and its FTS5 mirror (`chunks_fts`).
//
// FTS5 sync is done via EXPLICIT writes inside the SAME transaction as the
// base-table writes (D3) and is guarded by `kdb.hasFts5` (D1). Prepared
// statements and the batch transactions are built ONCE in the constructor.
//
// NOTE: better-sqlite3 is fully synchronous; nothing here is async.

import type { Database, Statement, Transaction } from 'better-sqlite3';
import type { FileChunkRow, KundunDb, NewChunkRow } from '../types.js';
import { toSafeFtsMatch, escapeLike } from '../fts.js';

/** A chunk search result enriched with the owning file's relative path. */
export type ChunkHit = FileChunkRow & { relative_path: string };

/** Outcome of {@link ChunkRepository.replaceForFile}. */
export interface ReplaceChunksResult {
  inserted: number;
  skippedDuplicate: number;
}

/** A chunk row about to be inserted, paired with its caller-supplied order. */
type ReplaceArgs = { fileId: number; chunks: NewChunkRow[] };

export class ChunkRepository {
  private readonly db: Database;
  private readonly hasFts5: boolean;

  private readonly deleteByFileStmt: Statement;
  private readonly deleteFtsByFileStmt: Statement | null;
  private readonly insertChunkStmt: Statement;
  private readonly insertFtsStmt: Statement | null;
  private readonly getByFileStmt: Statement;
  private readonly countAllStmt: Statement;
  private readonly listOrphanIdsStmt: Statement;
  private readonly deleteOrphansStmt: Statement;

  private readonly replaceForFileTxn: Transaction<(args: ReplaceArgs) => ReplaceChunksResult>;

  constructor(kdb: KundunDb) {
    this.db = kdb.db;
    this.hasFts5 = kdb.hasFts5;

    this.deleteByFileStmt = this.db.prepare('DELETE FROM file_chunks WHERE file_id = ?');
    this.deleteFtsByFileStmt = this.hasFts5
      ? this.db.prepare('DELETE FROM chunks_fts WHERE file_id = ?')
      : null;

    this.insertChunkStmt = this.db.prepare(
      `INSERT INTO file_chunks
         (file_id, chunk_index, content, content_hash, token_estimate,
          start_line, end_line, created_at, updated_at)
       VALUES
         (@file_id, @chunk_index, @content, @content_hash, @token_estimate,
          @start_line, @end_line, @created_at, @updated_at)`,
    );
    this.insertFtsStmt = this.hasFts5
      ? this.db.prepare(
          'INSERT INTO chunks_fts (content, file_id, chunk_id) VALUES (@content, @file_id, @chunk_id)',
        )
      : null;

    this.getByFileStmt = this.db.prepare(
      'SELECT * FROM file_chunks WHERE file_id = ? ORDER BY chunk_index ASC',
    );
    this.countAllStmt = this.db.prepare('SELECT COUNT(*) AS n FROM file_chunks');

    // Orphan = chunk whose file row is missing OR soft-deleted.
    this.listOrphanIdsStmt = this.db.prepare(
      `SELECT fc.id AS id
         FROM file_chunks fc
         LEFT JOIN files f ON f.id = fc.file_id
        WHERE f.id IS NULL OR f.is_deleted = 1`,
    );
    this.deleteOrphansStmt = this.db.prepare(
      `DELETE FROM file_chunks
        WHERE file_id NOT IN (SELECT id FROM files WHERE is_deleted = 0)`,
    );

    // Build the batch replace transaction ONCE.
    this.replaceForFileTxn = this.db.transaction((args: ReplaceArgs): ReplaceChunksResult => {
      const { fileId, chunks } = args;

      this.deleteByFileStmt.run(fileId);
      if (this.deleteFtsByFileStmt) {
        this.deleteFtsByFileStmt.run(fileId);
      }

      let inserted = 0;
      let skippedDuplicate = 0;
      const seen = new Set<string>();

      for (const chunk of chunks) {
        // Skip exact duplicate content within THIS file only.
        if (seen.has(chunk.content_hash)) {
          skippedDuplicate += 1;
          continue;
        }
        seen.add(chunk.content_hash);

        const info = this.insertChunkStmt.run({
          file_id: fileId,
          chunk_index: chunk.chunk_index,
          content: chunk.content,
          content_hash: chunk.content_hash,
          token_estimate: chunk.token_estimate,
          start_line: chunk.start_line,
          end_line: chunk.end_line,
          created_at: chunk.created_at,
          updated_at: chunk.updated_at,
        });

        if (this.insertFtsStmt) {
          this.insertFtsStmt.run({
            content: chunk.content,
            file_id: fileId,
            chunk_id: Number(info.lastInsertRowid),
          });
        }

        inserted += 1;
      }

      return { inserted, skippedDuplicate };
    });
  }

  /**
   * Replace ALL chunks for a file in one transaction: delete existing rows
   * (and FTS rows), then insert the new chunks, skipping exact duplicate
   * `content_hash` values within this file.
   */
  replaceForFile(fileId: number, chunks: NewChunkRow[]): ReplaceChunksResult {
    return this.replaceForFileTxn({ fileId, chunks });
  }

  /** Delete every chunk for a file. FK ON DELETE CASCADE does not cover FTS. */
  deleteForFile(fileId: number): number {
    if (this.deleteFtsByFileStmt) {
      this.deleteFtsByFileStmt.run(fileId);
    }
    const info = this.deleteByFileStmt.run(fileId);
    return info.changes;
  }

  /** All chunks for a file, ordered by `chunk_index`. */
  getByFile(fileId: number): FileChunkRow[] {
    return this.getByFileStmt.all(fileId) as FileChunkRow[];
  }

  /**
   * Full-text search over chunk content (FTS5). The query is sanitized into a
   * safe MATCH expression so arbitrary user input cannot trigger FTS syntax
   * errors. The last term is treated as a prefix (`"term"*`) so partial
   * identifiers match (e.g. `Payment` finds `PaymentService`). When the prefix
   * MATCH yields nothing, falls back to a literal LIKE substring search so an
   * agent never gets a misleading empty result for text that is clearly
   * present. Returns an empty array when FTS5 is unavailable or the query has
   * no usable terms.
   */
  searchFts(query: string, limit: number): ChunkHit[] {
    if (!this.hasFts5) {
      return [];
    }
    const match = toSafeFtsMatch(query, { prefix: true });
    if (match === null) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT fc.*, files.relative_path AS relative_path
           FROM chunks_fts
           JOIN file_chunks fc ON fc.id = chunks_fts.chunk_id
           JOIN files ON files.id = fc.file_id
          WHERE chunks_fts MATCH ?
            AND files.is_deleted = 0
          ORDER BY bm25(chunks_fts)
          LIMIT ?`,
      )
      .all(match, limit) as ChunkHit[];

    // Prefix MATCH can still miss substrings that are not token-prefixes
    // (e.g. a query that appears mid-token). Fall back to LIKE so "clearly
    // present" text is found rather than silently returning nothing.
    if (rows.length === 0) {
      return this.searchLike(query, limit);
    }
    return rows;
  }

  /**
   * Fallback substring search when FTS5 is unavailable. Escapes LIKE
   * metacharacters so the query is matched literally, and ranks by file
   * importance.
   */
  searchLike(query: string, limit: number): ChunkHit[] {
    const escaped = escapeLike(query);
    const rows = this.db
      .prepare(
        `SELECT fc.*, files.relative_path AS relative_path
           FROM file_chunks fc
           JOIN files ON files.id = fc.file_id
          WHERE fc.content LIKE '%' || ? || '%' ESCAPE '\\'
            AND files.is_deleted = 0
          ORDER BY files.importance_score DESC
          LIMIT ?`,
      )
      .all(escaped, limit);
    return rows as ChunkHit[];
  }

  /** Total number of chunk rows. */
  countAll(): number {
    const row = this.countAllStmt.get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Ids of chunks whose file is missing or soft-deleted. */
  listOrphanIds(): number[] {
    const rows = this.listOrphanIdsStmt.all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /**
   * Delete all orphaned chunks (file missing or soft-deleted) in one batch.
   * Also clears the matching FTS rows when FTS5 is available.
   */
  deleteOrphans(): number {
    const run = this.db.transaction((): number => {
      if (this.hasFts5) {
        this.db
          .prepare(
            `DELETE FROM chunks_fts
              WHERE file_id NOT IN (SELECT id FROM files WHERE is_deleted = 0)`,
          )
          .run();
      }
      const info = this.deleteOrphansStmt.run();
      return info.changes;
    });
    return run();
  }
}
