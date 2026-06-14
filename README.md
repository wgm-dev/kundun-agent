# Kundun-Agent

> Kundun-Agent is a local-first MCP memory and codebase intelligence agent built
> for fast project scanning, persistent memory, task recovery, diagnostics, and
> agent-friendly context retrieval.

Kundun-Agent is a local-first project intelligence layer for coding agents. It
indexes your codebase, stores persistent memory, tracks tasks, monitors
sessions, runs diagnostics, and gives AI agents the right context at the right
time.

---

## Disclaimer

Kundun-Agent is an independent open-source developer tool.

This project is not affiliated with, endorsed by, sponsored by, or approved by
any game company.

All trademarks, product names, and company names are the property of their
respective owners.

---

## Status

This repository is being implemented in milestones. **MVP 1 + MVP 2** are
implemented. MVP 1 delivers the local core: CLI, SQLite storage, configuration,
an incremental and safe project scanner, a code indexer with chunking and basic
symbol extraction, FTS5/`LIKE` search, a persistent memory engine, a task
engine, and an auto-cleanup engine. **MVP 2** adds the **MCP server** (18 tools
and 8 resources over stdio, started by `kundun mcp`), **heuristic diagnostics**
(`kundun diagnostics`), and an in-memory event bus. The daemon, session
registry, persisted health/metrics, local API, and Windows desktop app are
planned for later milestones.

### Install

Once published to npm, no clone is required:

```bash
# One-off, no install:
npx kundun-agent init

# Or install the CLI globally:
npm install -g kundun-agent
kundun --help
```

From a clone (development), build the local binary first:

```bash
npm install
npm run build
```

### Quick start

```bash
# Initialize Kundun in a project (creates .kundun/ and kundun.config.json)
kundun init

# Scan and index the project
kundun scan

# Search indexed code
kundun search "createServer"

# Find a symbol
kundun symbol "UserService"

# Project memory
kundun memory add --type decision --title "Use SQLite WAL" --content "..."
kundun memory search "sqlite"
kundun memory list

# Tasks
kundun task create --title "Add auth" --priority high
kundun task next
kundun task list

# Heuristic diagnostics
kundun diagnostics

# Maintenance
kundun cleanup --dry-run
kundun cleanup
kundun summary

# Start the MCP server (for Claude Code / Codex / Cursor)
kundun mcp
```

### Use it in Claude Code

Add Kundun-Agent as an MCP server (stdio). See the full guide:
[en](docs/en/mcp-integration.md) · [pt-BR](docs/pt-BR/mcp-integration.md).

```json
{
  "mcpServers": {
    "kundun-agent": {
      "command": "node",
      "args": [
        "/abs/path/to/kundun-agent/dist/cli/index.js",
        "--project-root",
        "/abs/path/to/your/project",
        "mcp"
      ]
    }
  }
}
```

---

## Documentation

Full bilingual (English + Português) documentation lives in
[`docs/`](docs/README.md):

- **Getting started** — [en](docs/en/getting-started.md) ·
  [pt-BR](docs/pt-BR/getting-started.md)
- **MCP integration** — [en](docs/en/mcp-integration.md) ·
  [pt-BR](docs/pt-BR/mcp-integration.md)
- **CLI reference** — [en](docs/en/cli-reference.md) ·
  [pt-BR](docs/pt-BR/cli-reference.md)
- **Configuration** — [en](docs/en/configuration.md) ·
  [pt-BR](docs/pt-BR/configuration.md)
- **Architecture** — [en](docs/en/architecture.md) ·
  [pt-BR](docs/pt-BR/architecture.md)
- Scanner & indexing, search, memory, tasks, cleanup, and security each have
  their own page in both languages.

For contributors and AI agents extending the project, see
[`CLAUDE.md`](CLAUDE.md) — project rules, a codebase map, and step-by-step
recipes for adding commands, tables, engines, languages, and docs.

The spec below (§1–§35) is the original full product specification and remains
the long-term roadmap; the milestone status note above tracks what is actually
implemented today.

---

# Kundun-Agent — Full Project Specification

## 1. Project Overview

**Project name:** Kundun-Agent
**Short description:** Local-first MCP memory and codebase intelligence agent.
**License:** Apache-2.0
**Primary goal:** Build a fast, local-first MCP server that scans, indexes, understands, stores memory, tracks tasks, exposes diagnostics, and improves project context retrieval for coding agents.

Kundun-Agent is a developer tool designed to help AI coding agents like Claude Code, Codex, Cursor, and other MCP-compatible clients work more efficiently with real software projects.

It should not behave like a generic MCP server. It should act as a persistent project intelligence layer.

The tool should:

- Scan a project safely.
- Index relevant files incrementally.
- Store useful project memory.
- Retrieve code, symbols, tasks, decisions, and diagnostics quickly.
- Avoid repeatedly reading the whole codebase.
- Improve agent context quality.
- Detect common language-specific issues.
- Track active sessions and tool usage.
- Expose project health.
- Provide a visual desktop control center on Windows.
- Run locally with SQLite.
- Clean up stale data automatically.

---

## 2. Branding and Disclaimer

The project name is **Kundun-Agent**.

Avoid using official game assets, logos, copyrighted artwork, or trademarks from any game company.

Add this disclaimer to the README:

