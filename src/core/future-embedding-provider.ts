// Placeholder for a future semantic (embedding-based) search provider.
//
// This is NOT wired into createSearchProvider in MVP1; it exists only to mark
// the intended extension point. A real implementation in a later milestone
// would compute query embeddings and rank chunk vectors by cosine similarity.
// Until then, searchCode throws so accidental use fails loudly rather than
// silently returning nothing.

import { KundunError } from '../utils/errors.js';
import type { SearchCodeOptions, SearchProvider, SearchResult } from './search-provider.js';

export class FutureEmbeddingProvider implements SearchProvider {
  // Reuses the 'fts5' | 'like' union; embedding mode is not representable in
  // MVP1, so this is a deliberate placeholder value never exercised at runtime.
  readonly mode = 'fts5' as const;

  searchCode(_query: string, _opts: SearchCodeOptions): SearchResult[] {
    throw new KundunError('invalid_argument', 'embedding search not available in MVP');
  }
}
