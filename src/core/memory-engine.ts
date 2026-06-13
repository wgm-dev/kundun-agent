// Memory engine (MVP1). Orchestrates the memories subsystem on top of
// MemoryRepository: validates input, applies the shared importance model (D5),
// and treats retrieval as "use" (touch last_used_at + bounded promotion) for
// non-read-only access paths. Pure orchestration; all persistence lives in the
// repository. All timestamps come from utils/time.ts.

import type {
  MemoryRepository,
  MemorySearchOptions,
  MemoryUpdatePatch,
} from '../storage/repositories/memory.repository.js';
import type { MemoryRow, MemoryType } from '../storage/types.js';
import type { Logger } from '../utils/logger.js';
import { clampImportance, demote, promote } from './importance.js';
import { KundunError } from '../utils/errors.js';
import { nowIso } from '../utils/time.js';

/** The 9 allowed memory categories (memories.type). Single source of truth. */
export const MEMORY_TYPES = [
  'architecture',
  'decision',
  'bug',
  'task',
  'convention',
  'command',
  'risk',
  'domain_rule',
  'user_note',
] as const satisfies readonly MemoryType[];

const MEMORY_TYPE_SET: ReadonlySet<string> = new Set<string>(MEMORY_TYPES);

/**
 * Assert that `t` is one of {@link MEMORY_TYPES} and narrow it to MemoryType.
 * Throws KundunError('invalid_argument') otherwise.
 */
export function validateMemoryType(t: string): MemoryType {
  if (!MEMORY_TYPE_SET.has(t)) {
    throw new KundunError(
      'invalid_argument',
      `Invalid memory type "${t}". Expected one of: ${MEMORY_TYPES.join(', ')}.`,
    );
  }
  return t as MemoryType;
}

/** Input accepted by {@link MemoryEngine.add}. */
export interface MemoryAddInput {
  type: string;
  title: string;
  content: string;
  tags?: string[];
  source?: string;
  importanceScore?: number;
  confidence?: number;
}

/** Dependencies for {@link createMemoryEngine}. */
export interface MemoryEngineDeps {
  memoryRepo: MemoryRepository;
  /** Whether FTS5 is available (D1); used to pick the search path. */
  hasFts5: boolean;
  /** Clock; defaults to nowIso. */
  now?: () => string;
  logger?: Logger;
}

/** Public surface of the memory engine. */
export interface MemoryEngine {
  add(input: MemoryAddInput): number;
  update(id: number, patch: MemoryUpdatePatch): void;
  /** Retrieval = use: touches last_used_at and applies bounded promotion. */
  get(id: number): MemoryRow | undefined;
  /** Pure read; never mutates the row. */
  getReadOnly(id: number): MemoryRow | undefined;
  /** Search; each returned memory is touched + bounded-promoted. */
  search(opts: MemorySearchOptions): MemoryRow[];
  /** Read-only listing of important memories; never mutates. */
  listImportant(limit?: number): MemoryRow[];
  archive(id: number): void;
  remove(id: number): void;
  promote(id: number): void;
  demote(id: number): void;
}

/** Default number of memories returned by listImportant. */
const DEFAULT_IMPORTANT_LIMIT = 20;

const DEFAULT_CONFIDENCE = 1;
const DEFAULT_IMPORTANCE = 0;

export function createMemoryEngine(deps: MemoryEngineDeps): MemoryEngine {
  const { memoryRepo, hasFts5 } = deps;
  const now = deps.now ?? nowIso;
  const logger = deps.logger?.child('memory-engine');

  /**
   * Mark a memory as used: set last_used_at and apply a bounded promotion
   * (never exceeds MAX_IMPORTANCE). Only invoked from non-read-only paths.
   */
  function touchAndPromote(row: MemoryRow): void {
    const ts = now();
    memoryRepo.touchUsed(row.id, ts);
    const next = clampImportance(promote(row.importance_score));
    if (next !== row.importance_score) {
      memoryRepo.setImportance(row.id, next);
    }
  }

  return {
    add(input: MemoryAddInput): number {
      const type = validateMemoryType(input.type);
      const ts = now();
      const importance = clampImportance(input.importanceScore ?? DEFAULT_IMPORTANCE);
      const confidence = input.confidence ?? DEFAULT_CONFIDENCE;
      const tags = input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null;

      const id = memoryRepo.add({
        type,
        title: input.title,
        content: input.content,
        tags,
        source: input.source ?? null,
        confidence,
        importance_score: importance,
        created_at: ts,
        updated_at: ts,
        last_used_at: null,
        expires_at: null,
        archived_at: null,
      });
      logger?.debug('memory added', { id, type, importance });
      return id;
    },

    update(id: number, patch: MemoryUpdatePatch): void {
      // Validate the type when the patch changes it; keep importance clamped.
      const normalized: MemoryUpdatePatch = { ...patch };
      if ('type' in patch && patch.type !== undefined) {
        normalized.type = validateMemoryType(patch.type);
      }
      if ('importance_score' in patch && patch.importance_score !== undefined) {
        normalized.importance_score = clampImportance(patch.importance_score);
      }
      memoryRepo.update(id, normalized);
      logger?.debug('memory updated', { id });
    },

    get(id: number): MemoryRow | undefined {
      const row = memoryRepo.getById(id);
      if (row === undefined || row.archived_at != null) {
        return row;
      }
      touchAndPromote(row);
      // Return the freshly persisted view so callers see the side effects.
      return memoryRepo.getById(id);
    },

    getReadOnly(id: number): MemoryRow | undefined {
      return memoryRepo.getById(id);
    },

    search(opts: MemorySearchOptions): MemoryRow[] {
      // The repo's searchFts already falls back internally, but we branch on the
      // captured hasFts5 flag (D1) to choose the path explicitly.
      const results = hasFts5 ? memoryRepo.searchFts(opts) : memoryRepo.searchLike(opts);
      for (const row of results) {
        touchAndPromote(row);
      }
      logger?.debug('memory search', { count: results.length });
      return results;
    },

    listImportant(limit: number = DEFAULT_IMPORTANT_LIMIT): MemoryRow[] {
      // Read-only: no touch, no promotion. minScore 0 surfaces everything;
      // high-importance rows (>= HIGH_IMPORTANCE_THRESHOLD) naturally lead since
      // the repo orders by importance_score DESC.
      return memoryRepo.listImportant(limit, 0);
    },

    archive(id: number): void {
      memoryRepo.archive(id, now());
      logger?.debug('memory archived', { id });
    },

    remove(id: number): void {
      memoryRepo.deleteHard(id);
      logger?.debug('memory removed', { id });
    },

    promote(id: number): void {
      const row = memoryRepo.getById(id);
      if (row === undefined) {
        return;
      }
      memoryRepo.setImportance(id, clampImportance(promote(row.importance_score)));
    },

    demote(id: number): void {
      const row = memoryRepo.getById(id);
      if (row === undefined) {
        return;
      }
      memoryRepo.setImportance(id, clampImportance(demote(row.importance_score)));
    },
  };
}