```md
Kundun-Agent is an independent open-source developer tool.

This project is not affiliated with, endorsed by, sponsored by, or approved by any game company.

All trademarks, product names, and company names are the property of their respective owners.
```

Recommended tagline:

```md
Kundun-Agent is a local-first MCP memory and codebase intelligence agent built for fast project scanning, persistent memory, task recovery, diagnostics, and agent-friendly context retrieval.
```

---

## 3. License

Use:

```text
Apache License 2.0
SPDX: Apache-2.0
```

Required files:

```text
LICENSE
NOTICE
README.md
CONTRIBUTING.md
SECURITY.md
CODE_OF_CONDUCT.md
```

Package metadata should include:

```json
{
  "license": "Apache-2.0"
}
```

---

## 4. High-Level Architecture

Kundun-Agent should be separated into three main components:

```text
kundun-agent-core      -> scanner, indexer, SQLite, memory, tasks, diagnostics, cleanup
kundun-agent-mcp       -> MCP adapter for Claude Code, Codex, Cursor, etc.
kundun-agent-desktop   -> Windows visual dashboard and tray app
```

The visual desktop app must be optional.

The MCP server must work in headless mode.

The UI must not be required for the MCP to function.

---

## 5. Recommended Stack

### Core and MCP MVP

Use TypeScript/Node.js initially for fast MCP integration and npm distribution.

Requirements:

```text
Node.js 20+
TypeScript
SQLite
MCP SDK
Vitest
ESLint
Prettier
tsup
```

### Desktop App

Use Go + Wails.

Recommended desktop stack:

```text
Go
Wails
React
TypeScript
Local HTTP API
WebSocket events
Windows tray
```

Alternative future options:

```text
Fyne     -> 100% Go UI
Walk     -> Windows-only native Go UI
Electron -> avoid unless necessary
```

---

## 6. Repository Structure

Recommended structure:

```text
kundun-agent/
  LICENSE
  NOTICE
  README.md
  CONTRIBUTING.md
  SECURITY.md
  CODE_OF_CONDUCT.md
  package.json
  tsconfig.json
  eslint.config.js
  prettier.config.js
  vitest.config.ts
  tsup.config.ts

  src/
    main.ts

    mcp/
      server.ts
      tools.ts
      resources.ts
      session-middleware.ts

    core/
      project-scanner.ts
      indexer.ts
      chunker.ts
      memory-engine.ts
      task-engine.ts
      cleanup-engine.ts
      language-detector.ts
      diagnostics-engine.ts
      health-monitor.ts
      metrics-engine.ts
      session-registry.ts
      event-bus.ts
      search-provider.ts

    storage/
      sqlite.ts
      migrations.ts
      repositories/
        file.repository.ts
        chunk.repository.ts
        symbol.repository.ts
        memory.repository.ts
        task.repository.ts
        diagnostic.repository.ts
        session.repository.ts
        health.repository.ts
        metrics.repository.ts

    languages/
      php.ts
      go.ts
      typescript.ts
      javascript.ts
      csharp.ts
      cpp.ts
      sql.ts

    config/
      config-loader.ts
      default-config.ts
      config-schema.ts

    cli/
      index.ts
      commands/
        init.ts
        scan.ts
        search.ts
        memory.ts
        task.ts
        diagnostics.ts
        cleanup.ts
        summary.ts
        mcp.ts
        daemon.ts
        desktop.ts
        status.ts
        sessions.ts
        health.ts
        logs.ts
        restart.ts

    api/
      local-server.ts
      auth.ts
      routes/
        health.routes.ts
        sessions.routes.ts
        metrics.routes.ts
        logs.routes.ts
        scan.routes.ts
        cleanup.routes.ts
        diagnostics.routes.ts

    utils/
      hashing.ts
      path-safety.ts
      ignore-rules.ts
      binary-detection.ts
      logger.ts
      time.ts
      json.ts

  desktop/
    wails.json
    main.go
    app.go
    internal/
      api-client/
      tray/
      startup/
      config/
    frontend/
      package.json
      src/
        main.tsx
        App.tsx
        pages/
          Dashboard.tsx
          Sessions.tsx
          Indexing.tsx
          Memory.tsx
          Tasks.tsx
          Diagnostics.tsx
          Health.tsx
          Logs.tsx
          Settings.tsx
        components/
        hooks/
        lib/
        styles/

  docs/
    architecture.md
    memory-engine.md
    indexing-strategy.md
    mcp-protocol.md
    desktop-app.md
    security.md
    configuration.md
    troubleshooting.md

  tests/
    fixtures/
    unit/
    integration/
```

---

## 7. Local Project Data

Kundun-Agent should create a local project directory:

```text
.kundun/
  kundun.sqlite
  cache/
  logs/
  snapshots/
  runtime/
    token
  config.json
```

Default SQLite database path:

```text
.kundun/kundun.sqlite
```

The system must be local-first.

No project content should be sent to external APIs by default.

---

## 8. SQLite Requirements

SQLite must be configured with:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Use:

- Prepared statements.
- Batch inserts.
- Transactions.
- Versioned migrations.
- Safe schema upgrades.
- Indexes for frequent queries.
- FTS5 when available.

---

## 9. SQLite Schema

### 9.1 project_meta

```sql
CREATE TABLE project_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_root TEXT NOT NULL,
  project_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_scan_at TEXT,
  schema_version INTEGER NOT NULL
);
```

