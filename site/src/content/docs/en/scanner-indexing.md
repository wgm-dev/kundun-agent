---
title: Scanner & Indexing
description: How Kundun-Agent builds knowledge of your codebase in two stages — the scanner walks the project and the indexer turns text files into searchable chunks, symbols, and importance scores.
---

Kundun-Agent builds its knowledge of your codebase in two cooperating stages. The
**scanner** walks the project and decides, file by file, what changed since the last
run. The **indexer** then takes the text files the scanner accepted and turns them
into searchable chunks, symbols, and importance scores. Both run from a single
command:

```bash
kundun scan
```

This page explains how each stage works, what is skipped and why, the safety
guarantees that bound the scan, and how indexing produces the data that powers
[search](/en/search/), [symbol lookup](/en/search/), and the [summary](/en/cli-reference/).

## The `scan` command

`scan` is incremental by default. It walks the project, compares each file against
what is already tracked, and indexes only the files that are new or changed.

```bash
# Incremental: index only new and changed files
kundun scan

# Force: reindex every tracked file, ignoring the change check
kundun scan --force
```

After a run, `scan` prints a one-line tally so you can see what happened:

```
scanned=842 new=12 changed=4 removed=1 skipped=37 indexed=16
```

Every run is recorded in the `scan_runs` table, so the history of scans is durable
and queryable.

## How incremental change detection works

The scanner does not trust timestamps. It detects change by content hash.

1. Walk the project respecting `include` / `exclude` globs and the root
   `.gitignore` (see [Configuration](/en/configuration/)).
2. For each candidate file, compute a **sha256** hash of its contents.
3. Compare against the hash stored in the `files` table:
   - **new** — the path is not tracked yet, so it is indexed.
   - **changed** — the path is tracked but the hash differs, so it is reindexed.
   - **unchanged** — the hash matches, so the file is skipped (no reindex).
4. Any tracked file that is no longer present on disk is marked `is_deleted=1`
   (**removed**). Its row stays so that [cleanup](/en/cleanup/) can retire it on the
   configured retention schedule.

Because change is hash-based, touching a file (changing only its mtime) does **not**
trigger a reindex — only a content change does. `--force` overrides this entirely
and reindexes all tracked files, which is the right choice after upgrading or if you
suspect the index is stale.

## Skip reasons

Not every file on disk is indexed. When the scanner declines a file, it records a
**skip reason**. The six reasons are exact:

| Skip reason      | Meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `not_included`   | Path is outside the configured `include` globs.                |
| `excluded`       | Path matches an `exclude` glob (e.g. `node_modules`, `dist`).  |
| `gitignored`     | Path is ignored by the project's root `.gitignore`.            |
| `binary`         | File is detected as binary and `scanBinaryFiles` is `false`.   |
| `too_large`      | File exceeds `maxFileSizeKb` (default 512 KB).                 |
| `sensitive_file` | File matches a sensitive pattern; its content is never stored. |

The skipped count in the run tally aggregates all of these.

## Safety guarantees

The scanner is designed never to read, follow, or leak anything outside the project
root.

- **No symlink following.** The scanner does not follow symbolic links. It performs
  a per-segment symlink check on each path so a symlinked directory cannot smuggle
  the walk outside the tree.
- **Path-traversal / root-escape blocking.** Paths that attempt to traverse out of
  the project root (e.g. via `..` or an absolute escape) are blocked.
- **Never reads outside the project root.** All reads are confined to the root you
  point `kundun` at with `--project-root` (defaults to the current directory).

### Sensitive files: skipped, content never stored

Some files must never have their contents captured. When a path matches a sensitive
pattern, the scanner skips it with reason `sensitive_file`. A `files` row and a hash
**may** be tracked so that the file can later be retired by cleanup, but the file's
**content is never stored** — no chunks, no symbols, no FTS entries.

Patterns treated as sensitive include:

- Environment files: `.env`, `.env.*`
- Keys and certificates: `*.pem`, `*.key`, `*.pfx`, `*.p12`, `id_rsa`
- Secrets and credentials: `**/secrets/**`, `*secret*`, `*credential*`,
  `.aws/credentials`
- Infrastructure state and dumps: `*.tfstate`, database dumps

This is a core part of Kundun-Agent's [security](/en/security/) posture: the index can
know a sensitive file _exists_ (path + hash) without ever ingesting what is inside
it.

## The indexer

Once the scanner hands over the new and changed text files, the indexer processes
them. It works on **text files only** and is built to never execute project code and
never crash the scan, even on malformed input.

### Language detection

Language is detected by file extension. The supported languages and their
extensions:

| Language     | Extensions                                       |
| ------------ | ------------------------------------------------ |
| `php`        | `.php`                                           |
| `go`         | `.go`                                            |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`                    |
| `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs`                    |
| `csharp`     | `.cs`                                            |
| `cpp`        | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.h`, `.c` |
| `sql`        | `.sql`                                           |

You can narrow a search or symbol lookup to one of these with `--language`:

```bash
kundun search "createUser" --language typescript
kundun symbol UserRepository --language php --kind class
```

### Line-range chunking and deduplication

The indexer splits each file into **line-range chunks** (default 200 lines per
chunk). Chunk boundaries are **1-based and inclusive** on both the start and end
line, which is why search results point you at a precise `relativePath:line`.

Each chunk gets its own **sha256** hash. Identical chunks **within the same file**
are deduplicated, so repeated boilerplate is not stored more than once per file.
Chunks are stored in the `file_chunks` table.

### Symbol extraction

For each file, the indexer runs a **per-language regex extractor** to pull out basic
symbols (functions, classes, and similar). These extractors:

- never execute project code, and
- never crash indexing — if extraction fails on a file, the file is still indexed.

Extracted symbols land in the `symbols` table and are what `kundun symbol` queries:

```bash
# Exact symbol name
kundun symbol parseConfig

# Prefix match, narrowed by kind
kundun symbol parse --prefix --kind function
```

### Importance scoring

Every indexed file is assigned an **importance score** from 0 to 100. The score
helps the [summary](/en/cli-reference/) surface what matters and helps
[cleanup](/en/cleanup/) reason about retention. Scoring is heuristic, based on the kind
of file:

- **High importance** — controllers, services, repositories, routes, middleware,
  migrations, schema SQL, auth, payments, security, domain code, tests, and config.
- **Low importance** — assets, generated CSS, lockfiles, snapshots, minified files,
  build output, cache, and logs.

### FTS index updates

When SQLite FTS5 is available, the indexer keeps the `chunks_fts` virtual table in
sync as it writes chunks, so full-text [search](/en/search/) reflects the latest
content. When FTS5 is unavailable, search transparently falls back to a `LIKE`
scan — the active mode is shown in command output.

## A typical first run

```bash
# 1. Initialize the project (creates kundun.config.json and .kundun/)
kundun init

# 2. Scan and index everything
kundun scan

# 3. Confirm what was indexed
kundun summary
```

After this, `search`, `symbol`, and `summary` all draw on the index the scan just
built. Re-running `kundun scan` later is cheap: only files whose content changed are
reindexed.

## See also

- [Documentation hub](/en/)
- [Search](/en/search/) — querying the chunks and symbols this stage produces
- [Security](/en/security/) — the full local-first and sensitive-file guarantees
