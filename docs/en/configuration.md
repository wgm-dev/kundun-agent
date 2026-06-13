# Configuration

Kundun-Agent is configured through a single file, `kundun.config.json`, at the
root of your project. This page documents every key, its default value, and its
meaning, and shows a complete example file.

The file is created by `kundun init`. It is read by every command. You can edit
it by hand at any time; missing keys fall back to the defaults documented below,
so a partial config file is perfectly valid.

## How configuration is loaded

- `kundun init` writes `kundun.config.json` if it is absent. Use
  `kundun init --force` to reinitialize an existing config.
- The config is validated with a schema (zod). Any keys you omit are filled in
  with the defaults shown here, so you only need to specify what differs from
  the defaults.
- A mirror copy is written to `.kundun/config.json`. The authoritative file you
  edit is `kundun.config.json` at the project root.

## Keys and defaults

The table below lists every key, its default, and a short description. Nested
objects are documented in their own sections.

| Key                   | Default                   | Meaning                                                                                     |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `projectName`         | (required)                | Human-readable name for the project. Set by `kundun init` (defaults to the directory name). |
| `databasePath`        | `".kundun/kundun.sqlite"` | Path to the SQLite database file, relative to the project root.                             |
| `include`             | see below                 | Directories to scan and index.                                                              |
| `exclude`             | see below                 | Directories and paths to skip.                                                              |
| `maxFileSizeKb`       | `512`                     | Files larger than this (in KB) are skipped during scanning.                                 |
| `scanBinaryFiles`     | `false`                   | Whether to scan binary files. Binary files are skipped by default.                          |
| `enableDiagnostics`   | `true`                    | Reserved. Diagnostics are **not implemented in MVP1**.                                      |
| `enableAutoCleanup`   | `true`                    | Whether automatic cleanup is allowed.                                                       |
| `allowRestartFromMcp` | `false`                   | Reserved for the MCP server, **not in MVP1**.                                               |
| `autoScan`            | see below                 | Reserved auto-scan daemon settings, **not in MVP1**.                                        |
| `cleanup`             | see below                 | Retention policy used by `kundun cleanup`.                                                  |
| `desktop`             | see below                 | Reserved desktop/local-API settings, **not in MVP1**.                                       |
| `languages`           | see below                 | Per-language enable/disable toggles.                                                        |

### `projectName` (required, string)

The project's display name. `kundun init` sets it for you, using the directory
name unless you pass `--name <name>`. It appears in the `project_meta` row and
in `kundun summary`.

### `databasePath` (string)

Default: `".kundun/kundun.sqlite"`. The location of the SQLite database,
relative to the project root. All indexed code, memory, tasks, and run history
live in this single file.

### `include` and `exclude`

These two lists control which parts of the project the scanner walks.

`include` — default:

```json
["src", "app", "database", "routes", "config", "docs"]
```

`exclude` — default:

```json
[
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
]
```

How they interact during a scan:

- A file is only considered if it lives under one of the `include` directories.
  Files outside `include` are skipped with reason `not_included`.
- A file under an `exclude` path is skipped with reason `excluded`, even if it
  also matches `include`.
- The scanner additionally respects the project's root `.gitignore`. Files
  ignored by Git are skipped with reason `gitignored`.

Other skip reasons you may see in scan output, independent of these lists:
`binary`, `too_large`, and `sensitive_file` (see
[Security](security.md) and [Scanner & indexing](scanner-indexing.md)).

### `maxFileSizeKb` (number)

Default: `512`. Any file larger than this size in kilobytes is skipped with
reason `too_large`. Raise it if you have large but meaningful source files;
lower it to keep the index lean.

### `scanBinaryFiles` (boolean)

Default: `false`. Binary files are detected and skipped (reason `binary`) by
default. The indexer only stores text files, so leaving this `false` is the
expected setting for MVP1.

### `enableAutoCleanup` (boolean)

