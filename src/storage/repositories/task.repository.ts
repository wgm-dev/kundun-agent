// Repository for the `tasks` table. `related_files` and `related_memories` are
// stored as JSON string arrays. No FTS is used for tasks.

import type { KundunDb, TaskRow, NewTaskRow, TaskStatus, TaskPriority } from '../types.js';
import { parseStringArray, stringifyArray } from '../../utils/json.js';
import { nowIso } from '../../utils/time.js';

/** Patch shape accepted by {@link TaskRepository.update}. */
export interface TaskUpdatePatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  /** Related file relative-paths as a string array; serialized to JSON. */
  related_files?: string[];
  /** Related memory ids (as strings) as a string array; serialized to JSON. */
  related_memories?: string[];
  completed_at?: string | null;
}

/** Options for {@link TaskRepository.list}. */
export interface TaskListOptions {
  status?: string;
  priority?: string;
  limit?: number;
}

/** Columns that {@link TaskRepository.update} may mutate (excluding updated_at/completed_at). */
const MUTABLE_COLUMNS = [
  'title',
  'description',
  'status',
  'priority',
  'related_files',
  'related_memories',
] as const;

const DEFAULT_LIST_LIMIT = 100;

/** Escape LIKE wildcards so user input is matched literally (ESCAPE '\'). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class TaskRepository {
  private readonly kdb: KundunDb;

  constructor(kdb: KundunDb) {
    this.kdb = kdb;
  }

  /** Insert a new task; returns the new id. Defaults status/priority at the DB. */
  create(row: NewTaskRow): number {
    const now = nowIso();
    const created = row.created_at || now;
    const updated = row.updated_at || now;

    const info = this.kdb.db
      .prepare(
        `INSERT INTO tasks
           (title, description, status, priority, related_files, related_memories,
            created_at, updated_at, completed_at)
         VALUES
           (@title, @description, @status, @priority, @related_files, @related_memories,
            @created_at, @updated_at, @completed_at)`,
      )
      .run({
        title: row.title,
        description: row.description,
        status: row.status || 'pending',
        priority: row.priority || 'medium',
        related_files: row.related_files,
        related_memories: row.related_memories,
        created_at: created,
        updated_at: updated,
        completed_at: row.completed_at,
      });

    return Number(info.lastInsertRowid);
  }

  /**
   * Dynamic, whitelisted SET update. Always bumps updated_at. When status is set
   * to 'completed' and no completed_at is supplied, completed_at is set to now.
   * Returns the number of rows changed (0 when the id does not exist).
   */
  update(id: number, patch: TaskUpdatePatch): number {
    const assignments: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const col of MUTABLE_COLUMNS) {
      if (!(col in patch)) {
        continue;
      }
      if (col === 'related_files' || col === 'related_memories') {
        const arr = patch[col];
        params[col] = arr === undefined ? null : stringifyArray(arr);
      } else {
        params[col] = patch[col];
      }
      assignments.push(`${col} = @${col}`);
    }

    const now = nowIso();
    params['updated_at'] = now;
    assignments.push('updated_at = @updated_at');

    if ('completed_at' in patch) {
      params['completed_at'] = patch.completed_at;
      assignments.push('completed_at = @completed_at');
    } else if (patch.status === 'completed') {
      // Auto-stamp completion time when transitioning to 'completed' without one.
      params['completed_at'] = now;
      assignments.push('completed_at = @completed_at');
    }

    const info = this.kdb.db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = @id`)
      .run(params);
    return info.changes;
  }

  /** Fetch a task by id, or undefined when not found. */
  getById(id: number): TaskRow | undefined {
    const row = this.kdb.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined;
    return row;
  }

  /** List tasks with optional status/priority filters, newest update first. */
  list(opts: TaskListOptions = {}): TaskRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: opts.limit ?? DEFAULT_LIST_LIMIT };

    if (opts.status != null && opts.status.length > 0) {
      params['status'] = opts.status;
      where.push('status = @status');
    }
    if (opts.priority != null && opts.priority.length > 0) {
      params['priority'] = opts.priority;
      where.push('priority = @priority');
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT *
      FROM tasks
      ${whereSql}
      ORDER BY updated_at DESC
      LIMIT @limit`;
    return this.kdb.db.prepare(sql).all(params) as TaskRow[];
  }

  /** LIKE search over title/description (wildcards escaped). */
  searchLike(query: string, limit = DEFAULT_LIST_LIMIT): TaskRow[] {
    const like = `%${escapeLike(query)}%`;
    const sql = `
      SELECT *
      FROM tasks
      WHERE title LIKE @like ESCAPE '\\' OR description LIKE @like ESCAPE '\\'
      ORDER BY updated_at DESC
      LIMIT @limit`;
    return this.kdb.db.prepare(sql).all({ like, limit }) as TaskRow[];
  }

  /**
   * The single most actionable task by a fixed priority/status rank:
   *   critical+pending(0), critical+in_progress(1), high+pending(2),
   *   high+in_progress(3), medium+pending(4), low+pending(5).
   * Any other combination (blocked/completed/archived, medium+in_progress,
   * low+in_progress, ...) is excluded. Ties broken by oldest updated_at.
   */
  findNext(): TaskRow | undefined {
    // The CASE rank lives in a subquery so the outer SELECT returns clean
    // TaskRow columns (no synthetic `rank` column leaks to callers).
    const sql = `
      SELECT t.id, t.title, t.description, t.status, t.priority,
             t.related_files, t.related_memories,
             t.created_at, t.updated_at, t.completed_at
      FROM (
        SELECT *,
          CASE
            WHEN priority = 'critical' AND status = 'pending' THEN 0
            WHEN priority = 'critical' AND status = 'in_progress' THEN 1
            WHEN priority = 'high' AND status = 'pending' THEN 2
            WHEN priority = 'high' AND status = 'in_progress' THEN 3
            WHEN priority = 'medium' AND status = 'pending' THEN 4
            WHEN priority = 'low' AND status = 'pending' THEN 5
            ELSE NULL
          END AS rank
        FROM tasks
      ) AS t
      WHERE t.rank IS NOT NULL
      ORDER BY t.rank ASC, t.updated_at ASC
      LIMIT 1`;
    const row = this.kdb.db.prepare(sql).get() as TaskRow | undefined;
    return row;
  }

  /** Merge-dedupe `files` into related_files (preserving existing order). */
  relateFiles(id: number, files: string[]): void {
    this.mergeArrayColumn(id, 'related_files', files);
  }

  /** Merge-dedupe `memIds` into related_memories (preserving existing order). */
  relateMemories(id: number, memIds: string[]): void {
    this.mergeArrayColumn(id, 'related_memories', memIds);
  }

  /** Completed tasks whose completion predates `iso` (cleanup candidates). */
  listCompletedOlderThan(iso: string): TaskRow[] {
    const sql = `
      SELECT *
      FROM tasks
      WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < @iso
      ORDER BY completed_at ASC`;
    return this.kdb.db.prepare(sql).all({ iso }) as TaskRow[];
  }

  /** Count of open tasks (pending, in_progress, blocked). */
  countOpen(): number {
    const row = this.kdb.db
      .prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE status IN ('pending', 'in_progress', 'blocked')",
      )
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  // --- internal helpers ---

  private mergeArrayColumn(
    id: number,
    column: 'related_files' | 'related_memories',
    additions: string[],
  ): void {
    const run = this.kdb.db.transaction((): void => {
      const current = this.kdb.db
        .prepare(`SELECT ${column} AS value FROM tasks WHERE id = ?`)
        .get(id) as { value: string | null } | undefined;
      if (current === undefined) {
        return;
      }
      const existing = parseStringArray(current.value);
      const merged = [...existing];
      for (const item of additions) {
        if (!merged.includes(item)) {
          merged.push(item);
        }
      }
      this.kdb.db
        .prepare(`UPDATE tasks SET ${column} = @value, updated_at = @updated_at WHERE id = @id`)
        .run({ value: stringifyArray(merged), updated_at: nowIso(), id });
    });
    run();
  }
}
