// Repository for `symbols`. Symbols have no FTS mirror; lookups are exact-name
// or prefix matches joined to `files` for the relative path, excluding
// soft-deleted files.
//
// Prepared statements and the batch replace transaction are built ONCE in the
// constructor. better-sqlite3 is fully synchronous; nothing here is async.

import type { Database, Statement, Transaction } from 'better-sqlite3';
import { nowIso } from '../../utils/time.js';
import type { KundunDb, NewSymbolRow, SymbolRow } from '../types.js';

/** A symbol search result enriched with the owning file's relative path. */
export type SymbolHit = SymbolRow & { relative_path: string };

/** Optional filters shared by name/prefix lookups. */
export interface SymbolLookupOptions {
  language?: string;
  kind?: string;
  limit?: number;
}

/** Default cap on rows returned by lookups when none is supplied. */
const DEFAULT_LIMIT = 50;

/** Args for the batch replace transaction. */
type ReplaceArgs = { fileId: number; symbols: NewSymbolRow[] };

export class SymbolRepository {
  private readonly db: Database;

  private readonly deleteByFileStmt: Statement;
  private readonly insertSymbolStmt: Statement;
  private readonly countAllStmt: Statement;
  private readonly listOrphanIdsStmt: Statement;
  private readonly deleteOrphansStmt: Statement;

  private readonly replaceForFileTxn: Transaction<(args: ReplaceArgs) => number>;

  constructor(kdb: KundunDb) {
    this.db = kdb.db;

    this.deleteByFileStmt = this.db.prepare('DELETE FROM symbols WHERE file_id = ?');
    this.insertSymbolStmt = this.db.prepare(
      `INSERT INTO symbols
         (file_id, name, kind, language, start_line, end_line, signature,
          parent_symbol, created_at)
       VALUES
         (@file_id, @name, @kind, @language, @start_line, @end_line, @signature,
          @parent_symbol, @created_at)`,
    );
    this.countAllStmt = this.db.prepare('SELECT COUNT(*) AS n FROM symbols');

    // Orphan = symbol whose file row is missing OR soft-deleted.
    this.listOrphanIdsStmt = this.db.prepare(
      `SELECT s.id AS id
         FROM symbols s
         LEFT JOIN files f ON f.id = s.file_id
        WHERE f.id IS NULL OR f.is_deleted = 1`,
    );
    this.deleteOrphansStmt = this.db.prepare(
      `DELETE FROM symbols
        WHERE file_id NOT IN (SELECT id FROM files WHERE is_deleted = 0)`,
    );

    // Build the batch replace transaction ONCE. created_at is stamped here from
    // utils/time.ts so every symbol in a batch shares one consistent timestamp.
    this.replaceForFileTxn = this.db.transaction((args: ReplaceArgs): number => {
      const { fileId, symbols } = args;
      this.deleteByFileStmt.run(fileId);

      const createdAt = nowIso();
      let inserted = 0;
      for (const sym of symbols) {
        this.insertSymbolStmt.run({
          file_id: fileId,
          name: sym.name,
          kind: sym.kind,
          language: sym.language,
          start_line: sym.start_line,
          end_line: sym.end_line,
          signature: sym.signature,
          parent_symbol: sym.parent_symbol,
          created_at: createdAt,
        });
        inserted += 1;
      }
      return inserted;
    });
  }

  /** Replace all symbols for a file in one transaction (delete then insert). */
  replaceForFile(fileId: number, symbols: NewSymbolRow[]): number {
    return this.replaceForFileTxn({ fileId, symbols });
  }

  /** Delete every symbol for a file. */
  deleteForFile(fileId: number): number {
    const info = this.deleteByFileStmt.run(fileId);
    return info.changes;
  }

  /** Exact-name lookup with optional language/kind filters. */
  findByName(name: string, opts?: SymbolLookupOptions): SymbolHit[] {
    return this.runLookup('s.name = ?', name, opts);
  }

  /**
   * Prefix lookup: matches symbols whose name starts with `prefix`. LIKE
   * metacharacters in `prefix` are escaped so they match literally.
   */
  findByPrefix(prefix: string, opts?: SymbolLookupOptions): SymbolHit[] {
    const pattern = `${escapeLike(prefix)}%`;
    return this.runLookup("s.name LIKE ? ESCAPE '\\'", pattern, opts);
  }

  /** Total number of symbol rows. */
  countAll(): number {
    const row = this.countAllStmt.get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Ids of symbols whose file is missing or soft-deleted. */
  listOrphanIds(): number[] {
    const rows = this.listOrphanIdsStmt.all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /** Delete all orphaned symbols (file missing or soft-deleted) in one batch. */
  deleteOrphans(): number {
    const info = this.deleteOrphansStmt.run();
    return info.changes;
  }

  /**
   * Shared query builder for name/prefix lookups: applies the name predicate,
   * optional language/kind filters, excludes soft-deleted files, and caps the
   * result count.
   */
  private runLookup(
    namePredicate: string,
    nameParam: string,
    opts: SymbolLookupOptions | undefined,
  ): SymbolHit[] {
    const params: Array<string | number> = [nameParam];
    let sql = `SELECT s.*, files.relative_path AS relative_path
         FROM symbols s
         JOIN files ON files.id = s.file_id
        WHERE ${namePredicate}
          AND files.is_deleted = 0`;

    if (opts?.language !== undefined) {
      sql += ' AND s.language = ?';
      params.push(opts.language);
    }
    if (opts?.kind !== undefined) {
      sql += ' AND s.kind = ?';
      params.push(opts.kind);
    }

    const limit = opts?.limit ?? DEFAULT_LIMIT;
    sql += ' ORDER BY s.name ASC, files.relative_path ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);
    return rows as SymbolHit[];
  }
}

/** Escape `%`, `_` and `\` for use inside a LIKE pattern with `ESCAPE '\\'`. */
function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
