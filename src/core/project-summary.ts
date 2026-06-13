// Minimal, read-only project summary (D8). Aggregates only MVP1 data —
// languages, important files/memories, task status, last scan/cleanup, row
// counts, the active search mode, and a static list of suggested commands.
// Explicitly NO diagnostics, health, or session data (those are later phases).
//
// Every query here is read-only and runs through the repositories plus a couple
// of direct SELECTs. better-sqlite3 is synchronous — nothing here is async.

import type { AppContext } from './container.js';

/** A language usage entry: how many active files are written in `language`. */
export interface LanguageCount {
  language: string;
  files: number;
}

/** A high-importance file projection. */
export interface ImportantFile {
  relativePath: string;
  importance: number;
}

/** A high-importance memory projection. */
export interface ImportantMemory {
  id: number;
  title: string;
  type: string;
  importance: number;
}

/** The single most actionable task, projected for display. */
export interface NextTask {
  id: number;
  title: string;
  priority: string;
}

/** Last-run summary for scan / cleanup operations. */
export interface LastRun {
  at: string | null;
  status: string | null;
}

/** Aggregate row counts across the MVP1 tables. */
export interface SummaryCounts {
  files: number;
  chunks: number;
  symbols: number;
  memories: number;
  tasks: number;
}

/** The complete, read-only project summary surfaced by `kundun summary`. */
export interface ProjectSummary {
  projectName: string;
  projectRoot: string;
  languages: LanguageCount[];
  importantFiles: ImportantFile[];
  importantMemories: ImportantMemory[];
  openTasks: number;
  nextTask: NextTask | null;
  lastScan: LastRun;
  lastCleanup: LastRun;
  counts: SummaryCounts;
  searchMode: 'fts5' | 'like';
  suggestedCommands: string[];
}

/** How many top files/memories to surface in the summary. */
const TOP_LIMIT = 8;

/** Static command hints (D8); not derived from project state. */
const SUGGESTED_COMMANDS: readonly string[] = [
  'kundun scan',
  'kundun search "<query>"',
  'kundun task next',
  'kundun cleanup --dry-run',
];

/** Shape returned by the GROUP BY language probe. */
interface LanguageRow {
  language: string;
  files: number;
}

/** Shape returned by the top-importance files probe. */
interface ImportantFileRow {
  relative_path: string;
  importance_score: number;
}

/** Shape returned by the tasks total-count probe. */
interface CountRow {
  n: number;
}

/**
 * Build the read-only project summary from a wired {@link AppContext}.
 * Performs only SELECTs; never mutates the database.
 */
export function buildProjectSummary(ctx: AppContext): ProjectSummary {
  const { kdb, repos } = ctx;
  const db = kdb.db;

  const meta = repos.meta.get();
  const projectName = meta?.project_name ?? ctx.config.projectName;
  const projectRoot = meta?.project_root ?? ctx.projectRoot;

  // Languages: active files grouped by language, ignoring NULL/empty languages.
  const languageRows = db
    .prepare(
      `SELECT language AS language, COUNT(*) AS files
         FROM files
        WHERE is_deleted = 0 AND language IS NOT NULL AND language <> ''
        GROUP BY language
        ORDER BY files DESC, language ASC`,
    )
    .all() as LanguageRow[];
  const languages: LanguageCount[] = languageRows.map((r) => ({
    language: r.language,
    files: r.files,
  }));

  // Top important active files.
  const importantFileRows = db
    .prepare(
      `SELECT relative_path AS relative_path, importance_score AS importance_score
         FROM files
        WHERE is_deleted = 0
        ORDER BY importance_score DESC, relative_path ASC
        LIMIT ?`,
    )
    .all(TOP_LIMIT) as ImportantFileRow[];
  const importantFiles: ImportantFile[] = importantFileRows.map((r) => ({
    relativePath: r.relative_path,
    importance: r.importance_score,
  }));

  // Top important (non-archived) memories via the repository.
  const importantMemories: ImportantMemory[] = repos.memory.listImportant(TOP_LIMIT).map((m) => ({
    id: m.id,
    title: m.title,
    type: m.type,
    importance: m.importance_score,
  }));

  // Next actionable task and open-task count.
  const next = repos.task.findNext();
  const nextTask: NextTask | null =
    next === undefined ? null : { id: next.id, title: next.title, priority: next.priority };
  const openTasks = repos.task.countOpen();

  // Last scan / cleanup runs.
  const lastScanRow = repos.run.lastScan();
  const lastScan: LastRun = {
    at: lastScanRow?.started_at ?? null,
    status: lastScanRow?.status ?? null,
  };

  const lastCleanupRow = repos.run.lastCleanup();
  const lastCleanup: LastRun = {
    at: lastCleanupRow?.started_at ?? null,
    status: lastCleanupRow?.status ?? null,
  };

  // Row counts. file/chunk/symbol/memory have count helpers; tasks is a direct
  // total (countOpen only covers open statuses).
  const tasksTotalRow = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as CountRow | undefined;
  const counts: SummaryCounts = {
    files: repos.file.countActive(),
    chunks: repos.chunk.countAll(),
    symbols: repos.symbol.countAll(),
    memories: repos.memory.countAll(),
    tasks: tasksTotalRow?.n ?? 0,
  };

  return {
    projectName,
    projectRoot,
    languages,
    importantFiles,
    importantMemories,
    openTasks,
    nextTask,
    lastScan,
    lastCleanup,
    counts,
    searchMode: kdb.hasFts5 ? 'fts5' : 'like',
    suggestedCommands: [...SUGGESTED_COMMANDS],
  };
}
