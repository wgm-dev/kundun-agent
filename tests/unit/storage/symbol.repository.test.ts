// SymbolRepository tests: replaceForFile, exact-name lookup, and prefix lookup.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymbolRepository } from '../../../src/storage/repositories/symbol.repository.js';
import { FileRepository } from '../../../src/storage/repositories/file.repository.js';
import { createTestDb, insertFile, type TestDb } from '../../helpers/test-db.js';
import type { NewSymbolRow } from '../../../src/storage/types.js';

function makeSymbol(overrides: Partial<NewSymbolRow> = {}): NewSymbolRow {
  return {
    file_id: 0, // overwritten by replaceForFile's fileId argument
    name: 'doThing',
    kind: 'function',
    language: 'typescript',
    start_line: 1,
    end_line: 5,
    signature: 'function doThing(): void',
    parent_symbol: null,
    // created_at is stamped inside replaceForFile from utils/time; the value
    // here is ignored by the insert, but the shape requires it.
    created_at: '1970-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SymbolRepository', () => {
  let t: TestDb;
  let repo: SymbolRepository;
  let fileId: number;

  beforeEach(() => {
    t = createTestDb();
    repo = new SymbolRepository(t.kdb);
    fileId = insertFile(t.kdb, { relative_path: 'src/a.ts' });
  });

  afterEach(() => {
    t.cleanup();
  });

  it('replaceForFile inserts all symbols and returns the count', () => {
    const inserted = repo.replaceForFile(fileId, [
      makeSymbol({ name: 'alpha' }),
      makeSymbol({ name: 'beta', kind: 'class' }),
    ]);
    expect(inserted).toBe(2);
    expect(repo.countAll()).toBe(2);
  });

  it('replaceForFile replaces previous symbols rather than appending', () => {
    repo.replaceForFile(fileId, [makeSymbol({ name: 'old' })]);
    repo.replaceForFile(fileId, [makeSymbol({ name: 'new' })]);

    expect(repo.countAll()).toBe(1);
    expect(repo.findByName('old')).toHaveLength(0);
    expect(repo.findByName('new')).toHaveLength(1);
  });

  it('findByName matches exactly and enriches with relative_path', () => {
    repo.replaceForFile(fileId, [
      makeSymbol({ name: 'handlePayment' }),
      makeSymbol({ name: 'handlePaymentRetry' }),
    ]);

    const hits = repo.findByName('handlePayment');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe('handlePayment');
    expect(hits[0]?.relative_path).toBe('src/a.ts');
  });

  it('findByName honors language and kind filters', () => {
    repo.replaceForFile(fileId, [
      makeSymbol({ name: 'fn', kind: 'function', language: 'typescript' }),
      makeSymbol({ name: 'fn', kind: 'method', language: 'typescript' }),
    ]);

    expect(repo.findByName('fn')).toHaveLength(2);
    expect(repo.findByName('fn', { kind: 'method' })).toHaveLength(1);
    expect(repo.findByName('fn', { language: 'go' })).toHaveLength(0);
  });

  it('findByPrefix matches all symbols starting with the prefix', () => {
    repo.replaceForFile(fileId, [
      makeSymbol({ name: 'getUser' }),
      makeSymbol({ name: 'getUserById' }),
      makeSymbol({ name: 'setUser' }),
    ]);

    const hits = repo.findByPrefix('getUser');
    expect(hits.map((h) => h.name).sort()).toEqual(['getUser', 'getUserById']);
  });

  it('findByPrefix treats LIKE metacharacters literally', () => {
    repo.replaceForFile(fileId, [makeSymbol({ name: 'a_b' }), makeSymbol({ name: 'axb' })]);
    // '_' is a LIKE wildcard; it must be escaped so only the literal matches.
    const hits = repo.findByPrefix('a_');
    expect(hits.map((h) => h.name)).toEqual(['a_b']);
  });

  it('lookups exclude symbols of soft-deleted files', () => {
    repo.replaceForFile(fileId, [makeSymbol({ name: 'ghost' })]);
    expect(repo.findByName('ghost')).toHaveLength(1);

    new FileRepository(t.kdb).markDeleted([fileId], '2026-06-13T12:00:00.000Z');
    expect(repo.findByName('ghost')).toHaveLength(0);
    expect(repo.findByPrefix('gho')).toHaveLength(0);
  });
});