---

### 9.2 files

```sql
CREATE TABLE files (
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

CREATE INDEX idx_files_relative_path ON files(relative_path);
CREATE INDEX idx_files_language ON files(language);
CREATE INDEX idx_files_hash ON files(hash);
CREATE INDEX idx_files_indexed_at ON files(indexed_at);
CREATE INDEX idx_files_is_deleted ON files(is_deleted);
```

---

### 9.3 file_chunks

```sql
CREATE TABLE file_chunks (
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

CREATE INDEX idx_file_chunks_file_id ON file_chunks(file_id);
CREATE INDEX idx_file_chunks_content_hash ON file_chunks(content_hash);
```

---

### 9.4 symbols

```sql
CREATE TABLE symbols (
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

CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_kind ON symbols(kind);
CREATE INDEX idx_symbols_language ON symbols(language);
CREATE INDEX idx_symbols_file_id ON symbols(file_id);
```

---

### 9.5 memories

```sql
CREATE TABLE memories (
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
  expires_at TEXT
);

CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_importance_score ON memories(importance_score);
CREATE INDEX idx_memories_last_used_at ON memories(last_used_at);
CREATE INDEX idx_memories_expires_at ON memories(expires_at);
```

Allowed memory types:

```text
architecture
decision
bug
task
convention
command
risk
domain_rule
user_note
```

---

### 9.6 tasks

```sql
CREATE TABLE tasks (
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

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_updated_at ON tasks(updated_at);
```

Allowed task status:

```text
pending
in_progress
blocked
completed
archived
```

Allowed priorities:

```text
low
medium
high
critical
```

---

### 9.7 diagnostics

```sql
CREATE TABLE diagnostics (
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

CREATE INDEX idx_diagnostics_file_id ON diagnostics(file_id);
CREATE INDEX idx_diagnostics_language ON diagnostics(language);
CREATE INDEX idx_diagnostics_severity ON diagnostics(severity);
CREATE INDEX idx_diagnostics_resolved_at ON diagnostics(resolved_at);
```

Allowed severity:

```text
info
warning
error
critical
```

---

### 9.8 scan_runs

```sql
CREATE TABLE scan_runs (
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

CREATE INDEX idx_scan_runs_started_at ON scan_runs(started_at);
CREATE INDEX idx_scan_runs_status ON scan_runs(status);
```

---

### 9.9 cleanup_runs

```sql
CREATE TABLE cleanup_runs (
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

CREATE INDEX idx_cleanup_runs_started_at ON cleanup_runs(started_at);
CREATE INDEX idx_cleanup_runs_status ON cleanup_runs(status);
```

---

### 9.10 sessions

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  client_name TEXT,
  client_version TEXT,
  transport TEXT,
  project_root TEXT,
  process_id INTEGER,
  started_at TEXT NOT NULL,
  last_activity_at TEXT,
  ended_at TEXT,
  status TEXT NOT NULL,
  tools_called INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  current_operation TEXT,
  metadata_json TEXT
);

CREATE INDEX idx_sessions_session_id ON sessions(session_id);
CREATE INDEX idx_sessions_client_name ON sessions(client_name);
CREATE INDEX idx_sessions_project_root ON sessions(project_root);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_last_activity_at ON sessions(last_activity_at);
```

Allowed session status:

```text
active
idle
disconnected
crashed
closed
```

---

### 9.11 health_events

```sql
CREATE TABLE health_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_health_events_source ON health_events(source);
CREATE INDEX idx_health_events_severity ON health_events(severity);
CREATE INDEX idx_health_events_created_at ON health_events(created_at);
```

---

### 9.12 metrics_snapshots

```sql
CREATE TABLE metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  active_sessions INTEGER NOT NULL DEFAULT 0,
  indexed_files INTEGER NOT NULL DEFAULT 0,
  indexed_chunks INTEGER NOT NULL DEFAULT 0,
  memory_count INTEGER NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  diagnostics_count INTEGER NOT NULL DEFAULT 0,
  db_size_bytes INTEGER NOT NULL DEFAULT 0,
  avg_tool_latency_ms REAL,
  scan_duration_ms INTEGER,
  cleanup_duration_ms INTEGER,
  errors_last_24h INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_metrics_snapshots_created_at ON metrics_snapshots(created_at);
