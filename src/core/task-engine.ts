// Task engine: validation + lifecycle orchestration over the tasks table.
// Owns enum validation (status/priority) and the small business rules around
// task creation, updates, completion, archival, and relationship merges.
// Pure delegation to TaskRepository for persistence; no direct SQL here.

import type { TaskRow, TaskStatus, TaskPriority } from '../storage/types.js';
import type { TaskRepository, TaskListOptions } from '../storage/repositories/task.repository.js';
import { KundunError } from '../utils/errors.js';
import { nowIso } from '../utils/time.js';

/** All valid task statuses (mirrors {@link TaskStatus}). */
export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'archived',
] as const satisfies readonly TaskStatus[];

/** All valid task priorities (mirrors {@link TaskPriority}). */
export const TASK_PRIORITIES = [
  'low',
  'medium',
  'high',
  'critical',
] as const satisfies readonly TaskPriority[];

const DEFAULT_PRIORITY: TaskPriority = 'medium';

/**
 * Validate that `value` is a known task status, returning the narrowed type.
 * Throws KundunError('invalid_argument') otherwise.
 */
export function validateStatus(value: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus;
  }
  throw new KundunError(
    'invalid_argument',
    `Invalid task status "${value}". Expected one of: ${TASK_STATUSES.join(', ')}.`,
  );
}

/**
 * Validate that `value` is a known task priority, returning the narrowed type.
 * Throws KundunError('invalid_argument') otherwise.
 */
export function validatePriority(value: string): TaskPriority {
  if ((TASK_PRIORITIES as readonly string[]).includes(value)) {
    return value as TaskPriority;
  }
  throw new KundunError(
    'invalid_argument',
    `Invalid task priority "${value}". Expected one of: ${TASK_PRIORITIES.join(', ')}.`,
  );
}

/** Input accepted by {@link TaskEngine.create}. */
export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: string;
  relatedFiles?: string[];
  relatedMemories?: string[];
}

/** Patch accepted by {@link TaskEngine.update}. */
export interface UpdateTaskPatch {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  relatedFiles?: string[];
  relatedMemories?: string[];
}

/** Options forwarded to {@link TaskEngine.list}. */
export interface ListTasksOptions {
  status?: string;
  priority?: string;
  limit?: number;
}

/** Public surface of the task engine. */
export interface TaskEngine {
  create(input: CreateTaskInput): number;
  update(id: number, patch: UpdateTaskPatch): void;
  get(id: number): TaskRow | undefined;
  list(opts?: ListTasksOptions): TaskRow[];
  search(query: string, limit?: number): TaskRow[];
  next(): TaskRow | undefined;
  complete(id: number): void;
  archive(id: number): void;
  relateFiles(id: number, files: string[]): void;
  relateMemories(id: number, ids: string[]): void;
}

/** Dependencies for {@link createTaskEngine}. */
export interface TaskEngineDeps {
  taskRepo: TaskRepository;
  /** Clock injection for tests; defaults to {@link nowIso}. */
  now?: () => string;
}

/**
 * Build a TaskEngine over the given repository. Stateless apart from injected
 * deps; safe to construct per request.
 */
export function createTaskEngine(deps: TaskEngineDeps): TaskEngine {
  const { taskRepo } = deps;
  const now = deps.now ?? nowIso;

  return {
    create(input: CreateTaskInput): number {
      // Default priority to 'medium' when omitted; validate when provided.
      const priority = input.priority == null ? DEFAULT_PRIORITY : validatePriority(input.priority);
      const ts = now();

      return taskRepo.create({
        title: input.title,
        description: input.description ?? null,
        status: 'pending',
        priority,
        related_files: input.relatedFiles ? JSON.stringify(input.relatedFiles) : null,
        related_memories: input.relatedMemories ? JSON.stringify(input.relatedMemories) : null,
        created_at: ts,
        updated_at: ts,
        completed_at: null,
      });
    },

    update(id: number, patch: UpdateTaskPatch): void {
      // Build the repository patch, validating enums and omitting absent keys
      // (exactOptionalPropertyTypes forbids assigning undefined to optionals).
      const repoPatch: {
        title?: string;
        description?: string;
        status?: TaskStatus;
        priority?: TaskPriority;
        related_files?: string[];
        related_memories?: string[];
      } = {};

      if (patch.title !== undefined) {
        repoPatch.title = patch.title;
      }
      if (patch.description !== undefined) {
        repoPatch.description = patch.description;
      }
      if (patch.status !== undefined) {
        repoPatch.status = validateStatus(patch.status);
      }
      if (patch.priority !== undefined) {
        repoPatch.priority = validatePriority(patch.priority);
      }
      if (patch.relatedFiles !== undefined) {
        repoPatch.related_files = patch.relatedFiles;
      }
      if (patch.relatedMemories !== undefined) {
        repoPatch.related_memories = patch.relatedMemories;
      }

      // The repository auto-stamps completed_at when status becomes 'completed'
      // and no completed_at is supplied, so we don't set it here.
      taskRepo.update(id, repoPatch);
    },

    get(id: number): TaskRow | undefined {
      return taskRepo.getById(id);
    },

    list(opts: ListTasksOptions = {}): TaskRow[] {
      // Validate filter enums up front so bad input fails fast.
      if (opts.status !== undefined) {
        validateStatus(opts.status);
      }
      if (opts.priority !== undefined) {
        validatePriority(opts.priority);
      }

      const repoOpts: TaskListOptions = {};
      if (opts.status !== undefined) {
        repoOpts.status = opts.status;
      }
      if (opts.priority !== undefined) {
        repoOpts.priority = opts.priority;
      }
      if (opts.limit !== undefined) {
        repoOpts.limit = opts.limit;
      }
      return taskRepo.list(repoOpts);
    },

    search(query: string, limit?: number): TaskRow[] {
      return limit === undefined ? taskRepo.searchLike(query) : taskRepo.searchLike(query, limit);
    },

    next(): TaskRow | undefined {
      return taskRepo.findNext();
    },

    complete(id: number): void {
      // Explicit completed_at keeps the engine's injected clock authoritative.
      taskRepo.update(id, { status: 'completed', completed_at: now() });
    },

    archive(id: number): void {
      taskRepo.update(id, { status: 'archived' });
    },

    relateFiles(id: number, files: string[]): void {
      taskRepo.relateFiles(id, files);
    },

    relateMemories(id: number, ids: string[]): void {
      taskRepo.relateMemories(id, ids);
    },
  };
}
