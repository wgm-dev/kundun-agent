// Repository for the `diagnostics` table (migration v2, README 9.7). Heuristic
// diagnostics are stored per-file or globally (null file_id). Per-file writes
// replace only the still-unresolved rows for that file so resolved history is
// preserved.
//
// Prepared statements and the batch replace transaction are built ONCE in the
// constructor. better-sqlite3 is fully synchronous; nothing here is async. All
// timestamps come from utils/time.ts.

import type { Database, Statement, Transaction } from 'better-sqlite3';
import { nowIso } from '../../utils/time.js';
import type { DiagnosticRow, KundunDb, NewDiagnosticRow } from '../types.js';

/** Optional filters for {@link DiagnosticRepository.list}. */
export interface DiagnosticListOptions {
  severity?: string;
  language?: string;
  fileId?: number;
  limit?: number;
}

/** Default cap on rows returned by `list` when none is supplied. */
const DEFAULT_LIMIT = 100;

/**
 * Severity ordering used by `list`: critical first, then error, warning, info.
 * Expressed as a CASE expression so unknown severities sort last.
 */
const SEVERITY_RANK_SQL = `CASE severity
  WHEN 'critical' THEN 0
  WHEN 'error' THEN 1
  WHEN 'warning' THEN 2
  WHEN 'info' THEN 3
  ELSE 4
END`;

/** Args for the per-file batch replace transaction. */
type ReplaceArgs = { fileId: number; diags: NewDiagnosticRow[] };

export class DiagnosticRepository {
  private readonly db: Database;

  private readonly deleteUnresolvedByFileStmt: Statement;
  private readonly insertStmt: Statement;
  private readonly countAllStmt: Statement;
  private readonly countBySeverityStmt: Statement;
  private readonly clearAllStmt: Statement;

  private readonly replaceForFileTxn: Transaction<(args: ReplaceArgs) => number>;

  constructor(kdb: KundunDb) {
    this.db = kdb.db;

    this.deleteUnresolvedByFileStmt = this.db.prepare(
      'DELETE FROM diagnostics WHERE file_id = ? AND resolved_at IS NULL',
    );

    // `column` is a reserved word in SQLite, so it is quoted.
    this.insertStmt = this.db.prepare(
      `INSERT INTO diagnostics
         (file_id, language, severity, code, message, line, "column", source,
          created_at, resolved_at)
       VALUES
         (@file_id, @language, @severity, @code, @message, @line, @column, @source,
          @created_at, @resolved_at)`,
    );

    this.countAllStmt = this.db.prepare('SELECT COUNT(*) AS n FROM diagnostics');
    this.countBySeverityStmt = this.db.prepare(
      'SELECT severity AS severity, COUNT(*) AS n FROM diagnostics GROUP BY severity',
    );
    this.clearAllStmt = this.db.prepare('DELETE FROM diagnostics');

    // Build the batch replace transaction ONCE. created_at is stamped here from
    // utils/time.ts so every diagnostic in a batch shares one timestamp.
    this.replaceForFileTxn = this.db.transaction((args: ReplaceArgs): number => {
      const { fileId, diags } = args;
      this.deleteUnresolvedByFileStmt.run(fileId);

      const createdAt = nowIso();
      let inserted = 0;
      for (const diag of diags) {
        this.insertStmt.run({
          file_id: diag.file_id,
          language: diag.language,
          severity: diag.severity,
          code: diag.code,
          message: diag.message,
          line: diag.line,
          column: diag.column,
          source: diag.source,
          created_at: createdAt,
          resolved_at: diag.resolved_at,
        });
        inserted += 1;
      }
      return inserted;
    });
  }

  /**
   * Replace the still-unresolved diagnostics for a file in one transaction:
   * delete existing unresolved rows for the file, then batch-insert `diags`.
   * Returns the number of rows inserted.
   */
  replaceForFile(fileId: number, diags: NewDiagnosticRow[]): number {
    return this.replaceForFileTxn({ fileId, diags });
  }

  /** Insert a single (typically file-less) diagnostic and return its id. */
  insertGlobal(diag: NewDiagnosticRow): number {
    const info = this.insertStmt.run({
      file_id: diag.file_id,
      language: diag.language,
      severity: diag.severity,
      code: diag.code,
      message: diag.message,
      line: diag.line,
      column: diag.column,
      source: diag.source,
      created_at: nowIso(),
      resolved_at: diag.resolved_at,
    });
    return Number(info.lastInsertRowid);
  }

  /**
   * List diagnostics with optional filters, ordered by severity rank
   * (critical > error > warning > info) then newest first.
   */
  list(opts?: DiagnosticListOptions): DiagnosticRow[] {
    const params: Array<string | number> = [];
    let sql = 'SELECT * FROM diagnostics';
    const where: string[] = [];

    if (opts?.severity !== undefined) {
      where.push('severity = ?');
      params.push(opts.severity);
    }
    if (opts?.language !== undefined) {
      where.push('language = ?');
      params.push(opts.language);
    }
    if (opts?.fileId !== undefined) {
      where.push('file_id = ?');
      params.push(opts.fileId);
    }

    if (where.length > 0) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }

    const limit = opts?.limit ?? DEFAULT_LIMIT;
    sql += ` ORDER BY ${SEVERITY_RANK_SQL} ASC, created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);
    return rows as DiagnosticRow[];
  }

  /** Total number of diagnostic rows. */
  countAll(): number {
    const row = this.countAllStmt.get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Count diagnostics grouped by severity, as a `{ severity: count }` map. */
  countBySeverity(): Record<string, number> {
    const rows = this.countBySeverityStmt.all() as Array<{ severity: string; n: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.severity] = row.n;
    }
    return result;
  }

  /** Delete every diagnostic row and return how many were removed. */
  clearAll(): number {
    const info = this.clearAllStmt.run();
    return info.changes;
  }
}