```

---

## 10. Configuration

Create:

```text
kundun.config.json
```

Example:

```json
{
  "projectName": "my-project",
  "databasePath": ".kundun/kundun.sqlite",
  "include": ["src", "app", "database", "routes", "config", "docs"],
  "exclude": [
    "node_modules",
    "vendor",
    ".git",
    ".next",
    "dist",
    "build",
    "coverage",
    "storage",
    "logs",
    "tmp",
    ".kundun"
  ],
  "maxFileSizeKb": 512,
  "scanBinaryFiles": false,
  "enableDiagnostics": true,
  "enableAutoCleanup": true,
  "allowRestartFromMcp": false,
  "autoScan": {
    "enabled": false,
    "intervalMinutes": 10
  },
  "cleanup": {
    "deleteDeletedFilesAfterDays": 7,
    "deleteUnusedChunksAfterDays": 30,
    "deleteLowImportanceMemoriesAfterDays": 60,
    "archiveCompletedTasksAfterDays": 30,
    "deleteLogsAfterDays": 14,
    "vacuumAfterCleanup": true
  },
  "desktop": {
    "enabled": true,
    "minimizeToTray": true,
    "startWithWindows": false,
    "localApiHost": "127.0.0.1",
    "localApiPort": 37373
  },
  "languages": {
    "php": true,
    "go": true,
    "typescript": true,
    "javascript": true,
    "csharp": true,
    "cpp": true,
    "sql": true
  }
}
```

---

## 11. Project Scanner

The project scanner must be fast, incremental, and safe.

Rules:

- Do not follow symlinks by default.
- Ignore binary files.
- Ignore large files.
- Respect `kundun.config.json`.
- Respect `.gitignore` when possible.
- Never read files outside the project root.
- Detect changed files using hash.
- Do not reindex unchanged files.
- Mark removed files as `is_deleted = true`.
- Register every scan in `scan_runs`.

Scanner output:

```json
{
  "newFiles": [],
  "changedFiles": [],
  "removedFiles": [],
  "skippedFiles": [],
  "errors": []
}
```

Skipped files should include reason:

```json
{
  "path": ".env",
  "reason": "sensitive_file"
}
```

Never store sensitive file content.

---

## 12. Indexer

The indexer must:

- Read textual files only.
- Detect language.
- Chunk large files by line range.
- Calculate hash per chunk.
- Avoid duplicate chunks.
- Extract basic symbols.
- Update `file_chunks`.
- Update `symbols`.
- Calculate `importance_score`.
- Update FTS index when available.

Importance score should prioritize:

High importance:

```text
controllers
services
repositories
routes
middleware
migrations
schema SQL
auth
payments
security
domain logic
tests
config
```

Low importance:

```text
assets
generated CSS
lockfiles
snapshots
minified files
build output
cache
logs
```

---

## 13. Search Engine

Initial search must use SQLite FTS5 when available.

If FTS5 is unavailable, use a safe fallback based on `LIKE`, indexed metadata, and ranking heuristics.

Search must support:

- Code search.
- File search.
- Chunk search.
- Symbol search.
- Memory search.
- Task search.
- Diagnostics search.
- Related context by file.

Do not require external embeddings in the MVP.

Prepare future abstraction:

```text
core/search-provider.ts
  sqlite-fts-provider.ts
  fallback-search-provider.ts
  future-embedding-provider.ts
