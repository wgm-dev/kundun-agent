// Security boundary for all filesystem path handling in Kundun-Agent.
// Every path that crosses into the working tree MUST be validated here before
// it is read, written, or stored. The goal is to make path traversal and
// symlink-escape attacks impossible by construction.

import path from 'node:path';
import fs from 'node:fs';

import { KundunError } from './errors.js';

/**
 * Canonicalize a path with fs.realpathSync where it exists on disk.
 * Walks up from the given path until an existing ancestor is found, resolves
 * that real path, then re-appends the non-existent tail. This lets us safely
 * canonicalize paths whose leaf does not exist yet (e.g. a file about to be
 * created) while still resolving symlinks in the existing prefix.
 */
function canonicalize(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];

  // Walk up to the first existing ancestor.
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      // Re-attach the non-existent segments we peeled off (deepest last).
      return tail.length > 0 ? path.resolve(real, ...tail.reverse()) : real;
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'ENOENT') {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing path.
        return tail.length > 0 ? path.resolve(current, ...tail.reverse()) : current;
      }
      const base = path.basename(current);
      tail.push(base);
      current = parent;
    }
  }
}

/** Narrow an unknown error to a Node errno exception. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/** Normalize a path's separators to forward slashes for stable storage/compare. */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True on win32 — used to make boundary comparisons case-insensitive. */
function isWin32(): boolean {
  return process.platform === 'win32';
}

/**
 * Split an absolute path into comparable segments. On win32 the comparison is
 * case-insensitive, so segments are lowercased there.
 */
function toComparableSegments(absResolved: string): string[] {
  const normalized = isWin32() ? absResolved.toLowerCase() : absResolved;
  // path.resolve already collapsed '.'/'..'; split on either separator and
  // drop empty segments (leading separator, drive trailing slash, etc.).
  return toForwardSlashes(normalized)
    .split('/')
    .filter((s) => s.length > 0);
}

/**
 * Segment-boundary containment check. Both paths are path.resolve'd first.
 * Unlike a plain startsWith, 'C:/rootEvil' is NOT considered inside 'C:/root'.
 * A path is considered inside itself.
 */
export function isInsideRoot(root: string, abs: string): boolean {
  const rootResolved = path.resolve(root);
  const absResolved = path.resolve(abs);

  const rootSegs = toComparableSegments(rootResolved);
  const absSegs = toComparableSegments(absResolved);

  // abs must have at least as many segments as root, and every root segment
  // must match the corresponding abs segment exactly.
  if (absSegs.length < rootSegs.length) {
    return false;
  }
  for (let i = 0; i < rootSegs.length; i += 1) {
    if (absSegs[i] !== rootSegs[i]) {
      return false;
    }
  }
  return true;
}

/** Throw KundunError('path_traversal_blocked') if abs is not inside root. */
export function assertInsideRoot(root: string, abs: string): void {
  if (!isInsideRoot(root, abs)) {
    throw new KundunError(
      'path_traversal_blocked',
      `Path escapes project root: ${toForwardSlashes(path.resolve(abs))} not inside ${toForwardSlashes(path.resolve(root))}`,
    );
  }
}

/**
 * Resolve candidate against root and return an absolute, forward-slash path.
 * The existing prefix of both root and the result is canonicalized via
 * realpath so that symlinked roots and traversal through symlinks cannot be
 * used to escape. Throws KundunError('path_traversal_blocked') if the resolved
 * path is not inside root.
 */
export function resolveWithinRoot(root: string, candidate: string): string {
  const realRoot = canonicalize(root);
  const resolved = path.isAbsolute(candidate)
    ? canonicalize(candidate)
    : canonicalize(path.resolve(realRoot, candidate));

  assertInsideRoot(realRoot, resolved);
  return toForwardSlashes(resolved);
}

/** path.relative(root, abs), normalized to forward slashes. */
export function toRelativePath(root: string, abs: string): string {
  return toForwardSlashes(path.relative(path.resolve(root), path.resolve(abs)));
}

/**
 * True if the given path, once normalized, contains a '..' segment or a NUL
 * byte. Useful as a cheap pre-check on raw, untrusted input before resolving.
 */
export function isPathTraversal(p: string): boolean {
  if (p.includes('\0')) {
    return true;
  }
  const normalized = toForwardSlashes(path.normalize(p));
  return normalized.split('/').some((segment) => segment === '..');
}

/**
 * Walk each path segment from root down to abs and lstat the partial path; if
 * any segment is a symbolic link, throw KundunError('symlink_escape'). Segments
 * at or above root are skipped (the root itself may legitimately live behind a
 * symlink). A not-yet-existing leaf (ENOENT) is ignored so brand-new files are
 * allowed.
 */
export function assertNoSymlink(root: string, abs: string): void {
  const rootResolved = path.resolve(root);
  const absResolved = path.resolve(abs);

  // Only inspect segments strictly below the root boundary.
  if (!isInsideRoot(rootResolved, absResolved)) {
    throw new KundunError(
      'path_traversal_blocked',
      `Path escapes project root: ${toForwardSlashes(absResolved)} not inside ${toForwardSlashes(rootResolved)}`,
    );
  }

  const relative = path.relative(rootResolved, absResolved);
  if (relative.length === 0) {
    // abs IS the root; nothing below to inspect.
    return;
  }

  const segments = relative.split(path.sep).filter((s) => s.length > 0);
  let partial = rootResolved;
  for (const segment of segments) {
    partial = path.join(partial, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(partial);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        // This segment (and therefore everything deeper) does not exist yet;
        // a new file is allowed, so stop walking.
        return;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new KundunError(
        'symlink_escape',
        `Symbolic link not allowed in path: ${toForwardSlashes(partial)}`,
      );
    }
  }
}
