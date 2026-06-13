import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTaskEngine } from '../../../src/core/task-engine.js';
import type { TaskEngine } from '../../../src/core/task-engine.js';
import { TaskRepository } from '../../../src/storage/repositories/task.repository.js';
import type { TaskPriority, TaskStatus, KundunDb } from '../../../src/storage/types.js';
import { makeTestDb } from '../../helpers/db.js';
import { makeClock } from '../../helpers/clock.js';

/** Seed a task directly with an explicit (priority, status) so we can build the
 *  full matrix; the engine's create() always starts at 'pending'. */
function seed(
  repo: TaskRepository,
  priority: TaskPriority,
  status: TaskStatus,
  iso: string,
): number {
  return repo.create({
    title: `${priority}-${status}`,
    description: null,
    status,
    priority,
    related_files: null,
    related_memories: null,
    created_at: iso,
    updated_at: iso,
    completed_at: status === 'completed' ? iso : null,
  });
}

describe('TaskEngine.next — priority matrix', () => {
  let kdb: KundunDb;
  let repo: TaskRepository;
  let engine: TaskEngine;
  const clock = makeClock(new Date('2026-06-13T12:00:00.000Z'));

  const priorities: TaskPriority[] = ['low', 'medium', 'high', 'critical'];
  const statuses: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'completed', 'archived'];

  beforeEach(() => {
    clock.set(new Date('2026-06-13T12:00:00.000Z'));
    kdb = makeTestDb();
    repo = new TaskRepository(kdb);
    engine = createTaskEngine({ taskRepo: repo, now: () => clock.now() });
  });

  afterEach(() => {
    kdb.close();
  });

  function seedFullMatrix(): void {
    for (const p of priorities) {
      for (const s of statuses) {
        seed(repo, p, s, clock.now());
      }
    }
  }

  it('returns critical+pending first across the full matrix', () => {
    seedFullMatrix();
    const next = engine.next();
    expect(next).toBeDefined();
    expect(next?.priority).toBe('critical');
    expect(next?.status).toBe('pending');
  });

  it('orders critical > high > medium > low, and pending before in_progress', () => {
    // Only ranked combinations, seeded in scrambled order to prove the ranking.
    seed(repo, 'low', 'pending', clock.now());
    seed(repo, 'high', 'in_progress', clock.now());
    seed(repo, 'medium', 'pending', clock.now());
    seed(repo, 'critical', 'in_progress', clock.now());
    seed(repo, 'high', 'pending', clock.now());
    seed(repo, 'critical', 'pending', clock.now());

    const expected: Array<[TaskPriority, TaskStatus]> = [
      ['critical', 'pending'],
      ['critical', 'in_progress'],
      ['high', 'pending'],
      ['high', 'in_progress'],
      ['medium', 'pending'],
      ['low', 'pending'],
    ];

    // Drain by completing the current next() each iteration; completed tasks are
    // excluded so the next-most-actionable surfaces.
    const observed: Array<[TaskPriority, TaskStatus]> = [];
    for (let i = 0; i < expected.length; i += 1) {
      const next = engine.next();
      expect(next).toBeDefined();
      if (next === undefined) break;
      observed.push([next.priority, next.status]);
      engine.complete(next.id);
    }

    expect(observed).toEqual(expected);
    // Once all ranked tasks are drained, nothing actionable remains.
    expect(engine.next()).toBeUndefined();
  });

  it('excludes blocked, completed, archived, and unranked in_progress combos', () => {
    // Seed ONLY combinations that must never be returned by next().
    seed(repo, 'critical', 'blocked', clock.now());
    seed(repo, 'critical', 'completed', clock.now());
    seed(repo, 'critical', 'archived', clock.now());
    seed(repo, 'high', 'blocked', clock.now());
    seed(repo, 'medium', 'in_progress', clock.now()); // unranked
    seed(repo, 'low', 'in_progress', clock.now()); // unranked
    seed(repo, 'low', 'blocked', clock.now());

    expect(engine.next()).toBeUndefined();
  });

  it('breaks ties by oldest updated_at within the same rank', () => {
    clock.set(new Date('2026-06-13T08:00:00.000Z'));
    const older = seed(repo, 'critical', 'pending', clock.now());
    clock.set(new Date('2026-06-13T10:00:00.000Z'));
    seed(repo, 'critical', 'pending', clock.now());

    expect(engine.next()?.id).toBe(older);
  });

  it('complete() sets status=completed and stamps completed_at from the clock', () => {
    const id = seed(repo, 'high', 'pending', clock.now());
    clock.set(new Date('2026-06-14T09:30:00.000Z'));

    engine.complete(id);

    const row = engine.get(id);
    expect(row?.status).toBe('completed');
    expect(row?.completed_at).toBe('2026-06-14T09:30:00.000Z');
  });

  it('create() rejects an empty/whitespace title (regression)', () => {
    expect(() => engine.create({ title: '' })).toThrowError(/must not be empty/);
    expect(() => engine.create({ title: '   ' })).toThrowError(/must not be empty/);
  });

  it('update() throws not_found for a non-existent id instead of silently succeeding (regression)', () => {
    expect(() => engine.update(999999, { status: 'completed' })).toThrowError(/not found/i);
    // A real task still updates fine.
    const id = seed(repo, 'low', 'pending', clock.now());
    expect(() => engine.update(id, { priority: 'high' })).not.toThrow();
    expect(engine.get(id)?.priority).toBe('high');
  });
});
