import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryEngine } from '../../../src/core/memory-engine.js';
import type { MemoryEngine } from '../../../src/core/memory-engine.js';
import { HIGH_IMPORTANCE_THRESHOLD, MAX_IMPORTANCE } from '../../../src/core/importance.js';
import { MemoryRepository } from '../../../src/storage/repositories/memory.repository.js';
import type { KundunDb } from '../../../src/storage/types.js';
import { makeTestDb } from '../../helpers/db.js';
import { makeClock } from '../../helpers/clock.js';

describe('MemoryEngine', () => {
  let kdb: KundunDb;
  let repo: MemoryRepository;
  let engine: MemoryEngine;
  const clock = makeClock(new Date('2026-06-13T12:00:00.000Z'));

  beforeEach(() => {
    clock.set(new Date('2026-06-13T12:00:00.000Z'));
    kdb = makeTestDb();
    repo = new MemoryRepository(kdb);
    engine = createMemoryEngine({
      memoryRepo: repo,
      hasFts5: kdb.hasFts5,
      now: () => clock.now(),
    });
  });

  afterEach(() => {
    kdb.close();
  });

  it('add validates the type and rejects an unknown one', () => {
    expect(() => engine.add({ type: 'not_a_type', title: 't', content: 'c' })).toThrowError(
      /Invalid memory type/,
    );
  });

  it('add accepts a valid type and stores it', () => {
    const id = engine.add({ type: 'decision', title: 'use sqlite', content: 'D2' });
    const row = engine.getReadOnly(id);
    expect(row?.type).toBe('decision');
    expect(row?.title).toBe('use sqlite');
  });

  it('search touches last_used_at and promotes importance (bounded)', () => {
    const id = engine.add({
      type: 'convention',
      title: 'naming',
      content: 'use camelCase everywhere',
      importanceScore: 10,
    });

    const before = engine.getReadOnly(id);
    expect(before?.last_used_at).toBeNull();
    expect(before?.importance_score).toBe(10);

    clock.advanceMs(1000);
    const results = engine.search({ query: 'camelCase' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === id)).toBe(true);

    const after = engine.getReadOnly(id);
    expect(after?.last_used_at).toBe(clock.now()); // touched with the injected clock
    expect(after?.importance_score).toBe(20); // promoted by PROMOTE_STEP (10)
  });

  it('search promotion never exceeds MAX_IMPORTANCE', () => {
    const id = engine.add({
      type: 'risk',
      title: 'leak',
      content: 'token leak risk uniquetoken',
      importanceScore: 100,
    });
    engine.search({ query: 'uniquetoken' });
    const row = engine.getReadOnly(id);
    expect(row?.importance_score).toBe(MAX_IMPORTANCE);
    expect(row?.importance_score).toBeLessThanOrEqual(100);
  });

  it('listImportant is read-only: no touch, no promotion', () => {
    const id = engine.add({
      type: 'architecture',
      title: 'layers',
      content: 'engine over repo',
      importanceScore: 50,
    });

    const listed = engine.listImportant();
    expect(listed.some((r) => r.id === id)).toBe(true);

    const row = engine.getReadOnly(id);
    expect(row?.importance_score).toBe(50); // unchanged
    expect(row?.last_used_at).toBeNull(); // never touched
  });

  it('archived memories are excluded from search and listImportant', () => {
    const id = engine.add({
      type: 'bug',
      title: 'crash',
      content: 'archivedneedle crash on boot',
      importanceScore: 90,
    });

    // Present before archiving.
    expect(engine.search({ query: 'archivedneedle' }).some((r) => r.id === id)).toBe(true);
    expect(engine.listImportant().some((r) => r.id === id)).toBe(true);

    engine.archive(id);

    expect(engine.search({ query: 'archivedneedle' }).some((r) => r.id === id)).toBe(false);
    expect(engine.listImportant().some((r) => r.id === id)).toBe(false);

    const row = engine.getReadOnly(id);
    expect(row?.archived_at).not.toBeNull();
  });

  it('listExpiredLowImportance never returns a high-importance (>=80) memory', () => {
    const nowStr = clock.now();
    const pastExpiry = new Date('2026-06-01T00:00:00.000Z').toISOString();

    // Low-importance + expired => a cleanup candidate.
    const lowId = engine.add({
      type: 'task',
      title: 'low',
      content: 'low importance expired',
      importanceScore: 10,
    });
    repo.update(lowId, { expires_at: pastExpiry });

    // High-importance + expired => must be preserved by construction.
    const highId = engine.add({
      type: 'task',
      title: 'high',
      content: 'high importance expired',
      importanceScore: HIGH_IMPORTANCE_THRESHOLD,
    });
    repo.update(highId, { expires_at: pastExpiry });

    const expired = repo.listExpiredLowImportance(nowStr, HIGH_IMPORTANCE_THRESHOLD);
    const ids = expired.map((m) => m.id);
    expect(ids).toContain(lowId);
    expect(ids).not.toContain(highId);
  });
});
