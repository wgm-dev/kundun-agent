// Heuristic diagnostics engine (README §16, migration v2). Walks the tracked,
// non-deleted files (or a single requested file), reads each one as text, runs
// the per-language heuristic rules over its lines, and persists the resulting
// findings via the DiagnosticRepository.
//
// SAFETY CONTRACT:
// - Diagnostics are heuristic SUGGESTIONS; the rules are line-based regex only.
// - This engine NEVER executes project code — it only reads files as text.
// - All filesystem access is guarded by path-safety.resolveWithinRoot, so a
//   malicious relative_path cannot escape the project root.
// - Per-file work is wrapped in try/catch: one unreadable/odd file logs a warn
//   and is skipped; it never aborts the run.
//
// better-sqlite3 is fully synchronous — nothing here is async.

import { readFileSync } from 'node:fs';

import { RULES_BY_LANGUAGE } from './diagnostics/rules.js';
import type { DiagnosticFinding } from './diagnostics/rules.js';
import { detectLanguage } from './language-detector.js';
import type { AppContext } from './container.js';
import { DiagnosticRepository } from '../storage/repositories/diagnostic.repository.js';
import type { FileRow, NewDiagnosticRow, SupportedLanguage } from '../storage/types.js';
import { isBinaryBuffer } from '../utils/binary-detection.js';
import { resolveWithinRoot } from '../utils/path-safety.js';

/** Dependencies for the diagnostics engine. */
export interface DiagnosticsEngineDeps {
  ctx: AppContext;
}

/** Options for a single diagnostics run. */
export interface RunDiagnosticsOptions {
  /** Limit the run to a single root-relative (or absolute, inside-root) path. */
  path?: string;
  /** Limit the run to one language (e.g. 'typescript'). */
  language?: string;
}

/** Outcome of a diagnostics run. */
export interface RunDiagnosticsResult {
  filesAnalyzed: number;
  findings: number;
  bySeverity: Record<string, number>;
  /** Set when the run produced nothing actionable (e.g. diagnostics disabled). */
  note?: string;
}

/** Public surface returned by {@link createDiagnosticsEngine}. */
export interface DiagnosticsEngine {
  run(opts?: RunDiagnosticsOptions): RunDiagnosticsResult;
}

/** Internal per-file outcome: whether rules ran, and the findings they produced. */
interface AnalyzeResult {
  analyzed: boolean;
  findings: DiagnosticFinding[];
}

/** Shared "this file was not analyzed" result (no language/rules/binary/etc.). */
const SKIPPED: AnalyzeResult = { analyzed: false, findings: [] };

/** Empty severity tally, used as the starting point for aggregation. */
function emptyBySeverity(): Record<string, number> {
  return { info: 0, warning: 0, error: 0, critical: 0 };
}

/** Narrow an unknown caught value to a human-readable message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create a diagnostics engine bound to an application context. The repository is
 * constructed here from `ctx.kdb` so callers never wire it by hand.
 */
