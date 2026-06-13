// ChunkRepository tests: replace inserts, in-file dedup by content_hash, FTS5
// search, direct LIKE fallback search, and orphan cleanup.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChunkRepository } from '../../../src/storage/repositories/chunk.repository.js';
import { FileRepository } from '../../../src/storage/repositories/file.repository.js';
import { createTestDb, insertFile, type TestDb } from '../../helpers/test-db.js';
import { nowIso } from '../../../src/utils/time.js';
import type { NewChunkRow } from '../../../src/storage/types.js';

function makeChunk(overrides: Partial<NewChunkRow> = {}): NewChunkRow {
  const iso = nowIso();
  return {
    file_id: 0, // overwritten by replaceForFile's fileId argument
    chunk_index: 0,
    content: 'placeholder content',
    content_hash: 'chash',
    token_estimate: 1,
    start_line: 1,
    end_line: 1,
    created_at: iso,
    updated_at: iso,
    ...overrides,
  };
}

describe('ChunkRepository', () => {
  let t: TestDb;
  let repo: ChunkRepository;
  let fileId: number;

  beforeEach(() => {
    t = createTestDb();
    repo = new ChunkRepository(t.kdb);
    fileId = insertFile(t.kdb, { relative_path: 'src/a.ts', importance_score: 10 });
  });

  afterEach(() => {
    t.cleanup();
  });

  it('replaceForFile inserts all chunks for a file', () => {
    const result = repo.replaceForFile(fileId, [
      makeChunk({ chunk_index: 0, content: 'alpha', content_hash: 'h0' }),
      makeChunk({ chunk_index: 1, content: 'beta', content_hash: 'h1' }),
    ]);
    expect(result.inserted).toBe(2);
    expect(result.skippedDuplicate).toBe(0);

    const stored = repo.getByFile(fileId);
    expect(stored).toHaveLength(2);
    expect(stored.map((c) => c.content)).toEqual(['alpha', 'beta']);
  });

  it('search with an extremely long query returns empty, never throws (regression: LIKE too complex)', () => {
    repo.replaceForFile(fileId, [makeChunk({ content: 'normal content', content_hash: 'h0' })]);
    const huge = 'x'.repeat(60000); // exceeds SQLITE_MAX_LIKE_PATTERN_LENGTH (50000)
    expect(() => repo.searchFts(huge, 10)).not.toThrow();
    expect(repo.searchFts(huge, 10)).toEqual([]);
    expect(() => repo.searchLike(huge, 10)).not.toThrow();
    expect(repo.searchLike(huge, 10)).toEqual([]);
  });

  it('replaceForFile replaces previous chunks rather than appending', () => {
    repo.replaceForFile(fileId, [makeChunk({ content: 'old', content_hash: 'old' })]);
    repo.replaceForFile(fileId, [makeChunk({ content: 'new', content_hash: 'new' })]);

    const stored = repo.getByFile(fileId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toBe('new');
  });

  it('dedups identical content_hash within the same file', () => {
    const result = repo.replaceForFile(fileId, [
      makeChunk({ chunk_index: 0, content: 'dup', content_hash: 'same' }),
      makeChunk({ chunk_index: 1, content: 'dup', content_hash: 'same' }),
      makeChunk({ chunk_index: 2, content: 'unique', content_hash: 'other' }),
    ]);
    expect(result.inserted).toBe(2);
    expect(result.skippedDuplicate).toBe(1);
    expect(repo.getByFile(fileId)).toHaveLength(2);
  });

  it('searchFts finds a chunk by term (FTS5 path)', () => {
    expect(t.kdb.hasFts5).toBe(true);
    repo.replaceForFile(fileId, [
      makeChunk({ content: 'the quick brown fox', content_hash: 'fts1' }),
      makeChunk({ chunk_index: 1, content: 'lazy dog sleeps', content_hash: 'fts2' }),
    ]);

    const hits = repo.searchFts('brown', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe('the quick brown fox');
    expect(hits[0]?.relative_path).toBe('src/a.ts');
  });

  it('replaceForFile leaves no stale FTS rows after content changes (contentless delete)', () => {
    // Contentless FTS5 deletes via the special 'delete' command, which needs
    // each chunk's ORIGINAL content. This guards against FTS drift: after a
    // second replace, the OLD content must NOT be findable and the NEW content
    // must be.
    expect(t.kdb.hasFts5).toBe(true);

    repo.replaceForFile(fileId, [makeChunk({ content: 'oldtoken alpha', content_hash: 'v1' })]);
    expect(repo.searchFts('oldtoken', 10)).toHaveLength(1);

    repo.replaceForFile(fileId, [makeChunk({ content: 'newtoken beta', content_hash: 'v2' })]);

    // The replaced (old) content must leave no stale FTS index entry.
    expect(repo.searchFts('oldtoken', 10)).toHaveLength(0);
    // The new content must be findable.
    const hits = repo.searchFts('newtoken', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe('newtoken beta');
  });

  it('searchFts excludes chunks of soft-deleted files', () => {
    repo.replaceForFile(fileId, [makeChunk({ content: 'findme token', content_hash: 'x' })]);
    new FileRepository(t.kdb).markDeleted([fileId], '2026-06-13T12:00:00.000Z');
    expect(repo.searchFts('findme', 10)).toHaveLength(0);
  });

  it('searchFts returns empty for a query with no usable terms', () => {
    repo.replaceForFile(fileId, [makeChunk({ content: 'anything', content_hash: 'x' })]);
    expect(repo.searchFts('   ', 10)).toHaveLength(0);
  });

  it('searchLike finds a chunk by literal substring (direct call)', () => {
    repo.replaceForFile(fileId, [
      makeChunk({ content: 'function handlePayment()', content_hash: 'l1' }),
      makeChunk({ chunk_index: 1, content: 'class Repository', content_hash: 'l2' }),
    ]);

    const hits = repo.searchLike('handlePayment', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe('function handlePayment()');
    expect(hits[0]?.relative_path).toBe('src/a.ts');
  });

  it('searchLike matches metacharacters literally', () => {
    repo.replaceForFile(fileId, [
      makeChunk({ content: 'a 100% match', content_hash: 'p1' }),
      makeChunk({ chunk_index: 1, content: 'a 100X mismatch', content_hash: 'p2' }),
    ]);
    // '%' must be treated as a literal, not a LIKE wildcard.
    const hits = repo.searchLike('100%', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe('a 100% match');
  });

  it('deleteOrphans removes chunks whose file is soft-deleted', () => {
    repo.replaceForFile(fileId, [makeChunk({ content: 'orphan-me', content_hash: 'o1' })]);
    expect(repo.countAll()).toBe(1);

    new FileRepository(t.kdb).markDeleted([fileId], '2026-06-13T12:00:00.000Z');
    expect(repo.listOrphanIds()).toHaveLength(1);

    const removed = repo.deleteOrphans();
    expect(removed).toBe(1);
    expect(repo.countAll()).toBe(0);
    expect(repo.listOrphanIds()).toHaveLength(0);
    // FTS mirror is cleared too, so a search no longer finds the orphaned text.
    expect(repo.searchFts('orphan-me', 10)).toHaveLength(0);
  });
});
