// Project scanner. Walks the working tree from the project root, classifies each
// file against the ignore rules, and reconciles the `files` table with what is
// currently on disk. It records a scan_runs row for the operation but does NOT
// read or chunk file content beyond what is needed to hash a file — chunking and
// symbol extraction are the indexer's job. The scanner returns relative-path
// LISTS (new / changed / removed) so the caller can drive the indexer next.
//
// better-sqlite3 is synchronous and all filesystem work here is synchronous too;
// there is no async/await in this module.

import fs from 'node:fs';
import path from 'node:path';

import type { KundunConfig } from '../config/config-schema.js';
import type { Logger } from '../utils/logger.js';
import type { KundunDb, NewFileRow } from '../storage/types.js';
import type { FileRepository } from '../storage/repositories/file.repository.js';
import type { RunRepository } from '../storage/repositories/run.repository.js';

import { createIgnoreMatcher } from '../utils/ignore-rules.js';
import type { IgnoreMatcher } from '../utils/ignore-rules.js';
import { assertInsideRoot, assertNoSymlink, toRelativePath } from '../utils/path-safety.js';
import { isBinaryBuffer, isLikelyBinaryByExtension } from '../utils/binary-detection.js';
import { hashBuffer } from '../utils/hashing.js';
import { detectLanguage } from './language-detector.js';
import { isKundunError } from '../utils/errors.js';
import { nowIso } from '../utils/time.js';

/** Directories that are ALWAYS pruned regardless of config (D6 / safety). */
const ALWAYS_PRUNED_DIRS: ReadonlySet<string> = new Set(['.kundun', '.git']);

/** Outcome of a single scan pass. File entries are forward-slash relative paths. */
export interface ScanResult {
  scanId: number;
  newFiles: string[];
  changedFiles: string[];
  removedFiles: string[];
  skippedFiles: { path: string; reason: string }[];
  errors: { path: string; error: string }[];
  filesScanned: number;
  filesIndexed: number;
}

/** Collaborators the scanner needs. The caller owns lifecycle of these. */
export interface ProjectScannerDeps {
  kdb: KundunDb;
  config: KundunConfig;
  projectRoot: string;
  fileRepo: FileRepository;
  runRepo: RunRepository;
  logger: Logger;
}

/** Public surface of the scanner. */
export interface ProjectScanner {
  scan(opts?: { force?: boolean }): ScanResult;
}

/**
 * Read the project root .gitignore, or null when it is missing/unreadable.
 * Only the root .gitignore is consulted (nested ones are out of scope for MVP1).
 */
