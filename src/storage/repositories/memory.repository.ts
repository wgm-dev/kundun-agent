// Repository for the `memories` table (+ optional `memories_fts` mirror).
// FTS5 writes are explicit (D3) and only performed when hasFts5 is true (D1).
// `tags` is stored as a JSON string array; archived memories (archived_at != null)
// are excluded from search and listImportant (D9).

import type { Statement } from 'better-sqlite3';
import type { KundunDb, MemoryRow, NewMemoryRow } from '../types.js';
import { stringifyArray } from '../../utils/json.js';
import { nowIso } from '../../utils/time.js';
import { toSafeFtsMatch, escapeLike } from '../fts.js';

/** Patch shape accepted by {@link MemoryRepository.update}. */
export interface MemoryUpdatePatch {
  type?: MemoryRow['type'];
  title?: string;
  content?: string;
  /** Tags as a string array; serialized to JSON for storage. */
  tags?: string[];
  source?: string | null;
  confidence?: number;
  importance_score?: number;
  expires_at?: string | null;
}

/** Options for the search methods. */
export interface MemorySearchOptions {
  query?: string;
  type?: string;
  tags?: string[];
  limit?: number;
}

/** Columns that {@link MemoryRepository.update} is allowed to mutate. */
const MUTABLE_COLUMNS = [
  'type',
  'title',
  'content',
  'tags',
  'source',
  'confidence',
  'importance_score',
  'expires_at',
] as const;

const DEFAULT_SEARCH_LIMIT = 20;

export class MemoryRepository {
  private readonly kdb: KundunDb;

  constructor(kdb: KundunDb) {
    this.kdb = kdb;
  }

  /** Insert a new memory; returns the new id. Mirrors the row into FTS when available. */
  add(row: NewMemoryRow): number {
    const now = nowIso();
    const created = row.created_at || now;
    const updated = row.updated_at || now;

    const insert = this.kdb.db.prepare(
      `INSERT INTO memories
         (type, title, content, tags, source, confidence, importance_score,
          created_at, updated_at, last_used_at, expires_at, archived_at)
       VALUES
         (@type, @title, @content, @tags, @source, @confidence, @importance_score,
          @created_at, @updated_at, @last_used_at, @expires_at, @archived_at)`,
    );

    const run = this.kdb.db.transaction((): number => {
      const info = insert.run({
        type: row.type,
        title: row.title,
        content: row.content,
        tags: row.tags,
        source: row.source,
        confidence: row.confidence,
        importance_score: row.importance_score,
        created_at: created,
        updated_at: updated,
        last_used_at: row.last_used_at,
        expires_at: row.expires_at,
        archived_at: row.archived_at,
      });
      const id = Number(info.lastInsertRowid);
      if (this.kdb.hasFts5 && row.archived_at == null) {
        this.insertFts(id, row.title, row.content, row.tags);
      }
      return id;
    });

    return run();
  }

  /**
   * Dynamic, whitelisted SET update. Always bumps updated_at. When title/content/
   * tags change and FTS is available, rewrites the FTS row.
   */
  update(id: number, patch: MemoryUpdatePatch): void {
    const assignments: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const col of MUTABLE_COLUMNS) {
      if (!(col in patch)) {
        continue;
      }
      if (col === 'tags') {
        const tags = patch.tags;
        params[col] = tags === undefined ? null : stringifyArray(tags);
      } else {
        params[col] = patch[col];
      }
      assignments.push(`${col} = @${col}`);
    }

    const updated = nowIso();
    params['updated_at'] = updated;
    assignments.push('updated_at = @updated_at');

    const ftsTouched =
      this.kdb.hasFts5 && ('title' in patch || 'content' in patch || 'tags' in patch);

    const run = this.kdb.db.transaction((): void => {
      this.kdb.db
        .prepare(`UPDATE memories SET ${assignments.join(', ')} WHERE id = @id`)
        .run(params);

      if (ftsTouched) {
        const current = this.getById(id);
        // Only re-sync FTS for non-archived memories (archived rows are not indexed).
        if (current && current.archived_at == null) {
          this.deleteFts(id);
          this.insertFts(id, current.title, current.content, current.tags);
        }
      }
    });

