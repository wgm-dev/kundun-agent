// Storage-layer type contracts. Row types mirror the SQLite schema (migration v1)
// EXACTLY: number for INTEGER/REAL columns, string for TEXT, and `string | null`
// (or `number | null`) for nullable columns. These are the single source of truth
// for shapes returned by / passed to the storage repositories.

import type Database from 'better-sqlite3';

// --- Enum-like literal unions (validated in app code, not via DB CHECK) ---

/** Allowed memory categories (memories.type). */
export type MemoryType =
  | 'architecture'
  | 'decision'
  | 'bug'
  | 'task'
  | 'convention'
  | 'command'
  | 'risk'
  | 'domain_rule'
  | 'user_note';

/** Allowed task lifecycle states (tasks.status). */
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'archived';

/** Allowed task priorities (tasks.priority). */
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

/** Languages the indexer understands. */
export type SupportedLanguage =
  | 'php'
  | 'go'
  | 'typescript'
  | 'javascript'
  | 'csharp'
  | 'cpp'
  | 'sql';

/**
 * Symbol kind (symbols.kind). Kept as a free-form string because extractors may
 * emit language-specific kinds; callers should not exhaustively switch on it.
 */
export type SymbolKind = string;

// --- Row types (mirror schema columns 1:1) ---

/** Row of `project_meta`. */
export interface ProjectMetaRow {
  id: number;
  project_root: string;
  project_name: string;
  created_at: string;
  updated_at: string;
  last_scan_at: string | null;
  schema_version: number;
}

/** Row of `files`. `is_deleted` is 0/1. `importance_score` is a 0..100 int in a REAL column. */
export interface FileRow {
  id: number;
  path: string;
  relative_path: string;
  extension: string | null;
  language: string | null;
  size_bytes: number;
  hash: string;
  last_modified_at: string;
  indexed_at: string | null;
  is_deleted: number;
  importance_score: number;
  /** When the file was soft-deleted (ISO-8601 UTC), or null when active/legacy. */
  deleted_at: string | null;
}

/**
 * Insert shape for `files`. `id` is assigned by AUTOINCREMENT; `deleted_at` is
 * managed by the repository (set on soft-delete, cleared on resurrection), never
 * supplied by callers.
 */
export type NewFileRow = Omit<FileRow, 'id' | 'deleted_at'>;

/** Row of `file_chunks`. */
export interface FileChunkRow {
  id: number;
  file_id: number;
  chunk_index: number;
  content: string;
  content_hash: string;
  token_estimate: number;
  start_line: number;
  end_line: number;
  created_at: string;
  updated_at: string;
}

/** Insert shape for `file_chunks` (id is assigned by AUTOINCREMENT). */
export type NewChunkRow = Omit<FileChunkRow, 'id'>;

/** Row of `symbols`. */
export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: SymbolKind;
  language: string | null;
  start_line: number | null;
  end_line: number | null;
  signature: string | null;
  parent_symbol: string | null;
  created_at: string;
}

/**
 * Insert shape for `symbols`. We omit only `id`; `created_at` is supplied by the
 * caller (sourced from utils/time.ts) so writes carry a single, consistent
 * timestamp rather than a DB default.
 */
export type NewSymbolRow = Omit<SymbolRow, 'id'>;

/**
 * Row of `memories`. Includes the `archived_at` column added in migration v1
 * (intentional deviation from README 9.5). Archived memories (archived_at != null)
 * are excluded from search and listImportant.
 */
export interface MemoryRow {
  id: number;
  type: MemoryType;
  title: string;
  content: string;
  tags: string | null;
  source: string | null;
  confidence: number;
  importance_score: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  archived_at: string | null;
}

/** Insert shape for `memories` (id is assigned by AUTOINCREMENT). */
export type NewMemoryRow = Omit<MemoryRow, 'id'>;

