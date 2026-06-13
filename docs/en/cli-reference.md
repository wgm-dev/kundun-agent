# CLI Reference

This is the authoritative command list for the `kundun` CLI. It documents every
command and subcommand, with exact flags, arguments, an example invocation, and
notes on the global options.

During development you invoke the binary via `node dist/cli/index.js ...`. Once
the package is published or linked, the binary is simply `kundun`. The examples
below use the `kundun ...` form.

## Global options

These options apply to **all** commands:

| Option                  | Description                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `--project-root <path>` | Project root to operate on. Defaults to the current working directory.                                 |
| `--json`                | Emit machine-readable JSON to stdout. Default `false`. stdout stays clean JSON; all logs go to stderr. |
| `-V`, `--version`       | Print the version and exit.                                                                            |
| `-h`, `--help`          | Print help and exit.                                                                                   |

When `--json` is set, stdout contains **only** the JSON result, so it is safe to
pipe into another tool. Diagnostic and progress logs are written to stderr.

Use `--project-root` to run against a project other than the current directory:

```sh
kundun --project-root /path/to/repo scan
```

## kundun init

Initializes a project. Creates `kundun.config.json` (if absent) and the
`.kundun/` directory with the subdirs `cache/`, `logs/`, `snapshots/`, and
`runtime/`. It opens the database, runs migrations, and writes the
`project_meta` row.

| Flag            | Description                                               |
| --------------- | --------------------------------------------------------- |
| `--name <name>` | Project name. Defaults to the directory name.             |
| `--force`       | Reinitialize even if `kundun.config.json` already exists. |

Example:

```sh
kundun init --name my-service
```

## kundun scan

Walks the project, detecting new, changed, and removed files by hash, and
indexes the new and changed files. Removed files are marked `is_deleted=1`.
Every run is recorded in `scan_runs`. The command prints counts of
scanned/new/changed/removed/skipped/indexed.

| Flag      | Description                                               |
| --------- | --------------------------------------------------------- |
| `--force` | Reindex **all** tracked files, not just new/changed ones. |

Example:

```sh
kundun scan
```

See [`scanner-indexing.md`](scanner-indexing.md) for how files are selected,
skipped, and chunked.

## kundun search

Searches indexed code chunks. Uses SQLite FTS5 (bm25 ranking) when available,
falling back to a LIKE search otherwise. Prints `relativePath:line` plus a
snippet; the footer shows the active search mode (`fts5` or `like`).

| Argument / Flag         | Description                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `<query>`               | The search query (required positional argument).                  |
| `--language <language>` | Restrict results to one language (see supported languages below). |
| `--limit <n>`           | Maximum number of results to return.                              |

Example:

```sh
kundun search "validateToken" --language typescript --limit 20
```

See [`search.md`](search.md) for ranking and fallback details.

## kundun symbol

Finds symbols by exact name, or by prefix with `--prefix`.

| Argument / Flag         | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `<name>`                | Symbol name to look up (required positional argument). |
| `--language <language>` | Restrict results to one language.                      |
| `--kind <kind>`         | Restrict by symbol kind, e.g. `function`, `class`.     |
| `--limit <n>`           | Maximum number of results to return.                   |
| `--prefix`              | Match by name prefix instead of exact name.            |

Example:

```sh
kundun symbol UserController --kind class --prefix
```

## kundun memory

Persistent project memory. Memories have a `type`, `title`, `content`,
optional `tags`, an importance score (0..100), and a source. The nine allowed
memory types are: `architecture`, `decision`, `bug`, `task`, `convention`,
`command`, `risk`, `domain_rule`, `user_note`.

### kundun memory add

| Flag                  | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `--type <type>`       | Memory type (one of the nine allowed types). Required. |
| `--title <title>`     | Short title. Required.                                 |
| `--content <content>` | Memory body. Required.                                 |
| `--tags <a,b>`        | Comma-separated tags.                                  |
| `--importance <n>`    | Importance score, `0..100`.                            |
| `--source <source>`   | Where this memory came from.                           |

Example:

```sh
kundun memory add --type decision \
  --title "Use SQLite WAL" \
  --content "WAL mode chosen for concurrent reads during scans." \
  --tags storage,sqlite --importance 80
```

### kundun memory search

| Argument / Flag | Description                          |
| --------------- | ------------------------------------ |
| `[query]`       | Optional search query.               |
| `--type <type>` | Restrict to one memory type.         |
| `--tags <a,b>`  | Comma-separated tags to filter by.   |
| `--limit <n>`   | Maximum number of results to return. |

Example:

```sh
kundun memory search "auth" --type decision --limit 10
```

### kundun memory list

| Flag          | Description                         |
| ------------- | ----------------------------------- |
| `--limit <n>` | Maximum number of memories to list. |

Example:

```sh
kundun memory list --limit 25
```

See [`memory-engine.md`](memory-engine.md) for retrieval, promotion, and
archival behavior.

## kundun task

Tracks project tasks. Priorities are `low`, `medium`, `high`, `critical`.
Statuses are `pending`, `in_progress`, `blocked`, `completed`, `archived`.

### kundun task create

| Flag                | Description                                 |
| ------------------- | ------------------------------------------- |
| `--title <title>`   | Task title. Required.                       |
| `--description <d>` | Longer description.                         |
| `--priority <p>`    | One of `low`, `medium`, `high`, `critical`. |
| `--files <a,b>`     | Comma-separated related file paths.         |

Example:

```sh
kundun task create --title "Fix scan on symlinked dirs" \
  --priority high --files src/scanner/walk.ts
```

### kundun task next

Returns the single next task to work on. No flags.

The selection order is exactly: `critical` + `pending` > `critical` +
`in_progress` > `high` + `pending` > `high` + `in_progress` > `medium` +
`pending` > `low` + `pending`. Everything else (`blocked`, `completed`,
`archived`, `medium` + `in_progress`, `low` + `in_progress`) is excluded.

Example:

```sh
kundun task next
```

### kundun task update

| Argument / Flag     | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `<id>`              | Task id to update (required positional argument).                    |
| `--status <s>`      | One of `pending`, `in_progress`, `blocked`, `completed`, `archived`. |
| `--priority <p>`    | One of `low`, `medium`, `high`, `critical`.                          |
| `--title <t>`       | New title.                                                           |
| `--description <d>` | New description.                                                     |

Example:

```sh
kundun task update 42 --status in_progress --priority critical
```

### kundun task list

| Flag           | Description                      |
| -------------- | -------------------------------- |
| `--status <s>` | Filter by status.                |
| `--limit <n>`  | Maximum number of tasks to list. |

Example:

```sh
kundun task list --status pending --limit 20
```

See [`task-engine.md`](task-engine.md) for the full task lifecycle.

## kundun cleanup

Applies retention rules from `config.cleanup`. Targets old deleted files
(cascading their chunks and symbols), orphan chunks, orphan symbols, expired
low-importance memories, old completed tasks (moved to `archived`), and old log
files. High-importance memories (score `>= 80`) are never auto-deleted.

| Flag        | Description                                                                          |
| ----------- | ------------------------------------------------------------------------------------ |
| `--dry-run` | Report what **would** be removed and change nothing — not even a `cleanup_runs` row. |

Example:

```sh
kundun cleanup --dry-run
```

See [`cleanup.md`](cleanup.md) for retention defaults and the transaction model.

## kundun summary

Read-only project overview. Reports languages, important files, important
memories, open tasks plus the next task, the last scan, the last cleanup,
counts, the active search mode, and suggested commands. Takes no flags beyond
the globals.

Example:

```sh
kundun summary
```

## Supported languages

The `--language` flag accepts these values (with their detected extensions):

| Language     | Extensions                                       |
| ------------ | ------------------------------------------------ |
| `php`        | `.php`                                           |
| `go`         | `.go`                                            |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`                    |
| `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs`                    |
| `csharp`     | `.cs`                                            |
| `cpp`        | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.h`, `.c` |
| `sql`        | `.sql`                                           |

## See also

- [Documentation hub](../README.md)
- [Getting started](getting-started.md)
- [Configuration](configuration.md)
