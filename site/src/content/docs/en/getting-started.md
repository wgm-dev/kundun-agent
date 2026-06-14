---
title: Getting Started
description: Kundun-Agent is a local-first project intelligence layer for coding agents. This page walks you through installing the CLI and your first run — init, scan, search, summary.
---

Kundun-Agent is a local-first project intelligence layer for coding agents. It
indexes your codebase, stores persistent project memory, tracks tasks, runs
cleanup, and serves agent-friendly context — all locally, backed by SQLite. No
project content is sent to external APIs by default.

This page walks you through installing and building the CLI, explains what the
`.kundun/` directory is, and takes you through your first run: `init` → `scan` →
`search`/`summary`. It ends with a complete worked example and pointers to where
to go next.

## Prerequisites

- **Node.js 20+** (tested up to 24).
- A project you want to index. Kundun-Agent never reads outside the project
  root.

The CLI depends on `better-sqlite3 ^12`, which ships a prebuilt binary with
FTS5 enabled (SQLite 3.53). No separate SQLite install is required.

## Install & build

Clone or download the repository, then install dependencies and build:

```bash
npm install
npm run build
```

The build produces the `kundun` binary entry point at `dist/cli/index.js`.

During development you invoke it directly with Node:

```bash
node dist/cli/index.js --help
```

Once the package is published or linked, the same commands are available as
`kundun ...`. This guide uses the `kundun ...` form throughout. If you are
running from a fresh build and have not linked the binary yet, mentally
substitute `node dist/cli/index.js` for `kundun`.

### Global options

These options apply to every command:

| Option                  | Meaning                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `--project-root <path>` | Project root (defaults to the current directory).                                     |
| `--json`                | Emit machine-readable JSON to stdout. stdout stays clean JSON; all logs go to stderr. |
| `-V`, `--version`       | Print the version.                                                                    |
| `-h`, `--help`          | Print help.                                                                           |

The `--json` flag is what makes Kundun-Agent friendly to coding agents: pipe
stdout straight into a parser and ignore stderr.

## What `.kundun/` is

Running `kundun init` creates a `kundun.config.json` file and a `.kundun/`
directory at the project root. `.kundun/` is the local home for everything
Kundun-Agent persists:

| Path                    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `.kundun/kundun.sqlite` | The SQLite database (code index, memory, tasks, run history). |
| `.kundun/cache/`        | Working cache.                                                |
| `.kundun/logs/`         | Log files (subject to retention during cleanup).              |
| `.kundun/snapshots/`    | Snapshot storage.                                             |
| `.kundun/runtime/`      | Runtime working files.                                        |
| `.kundun/config.json`   | A mirror of the active configuration.                         |

The database uses WAL journaling, `foreign_keys=ON`, a 5-second busy timeout,
and `synchronous=NORMAL`. The schema version is tracked authoritatively in a
`_migrations` table and mirrored on the `project_meta` row. You normally never
touch these files by hand — the CLI manages them.

Because all state lives under `.kundun/`, it is typically safe to add
`.kundun/` to your `.gitignore`.

## Your first run: init → scan → search/summary

The first-run flow has three steps.

### 1. Initialize

```bash
kundun init
```

This creates `kundun.config.json` (if absent) and the `.kundun/` directory with
its subdirectories, opens the database, runs migrations, and writes the
`project_meta` row. The project name defaults to the directory name; override it
with `--name`:

```bash
kundun init --name my-service
```

Use `--force` to reinitialize an existing project.

### 2. Scan

```bash
kundun scan
```

`scan` walks the project, detecting new, changed, and removed files by SHA-256
hash, and indexes new and changed files into searchable chunks and symbols. It
prints counts for `scanned`, `new`, `changed`, `removed`, `skipped`, and
`indexed`, and records the run in `scan_runs`.

The scanner is incremental and safe by design: it respects your `include` /
`exclude` globs and the root `.gitignore`, does not follow symlinks, blocks
path traversal, and skips binary files and files larger than `maxFileSizeKb`.
**Sensitive files** (`.env`, `*.pem`, `*.key`, anything under `secrets/`, and
similar) are skipped with reason `sensitive_file` — their path and hash may be
tracked, but their content is never stored.

Use `--force` to reindex every tracked file from scratch.

### 3. Search and summarize

Search the indexed code:

```bash
kundun search "checkout total"
```

Each hit prints as `relativePath:line` plus a snippet, and a footer shows the
active search mode (`fts5` or `like`). FTS5 with bm25 ranking is used when
available; otherwise the LIKE fallback kicks in.

Get a read-only overview of the project at any time:

```bash
kundun summary
```

`summary` reports detected languages, important files, important memories, open
tasks plus the next task, the last scan and last cleanup, counts, the active
search mode, and suggested commands. It is the fastest way for an agent to
orient itself.

## Quickstart (copy-pasteable)

From the project you want to index:

