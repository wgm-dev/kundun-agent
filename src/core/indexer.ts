// File indexer. Turns a scanned file (already present in the `files` table) into
// searchable chunks and extracted symbols, then refreshes its importance score
// and indexed_at timestamp. The scanner owns discovery and the files-table
// upsert; the indexer owns the per-file content work below it.
//
// Each file's work runs in its OWN transaction so one malformed file rolls back
// only itself and never the whole batch. better-sqlite3 is fully synchronous —
// nothing here is async.

import { readFileSync } from 'node:fs';

import { chunkByLines, normalizeNewlines } from './chunker.js';
import { computeFileImportance } from './importance.js';
import { detectLanguage, isLanguageEnabled } from './language-detector.js';
import { getExtractor } from '../languages/index.js';
import type { ChunkRepository } from '../storage/repositories/chunk.repository.js';
import type { FileRepository } from '../storage/repositories/file.repository.js';
import type { SymbolRepository } from '../storage/repositories/symbol.repository.js';
import { transaction } from '../storage/sqlite.js';
import type { KundunDb, NewChunkRow, NewSymbolRow, SupportedLanguage } from '../storage/types.js';
import { isBinaryBuffer } from '../utils/binary-detection.js';
import { hashChunk } from '../utils/hashing.js';
import { createIgnoreMatcher } from '../utils/ignore-rules.js';
import type { Logger } from '../utils/logger.js';
import { resolveWithinRoot } from '../utils/path-safety.js';
import { nowIso } from '../utils/time.js';
import type { KundunConfig } from '../config/config-schema.js';

/** Collaborators the indexer needs. Supplied once by the engine wiring layer. */
export interface IndexerDeps {
  kdb: KundunDb;
  config: KundunConfig;
  projectRoot: string;
  fileRepo: FileRepository;
  chunkRepo: ChunkRepository;
  symbolRepo: SymbolRepository;
  logger: Logger;
}

/** Why a single file was not indexed. */
export type IndexSkipReason = 'not_scanned' | 'sensitive' | 'binary' | 'read_error';

/** Outcome of indexing a single file. */
export interface IndexFileResult {
  indexed: boolean;
  reason?: IndexSkipReason;
}

/** Aggregate outcome of indexing a batch of files. */
export interface IndexFilesResult {
  indexed: number;
  skipped: number;
  errors: number;
}

/** Public surface of the indexer. */
export interface Indexer {
  /** Index a single root-relative file path. */
  indexFile(relativePath: string): IndexFileResult;
  /** Index many paths, isolating failures per file. */
  indexFiles(relativePaths: string[]): IndexFilesResult;
}

/**
 * Build an indexer bound to a project. The sensitivity matcher is constructed
 * once here (include/exclude from config) and reused for the per-file
 * re-guard — the scanner already filtered, but we never read a file the
 * sensitive denylist flags, even if asked to index it directly.
 */
export function createIndexer(deps: IndexerDeps): Indexer {
  const { kdb, config, projectRoot, fileRepo, chunkRepo, symbolRepo } = deps;
  const log = deps.logger.child('indexer');

  // gitignore is intentionally omitted: the only classification we consume here
  // is the sensitive-file denylist, which is independent of .gitignore.
  const matcher = createIgnoreMatcher({
    projectRoot,
    include: config.include,
    exclude: config.exclude,
  });

  function indexFile(relativePath: string): IndexFileResult {
    // The file must already be tracked (scanner inserted it). If not, there is
    // nothing to attach chunks/symbols to.
    const fileRow = fileRepo.getByRelativePath(relativePath);
    if (fileRow === undefined) {
      return { indexed: false, reason: 'not_scanned' };
    }
    const fileId = fileRow.id;

    // Sensitivity re-guard: never read a denylisted file even on a direct call.
    if (matcher.classify(relativePath).skipReason === 'sensitive_file') {
      log.warn('skip sensitive file', { relativePath });
      return { indexed: false, reason: 'sensitive' };
    }

    // Resolve and validate the absolute path inside the project root.
    const absPath = resolveWithinRoot(projectRoot, relativePath);

    const language = detectLanguage(relativePath);

    let buffer: Buffer;
    try {
      buffer = readFileSync(absPath);
    } catch (err) {
      log.warn('read failed', { relativePath, error: errorMessage(err) });
      return { indexed: false, reason: 'read_error' };
    }

    if (isBinaryBuffer(buffer)) {
      return { indexed: false, reason: 'binary' };
    }

    const content = normalizeNewlines(buffer.toString('utf8'));

    // Symbols are extracted only when the language is enabled in config; content
    // is still chunked for search regardless (an unknown/disabled language is
    // searchable text).
    const symbols = isLanguageEnabled(language, config.languages)
      ? extractSymbolsSafely(language, content, fileId, relativePath)
      : [];

    const chunks = buildChunkRows(content);
    const importance = computeFileImportance(relativePath, language);

    // One transaction per file: chunks, symbols, importance, and indexed_at all
    // commit together or not at all.
    transaction(kdb.db, () => {
      chunkRepo.replaceForFile(fileId, chunks);
      symbolRepo.replaceForFile(fileId, symbols);
      fileRepo.updateImportance(fileId, importance);
      fileRepo.setIndexedAt(fileId, nowIso());
    });

    return { indexed: true };
  }

  function indexFiles(relativePaths: string[]): IndexFilesResult {
    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    for (const relativePath of relativePaths) {
      try {
        const result = indexFile(relativePath);
        if (result.indexed) {
          indexed += 1;
        } else {
          skipped += 1;
        }
      } catch (err) {
        errors += 1;
        log.error('indexFile threw', { relativePath, error: errorMessage(err) });
      }
    }

    return { indexed, skipped, errors };
  }

  /**
   * Run the language's extractor under a guard: extractors are contractually
   * pure and total, but a buggy one must never fail the file — log and fall back
   * to no symbols.
   */
  function extractSymbolsSafely(
    language: SupportedLanguage | null,
    content: string,
    fileId: number,
    relativePath: string,
  ): NewSymbolRow[] {
    const extractor = getExtractor(language);
    if (extractor === undefined) {
      return [];
    }
    try {
      return extractor(content, fileId);
    } catch (err) {
      log.warn('symbol extraction failed', {
        relativePath,
        language,
        error: errorMessage(err),
      });
      return [];
    }
  }

  return { indexFile, indexFiles };
}

/**
 * Convert chunker output into NewChunkRow inserts. created_at and updated_at
 * share one timestamp per file pass; content_hash is computed here (the repo
 * dedups exact-duplicate hashes within a file).
 */
function buildChunkRows(content: string): NewChunkRow[] {
  const now = nowIso();
  return chunkByLines(content).map((chunk) => ({
    file_id: 0, // overwritten by ChunkRepository.replaceForFile using its fileId arg
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    content_hash: hashChunk(chunk.content),
    token_estimate: chunk.tokenEstimate,
    start_line: chunk.startLine,
    end_line: chunk.endLine,
    created_at: now,
    updated_at: now,
  }));
}

/** Extract a printable message from an unknown caught value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
