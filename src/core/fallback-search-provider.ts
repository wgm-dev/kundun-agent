// LIKE-based fallback search provider (mode='like').
//
// Used when the SQLite build lacks FTS5 (D1). Delegates to
// ChunkRepository.searchLike (substring match ranked by file importance) and
// projects each ChunkHit into a SearchResult via the shared mapper. Sensitive
// files are never chunked, so snippets carry no sensitive-content concern.
//
// Language filter: a ChunkHit carries only file_chunks columns plus
// relative_path, not the owning file's language, so a post-query language
// filter cannot be applied from the hit alone. The option is accepted for
// interface symmetry; language narrowing is a future repository-level concern.

import type { ChunkRepository } from '../storage/repositories/chunk.repository.js';
import type { SearchCodeOptions, SearchProvider, SearchResult } from './search-provider.js';
import { hitToResult } from './search-result-mapper.js';

export class FallbackSearchProvider implements SearchProvider {
  readonly mode = 'like' as const;

  constructor(private readonly chunkRepo: ChunkRepository) {}

  searchCode(query: string, opts: SearchCodeOptions): SearchResult[] {
    return this.chunkRepo.searchLike(query, opts.limit).map((hit, rank) => hitToResult(hit, rank));
  }
}
