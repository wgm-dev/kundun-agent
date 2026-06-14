---
title: Cleanup
description: The cleanup engine keeps a Kundun-Agent project's local SQLite database tidy over time by applying a configurable retention policy to remove or archive stale data.
---

The cleanup engine keeps a Kundun-Agent project's local SQLite database tidy over
time. As you scan, index, record memories, and complete tasks, the database
accumulates rows that are no longer useful: files that were deleted on disk,
orphaned chunks and symbols, expired low-importance notes, long-completed tasks,
and old log files. `kundun cleanup` applies a configurable **retention policy** to
remove or archive that stale data — safely, in one transaction, and entirely
locally.

This page covers the retention keys and the targets they map to, the difference
between a dry run and a real run, the guarantee that high-importance memories are
never auto-deleted, how `VACUUM` behaves, and example output for both modes.

## Command

```bash
kundun cleanup [--dry-run]
```

- With no flag, cleanup performs a **real run**: it mutates the database, deletes
  old log files, optionally runs `VACUUM`, and records a row in `cleanup_runs`.
- With `--dry-run`, cleanup only **reports what would be removed** and changes
  nothing at all — see [Dry run vs. real run](#dry-run-vs-real-run).

Like every command, `cleanup` accepts the [global options](/en/cli-reference/)
`--project-root <path>` and `--json` (clean JSON on stdout; logs on stderr).

## Retention policy

The policy lives under the `cleanup` object in `kundun.config.json`. Each key sets
an age threshold (in days) or a behavior flag, and each maps to a specific cleanup
target. The defaults are:

```json
{
  "cleanup": {
    "deleteDeletedFilesAfterDays": 7,
    "deleteUnusedChunksAfterDays": 30,
    "deleteLowImportanceMemoriesAfterDays": 60,
    "archiveCompletedTasksAfterDays": 30,
    "deleteLogsAfterDays": 14,
    "vacuumAfterCleanup": true
  }
}
```

Each key maps to a target as follows:

| Config key                             | Target                             | What happens                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deleteDeletedFilesAfterDays`          | Old deleted files                  | Files marked `is_deleted=1` (removed on disk and detected by the scanner) older than this threshold are deleted. The delete **cascades** to their `file_chunks` and `symbols`. |
| `deleteUnusedChunksAfterDays`          | Orphan chunks (and orphan symbols) | Chunks no longer attached to a live file, older than this threshold, are removed. Orphan symbols are cleaned up alongside them.                                                |
| `deleteLowImportanceMemoriesAfterDays` | Expired low-importance memories    | Expired memories below the high-importance threshold, older than this threshold, are deleted. Memories with `importance_score >= 80` are **never** touched (see below).        |
| `archiveCompletedTasksAfterDays`       | Old completed tasks                | Tasks that have been `completed` longer than this threshold are **archived** (moved to `archived` status), not deleted.                                                        |
| `deleteLogsAfterDays`                  | Old log files                      | Log files in `.kundun/logs/` older than this threshold are deleted from disk.                                                                                                  |
| `vacuumAfterCleanup`                   | Database compaction                | Whether to run `VACUUM` after a real cleanup (see [VACUUM behavior](#vacuum-behavior)).                                                                                        |

A partial config is accepted: any `cleanup` key you omit falls back to the default
above. Whether automatic cleanup is allowed at all is gated by the top-level
`enableAutoCleanup` flag — see the [configuration](/en/configuration/) page. You can
always trigger cleanup explicitly with `kundun cleanup` regardless.

## Dry run vs. real run

`--dry-run` is the safe way to preview cleanup. The two modes differ as follows:

| Aspect             | `--dry-run`      | Real run                                 |
| ------------------ | ---------------- | ---------------------------------------- |
| Database rows      | Counted only     | Deleted/archived in a single transaction |
| Log files on disk  | Counted only     | Deleted (outside the transaction)        |
| `VACUUM`           | Never runs       | Runs if `vacuumAfterCleanup` is `true`   |
| `cleanup_runs` row | **Not recorded** | Recorded                                 |

A dry run **changes nothing** — it does not mutate any table, does not delete any
log file, does not run `VACUUM`, and **does not even write a `cleanup_runs` row**.
It exists purely to tell you what a real run _would_ do, so you can review the
counts before committing.

A real run performs all database mutations inside **one transaction**. After the
transaction commits, it deletes the old log files (this happens outside the
transaction), then runs `VACUUM` if enabled, and finally records a `cleanup_runs`
row capturing the outcome.

## High-importance memories are never auto-deleted

Cleanup will **never** delete a memory whose `importance_score` is at or above the
high-importance threshold of `80` (`HIGH_IMPORTANCE_THRESHOLD`). Only _expired
low-importance_ memories — those below `80` and past their `expires_at`, older than
`deleteLowImportanceMemoriesAfterDays` — are eligible for removal. A high-importance
memory is protected **even if it has expired**.

If you want a memory to survive cleanup indefinitely, give it an importance of `80`
or more. See the [memory engine](/en/memory-engine/) page for how importance is set
and how bounded promotion can carry a memory above the threshold through repeated
use.

## VACUUM behavior

`VACUUM` reclaims space and defragments the SQLite database file after rows have
been deleted. Its behavior is deliberately conservative:

- It runs **only** when `vacuumAfterCleanup` is `true` **and** the run is a real
  run — never on a dry run.
- It runs **after the transaction commits**, outside of any transaction (`VACUUM`
  cannot run inside one).
- If the database is **locked** at that moment, the `VACUUM` is **skipped, not
  treated as an error** — the cleanup still succeeds and is recorded.

## Examples

### Dry run

Preview what cleanup would remove, changing nothing:

```bash
kundun cleanup --dry-run
```

```text
Cleanup (dry run) — no changes made
  deleted files (cascades chunks/symbols) : 3
  orphan chunks                           : 41
  orphan symbols                          : 12
  expired low-importance memories         : 5   (high-importance >=80 protected)
  completed tasks to archive              : 2
  old log files                           : 4
  VACUUM                                  : skipped (dry run)
No cleanup_runs row written (dry run).
```

### Real run

Apply the retention policy for real:

```bash
kundun cleanup
```

```text
Cleanup complete
  deleted files (cascaded chunks/symbols) : 3
  orphan chunks removed                   : 41
  orphan symbols removed                  : 12
  expired low-importance memories removed : 5   (high-importance >=80 protected)
  completed tasks archived                : 2
  old log files deleted                   : 4
  VACUUM                                  : done
  cleanup_runs row recorded.
```

> Output is illustrative. Use `--json` for the exact machine-readable payload;
> stdout stays clean JSON while logs go to stderr.

## When and how to run cleanup

Cleanup is safe to run routinely. Good moments to run it:

- After a large scan that removed many files (lots of `is_deleted=1` rows and
  orphan chunks to reclaim).
- Periodically, to archive long-completed tasks and trim old logs.
- Before sharing or backing up a project, to compact the database.

Recommended habit: run `kundun cleanup --dry-run` first to review the counts, then
run `kundun cleanup` once you are satisfied. There is no auto-scan or daemon in this
release, so cleanup is invoked explicitly when you choose. Use the read-only
[`summary`](/en/cli-reference/) overview to see when the last cleanup ran.

## See also

- [Documentation hub](/en/)
- [Memory engine](/en/memory-engine/) — importance scoring and why
  high-importance memories survive cleanup.
- [Configuration](/en/configuration/) — the full `cleanup` retention keys and
  `enableAutoCleanup`.
