// Unit tests for the path-safety boundary helpers. These guard every path that
// crosses into the working tree, so the traversal / boundary semantics are
// verified directly here.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveWithinRoot,
  isInsideRoot,
  toRelativePath,
  isPathTraversal,
} from '../../../src/utils/path-safety.js';
import { KundunError } from '../../../src/utils/errors.js';

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kundun-path-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('resolveWithinRoot', () => {
  it('resolves a normal relative path inside the root', () => {
    const root = makeRoot();
    const resolved = resolveWithinRoot(root, 'src/file.ts');
    expect(resolved.endsWith('src/file.ts')).toBe(true);
    // Always forward-slash normalized.
    expect(resolved.includes('\\')).toBe(false);
  });

  it("blocks '../escape' traversal out of the root", () => {
    const root = makeRoot();
    expect(() => resolveWithinRoot(root, '../escape')).toThrow(KundunError);
    try {
      resolveWithinRoot(root, '../escape');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KundunError);
      expect((err as KundunError).code).toBe('path_traversal_blocked');
    }
  });

  it('blocks an absolute path outside the root', () => {
    const root = makeRoot();
    // A sibling temp dir is guaranteed to be outside `root`.
    const outside = makeRoot();
    expect(() => resolveWithinRoot(root, path.join(outside, 'x.ts'))).toThrow(KundunError);
  });
});

describe('isInsideRoot', () => {
  it('returns true for a child path and for the root itself', () => {
    const root = path.resolve('/tmp/root');
    expect(isInsideRoot(root, path.join(root, 'a', 'b.ts'))).toBe(true);
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it('respects segment boundaries (rootEvil is NOT inside root)', () => {
    const root = path.resolve('/tmp/root');
    const rootEvil = path.resolve('/tmp/rootEvil');
    expect(isInsideRoot(root, rootEvil)).toBe(false);
    expect(isInsideRoot(root, path.join(rootEvil, 'file.ts'))).toBe(false);
  });

  it('returns false when abs has fewer segments than root', () => {
    const root = path.resolve('/tmp/root/deep');
    expect(isInsideRoot(root, path.resolve('/tmp/root'))).toBe(false);
  });
});

describe('toRelativePath', () => {
  it('returns a forward-slash relative path', () => {
    const root = path.resolve('/tmp/proj');
    const abs = path.join(root, 'src', 'nested', 'a.ts');
    expect(toRelativePath(root, abs)).toBe('src/nested/a.ts');
  });
});

describe('isPathTraversal', () => {
  it("flags paths containing a '..' segment", () => {
    expect(isPathTraversal('../secret')).toBe(true);
    expect(isPathTraversal('src/../../etc/passwd')).toBe(true);
  });

  it('flags paths containing a NUL byte', () => {
    expect(isPathTraversal('safe\0name')).toBe(true);
  });

  it('does not flag a clean relative path', () => {
    expect(isPathTraversal('src/app/file.ts')).toBe(false);
    // A '..' as a substring of a name is not a traversal segment.
    expect(isPathTraversal('src/foo..bar/file.ts')).toBe(false);
  });
});
