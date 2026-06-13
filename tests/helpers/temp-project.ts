// Test helper: build a throwaway project directory on disk for scanner/indexer
// integration tests, and tear it down afterwards. Files are written relative to
// a unique temp root so parallel tests never collide.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A live temp project on disk with helpers to mutate and clean it up. */
export interface TempProject {
  /** Absolute path to the project root. */
  root: string;
  /** Absolute path to the `.kundun` directory (created eagerly). */
  kundunDir: string;
  /** Write a file at a root-relative path (parent dirs are created). */
  writeFile(relPath: string, content: string): void;
  /** Delete a file at a root-relative path. */
  removeFile(relPath: string): void;
  /** Set the mtime (and atime) of a root-relative file to a given Date. */
  touch(relPath: string, when: Date): void;
  /** Absolute path for a root-relative path. */
  abs(relPath: string): string;
  /** Remove the entire project tree from disk. */
  cleanup(): void;
}

/** Create an empty temp project under the OS temp dir. */
export function makeTempProject(): TempProject {
  const root = mkdtempSync(join(tmpdir(), 'kundun-test-'));
  const kundunDir = join(root, '.kundun');
  mkdirSync(kundunDir, { recursive: true });

  function abs(relPath: string): string {
    return join(root, relPath);
  }

  return {
    root,
    kundunDir,
    abs,
    writeFile(relPath: string, content: string): void {
      const target = abs(relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    },
    removeFile(relPath: string): void {
      rmSync(abs(relPath), { force: true });
    },
    touch(relPath: string, when: Date): void {
      utimesSync(abs(relPath), when, when);
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
