---
title: Memory Engine
description: The memory engine is Kundun-Agent's persistent project memory — capturing what you and your agents have learned about the project.
---

The memory engine is Kundun-Agent's **persistent project memory**. While the
scanner and indexer capture _what the code is_, the memory engine captures
_what you and your agents have learned about the project_ — architectural
decisions, conventions, known bugs, domain rules, useful commands, and risks.

Memory is stored locally in SQLite (in the `memories` table) and survives across
sessions, restarts, and re-scans. Coding agents can write memories as they work
and read them back later to stay grounded in the project's real history instead
of re-deriving context every time.

## Memory types

Every memory has exactly one `type`, chosen from these nine allowed values:

| Type           | Use it for                                                        |
| -------------- | ----------------------------------------------------------------- |
| `architecture` | How the system is structured; module boundaries; data flow.       |
| `decision`     | A choice that was made and why (e.g. "use SQLite, not Postgres"). |
| `bug`          | A known defect, its symptom, and any workaround.                  |
| `task`         | A note tied to a unit of work (distinct from the task engine).    |
| `convention`   | Coding/style/naming rules the project follows.                    |
| `command`      | A useful command or recipe to run.                                |
| `risk`         | Something fragile or dangerous to be careful about.               |
| `domain_rule`  | A business/domain rule the code must honor.                       |
| `user_note`    | A free-form note from a human or agent.                           |

Passing any other value to `--type` is rejected.

## Fields

Each memory record carries the following fields:

- `type` — one of the nine types above.
- `title` — short, human-readable label.
- `content` — the full text of the memory.
- `tags` — free-form labels for grouping and filtering.
- `source` — where the memory came from (e.g. an agent name, a doc, a person).
- `confidence` — how trustworthy the memory is.
- `importance_score` — a value from `0` to `100` (see
  [Importance and promotion](#importance-and-promotion)).
- `created_at` / `updated_at` — when the memory was created and last modified.
- `last_used_at` — when the memory was last retrieved (updated on retrieval).
- `expires_at` — optional expiry for temporary notes (see
  [Expiration](#expiration)).
- `archived_at` — set when the memory is archived (see
  [Archiving](#archiving)).

## Commands

All commands accept the [global options](/en/) (`--project-root`,
`--json`). Examples below show the published `kundun` invocation.

### Add a memory

```text
kundun memory add --type <type> --title <title> --content <content> \
  [--tags <a,b>] [--importance <n>] [--source <source>]
```

- `--type` (required) — one of the nine types.
- `--title` (required) — short label.
- `--content` (required) — the memory body.
- `--tags` — comma-separated tags, e.g. `auth,session`.
- `--importance` — `0..100`. Higher means more important.
- `--source` — origin of the memory.

Example — record an architectural decision so future agents stop re-asking:

```text
kundun memory add \
  --type decision \
  --title "Search uses SQLite FTS5, LIKE fallback" \
  --content "Primary search is FTS5 with bm25 ranking; falls back to LIKE when FTS5 is unavailable. No external embeddings in MVP1." \
  --tags search,sqlite \
  --importance 80 \
  --source architecture-review
```

### Search memories

```text
kundun memory search [query] [--type <type>] [--tags <a,b>] [--limit <n>]
```

- `query` — optional free-text query.
- `--type` — restrict to a single memory type.
- `--tags` — restrict to memories carrying these tags.
- `--limit` — cap the number of results.

Search excludes archived memories. Retrieving a memory through search updates
its `last_used_at` and applies bounded promotion (see below).

Example — find everything tagged `auth` that is a known bug:

```text
kundun memory search --type bug --tags auth
```

### List recent memories

```text
kundun memory list [--limit <n>]
```

Lists memories for a quick overview. The `summary` command also surfaces the
most important memories as part of its read-only project overview.

## Importance and promotion

`importance_score` runs from `0` to `100`. You set an initial value with
`--importance` when adding a memory; if you omit it, the engine assigns a
score.

**Bounded promotion on retrieval.** When a memory is _retrieved_ (via get or
search), the engine bumps its `importance_score` by **`+10`, clamped to a
maximum of `100`**, and updates `last_used_at`. This means memories you actually
keep using drift upward in importance over time — but never past `100`, and
never by more than one step per retrieval.

**`listImportant` is read-only.** Listing the important memories (as used by the
`summary` overview) does **not** promote anything: it neither changes
`importance_score` nor touches `last_used_at`. Only get/search retrieval
promotes. Archived memories are excluded from this list.

### High-importance memories are never auto-deleted

Memories with `importance_score >= 80` (the `HIGH_IMPORTANCE_THRESHOLD`) are
**never** removed by automatic [cleanup](/en/cleanup/). Cleanup only ever
considers _low-importance_ expired memories for deletion; anything at or above
`80` is protected. If you want a memory to stick around permanently, give it an
importance of `80` or more — or let bounded promotion carry it there through
repeated use.

## Archiving

Archiving retires a memory without deleting it. `archive()` sets the
`archived_at` timestamp, and from then on the memory is **excluded from search
and from the important-memories list**. The record (and its content) stays in
the database — archiving is a soft retirement, not a delete.

Use archiving for memories that are no longer relevant but that you may want to
keep for historical reference.

## Expiration

Temporary notes can be given an `expires_at` timestamp. Expired
_low-importance_ memories become eligible for removal by automatic cleanup,
according to `cleanup.deleteLowImportanceMemoriesAfterDays` in your
[configuration](/en/configuration/). High-importance memories (`>= 80`) are still
protected even if they have expired — they are never auto-deleted. Use
expiration for short-lived context (a temporary workaround, a note that only
matters during a migration) that you do not want lingering forever.

## See also

- [Documentation hub](/en/)
- [Cleanup](/en/cleanup/) — retention rules, and why high-importance memories
  survive.
- [Search](/en/search/) — how FTS5/LIKE search works across indexed content.