/** Row of `tasks`. */
export interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  related_files: string | null;
  related_memories: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** Insert shape for `tasks` (id is assigned by AUTOINCREMENT). */
export type NewTaskRow = Omit<TaskRow, 'id'>;

/** Row of `scan_runs`. */
export interface ScanRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  files_scanned: number;
  files_indexed: number;
  files_skipped: number;
  errors_count: number;
  duration_ms: number | null;
  status: string;
}

/** Row of `cleanup_runs`. */
export interface CleanupRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  removed_chunks: number;
  removed_files: number;
  removed_memories: number;
  vacuum_executed: number;
  duration_ms: number | null;
  status: string;
}

/** Allowed diagnostic severities (diagnostics.severity). */
export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Row of `diagnostics` (migration v2, README 9.7). `file_id` is nullable because
 * the FK is `ON DELETE SET NULL`; global diagnostics also carry a null file_id.
 */
export interface DiagnosticRow {
  id: number;
  file_id: number | null;
  language: string | null;
  severity: DiagnosticSeverity;
  code: string | null;
  message: string;
  line: number | null;
  column: number | null;
  source: string | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Insert shape for `diagnostics`. We omit `id` (AUTOINCREMENT) and `created_at`
 * (stamped by the repository from utils/time.ts).
 */
export type NewDiagnosticRow = Omit<DiagnosticRow, 'id' | 'created_at'>;

// --- MVP3 observability row types (migration v5) ---

/** Allowed client session lifecycle states (sessions.status). */
export type SessionStatus = 'active' | 'idle' | 'disconnected' | 'crashed' | 'closed';

/** Allowed health-event severities (health_events.severity). */
export type HealthSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Row of `sessions` (migration v5). Tracks a connected MCP/desktop client.
 * Nullable columns mirror the schema (NULL until populated/ended).
 */
export interface SessionRow {
  id: number;
  session_id: string;
  client_name: string | null;
  client_version: string | null;
  transport: string | null;
  project_root: string | null;
  process_id: number | null;
  started_at: string;
  last_activity_at: string | null;
  ended_at: string | null;
  status: SessionStatus;
  tools_called: number;
  errors_count: number;
  current_operation: string | null;
  metadata_json: string | null;
}

/** Insert shape for `sessions` (id is assigned by AUTOINCREMENT). */
export type NewSessionRow = Omit<SessionRow, 'id'>;

/** Row of `health_events` (migration v5). */
export interface HealthEventRow {
  id: number;
  source: string;
  severity: HealthSeverity;
  message: string;
  details_json: string | null;
  created_at: string;
}

/**
 * Insert shape for `health_events`. We omit `id` (AUTOINCREMENT) and `created_at`
 * (stamped by the repository from utils/time.ts).
 */
export type NewHealthEventRow = Omit<HealthEventRow, 'id' | 'created_at'>;

/** Row of `metrics_snapshots` (migration v5). Nullable REAL/INTEGER cols as T|null. */
export interface MetricsSnapshotRow {
  id: number;
  created_at: string;
  active_sessions: number;
  indexed_files: number;
  indexed_chunks: number;
  memory_count: number;
  task_count: number;
  diagnostics_count: number;
  db_size_bytes: number;
  avg_tool_latency_ms: number | null;
  scan_duration_ms: number | null;
  cleanup_duration_ms: number | null;
  errors_last_24h: number;
}

/**
 * Insert shape for `metrics_snapshots`. We omit `id` (AUTOINCREMENT) and
 * `created_at` (stamped by the repository from utils/time.ts).
 */
export type NewMetricsSnapshotRow = Omit<MetricsSnapshotRow, 'id' | 'created_at'>;

/**
 * Handle to an open Kundun SQLite database.
 * `hasFts5` is detected ONCE at open time (D1); consumers read this flag and
 * never re-probe for FTS5 support.
 */
export interface KundunDb {
  db: Database.Database;
  hasFts5: boolean;
  close(): void;
}
