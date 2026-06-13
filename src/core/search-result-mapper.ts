// Shared projection from a ChunkHit (a file_chunks row plus its file's
// relative_path) to the provider-facing SearchResult. Both the FTS5 and LIKE
// providers reuse this so snippet shaping and field mapping stay identical.

import type { ChunkHit } from '../storage/repositories/chunk.repository.js';
import type { SearchResult } from './search-provider.js';

/** Maximum snippet length, in characters, taken from the chunk content. */
export const SNIPPET_MAX_CHARS = 200;

/**
 * Collapse chunk content to a single-line snippet of at most
 * {@link SNIPPET_MAX_CHARS} characters. Sensitive files are never chunked, so
 * the content is safe to surface verbatim.
 */
export function toSnippet(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  return singleLine.length > SNIPPET_MAX_CHARS
    ? singleLine.slice(0, SNIPPET_MAX_CHARS)
    : singleLine;
}

/**
 * Project a ChunkHit into a SearchResult. The repository returns hits already
 * ordered best-first; `rank` is the zero-based position in that ordering, which
 * we turn into a descending [0, 1] relevance score so callers have a uniform
 * notion of "higher is better" regardless of backend.
 */
export function hitToResult(hit: ChunkHit, rank: number): SearchResult {
  return {
    kind: 'chunk',
    fileId: hit.file_id,
    chunkId: hit.id,
    relativePath: hit.relative_path,
    startLine: hit.start_line,
    endLine: hit.end_line,
    snippet: toSnippet(hit.content),
    score: 1 / (1 + rank),
  };
}
