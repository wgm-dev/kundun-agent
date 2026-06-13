# Task Engine

The task engine is Kundun-Agent's lightweight, local-first work tracker. It lets you
(or a coding agent) record what needs doing, pick the single most important next
task, update progress, and link tasks back to the code and decisions they touch.
Everything lives in the local SQLite database — there is no server and no external
service.

This page covers the task lifecycle, the available statuses and priorities, the
`task` subcommands, the exact ordering used by `task next` (with a worked example),
and how to relate a task to files and memories.

## Concepts

A task is a unit of work with a title, an optional description, a priority, and a
status. Tasks move through a small lifecycle and can be related to files in the
indexed codebase and to entries in the [memory engine](memory-engine.md).

### Priorities

A task has exactly one priority:

| Priority   | Meaning                                 |
| ---------- | --------------------------------------- |
| `critical` | Must be handled before anything else.   |
| `high`     | Important; handled after critical work. |
| `medium`   | Normal work.                            |
| `low`      | Nice to have / can wait.                |

### Statuses

A task has exactly one status. The lifecycle is:

| Status        | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `pending`     | Created but not started.                                    |
| `in_progress` | Actively being worked on.                                   |
| `blocked`     | Cannot proceed (waiting on something).                      |
| `completed`   | Finished. Completing a task records a completion timestamp. |
| `archived`    | Retired from active views (e.g. by cleanup retention).      |

A typical task moves `pending` → `in_progress` → `completed`, with `blocked` as a
temporary detour and `archived` as the end-of-life state.

## Commands

All commands share the [global CLI options](cli-reference.md) — notably
`--project-root <path>` and `--json` for machine-readable output.

### Create a task

```bash
kundun task create --title <title> [--description <d>] [--priority <p>] [--files <a,b>]
```

- `--title` is required.
- `--priority` is one of `low | medium | high | critical`.
- `--files` accepts a comma-separated list of file paths to relate to the task.

```bash
kundun task create \
  --title "Fix payment webhook retry loop" \
  --description "Webhook handler retries indefinitely on 5xx" \
  --priority critical \
  --files "src/payments/webhook.ts,src/payments/retry.ts"
```

A newly created task starts in `pending`.

### Get the next task

```bash
kundun task next
```

Returns the single most important task to work on according to the strict ordering
described in [The `next()` ordering](#the-next-ordering) below. Returns nothing if
no task qualifies.

### Update a task

```bash
kundun task update <id> [--status <s>] [--priority <p>] [--title <t>] [--description <d>]
```

- `--status` is one of `pending | in_progress | blocked | completed | archived`.
- `--priority` is one of `low | medium | high | critical`.

Move a task into progress, then complete it:

```bash
kundun task update 42 --status in_progress
kundun task update 42 --status completed
```

Setting `--status completed` records the completion timestamp.

### List tasks

```bash
kundun task list [--status <s>] [--limit <n>]
```

Lists tasks, optionally filtered by `--status` and capped by `--limit`.

```bash
kundun task list --status in_progress
kundun task list --limit 20
```

## The `next()` ordering

`kundun task next` does **not** simply return the highest-priority task. It applies
a fixed, fully ordered preference list that combines priority and status. The order
is exactly:

1. `critical` + `pending`
2. `critical` + `in_progress`
3. `high` + `pending`
4. `high` + `in_progress`
5. `medium` + `pending`
6. `low` + `pending`

Everything else is **excluded** from `task next`:

- any `blocked` task,
- any `completed` task,
- any `archived` task,
- `medium` + `in_progress`,
- `low` + `in_progress`.

The first bucket (top of the list) that contains at least one task wins, and a task
from that bucket is returned.

### Worked example

Suppose the active task list contains:

| ID  | Title                    | Priority   | Status        |
| --- | ------------------------ | ---------- | ------------- |
| 1   | Patch auth bypass        | `critical` | `in_progress` |
| 2   | Add audit log            | `high`     | `pending`     |
| 3   | Refactor billing service | `high`     | `in_progress` |
| 4   | Update README            | `medium`   | `pending`     |
| 5   | Investigate flaky test   | `low`      | `in_progress` |
| 6   | Rotate API keys          | `critical` | `blocked`     |

Walking the ordering:

1. `critical` + `pending` — no task (task 6 is `critical` but `blocked`, so it is
   excluded entirely).
2. `critical` + `in_progress` — **task 1 matches**.

`kundun task next` returns **task 1 (Patch auth bypass)**.

Note the subtleties this example demonstrates:

- Task 6 is `critical` but `blocked`, so it never qualifies — `blocked` tasks are
  excluded regardless of priority.
- Task 1 (`critical` + `in_progress`) is chosen over task 2 (`high` + `pending`),
  because the critical buckets sit above all high buckets.
- Task 5 (`low` + `in_progress`) is excluded; only `low` + `pending` qualifies.

If task 1 were instead `completed`, the next match would be task 2 (`high` +
`pending`), and task 3 (`high` + `in_progress`) would only be chosen if task 2 did
not exist.

## Relating tasks to files and memories

Tasks can be related to files in the indexed codebase and to entries in the
[memory engine](memory-engine.md). These relations are stored as JSON on the task,
so the agent can later answer "which files does this task touch?" or "what decision
backs this task?".

File relations can be set at creation time with `--files`:

```bash
kundun task create \
  --title "Tighten session expiry" \
  --priority high \
  --files "src/auth/session.ts,src/auth/middleware.ts"
```

Relating a task to a memory (for example, a recorded `decision` or `risk`) connects
the work item to the reasoning behind it, so context survives across sessions. See
the [memory engine](memory-engine.md) page for how memories are created and
classified.

## See also

- [Documentation hub](../README.md)
- [Memory engine](memory-engine.md) — persistent project memory you can relate
  tasks to.
- [CLI reference](cli-reference.md) — full list of commands and global options.
