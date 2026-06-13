// FileRepository tests: upsert change-detection, soft delete, relative-path
// listing, and hard delete cascading to dependent chunks.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileRepository } from '../../../src/storage/repositories/file.repository.js';
import { ChunkRepository } from '../../../src/storage/repositories/chunk.repository.js';
import { createTestDb, makeFileRow, type TestDb } from '../../helpers/test-db.js';
import { nowIso } from '../../../src/utils/time.js';
import type { NewChunkRow } from '../../../src/storage/types.js';

function makeChunk(overrides: Partial<NewChunkRow> = {}): NewChunkRow {
  const iso = nowIso();
  return {
    file_id: 0, // set by replaceForFile
    chunk_index: 0,
    content: 'hello world',
    content_hash: 'chash-1',
    token_estimate: 2,
    start_line: 1,
    end_line: 1,
    created_at: iso,
    updated_at: iso,
    ...overrides,
  };
}

describe('FileRepository', () => {
  let t: TestDb;
  let repo: FileRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new FileRepository(t.kdb);
  });

  afterEach(() => {
    t.cleanup();
  });

  it('upsert of a brand-new file reports changed=true', () => {
    const { id, changed } = repo.upsertByRelativePath(
      makeFileRow({ relative_path: 'src/a.ts', hash: 'h1' }),
    );
    expect(id).toBeGreaterThan(0);
    expect(changed).toBe(true);
  });

  it('upsert with the same hash reports changed=false', () => {
    repo.upsertByRelativePath(makeFileRow({ relative_path: 'src/a.ts', hash: 'h1' }));
    const second = repo.upsertByRelativePath(
      makeFileRow({ relative_path: 'src/a.ts', hash: 'h1' }),
    );
    expect(second.changed).toBe(false);
  });

  it('upsert with a changed hash reports changed=true and keeps the same id', () => {
    const first = repo.upsertByRelativePath(makeFileRow({ relative_path: 'src/a.ts', hash: 'h1' }));
    const second = repo.upsertByRelativePath(
      makeFileRow({ relative_path: 'src/a.ts', hash: 'h2' }),
    );
    expect(second.changed).toBe(true);
    expect(second.id).toBe(first.id);

    const row = repo.getById(first.id);
    expect(row?.hash).toBe('h2');
  });

  it('re-seeing a soft-deleted file resurrects it and reports changed=true', () => {
    const first = repo.upsertByRelativePath(makeFileRow({ relative_path: 'src/a.ts', hash: 'h1' }));
    repo.markDeleted([first.id]);
    expect(repo.getById(first.id)?.is_deleted).toBe(1);

    // Same hash, but the row was soft-deleted -> still a change (resurrection).
    const second = repo.upsertByRelativePath(
      makeFileRow({ relative_path: 'src/a.ts', hash: 'h1' }),
    );
    expect(second.changed).toBe(true);
    expect(repo.getById(first.id)?.is_deleted).toBe(0);
  });

  it('markDeleted soft-deletes and removes the file from listActive', () => {
    const { id } = repo.upsertByRelativePath(makeFileRow({ relative_path: 'src/a.ts' }));
    const affected = repo.markDeleted([id]);
    expect(affected).toBe(1);
    expect(repo.getById(id)?.is_deleted).toBe(1);
    expect(repo.listActive().map((f) => f.id)).not.toContain(id);
    expect(repo.countActive()).toBe(0);
  });

  it('markDeleted with an empty id list is a no-op', () => {
    expect(repo.markDeleted([])).toBe(0);
  });

  it('listAllRelativePaths returns every file including soft-deleted ones', () => {
    const a = repo.upsertByRelativePath(makeFileRow({ relative_path: 'src/a.ts', hash: 'h1' }));
    repo.upsertByRelativePath(makeFileRow({ relative_path: 'src/b.ts', hash: 'h2' }));
    repo.markDeleted([a.id]);

    const map = repo.listAllRelativePaths();
    expect(map.size).toBe(2);
    expect(map.get('src/a.ts')).toEqual({ id: a.id, hash: 'h1', is_deleted: 1 });
    expect(map.get('src/b.ts')?.is_deleted).toBe(0);
  });

  it('deleteHard removes the file and cascades to its chunks', () => {
    const { id } = repo.upsertByRelativePath(makeFileRow({ relative_path: 'src/a.ts' }));

    const chunkRepo = new ChunkRepository(t.kdb);
    const result = chunkRepo.replaceForFile(id, [makeChunk({ content_hash: 'c1' })]);
    expect(result.inserted).toBe(1);
    expect(chunkRepo.getByFile(id)).toHaveLength(1);

    const deleted = repo.deleteHard([id]);
    expect(deleted).toBe(1);
    expect(repo.getById(id)).toBeUndefined();
    // ON DELETE CASCADE removed the dependent chunk.
    expect(chunkRepo.getByFile(id)).toHaveLength(0);
  });

  it('deleteHard with an empty id list is a no-op', () => {
    expect(repo.deleteHard([])).toBe(0);
  });
});