function readRootGitignore(projectRoot: string): string | null {
  try {
    return fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Lowercase extension WITHOUT the leading dot for the `files.extension` column,
 * or null when the basename has no usable extension. Mirrors the language
 * detector's notion of an extension but drops the dot for storage.
 */
function extensionForStorage(relPath: string): string | null {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return null;
  }
  return base.slice(dot + 1).toLowerCase();
}

/** Build the NewFileRow insert shape, defaulting the scanner-irrelevant columns. */
function buildFileRow(args: {
  absPath: string;
  relPath: string;
  extension: string | null;
  language: string | null;
  sizeBytes: number;
  hash: string;
  lastModifiedAt: string;
}): NewFileRow {
  return {
    path: args.absPath,
    relative_path: args.relPath,
    extension: args.extension,
    language: args.language,
    size_bytes: args.sizeBytes,
    hash: args.hash,
    last_modified_at: args.lastModifiedAt,
    indexed_at: null,
    is_deleted: 0,
    importance_score: 0,
  };
}

/** Create a project scanner bound to the given collaborators. */
export function createProjectScanner(deps: ProjectScannerDeps): ProjectScanner {
  const { config, projectRoot, fileRepo, runRepo, logger } = deps;
  const maxFileSizeBytes = config.maxFileSizeKb * 1024;

  function scan(opts?: { force?: boolean }): ScanResult {
    const force = opts?.force === true;
    const startedAtIso = nowIso();
    const scanId = runRepo.startScan();

    const result: ScanResult = {
      scanId,
      newFiles: [],
      changedFiles: [],
      removedFiles: [],
      skippedFiles: [],
      errors: [],
      filesScanned: 0,
      filesIndexed: 0,
    };

    // Relative paths observed on disk this pass (used for removed-file diffing).
    const seen = new Set<string>();

    // Snapshot of live (non-deleted) rows BEFORE this pass, so we can classify a
    // freshly-upserted file as new vs. changed. Taken once per scan().
    const knownBefore = new Set<string>();
    for (const [rel, info] of fileRepo.listAllRelativePaths()) {
      if (info.is_deleted === 0) {
        knownBefore.add(rel);
      }
    }

    try {
      const matcher = createIgnoreMatcher({
        projectRoot,
        include: config.include,
        exclude: config.exclude,
        gitignoreContent: readRootGitignore(projectRoot),
      });

      walkDirectory(projectRoot, matcher, result, seen, knownBefore, force);
      detectRemovedFiles(seen, result);

      runRepo.finishScan(scanId, {
        filesScanned: result.filesScanned,
        // The indexer fills in real indexed counts later; the scanner reports 0.
        filesIndexed: result.filesIndexed,
        filesSkipped: result.skippedFiles.length,
        errorsCount: result.errors.length,
        status: 'completed',
        startedAtIso,
      });

      logger.info('scan completed', {
        scanId,
        filesScanned: result.filesScanned,
        new: result.newFiles.length,
        changed: result.changedFiles.length,
        removed: result.removedFiles.length,
        skipped: result.skippedFiles.length,
        errors: result.errors.length,
      });

      return result;
    } catch (err) {
      // Mark the run failed but do not throw: callers get a usable (partial)
      // result plus the recorded error. Re-throw would lose the scan_runs update.
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ path: projectRoot, error: message });
      try {
        runRepo.finishScan(scanId, {
          filesScanned: result.filesScanned,
          filesIndexed: result.filesIndexed,
          filesSkipped: result.skippedFiles.length,
          errorsCount: result.errors.length,
          status: 'failed',
          startedAtIso,
        });
      } catch (finishErr) {
        logger.error('failed to record failed scan run', {
          scanId,
          error: finishErr instanceof Error ? finishErr.message : String(finishErr),
        });
      }
      logger.error('scan failed', { scanId, error: message });
      return result;
    }
  }

  /**
   * Depth-first walk of `dirAbs`. Excluded/sensitive directories, the .kundun and
   * .git dirs, and symlinked entries are pruned. Each regular file is handed to
   * processFile.
   */
  function walkDirectory(
    dirAbs: string,
    matcher: IgnoreMatcher,
    result: ScanResult,
    seen: Set<string>,
    knownBefore: Set<string>,
    force: boolean,
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      result.errors.push({
        path: toRelativePath(projectRoot, dirAbs),
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const childAbs = path.join(dirAbs, name);

      // Never follow symlinks (dirs OR files); record nothing for them.
      if (entry.isSymbolicLink()) {
        result.skippedFiles.push({
          path: toRelativePath(projectRoot, childAbs),
          reason: 'symlink',
        });
        continue;
      }

      if (entry.isDirectory()) {
        if (ALWAYS_PRUNED_DIRS.has(name)) {
          continue;
        }
        const relDir = toRelativePath(projectRoot, childAbs);
        if (matcher.isExcludedDir(relDir)) {
          continue;
        }
        walkDirectory(childAbs, matcher, result, seen, knownBefore, force);
        continue;
      }

      if (entry.isFile()) {
        processFile(childAbs, matcher, result, seen, knownBefore, force);
      }
      // Anything else (FIFO, socket, block device, ...) is silently ignored.
    }
  }

  /** Classify and (when eligible) upsert a single regular file. */
  function processFile(
    absPath: string,
    matcher: IgnoreMatcher,
    result: ScanResult,
    seen: Set<string>,
    knownBefore: Set<string>,
    force: boolean,
  ): void {
    const relPath = toRelativePath(projectRoot, absPath);

    // Defense in depth: re-assert the path is inside the root and not reachable
    // through a symlinked ancestor before touching its bytes.
    try {
      assertInsideRoot(projectRoot, absPath);
      assertNoSymlink(projectRoot, absPath);
    } catch (err) {
      if (isKundunError(err)) {
        result.skippedFiles.push({ path: relPath, reason: 'symlink' });
        return;
      }
      throw err;
    }

    const classification = matcher.classify(relPath);
    const extension = extensionForStorage(relPath);

    // Sensitive files: we still TRACK them (a files row + hash) so deletion is
    // detectable, but we never read or store their content. The indexer re-checks
    // sensitivity via the same ignore rules and refuses to chunk them.
    if (classification.skipReason === 'sensitive_file') {
      handleTrackedNoContent(absPath, relPath, extension, result, seen);
      return;
    }

    // Any other non-included file is skipped outright (not tracked).
    if (!classification.included) {
      result.skippedFiles.push({
        path: relPath,
        reason: classification.skipReason ?? 'not_included',
      });
      return;
    }

    // stat for size + mtime.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch (err) {
      result.errors.push({
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (stat.size > maxFileSizeBytes) {
      result.skippedFiles.push({ path: relPath, reason: 'too_large' });
      return;
    }

    // Extension-based binary detection (cheap) before any read.
    if (extension !== null && isLikelyBinaryByExtension(extension) && !config.scanBinaryFiles) {
      result.skippedFiles.push({ path: relPath, reason: 'binary' });
      return;
    }

    // Read raw bytes once; reuse for both binary sniffing and hashing.
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(absPath);
    } catch (err) {
      result.errors.push({
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Content-based binary detection.
    if (isBinaryBuffer(buffer) && !config.scanBinaryFiles) {
      result.skippedFiles.push({ path: relPath, reason: 'binary' });
      return;
    }

    const hash = hashBuffer(buffer);
    const language = detectLanguage(relPath);
    const lastModifiedAt = stat.mtime.toISOString();

    const row = buildFileRow({
      absPath,
      relPath,
      extension,
      language,
      sizeBytes: stat.size,
      hash,
      lastModifiedAt,
    });

    const { changed } = fileRepo.upsertByRelativePath(row);
    seen.add(relPath);
    result.filesScanned += 1;

    if (!knownBefore.has(relPath)) {
      // No live row existed for this path before the pass (brand-new or a
      // resurrected soft-deleted file): treat it as new.
      result.newFiles.push(relPath);
    } else if (changed || force) {
      result.changedFiles.push(relPath);
    }
    // Unchanged (known, same hash, not forced): counted as scanned only.
  }

  /**
   * Track a sensitive file without reading its content: upsert a row carrying the
   * byte hash (so a later deletion is detectable) and language=null, then record
   * it as skipped. We hash the bytes but never store/scan content.
   */
  function handleTrackedNoContent(
    absPath: string,
    relPath: string,
    extension: string | null,
    result: ScanResult,
    seen: Set<string>,
  ): void {
    let stat: fs.Stats;
    let buffer: Buffer;
    try {
      stat = fs.statSync(absPath);
      buffer = fs.readFileSync(absPath);
    } catch (err) {
      // If we cannot even hash it, fall back to recording the skip reason only.
      result.skippedFiles.push({ path: relPath, reason: 'sensitive_file' });
      result.errors.push({
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const row = buildFileRow({
      absPath,
      relPath,
      extension,
      language: null,
      sizeBytes: stat.size,
      hash: hashBuffer(buffer),
      lastModifiedAt: stat.mtime.toISOString(),
    });

    fileRepo.upsertByRelativePath(row);
    seen.add(relPath);
    result.filesScanned += 1;
    result.skippedFiles.push({ path: relPath, reason: 'sensitive_file' });
  }

  /**
   * Any previously-active relative path NOT seen on disk this pass is soft-deleted
   * and reported in removedFiles.
   */
  function detectRemovedFiles(seen: Set<string>, result: ScanResult): void {
    const all = fileRepo.listAllRelativePaths();
    const removedIds: number[] = [];
    for (const [rel, info] of all) {
      if (info.is_deleted === 0 && !seen.has(rel)) {
        removedIds.push(info.id);
        result.removedFiles.push(rel);
      }
    }
    if (removedIds.length > 0) {
      fileRepo.markDeleted(removedIds);
    }
  }

  return { scan };
}