Default: `true`. Controls whether automatic cleanup is permitted. You can always
run cleanup explicitly with `kundun cleanup`; see [Cleanup](cleanup.md).

### `cleanup` (object)

Retention policy applied by `kundun cleanup`. Defaults:

```json
{
  "deleteDeletedFilesAfterDays": 7,
  "deleteUnusedChunksAfterDays": 30,
  "deleteLowImportanceMemoriesAfterDays": 60,
  "archiveCompletedTasksAfterDays": 30,
  "deleteLogsAfterDays": 14,
  "vacuumAfterCleanup": true
}
```

| Sub-key                                | Default | Meaning                                                                                                          |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `deleteDeletedFilesAfterDays`          | `7`     | Remove files marked deleted older than this many days (cascades their chunks and symbols).                       |
| `deleteUnusedChunksAfterDays`          | `30`    | Remove orphaned/unused chunks older than this.                                                                   |
| `deleteLowImportanceMemoriesAfterDays` | `60`    | Expire low-importance memories older than this. High-importance memories (score `>= 80`) are never auto-deleted. |
| `archiveCompletedTasksAfterDays`       | `30`    | Move completed tasks older than this to `archived`.                                                              |
| `deleteLogsAfterDays`                  | `14`    | Delete old log files older than this.                                                                            |
| `vacuumAfterCleanup`                   | `true`  | Run `VACUUM` after a real cleanup. Skipped if the database is locked (not fatal) and never run on a dry run.     |

See [Cleanup](cleanup.md) for the full behavior, including what a dry run does
and does not change.

### `languages` (object)

Per-language toggles. Every supported language defaults to `true`:

```json
{
  "php": true,
  "go": true,
  "typescript": true,
  "javascript": true,
  "csharp": true,
  "cpp": true,
  "sql": true
}
```

Set a language to `false` to disable indexing for that language. The supported
languages and their file extensions are:

| Language     | Extensions                                       |
| ------------ | ------------------------------------------------ |
| `php`        | `.php`                                           |
| `go`         | `.go`                                            |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`                    |
| `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs`                    |
| `csharp`     | `.cs`                                            |
| `cpp`        | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.h`, `.c` |
| `sql`        | `.sql`                                           |

## Reserved keys (not in MVP1)

The following keys exist in the config and are accepted by the schema, but the
features they configure are **not implemented in MVP1**. They are reserved for
later milestones. Setting them has no effect on the current core (CLI, storage,
scanner, indexer, search, memory, tasks, cleanup).

### `enableDiagnostics` (boolean)

Default: `true`. Reserved for heuristic diagnostics. Diagnostics are not part of
MVP1.

### `allowRestartFromMcp` (boolean)

Default: `false`. Reserved for the MCP server. The MCP server is not part of
MVP1.

### `autoScan` (object)

Reserved auto-scan daemon settings. There is no scan daemon in MVP1; run
`kundun scan` manually. Defaults:

```json
{
  "enabled": false,
  "intervalMinutes": 10
}
```

### `desktop` (object)

Reserved desktop app and local-API settings. The desktop app, local HTTP API,
and WebSocket are not part of MVP1. Defaults:

```json
{
  "enabled": true,
  "minimizeToTray": true,
  "startWithWindows": false,
  "localApiHost": "127.0.0.1",
  "localApiPort": 37373
}
```

## Full example

A complete `kundun.config.json` showing every key with its default value. You do
not need to write all of this — a partial file is valid and missing keys take
these defaults — but it is useful as a reference.

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

## Applying changes

After editing `kundun.config.json`, the next command picks up the new values.
If you change `include`, `exclude`, `maxFileSizeKb`, `scanBinaryFiles`, or the
`languages` toggles, run a scan to reflect the new scope:

```bash
kundun scan
```

Use `kundun scan --force` to reindex all tracked files when you have widened
what should be indexed.

## See also

- [Documentation hub](../README.md)
- [Getting started](getting-started.md)
- [Scanner & indexing](scanner-indexing.md)