```bash
# 1. Build the CLI (once, from the kundun-agent repo)
npm install && npm run build

# 2. Initialize the current project
kundun init

# 3. Index the codebase
kundun scan

# 4. Explore
kundun search "authentication"
kundun symbol UserController --kind class
kundun summary

# 5. Capture knowledge and work items
kundun memory add --type decision \
  --title "Use SQLite for local storage" \
  --content "All state is local; no external services in MVP1." \
  --importance 80
kundun task create --title "Add retry to payment client" --priority high
kundun task next

# 6. Re-scan after changes; clean up periodically (preview first)
kundun scan
kundun cleanup --dry-run
```

## A complete worked example

Suppose you have a small TypeScript service:

```
my-service/
  src/
    server.ts
    controllers/payment.controller.ts
    services/payment.service.ts
  package.json
  .env                      # secrets — will be skipped
```

**Initialize.** From inside `my-service/`:

```bash
$ kundun init --name my-service
```

This writes `kundun.config.json` and creates `.kundun/`. The default `include`
list already covers `src`, so no config changes are needed for this layout.

**Scan.** Index the code:

```bash
$ kundun scan
scanned: 5  new: 4  changed: 0  removed: 0  skipped: 1  indexed: 4
```

Four source files were indexed. `.env` accounts for the single `skipped` file —
it matches the sensitive-file rules, so it is skipped (`sensitive_file`) and its
content is never stored.

**Search.** Find where payment totals are computed:

```bash
$ kundun search "payment total" --language typescript
src/services/payment.service.ts:42  computeTotal(items: LineItem[]): Money {
src/controllers/payment.controller.ts:18  const total = this.payments.computeTotal(req.body.items);
(search mode: fts5)
```

**Find a symbol.** Look up a class by name:

```bash
$ kundun symbol PaymentService --kind class
src/services/payment.service.ts:10  class PaymentService
```

**Record what you learned.** Persist a decision and a task so the next session
(or the next agent) has the context:

```bash
$ kundun memory add --type decision \
    --title "Money values use integer cents" \
    --content "Avoid floating-point rounding; all amounts are integer cents." \
    --tags payments,money --importance 85

$ kundun task create \
    --title "Add idempotency key to payment endpoint" \
    --priority high --files src/controllers/payment.controller.ts
```

**Ask what to do next.** The task engine returns the highest-priority actionable
task:

```bash
$ kundun task next
[high] Add idempotency key to payment endpoint  (pending)
```

**Get the big picture.** When orienting at the start of a session:

```bash
$ kundun summary
```

This surfaces the detected language (TypeScript), the important files
(controllers and services rank high), the high-importance memory you just added,
the open task and next task, the last scan time, counts, and the active search
mode — a complete snapshot in one command.

**Iterate.** As you edit code, re-run `kundun scan` to pick up changes
incrementally (only new and changed files are reindexed). Run
`kundun cleanup --dry-run` periodically to preview what retention would remove;
it reports counts and changes nothing — not even a `cleanup_runs` row — so it is
always safe to run.

## For coding agents

A typical agent loop:

1. `kundun summary --json` to orient.
2. `kundun search <query> --json` and `kundun symbol <name> --json` to gather
   relevant code.
3. `kundun memory search <query> --json` to recall prior decisions and
   conventions.
4. `kundun task next --json` to pick the next unit of work.
5. After making changes: `kundun scan`, then `kundun memory add` /
   `kundun task update` to record what happened.

With `--json`, stdout is clean machine-readable output and all logs go to
stderr, so parsing is straightforward.

## Web dashboard

Kundun-Agent ships a small web UI, the **Kundun Control Center**, served by the
local daemon — no extra toolchain required. Start the daemon and open the
dashboard:

```bash
kundun daemon
```

Then open [http://127.0.0.1:37373/](http://127.0.0.1:37373/) in a browser (the
default port is `37373`). Paste the token from `.kundun/runtime/token` into the
field at the top of the page to unlock the data panels — health, sessions,
metrics, a live event stream, and token-gated actions (scan, cleanup,
diagnostics, MCP restart). The UI shell is public, but all data requires the
token, which the page sends as a `Bearer` header. To run the daemon without the
UI, use `kundun daemon --no-dashboard`. See the
[Web dashboard](/en/dashboard/) page for details.

## Where to go next

- **[Configuration](/en/configuration/)** — every key in `kundun.config.json`,
  including `include`/`exclude`, `maxFileSizeKb`, language toggles, and cleanup
  retention.
- **[CLI reference](/en/cli-reference/)** — the complete command and flag list.
- **[Scanner & indexing](/en/scanner-indexing/)** — how files are walked, chunked,
  and scored, and how sensitive files are handled.
- **[Search](/en/search/)** — FTS5 vs. the LIKE fallback and how ranking works.
- **[Memory engine](/en/memory-engine/)** and **[Task engine](/en/task-engine/)** —
  persisting knowledge and tracking work.
- **[Cleanup](/en/cleanup/)** — retention rules and what `--dry-run` does.

## See also

- [Documentation hub](/en/)
- [CLI reference](/en/cli-reference/)
- [Configuration](/en/configuration/)
