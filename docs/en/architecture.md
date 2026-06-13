# Architecture

This page explains how Kundun-Agent is put together: the layered module
structure, the single composition root that wires everything up, the SQLite
storage model, and the on-disk layout under `.kundun/`. It is intentionally
conceptual — for code-level recipes ("how do I add a new language extractor?",
"how do I add a CLI command?") see [`../../CLAUDE.md`](../../CLAUDE.md).

Kundun-Agent is **local-first**: it indexes a codebase, stores persistent
memory, tracks tasks, runs cleanup, and serves context — all locally, backed by
a single SQLite database. No project content is sent to external APIs by
default.

> This page covers **MVP 1** (the local core). The MCP server, diagnostics,
> daemon, sessions, health/metrics, local HTTP API, and desktop app are not part
> of MVP 1 and are not described here.

## Layers

The codebase is organized as a strict dependency stack. Each layer may depend
only on the layers below it; nothing reaches back up.

```
cli         CLI commands and argument parsing (the kundun binary)
languages   per-language regex symbol extractors (php, go, ts, js, csharp, cpp, sql)
core        engines: scanner, indexer, search, memory, task, cleanup, summary
storage     SQLite connection, migrations, repositories, the data model
config      kundun.config.json loading + zod schema + defaults
utils       hashing, time, path-safety, binary detection, logging, errors, json
```

The flow of control runs top-down. A CLI command builds an application context,
asks a `core` engine to do work, and the engine talks to the database through
`storage` repositories. Cross-cutting helpers (hashing a file, checking a path
is inside the project root, formatting a timestamp) live in `utils` and are used
everywhere.

Keeping the dependencies one-directional means each engine can be reasoned
about — and tested — in isolation, with the database (or in-memory database)
behind a narrow repository interface.

## The composition root

All wiring happens in one place: `src/core/container.ts`. CLI commands never
construct repositories or engines by hand; they call the container, which
returns a fully assembled `AppContext`.

`createAppContext({ projectRoot })` performs a fixed sequence:

1. Load and resolve `kundun.config.json` (throws a `not_initialized` error if
   the project has no config or no database yet, so the CLI can suggest
   `kundun init`).
2. Open the SQLite database and apply connection PRAGMAs.
3. Run any pending migrations.
4. Mirror the authoritative schema version into the `project_meta` row.
5. Build the logger.
6. Construct every repository.

The resulting `AppContext` bundles the loaded `config`, the resolved
`projectRoot` and `kundunDir` paths, the open database handle (`kdb`), a
`logger`, all `repos`, and a `close()` method that releases the database (and
checkpoints the WAL).

On top of the context, thin `build*` factories assemble each engine on demand:

```
buildScanner(ctx)        -> ProjectScanner
buildIndexer(ctx)        -> Indexer
buildSearchProvider(ctx) -> SearchProvider   (FTS5 vs LIKE chosen from kdb.hasFts5)
buildMemoryEngine(ctx)   -> MemoryEngine
buildTaskEngine(ctx)     -> TaskEngine
buildCleanupEngine(ctx)  -> CleanupEngine
```

Two facts shape the wiring:

- **`better-sqlite3` is fully synchronous.** Nothing in the container or the
  engines is `async` — there is no event loop juggling around the database.
- **FTS5 availability is detected once** when the database is opened and exposed
  as `kdb.hasFts5`. The search provider and the memory engine read that flag to
  decide between the FTS5 path and the LIKE fallback, so the choice is made in
  exactly one place.

## Storage model

The database is a single SQLite file (default `.kundun/kundun.sqlite`). It is
opened with these connection PRAGMAs:

| PRAGMA         | Value    | Why                                                               |
| -------------- | -------- | ----------------------------------------------------------------- |
| `journal_mode` | `WAL`    | better concurrent read/write behavior                             |
| `foreign_keys` | `ON`     | enforce cascades; OFF by default in SQLite, so set per-connection |
| `busy_timeout` | `5000`   | wait up to 5s on a locked database before failing                 |
| `synchronous`  | `NORMAL` | durable enough under WAL, faster than `FULL`                      |

### Schema versioning

The **authoritative** schema version lives in a `_migrations` table — one row
per applied migration `(version, applied_at)`. Migrations run forward only, each
inside its own transaction together with its bookkeeping insert.

After migrations run, the version is **mirrored** into
`project_meta.schema_version` purely as a human-readable convenience. When the
two ever disagree, `_migrations` is the source of truth.

### The 8 MVP 1 tables

| Table          | Holds                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `project_meta` | one row of project identity: root, name, timestamps, last scan, mirrored schema version                                |
| `files`        | one row per tracked file: path, relative path, language, size, sha256 hash, `is_deleted` flag, importance score        |
| `file_chunks`  | line-range chunks of indexed file content (start/end line, content, per-chunk hash); cascades from `files`             |
| `symbols`      | extracted symbols (name, kind, language, line range, signature); cascades from `files`                                 |
| `memories`     | persistent project memory: type, title, content, tags, confidence, importance, timestamps, `expires_at`, `archived_at` |
| `tasks`        | work items: title, description, status, priority, related files/memories (JSON), `completed_at`                        |
| `scan_runs`    | one row per `kundun scan`: counts (scanned/indexed/skipped), errors, duration, status                                  |
| `cleanup_runs` | one row per real `kundun cleanup`: removed counts, whether VACUUM ran, duration, status                                |

`file_chunks` and `symbols` both carry a `file_id` foreign key with
`ON DELETE CASCADE`, so deleting a `files` row automatically removes its chunks
and symbols. This is what lets the cleanup engine drop an old deleted file and
have its derived rows disappear in the same transaction.

### FTS5 virtual tables

When FTS5 is compiled into the SQLite build, two virtual tables are created:

- `chunks_fts` — full-text index over chunk `content` (with `file_id` and
  `chunk_id` stored unindexed), used by `kundun search`.
- `memories_fts` — full-text index over memory `title`, `content`, and `tags`,
  used by `kundun memory search`.

These tables are populated by **explicit writes** from the engines, never by
SQLite triggers. When FTS5 is unavailable, the tables are simply not created and
both search paths fall back to `LIKE`. The active mode (`fts5` or `like`) is
shown in command output.

## Local data layout

Everything Kundun-Agent writes for a project lives under `.kundun/` at the
project root:

```
.kundun/
  kundun.sqlite     the single SQLite database (all tables + FTS5)
  config.json       a mirror of kundun.config.json
  cache/            scratch/cache space
  logs/             log files (subject to cleanup retention)
  snapshots/        snapshot space
  runtime/          runtime scratch (no token file in MVP 1)
```

The `kundun.config.json` file itself lives at the project root (next to
`.kundun/`), not inside it; `.kundun/config.json` is only a mirror.

Because all state is a single SQLite file plus a few scratch directories, a
project's Kundun data is trivially portable and trivially disposable: delete
`.kundun/` (and the config) to remove every trace, or copy it to move the index
elsewhere.

## See also

- [Documentation hub](../README.md)
- [Configuration](configuration.md) — every key in `kundun.config.json`
- [Search](search.md) — how the FTS5 / LIKE providers are chosen and used