```

---

## 14. Memory Engine

Kundun-Agent should store persistent project memory.

Memory examples:

```text
Architecture decisions
Project conventions
Known bugs
Useful commands
Security risks
Domain rules
Important flows
User notes
Agent-learned conclusions
```

Memory fields:

```text
type
title
content
tags
source
confidence
importance_score
created_at
updated_at
last_used_at
expires_at
```

Required operations:

```text
add memory
update memory
search memory
list important memories
archive memory
delete memory
promote memory
demote memory
```

Promotion logic:

- Increase importance when memory is frequently used.
- Update `last_used_at` when retrieved.
- Never auto-delete high-importance memories.
- Allow expiration for temporary notes.

---

## 15. Task Engine

The task engine should be simple but reliable.

Required operations:

```text
create task
list tasks
search tasks
get next task
update task
complete task
archive task
relate task to files
relate task to memories
```

Next task priority order:

```text
critical pending
critical in_progress
high pending
high in_progress
medium pending
low pending
```

Completed or archived tasks should not appear as next task.

---

## 16. Language Diagnostics

Diagnostics must be heuristic.

They must not claim absolute correctness.

They must not execute project code.

They should be marked as suggestions.

### PHP

Detect:

```text
SQL queries concatenated with variables
raw input usage
echo/render without escaping in suspicious contexts
missing authorization checks in mutation-like controllers
dangerous file operations
```

Suggest:

```bash
vendor/bin/phpstan analyse
vendor/bin/psalm
vendor/bin/php-cs-fixer fix --dry-run
composer test
```

### Go

Detect:

```text
ignored errors
goroutines without visible context/cancellation
context not propagated
possible race-prone shared state
```

Suggest:

```bash
go test ./...
go test -race ./...
go vet ./...
golangci-lint run
```

### TypeScript / Next.js

Detect:

```text
excessive any usage
fetch without error handling
server/client boundary mistakes
missing input validation
unsafe API handlers
```

Suggest:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

### C#

Detect:

```text
async void
Task.Result
Task.Wait
missing CancellationToken
possible incorrect DI lifetime
```

Suggest:

```bash
dotnet build
dotnet test
dotnet format --verify-no-changes
```

### C++

Detect:

```text
strcpy
sprintf
gets
manual new/delete patterns
raw buffer manipulation
unchecked pointer arithmetic
```

Suggest:

```bash
clang-tidy
cppcheck
asan/ubsan build when possible
```

### SQL

Detect:

```text
SELECT *
UPDATE without WHERE
DELETE without WHERE
dynamic SQL concatenation
missing transaction around critical updates
```

---

## 17. Auto Cleanup

The cleanup engine must keep the database healthy.

Cleanup should support:

```text
dry-run mode
real cleanup mode
manual execution
scheduled execution
post-scan execution after N scans
```

Cleanup targets:

```text
deleted files older than configured days
orphan chunks
orphan symbols
resolved old diagnostics
low-importance expired memories
completed old tasks
old logs
temporary cache
```

Rules:

- Dry-run must not delete anything.
- Never delete high-importance memories automatically.
- Register cleanup execution in `cleanup_runs`.
- Execute `VACUUM` only when configured.
- Run cleanup inside safe transactions when possible.

CLI:

```bash
kundun cleanup --dry-run
kundun cleanup
```

MCP tool:

```text
kundun.cleanup
```

---

## 18. MCP Tools

Implement these MCP tools.

### 18.1 kundun.scan_project

Scans and indexes the project.

Input:

```json
{
  "rootPath": "string optional",
  "force": "boolean optional"
}
```

Output:

```json
{
  "scanId": 1,
  "filesScanned": 100,
  "filesIndexed": 20,
  "filesSkipped": 5,
  "errors": []
}
```

---

### 18.2 kundun.search_code

Searches indexed code.

Input:

```json
{
  "query": "string",
  "language": "string optional",
  "limit": "number optional"
}
```

---

### 18.3 kundun.get_file_context

Returns useful context for a file.

Input:

```json
{
  "path": "string"
}
```

Output should include:

```text
file metadata
relevant chunks
symbols
related memories
related tasks
related diagnostics
```

---

### 18.4 kundun.find_symbol

Finds classes, functions, methods, constants, tables, procedures, etc.

Input:

```json
{
  "name": "string",
  "language": "string optional",
  "kind": "string optional"
}
```

---

### 18.5 kundun.add_memory

Adds persistent memory.

Input:

```json
{
  "type": "architecture | decision | bug | task | convention | command | risk | domain_rule | user_note",
  "title": "string",
  "content": "string",
  "tags": ["string"],
  "importanceScore": "number optional",
  "confidence": "number optional"
}
```

---

### 18.6 kundun.search_memory

Searches memories.

Input:

```json
{
  "query": "string optional",
  "type": "string optional",
  "tags": ["string"],
  "limit": "number optional"
}
```

---

### 18.7 kundun.list_important_memories

Lists the most important memories.

---

### 18.8 kundun.create_task

Creates a task.

Input:

```json
{
  "title": "string",
  "description": "string optional",
  "priority": "low | medium | high | critical",
  "relatedFiles": ["string"]
}
```

---

### 18.9 kundun.next_task

Returns the next recommended task.

---

### 18.10 kundun.update_task

Updates a task.

Input:

```json
{
  "taskId": "number",
  "title": "string optional",
  "description": "string optional",
  "status": "pending | in_progress | blocked | completed | archived optional",
  "priority": "low | medium | high | critical optional"
}
```

---

### 18.11 kundun.run_diagnostics

Runs heuristic diagnostics.

Input:

```json
{
  "path": "string optional",
  "language": "string optional"
}
```

---

### 18.12 kundun.cleanup

Runs cleanup.

Input:

```json
{
  "dryRun": "boolean optional"
}
```

---

### 18.13 kundun.project_summary

Returns a high-level project summary.

Output should include:

```text
detected languages
important files
important memories
open tasks
critical diagnostics
last scans
last cleanup
suggested commands
health status
```

---

### 18.14 kundun.get_sessions

Returns active and recent sessions.

---

### 18.15 kundun.get_health

Returns current health status.

---

### 18.16 kundun.get_metrics

Returns recent metrics snapshots.

---

### 18.17 kundun.get_recent_events

Returns recent system events.

---

### 18.18 kundun.restart_daemon

Restarts the local daemon if allowed.

This must require:

```json
{
  "allowRestartFromMcp": true
}
```

Default must be false.

---

## 19. MCP Resources

Expose these MCP resources:

```text
kundun://project/summary
kundun://project/memories
kundun://project/tasks
kundun://project/diagnostics
kundun://project/recent-changes
kundun://project/sessions
kundun://project/health
kundun://project/metrics
```

---

## 20. CLI

Required CLI commands:

```bash
kundun init
kundun scan
kundun search "query"
kundun symbol "name"
kundun memory add
kundun memory search
kundun memory list
kundun task create
kundun task next
kundun task update
kundun task list
kundun diagnostics
kundun cleanup
kundun summary
kundun mcp
kundun daemon
kundun desktop
kundun status
kundun sessions
kundun health
kundun logs
kundun restart
```

The command:

```bash
kundun mcp
```

Starts the MCP server.

The command:

```bash
kundun daemon
```

Starts the local background daemon.

The command:

```bash
kundun desktop
```

Starts the visual desktop app.

---

## 21. MCP Integration Example

Generic MCP config:

```json
{
  "mcpServers": {
    "kundun-agent": {
      "command": "npx",
      "args": ["-y", "kundun-agent", "mcp"],
      "env": {
        "KUNDUN_PROJECT_ROOT": "/path/to/project"
      }
    }
  }
}
```

Local usage:

```bash
npx kundun-agent init
npx kundun-agent scan
npx kundun-agent mcp
```

---

## 22. Local API

The local API is used by the desktop app.

It must listen only on:

```text
127.0.0.1
```

Default port:

```text
37373
```

Mutable endpoints must require:

```http
Authorization: Bearer <local-token>
```

Token location:

```text
.kundun/runtime/token
```

Required endpoints:

```text
GET  /health
GET  /sessions
GET  /metrics
GET  /projects
GET  /logs
GET  /events

