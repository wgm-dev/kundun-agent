---
title: Security
description: Kundun-Agent is a local-first project intelligence layer that reads your source code, builds an index, and keeps persistent memory — all on your machine.
---

Kundun-Agent is a **local-first project intelligence layer**. Its entire job is to
read your source code, build an index, and keep persistent memory about a project —
and it does all of that on your machine, in a single SQLite database under `.kundun/`.
This page describes the security model end to end: what Kundun-Agent will and will
not do with your code, how the scanner stays inside the project root, how sensitive
files are handled, and how you can verify the secret-leak guarantee yourself.

For vulnerability reporting and supported versions, see the project's
[SECURITY.md](https://github.com/wgm-dev/kundun-agent/blob/main/SECURITY.md).

## Local-first: no external API calls by default

Kundun-Agent does not send your project content anywhere. Indexing, search, memory,
tasks, and cleanup all run locally against the SQLite database. There are **no
external embeddings** in MVP1 — search uses SQLite FTS5 (with a `LIKE` fallback), not
a remote model. A `future-embedding-provider` exists only as a stub.

The practical consequence: you can run Kundun-Agent fully offline. Disconnect the
network and every command still works.

```bash
kundun scan
kundun search "createUser"
kundun summary
```

None of these reach out to a third party.

## No code or command execution

Kundun-Agent **never executes your project code** and **never runs arbitrary
commands** on behalf of an agent. It only _reads_ files and writes to its own
database.

This guarantee holds throughout the pipeline:

- The **indexer** processes text files only. Symbols are extracted with per-language
  **regex extractors** — it pattern-matches source text, it does not evaluate it.
- Symbol extraction **never executes code** and **never crashes indexing**: if an
  extractor fails on a malformed file, that file is still indexed and the scan
  continues.
- There is no `eval`, no spawning of build tools, no running of test suites.

In MVP1 there is also no MCP server, no daemon, no local HTTP API, and no WebSocket —
so there is no network surface that could be used to trigger execution. The config
keys `allowRestartFromMcp` and `autoScan` exist, but the features they would gate are
not implemented in MVP1.

## Root containment, traversal blocking, and symlinks

Every read Kundun-Agent performs is confined to the project root — the directory you
point it at with `--project-root` (it defaults to the current working directory). The
scanner is built so that nothing can pull the walk outside that tree.

- **Never reads outside the project root.** All file access is scoped to the root.
- **Path-traversal / root-escape blocking.** Paths that try to climb out of the root
  (for example via `..` or an absolute escape) are blocked.
- **No symlink following.** The scanner does not follow symbolic links. It runs a
  **per-segment symlink check** on each path, so a symlinked directory cannot be used
  to smuggle the walk into, say, your home directory.

These checks live in the scanner; see [Scanner & Indexing](/en/scanner-indexing/) for
how they fit into the walk. The root `.gitignore` and the configured
`include` / `exclude` globs further bound what is even considered (see
[Configuration](/en/configuration/)).

## Sensitive files: skipped, content never stored

Some files must never have their contents captured, even though they live inside the
project. When a path matches a **sensitive pattern**, the scanner skips it with the
skip reason `sensitive_file`.

The important detail: a `files` row and a content **hash** _may_ be recorded so that
the file can be tracked for deletion by [cleanup](/en/cleanup/) — but the file's
**content is never stored**. No chunks, no symbols, no FTS entries. The index can know
that a secret file _exists_ (path + hash) without ever ingesting what is inside it.

Patterns treated as sensitive include:

| Category                   | Examples                                                        |
| -------------------------- | --------------------------------------------------------------- |
| Environment files          | `.env`, `.env.*`                                                |
| Keys and certificates      | `*.pem`, `*.key`, `*.pfx`, `*.p12`, `id_rsa`                    |
| Secrets and credentials    | `**/secrets/**`, `*secret*`, `*credential*`, `.aws/credentials` |
| Infrastructure state/dumps | `*.tfstate`, database dumps                                     |

This sits alongside the other five skip reasons (`excluded`, `gitignored`, `binary`,
`too_large`, `not_included`); only `sensitive_file` carries the
content-never-stored guarantee specifically.

## Verifying the secret-leak guarantee yourself

You do not have to take the guarantee on faith. Because everything lives in one
SQLite file, you can prove that a sensitive file's content never entered the index.

1. **Create a secret in your project root** with a unique, greppable marker:

   ```bash
   echo "API_TOKEN=SUPER_SECRET_MARKER_12345" > .env
   ```

2. **Initialize and scan.** The `.env` file will be skipped with reason
   `sensitive_file`:

   ```bash
   kundun init
   kundun scan
   ```

   The run tally counts it under `skipped`, not `indexed`.

3. **Search for the marker.** It must not be found, because the content was never
   stored:

   ```bash
   kundun search "SUPER_SECRET_MARKER_12345"
   ```

4. **Inspect the database directly** for the marker. It should return no rows from
   any content-bearing table:

   ```bash
   sqlite3 .kundun/kundun.sqlite \
     "SELECT path FROM file_chunks WHERE content LIKE '%SUPER_SECRET_MARKER%';"
   ```

The only place `.env` may appear is the `files` table (path + hash for change
tracking) — never in `file_chunks`, `symbols`, or the FTS tables. Because the
database is plain SQLite on your disk, you can audit it with any SQLite client at any
time.

## Where your data lives

All Kundun-Agent state is local, under the project's `.kundun/` directory:

- `kundun.sqlite` — the database (WAL mode, `foreign_keys=ON`).
- `cache/`, `logs/`, `snapshots/`, `runtime/` — supporting directories.
- `config.json` — a mirror of the project config.

Nothing is written outside the project root, and nothing leaves your machine.

## Summary

- **Local-first** — no project content is sent to external APIs by default; works
  fully offline.
- **No execution** — never runs project code or arbitrary commands; symbols are
  extracted by regex, not evaluation.
- **Root-contained** — never reads outside the project root, blocks path traversal,
  does not follow symlinks (per-segment check).
- **Secret-safe** — sensitive files are skipped; only path + hash may be tracked,
  content is never stored — and you can verify it directly against the SQLite file.

## See also

- [Documentation hub](/en/)
- [Scanner & Indexing](/en/scanner-indexing/) — where the containment and
  sensitive-file checks run
- [Configuration](/en/configuration/) — `include` / `exclude`, `maxFileSizeKb`, and
  cleanup retention
