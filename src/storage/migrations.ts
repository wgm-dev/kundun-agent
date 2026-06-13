// Schema migrations. Authoritative schema-version source is the `_migrations`
// table (D2); project_meta.schema_version is only a human-readable mirror that
// the init/meta repository updates after running migrations.
//
// FTS5 virtual tables are created only when FTS5 is available (D1); FTS5 sync is
// handled by explicit writes elsewhere, never by triggers (D3).

import type { Database } from 'better-sqlite3';
import { nowIso } from '../utils/time.js';

/** Latest schema version this build knows how to migrate to. */
export const LATEST_SCHEMA_VERSION = 2;

/** Context passed to each migration's `up` step. */
export interface MigrationContext {
  hasFts5: boolean;
}

/** A single forward migration. */
export interface Migration {
  version: number;
  up(db: Database, ctx: MigrationContext): void;
}

/** Result of running pending migrations. */
export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

// --- Migration v1: the 8 MVP1 base tables, their indexes, and FTS5 tables. ---

const V1_TABLES = `
CREATE TABLE IF NOT EXISTS project_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_root TEXT NOT NULL,
  project_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_scan_at TEXT,
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  extension TEXT,
  language TEXT,
  size_bytes INTEGER NOT NULL,
  hash TEXT NOT NULL,
  last_modified_at TEXT NOT NULL,
  indexed_at TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  importance_score REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  language TEXT,
  start_line INTEGER,
  end_line INTEGER,
  signature TEXT,
  parent_symbol TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  importance_score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'medium',
  related_files TEXT,
  related_memories TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_indexed INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cleanup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  removed_chunks INTEGER NOT NULL DEFAULT 0,
  removed_files INTEGER NOT NULL DEFAULT 0,
  removed_memories INTEGER NOT NULL DEFAULT 0,
  vacuum_executed INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  status TEXT NOT NULL
);
`;

const V1_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_files_relative_path ON files(relative_path);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
CREATE INDEX IF NOT EXISTS idx_files_indexed_at ON files(indexed_at);
CREATE INDEX IF NOT EXISTS idx_files_is_deleted ON files(is_deleted);

CREATE INDEX IF NOT EXISTS idx_file_chunks_file_id ON file_chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_file_chunks_content_hash ON file_chunks(content_hash);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_language ON symbols(language);
CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_importance_score ON memories(importance_score);
CREATE INDEX IF NOT EXISTS idx_memories_last_used_at ON memories(last_used_at);
CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);

CREATE INDEX IF NOT EXISTS idx_scan_runs_started_at ON scan_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status);

CREATE INDEX IF NOT EXISTS idx_cleanup_runs_started_at ON cleanup_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_cleanup_runs_status ON cleanup_runs(status);
`;

const V1_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  file_id UNINDEXED,
  chunk_id UNINDEXED,
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  content,
  tags,
  memory_id UNINDEXED
);
`;

// --- Migration v2: the diagnostics table and its indexes (README 9.7). ---

const V2_DIAGNOSTICS = `
CREATE TABLE IF NOT EXISTS diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER,
  language TEXT,
  severity TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  line INTEGER,
  column INTEGER,
  source TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_diagnostics_file_id ON diagnostics(file_id);
CREATE INDEX IF NOT EXISTS idx_diagnostics_language ON diagnostics(language);
CREATE INDEX IF NOT EXISTS idx_diagnostics_severity ON diagnostics(severity);
CREATE INDEX IF NOT EXISTS idx_diagnostics_resolved_at ON diagnostics(resolved_at);
`;

const migrations: Migration[] = [
  {
    version: 1,
    up(db, ctx) {
      // DDL is transactional in SQLite; runMigrations wraps this in a tx.
      db.exec(V1_TABLES);
      db.exec(V1_INDEXES);
      if (ctx.hasFts5) {
        db.exec(V1_FTS);
      }
    },
  },
  {
    version: 2,
    up(db, _ctx) {
      // DDL is transactional in SQLite; runMigrations wraps this in a tx.
      db.exec(V2_DIAGNOSTICS);
    },
  },
];

/**
 * Current applied schema version, read from the authoritative `_migrations`
 * table. Ensures the table exists first. Returns 0 when no migration has run.
 */
export function getCurrentVersion(db: Database): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  const row = db.prepare('SELECT MAX(version) AS version FROM _migrations').get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

/**
 * Apply all pending migrations (version > current), each inside its own
 * transaction together with the `_migrations` bookkeeping insert.
 */
export function runMigrations(db: Database, hasFts5: boolean): MigrationResult {
  const from = getCurrentVersion(db);
  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version);

  const applied: number[] = [];
  const insert = db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)');

  for (const mig of pending) {
    const apply = db.transaction(() => {
      mig.up(db, { hasFts5 });
      insert.run(mig.version, nowIso());
    });
    apply();
    applied.push(mig.version);
  }

  const to = applied.length > 0 ? Math.max(...applied) : from;
  return { from, to, applied };
}