POST /scan
POST /cleanup
POST /diagnostics
POST /mcp/restart
```

WebSocket:

```text
GET /events
```

---

## 23. Event Bus

Implement an internal event bus.

Events:

```text
session.started
session.heartbeat
session.ended
scan.started
scan.progress
scan.completed
scan.failed
index.started
index.progress
index.completed
diagnostics.started
diagnostics.completed
cleanup.started
cleanup.completed
memory.created
memory.updated
task.created
task.updated
health.warning
health.error
```

For MVP:

```text
in-memory event bus
```

For desktop communication:

```text
WebSocket stream
```

---

## 24. Desktop App — Kundun Control Center

The visual app should be called:

```text
Kundun Control Center
```

It should run on Windows.

It may run as:

```text
normal window
minimized to system tray
startup app
```

The desktop app is optional.

The MCP must work without it.

---

## 25. Desktop Screens

### 25.1 Dashboard

Show:

```text
Project name
Project root
Global status
Active sessions
Indexed files
Indexed chunks
Memory entries
Open tasks
Diagnostics count
SQLite size
Last scan
Last cleanup
Current operation
Errors in last 24h
```

---

### 25.2 Sessions

Show table:

```text
Client
Session ID
Transport
Project
Status
Started at
Last activity
Tools called
Errors
Current operation
```

Allow opening session details.

---

### 25.3 Indexing

Show:

```text
Scan status
Files scanned
Files indexed
Files skipped
Current file
Duration
Last scan result
Manual scan button
```

---

### 25.4 Memory

Show:

```text
Important memories
Recent memories
Memory type
Tags
Importance score
Last used
Search field
```

---

### 25.5 Tasks

Show:

```text
Pending tasks
In-progress tasks
Blocked tasks
Completed tasks
Next recommended task
Priority
Related files
```

---

### 25.6 Diagnostics

Show:

```text
Critical
Errors
Warnings
Info
Filter by language
Filter by file
Latest diagnostics run
```

---

### 25.7 Health

Show:

```text
MCP server status
SQLite status
WAL status
Scanner status
Indexer status
Cleanup status
Memory engine status
Task engine status
Diagnostics engine status
Errors in last 24h
Average latency
```

---

### 25.8 Logs

Show logs in real time.

Filters:

```text
info
warning
error
critical
```

---

### 25.9 Settings

Allow configuring:

```text
project root
auto scan enabled
auto cleanup enabled
cleanup interval
max file size
ignored folders
enabled languages
start with Windows
minimize to tray
launch MCP automatically
local API port
```

---

## 26. Tray Behavior

Tray menu:

```text
Open Kundun Control Center
Current Project
Scan Current Project
Run Cleanup
Pause Indexing
Resume Indexing
Show Logs
Restart MCP Server
Exit
```

Close button behavior:

```text
If minimizeToTray = true:
  hide window and keep tray active.

If minimizeToTray = false:
  close normally.
```

Startup behavior:

```text
Start with Windows must be optional.
Do not enable it by default.
Ask user consent before enabling.
```

---

## 27. Security Requirements

Kundun-Agent must not index by default:

```text
.env
.env.*
secrets
private keys
*.pem
*.key
database dumps
binary files
credentials
node_modules
vendor
.git
```

Rules:

```text
Do not send data to external APIs by default.
Do not execute arbitrary commands from the agent.
Do not execute project code for diagnostics.
Do not read files outside project root.
Block path traversal.
Store sensitive skipped file reason, but not content.
Local API must listen only on 127.0.0.1.
Mutable local API routes require token.
Restart from MCP must be disabled by default.
```

---

## 28. Performance Requirements

Kundun-Agent must be optimized for daily development use.

Required performance strategies:

```text
Incremental scan
File hashing
Chunk hashing
Do not reindex unchanged files
SQLite WAL
Prepared statements
Batch inserts
Transactions
File size limits
Efficient ignore rules
Avoid loading entire project into memory
Process files in batches
Measure scan duration
Measure cleanup duration
Measure MCP tool latency
```

---

## 29. Testing Requirements

Create tests for:

```text
config loader
path safety
ignore rules
binary detection
scanner incremental behavior
hash detection
SQLite migrations
file repository
chunk repository
symbol repository
memory CRUD
task CRUD
diagnostic generation
cleanup dry-run
cleanup real execution
language detection
MCP tool handlers
local API auth
local API routes
session registry
health monitor
metrics snapshots
event bus
```

Required commands:

```bash
npm run build
npm run test
npm run lint
npm run typecheck
```

---

## 30. GitHub Actions

Create CI workflow:

```yaml
name: CI

on:
  push:
    branches: ['main']
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test
      - run: npm run build