    run();
  }

  /** Fetch a memory by id, or undefined when not found. */
  getById(id: number): MemoryRow | undefined {
    const row = this.kdb.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | MemoryRow
      | undefined;
    return row;
  }

  /**
   * Full-text search via memories_fts when a query is given; otherwise falls back
   * to the most recent memories. Always excludes archived rows and applies the
   * optional type/tags filters. Requires hasFts5 for the MATCH path; when FTS is
   * unavailable this delegates to {@link searchLike}.
   */
  searchFts(opts: MemorySearchOptions): MemoryRow[] {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const query = opts.query?.trim();

    if (query == null || query.length === 0) {
      return this.recent(opts, limit);
    }
    if (!this.kdb.hasFts5) {
      return this.searchLike(opts);
    }

    // Sanitize user input into a safe MATCH expression (prefix on the last
    // term). Raw input must never reach MATCH — a dotted filename or an FTS
    // operator like `col:foo` would otherwise raise a SQLite error or act as
    // an injection. When nothing usable remains, fall back to recent memories.
    const match = toSafeFtsMatch(query, { prefix: true });
    if (match === null) {
      return this.recent(opts, limit);
    }

    const where: string[] = ['m.archived_at IS NULL'];
    const params: Record<string, unknown> = { query: match, limit };
    this.applyFilters(opts, where, params);

    const sql = `
      SELECT m.*
      FROM memories_fts f
      JOIN memories m ON m.id = f.memory_id
      WHERE f.memories_fts MATCH @query
        AND ${where.join(' AND ')}
      ORDER BY bm25(memories_fts) ASC, m.importance_score DESC, m.last_used_at DESC
      LIMIT @limit`;

    return this.kdb.db.prepare(sql).all(params) as MemoryRow[];
  }

  /**
   * LIKE-based fallback search on title/content (wildcards escaped). Excludes
   * archived rows, applies filters, ordered by importance then recency of use.
   */
  searchLike(opts: MemorySearchOptions): MemoryRow[] {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const query = opts.query?.trim();

    const where: string[] = ['m.archived_at IS NULL'];
    const params: Record<string, unknown> = { limit };

    if (query != null && query.length > 0) {
      params['like'] = `%${escapeLike(query)}%`;
      where.push("(m.title LIKE @like ESCAPE '\\' OR m.content LIKE @like ESCAPE '\\')");
    }
    this.applyFilters(opts, where, params);

    const sql = `
      SELECT m.*
      FROM memories m
      WHERE ${where.join(' AND ')}
      ORDER BY m.importance_score DESC, m.last_used_at DESC
      LIMIT @limit`;

    return this.kdb.db.prepare(sql).all(params) as MemoryRow[];
  }

  /**
   * Highest-importance, non-archived memories at or above `minScore` (default 0),
   * ordered by importance then recency of use.
   */
  listImportant(limit: number, minScore = 0): MemoryRow[] {
    const sql = `
      SELECT *
      FROM memories
      WHERE archived_at IS NULL AND importance_score >= @minScore
      ORDER BY importance_score DESC, last_used_at DESC
      LIMIT @limit`;
    return this.kdb.db.prepare(sql).all({ minScore, limit }) as MemoryRow[];
  }

  /** Update last_used_at to the given ISO timestamp. */
  touchUsed(id: number, iso: string): void {
    this.kdb.db.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?').run(iso, id);
  }

  /** Set the importance score (0..100) and bump updated_at. */
  setImportance(id: number, score: number): void {
    this.kdb.db
      .prepare('UPDATE memories SET importance_score = ?, updated_at = ? WHERE id = ?')
      .run(score, nowIso(), id);
  }

  /** Soft-archive a memory: set archived_at + updated_at and drop its FTS row. */
  archive(id: number, iso: string): void {
    const run = this.kdb.db.transaction((): void => {
      this.kdb.db
        .prepare('UPDATE memories SET archived_at = ?, updated_at = ? WHERE id = ?')
        .run(iso, iso, id);
      if (this.kdb.hasFts5) {
        this.deleteFts(id);
      }
    });
    run();
  }

  /** Permanently delete a memory and its FTS row. */
  deleteHard(id: number): void {
    const run = this.kdb.db.transaction((): void => {
      if (this.kdb.hasFts5) {
        this.deleteFts(id);
      }
      this.kdb.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    });
    run();
  }

  /**
   * Expired, low-importance, non-archived memories — cleanup candidates. By
   * construction never returns high-importance or non-expiring (expires_at NULL)
   * memories.
   */
  listExpiredLowImportance(nowIsoStr: string, importanceThreshold: number): MemoryRow[] {
    const sql = `
      SELECT *
      FROM memories
      WHERE archived_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at < @now
        AND importance_score < @threshold
      ORDER BY expires_at ASC`;
    return this.kdb.db
      .prepare(sql)
      .all({ now: nowIsoStr, threshold: importanceThreshold }) as MemoryRow[];
  }

  /** Count of non-archived memories. */
  countAll(): number {
    const row = this.kdb.db
      .prepare('SELECT COUNT(*) AS c FROM memories WHERE archived_at IS NULL')
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  // --- internal helpers ---

  /** Most recent non-archived memories, used as the no-query fallback. */
  private recent(opts: MemorySearchOptions, limit: number): MemoryRow[] {
    const where: string[] = ['m.archived_at IS NULL'];
    const params: Record<string, unknown> = { limit };
    this.applyFilters(opts, where, params);

    const sql = `
      SELECT m.*
      FROM memories m
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT @limit`;
    return this.kdb.db.prepare(sql).all(params) as MemoryRow[];
  }

  /** Append type/tags filters (tags use OR-of-LIKE against the JSON string). */
  private applyFilters(
    opts: MemorySearchOptions,
    where: string[],
    params: Record<string, unknown>,
  ): void {
    if (opts.type != null && opts.type.length > 0) {
      params['type'] = opts.type;
      where.push('m.type = @type');
    }
    if (opts.tags && opts.tags.length > 0) {
      const clauses: string[] = [];
      opts.tags.forEach((tag, i) => {
        const key = `tag${i}`;
        params[key] = `%${escapeLike(tag)}%`;
        clauses.push(`m.tags LIKE @${key} ESCAPE '\\'`);
      });
      where.push(`(${clauses.join(' OR ')})`);
    }
  }

  private insertFts(memoryId: number, title: string, content: string, tags: string | null): void {
    this.ftsInsertStmt().run({
      title,
      content,
      tags: tags ?? '',
      memory_id: memoryId,
    });
  }

  private deleteFts(memoryId: number): void {
    this.kdb.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(memoryId);
  }

  private ftsInsertStmt(): Statement {
    return this.kdb.db.prepare(
      `INSERT INTO memories_fts (title, content, tags, memory_id)
       VALUES (@title, @content, @tags, @memory_id)`,
    );
  }
}
