// Search provider abstraction over chunk full-text search.
//
// Two concrete strategies exist in MVP1: FTS5 (when the SQLite build has the
// FTS5 module, per D1) and a LIKE-based fallback. The chosen strategy is
// decided ONCE by `createSearchProvider`, which reads `kdb.hasFts5` and never
// re-probes. A `FutureEmbeddingProvider` stub marks the post-MVP1 abstraction.
//
// All providers are thin wrappers over ChunkRepository; they own NO SQL of
// their own. better-sqlite3 is synchronous, so nothing here is async.

import type { ChunkRepository } from '../storage/repositories/chunk.repository.js';
import type { KundunDb } from '../storage/types.js';
import { FallbackSearchProvider } from './fallback-search-provider.js';
import { SqliteFtsProvider } from './sqlite-fts-provider.js';

/** A single code-search hit, projected from a chunk row. */
export interface SearchResult {
  kind: 'chunk';
  fileId: number;
  chunkId: number;
  relativePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

/** Options accepted by {@link SearchProvider.searchCode}. */
export interface SearchCodeOptions {
  /** Restrict results to a single language (e.g. 'typescript'). */
  language?: string;
  /** Maximum number of results to return. */
  limit: number;
}

/**
 * Strategy for searching indexed code chunks. `mode` reports which concrete
 * backend is in use so callers can surface it (e.g. in `summary`) without
 * caring about the implementation.
 */
export interface SearchProvider {
  searchCode(query: string, opts: SearchCodeOptions): SearchResult[];
  readonly mode: 'fts5' | 'like';
}

/**
 * Pick the search strategy ONCE based on the database's FTS5 capability (D1):
 * `SqliteFtsProvider` when FTS5 is available, otherwise `FallbackSearchProvider`.
 */
export function createSearchProvider(kdb: KundunDb, chunkRepo: ChunkRepository): SearchProvider {
  return kdb.hasFts5 ? new SqliteFtsProvider(chunkRepo) : new FallbackSearchProvider(chunkRepo);
}