```

Future desktop release workflow:

```text
Build Windows artifact
Package Wails app
Upload release artifact
```

---

# 31. Implementation Taskplan

## Phase 1 — Project Bootstrap

### Objective

Create the base project structure.

### Tasks

1. Create `package.json`.
2. Configure TypeScript strict.
3. Configure ESLint.
4. Configure Prettier.
5. Configure Vitest.
6. Configure tsup.
7. Create folder structure.
8. Create README.
9. Create LICENSE Apache-2.0.
10. Create basic CLI command `kundun --help`.

### Acceptance Criteria

```text
npm install works
npm run build works
npm run test works
CLI responds
```

---

## Phase 2 — Config and SQLite Storage

### Objective

Create configuration and storage layer.

### Tasks

1. Create config loader.
2. Create default config.
3. Create config schema.
4. Create `kundun init`.
5. Create `.kundun` directory.
6. Create SQLite connection.
7. Enable WAL.
8. Enable foreign keys.
9. Enable busy timeout.
10. Create migration system.
11. Create initial schema.
12. Create base repositories.

### Acceptance Criteria

```text
kundun init creates config
kundun init creates database
migrations run safely
storage tests pass
```

---

## Phase 3 — Incremental Scanner

### Objective

Safely scan project files.

### Tasks

1. Implement path safety.
2. Implement ignore rules.
3. Implement `.gitignore` support if practical.
4. Implement binary file detection.
5. Implement file size limit.
6. Implement hashing.
7. Implement incremental scan.
8. Detect new files.
9. Detect changed files.
10. Detect removed files.
11. Mark removed files.
12. Register scan run.
13. Create `kundun scan`.

### Acceptance Criteria

```text
new files are detected
unchanged files are skipped
changed files are detected
removed files are marked
sensitive files are skipped
```

---

## Phase 4 — Indexer and Chunks

### Objective

Index useful file content.

### Tasks

1. Create language detector.
2. Create line-based chunker.
3. Save file chunks.
4. Avoid duplicate chunks.
5. Calculate token estimate.
6. Calculate importance score.
7. Create FTS5 table if available.
8. Create fallback search.
9. Create `kundun search`.

### Acceptance Criteria

```text
search finds indexed content
chunks include start/end lines
large files are chunked correctly
FTS/fallback works
```

---

## Phase 5 — Basic Symbols

### Objective

Extract basic code symbols.

### Tasks

1. PHP extractor.
2. Go extractor.
3. TypeScript extractor.
4. JavaScript extractor.
5. C# extractor.
6. C++ extractor.
7. SQL extractor.
8. Store symbols.
9. Create `kundun symbol`.

### Acceptance Criteria

```text
classes can be found
functions can be found
methods can be found
false positives are acceptable for MVP
extractors must not crash indexing
```

---

## Phase 6 — Memory Engine

### Objective

Create persistent project memory.

### Tasks

1. Implement memory repository.
2. Add memory.
3. Update memory.
4. Search memory.
5. List important memories.
6. Update `last_used_at`.
7. Implement simple promotion.
8. Implement simple demotion.
9. Create CLI memory commands.

### Acceptance Criteria

```text
memories can be created
memories can be searched
important memories appear in summary
last_used_at updates on retrieval
```

---

## Phase 7 — Task Engine

### Objective

Create persistent task management.

### Tasks

1. Implement task repository.
2. Create task.
3. Update task.
4. List tasks.
5. Search tasks.
6. Get next task.
7. Relate tasks to files.
8. Relate tasks to memories.
9. Create CLI task commands.

### Acceptance Criteria

```text
next task prioritizes critical/high
completed tasks are ignored by next_task
tasks can reference files and memories
```

---

## Phase 8 — Heuristic Diagnostics

### Objective

Create simple language diagnostics.

### Tasks

1. Implement PHP diagnostics.
2. Implement Go diagnostics.
3. Implement TypeScript diagnostics.
4. Implement JavaScript diagnostics.
5. Implement C# diagnostics.
6. Implement C++ diagnostics.
7. Implement SQL diagnostics.
8. Save diagnostics.
9. Create `kundun diagnostics`.

### Acceptance Criteria

```text
diagnostics do not execute code
diagnostics include file, line, severity, message
diagnostics are marked as heuristic suggestions
```

---

## Phase 9 — Auto Cleanup

### Objective

Keep database and cache healthy.

### Tasks

1. Implement cleanup dry-run.
2. Remove orphan chunks.
3. Remove orphan symbols.
4. Archive old completed tasks.
5. Remove expired low-importance memories.
6. Remove old deleted files.
7. Remove old logs.
8. Register cleanup run.
9. Optional VACUUM.
10. Create `kundun cleanup`.

### Acceptance Criteria

```text
dry-run removes nothing
real cleanup removes only eligible data
important memories are preserved
cleanup_runs records execution
```

---

## Phase 10 — MCP Server

### Objective

Expose core features through MCP.

### Tasks

1. Create MCP server.
2. Register tools.
3. Register resources.
4. Connect MCP tools to core services.
5. Validate inputs.
6. Track sessions.
7. Track tool calls.
8. Handle errors safely.
9. Create `kundun mcp`.

### Acceptance Criteria

```text
MCP server starts
Claude/Codex can call tools
tools return clean JSON
errors do not crash server
```

---

## Phase 11 — Project Summary

### Objective

Create an intelligent project overview.

### Tasks

1. Summarize detected languages.
2. List important files.
3. List important memories.
4. List open tasks.
5. List critical diagnostics.
6. List recent scans.
7. List cleanup status.
8. Suggest useful commands.
9. Expose via CLI.
10. Expose via MCP resource.

### Acceptance Criteria

```text
kundun summary returns useful context quickly
project_summary MCP tool works
summary is concise and useful for agents
```

---

## Phase 12 — Documentation and First Release

### Objective

Prepare open source release.

### Tasks

1. Complete README.
2. Add installation guide.
3. Add MCP integration guide.
4. Add configuration guide.
5. Add security guide.
6. Add CONTRIBUTING.md.
7. Add SECURITY.md.
8. Add examples.
9. Add GitHub Actions.
10. Prepare first npm release.

### Acceptance Criteria

```text
new user can install
new user can run init
new user can scan project
new user can start MCP
```

---

## Phase 13 — Core Daemon and Session Registry

### Objective

Support observability and multiple sessions.

### Tasks

1. Create `kundun daemon`.
2. Create session registry.
3. Create `sessions` table.
4. Register MCP sessions.
5. Update heartbeat.
6. Track tool calls.
7. Track session errors.
8. Create `kundun sessions`.
9. Add tests.

### Acceptance Criteria

```text
MCP sessions appear in registry
inactive sessions are marked correctly
each MCP call updates last_activity_at
```

---

## Phase 14 — Health Monitor and Metrics

### Objective

Create local telemetry.

### Tasks

1. Create health monitor.
2. Create `health_events` table.
3. Create `metrics_snapshots` table.
4. Collect SQLite metrics.
5. Collect scanner metrics.
6. Collect indexer metrics.
7. Collect cleanup metrics.
8. Collect recent errors.
9. Create `kundun health`.
10. Create `kundun status`.

### Acceptance Criteria

```text
health shows real state
metrics are periodically saved
failures are registered as health events
```

---

## Phase 15 — Local API and WebSocket

### Objective

Allow communication between core and desktop app.

### Tasks

1. Create local HTTP server on `127.0.0.1`.
2. Generate local token.
3. Create auth middleware.
4. Add `/health`.
5. Add `/sessions`.
6. Add `/metrics`.
7. Add `/logs`.
8. Add `/events`.
9. Add `POST /scan`.
10. Add `POST /cleanup`.
11. Add `POST /diagnostics`.
12. Add WebSocket event stream.
13. Add tests.

### Acceptance Criteria

```text
desktop can read status
events arrive in real time
mutable endpoints require token
API is not exposed externally
```

---

## Phase 16 — Wails Desktop App

### Objective

Create Kundun Control Center.

### Tasks

1. Create Wails app.
2. Create base layout.
3. Create Dashboard page.
4. Create Sessions page.
5. Create Indexing page.
6. Create Memory page.
7. Create Tasks page.
8. Create Diagnostics page.
9. Create Health page.
10. Create Logs page.
11. Create Settings page.
12. Connect UI to local API.
13. Connect UI to WebSocket events.
14. Create Windows build.

### Acceptance Criteria

```text
app opens on Windows
dashboard shows real data
sessions appear in real time
scan can be started from UI
cleanup can be started from UI
```

---

## Phase 17 — Tray Integration

### Objective

Add Windows tray behavior.

### Tasks

1. Create tray icon.
2. Create tray menu.
3. Implement Open Dashboard.
4. Implement Scan Current Project.
5. Implement Run Cleanup.
6. Implement Pause Indexing.
7. Implement Resume Indexing.
8. Implement Show Logs.
9. Implement Restart MCP Server.
10. Implement Exit.
11. Implement minimize to tray.

### Acceptance Criteria

```text
app can stay in tray
closing window minimizes to tray if configured
tray actions work
Exit fully closes the app
```

---

## Phase 18 — Windows Startup and Packaging

### Objective

Prepare desktop distribution.

### Tasks

1. Create Windows build.
2. Create optional installer.
3. Implement start with Windows.
4. Store logs locally.
5. Document installation.
6. Document troubleshooting.
7. Create GitHub release artifact.

### Acceptance Criteria

```text
user can install app
user can enable or disable start with Windows
release includes Windows artifact
```

---

# 32. Development Rules for the Agent

Before implementing, generate a short technical plan validating:

```text
chosen architecture
minimal dependencies
SQLite schema
MCP interface
local API interface
desktop architecture
technical risks
implementation order
```

For each phase:

```text
1. Explain the phase objective.
2. List files to create or modify.
3. Implement the phase.
4. Run or describe tests.
5. Review security and performance.
6. Stop before moving to the next phase unless instructed.
```

Code comments must be in English.

Avoid overengineering.

Prefer simple, testable, modular code.

Do not create unnecessary abstractions.

The project should be professional, pragmatic, and easy to maintain.

---

# 33. MVP Scope

## MVP 1

```text
CLI
SQLite
config
scanner
indexer
search
memory
tasks
cleanup
```

## MVP 2

```text
MCP server
MCP tools
MCP resources
project summary
diagnostics
```

## MVP 3

```text
daemon
sessions
health
metrics
local API
WebSocket events
```

## MVP 4

```text
Wails desktop app
tray
dashboard
settings
Windows packaging
```

---

# 34. Non-Goals for MVP

Do not implement in MVP:

```text
external embeddings
remote database
mandatory Docker
cloud sync
multi-user auth
plugin marketplace
automatic code execution
automatic command execution
AI model integration
large-scale distributed indexing
```

---

# 35. Final Expected Deliverables

The final project should include:

```text
functional CLI
functional SQLite storage
versioned migrations
safe incremental scanner
code indexer
symbol extraction
SQLite search
persistent memory
task engine
heuristic diagnostics
auto-cleanup
MCP server
MCP tools
MCP resources
session registry
health monitor
metrics engine
local API
WebSocket events
optional Windows desktop app
tray support
README
documentation
tests
GitHub Actions
Apache-2.0 license
```