export function createDiagnosticsEngine(deps: DiagnosticsEngineDeps): DiagnosticsEngine {
  const { ctx } = deps;
  const log = ctx.logger.child('diagnostics');
  const diagnosticRepo = new DiagnosticRepository(ctx.kdb);
  const fileRepo = ctx.repos.file;

  /**
   * Resolve the set of files to analyze. With `opts.path` we look up exactly one
   * tracked file by its relative path; otherwise we take every active (non
   * soft-deleted) file. The language filter is applied later, per file.
   */
  function targetFiles(opts: RunDiagnosticsOptions): FileRow[] {
    if (opts.path !== undefined) {
      // Normalize an absolute (inside-root) path back to a relative lookup key;
      // a plain relative path is used as-is.
      const relative = toRelativeKey(ctx.projectRoot, opts.path);
      const row = fileRepo.getByRelativePath(relative);
      if (row === undefined || row.is_deleted === 1) {
        return [];
      }
      return [row];
    }
    return fileRepo.listActive();
  }

  /**
   * Analyze a single file: resolve+read it safely, detect its language, run the
   * matching rules, and replace its stored (unresolved) diagnostics. Returns
   * whether the file was actually analyzed (matching language + rules + text)
   * plus the findings persisted, so the caller can aggregate counts without
   * re-detecting anything. Never throws here — the caller wraps it in try/catch.
   */
  function analyzeFile(file: FileRow, languageFilter: string | undefined): AnalyzeResult {
    const language = detectLanguage(file.relative_path);
    if (language === null) {
      return SKIPPED;
    }
    if (languageFilter !== undefined && language !== languageFilter) {
      return SKIPPED;
    }

    const rules = RULES_BY_LANGUAGE[language];
    if (rules === undefined) {
      return SKIPPED;
    }

    // Resolve inside the project root; reject traversal/symlink escapes.
    const absPath = resolveWithinRoot(ctx.projectRoot, file.relative_path);

    const buffer = readFileSync(absPath);
    if (isBinaryBuffer(buffer)) {
      return SKIPPED;
    }

    const content = buffer.toString('utf8').replace(/\r\n/g, '\n');
    const lines = content.split('\n');

    const findings = rules(content, lines);

    const rows: NewDiagnosticRow[] = findings.map((f) => toNewRow(file.id, language, f));
    diagnosticRepo.replaceForFile(file.id, rows);

    return { analyzed: true, findings };
  }

  return {
    run(opts: RunDiagnosticsOptions = {}): RunDiagnosticsResult {
      if (!ctx.config.enableDiagnostics) {
        return {
          filesAnalyzed: 0,
          findings: 0,
          bySeverity: emptyBySeverity(),
          note: 'Diagnostics are disabled (config.enableDiagnostics = false).',
        };
      }

      const files = targetFiles(opts);
      const bySeverity = emptyBySeverity();
      let filesAnalyzed = 0;
      let totalFindings = 0;

      for (const file of files) {
        try {
          const result = analyzeFile(file, opts.language);
          if (!result.analyzed) {
            continue;
          }
          filesAnalyzed += 1;
          for (const f of result.findings) {
            totalFindings += 1;
            bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
          }
        } catch (err) {
          log.warn('diagnostics skipped file', {
            relativePath: file.relative_path,
            error: errorMessage(err),
          });
        }
      }

      log.info('diagnostics completed', {
        filesAnalyzed,
        findings: totalFindings,
        bySeverity,
      });

      return { filesAnalyzed, findings: totalFindings, bySeverity };
    },
  };
}

/**
 * Map a heuristic finding to a `diagnostics` insert row. `column` is normalized
 * to `null` when the rule did not provide one (exactOptionalPropertyTypes: we
 * never read an absent key as undefined into a non-optional column).
 */
function toNewRow(
  fileId: number,
  language: SupportedLanguage,
  f: DiagnosticFinding,
): NewDiagnosticRow {
  return {
    file_id: fileId,
    language,
    severity: f.severity,
    code: f.code,
    message: f.message,
    line: f.line,
    column: f.column ?? null,
    source: f.source,
    resolved_at: null,
  };
}

/**
 * Reduce a requested path to the relative key used in the `files` table. An
 * absolute path inside the root is converted to its root-relative form (forward
 * slashes); anything already relative is returned with separators normalized.
 */
function toRelativeKey(projectRoot: string, requested: string): string {
  const resolved = resolveWithinRoot(projectRoot, requested);
  const rootResolved = resolveWithinRoot(projectRoot, '.');
  if (resolved === rootResolved) {
    return '.';
  }
  const prefix = rootResolved.endsWith('/') ? rootResolved : `${rootResolved}/`;
  if (resolved.startsWith(prefix)) {
    return resolved.slice(prefix.length);
  }
  // Fallback: normalize separators on the raw input.
  return requested.replace(/\\/g, '/');
}
