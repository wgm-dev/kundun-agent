// Composition root for Kundun-Agent. This is the single wiring point every CLI
// command uses: it loads config, opens the database, runs migrations, mirrors
// the schema version into project_meta (D2), builds the logger, and constructs
// every repository. Thin `build*` factories assemble the core engines from the
// resulting context so callers never wire dependencies by hand.
//
// better-sqlite3 is fully synchronous — nothing here is async.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { KundunConfig } from '../config/config-schema.js';
import { configExists, loadConfig } from '../config/config-loader.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../storage/migrations.js';
import { openDatabase } from '../storage/sqlite.js';
import type { KundunDb } from '../storage/types.js';

import { ChunkRepository } from '../storage/repositories/chunk.repository.js';
import { FileRepository } from '../storage/repositories/file.repository.js';
import { MemoryRepository } from '../storage/repositories/memory.repository.js';
import { MetaRepository } from '../storage/repositories/meta.repository.js';
import { RunRepository } from '../storage/repositories/run.repository.js';
import { SymbolRepository } from '../storage/repositories/symbol.repository.js';
import { TaskRepository } from '../storage/repositories/task.repository.js';

import { KundunError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

import { createProjectScanner } from './project-scanner.js';
import type { ProjectScanner } from './project-scanner.js';
import { createIndexer } from './indexer.js';
import type { Indexer } from './indexer.js';
import { createMemoryEngine } from './memory-engine.js';
import type { MemoryEngine } from './memory-engine.js';
import { createTaskEngine } from './task-engine.js';
import type { TaskEngine } from './task-engine.js';
import { createCleanupEngine } from './cleanup-engine.js';
import type { CleanupEngine } from './cleanup-engine.js';
import { createSearchProvider } from './search-provider.js';
import type { SearchProvider } from './search-provider.js';

/** The repositories bundled on an {@link AppContext}. */
export interface Repositories {
  meta: MetaRepository;
  run: RunRepository;
  file: FileRepository;
  chunk: ChunkRepository;
  symbol: SymbolRepository;
  memory: MemoryRepository;
  task: TaskRepository;
}

/**
 * Fully-wired application context shared by every CLI command. Holds the loaded
 * config, resolved paths, the open database handle, a logger, and all
 * repositories. `close()` releases the database (and checkpoints the WAL).
 */
export interface AppContext {
  config: KundunConfig;
  projectRoot: string;
  kundunDir: string;
  kdb: KundunDb;
  logger: Logger;
  repos: Repositories;
  close(): void;
}

/** Options for {@link createAppContext}. */
export interface CreateAppContextOptions {
  projectRoot: string;
}

/**
 * Build the application context for a project root.
 *
 * Order: load+resolve config -> open database -> run migrations -> mirror the
 * authoritative schema version into project_meta (D2) -> build logger ->
 * construct repositories. Throws KundunError('not_initialized') when the project
 * has no config or no database file yet, so the caller can suggest `kundun init`.
 */
export function createAppContext(opts: CreateAppContextOptions): AppContext {
  const { projectRoot } = opts;

  if (!configExists(projectRoot)) {
    throw new KundunError(
      'not_initialized',
      `Kundun is not initialized in ${projectRoot}. Run \`kundun init\` first.`,
    );
  }

  // loadConfig throws config_not_found/parse/invalid; translate the missing-file
  // case to not_initialized so callers can give the consistent init hint.
  let loaded;
  try {
    loaded = loadConfig(projectRoot);
  } catch (err) {
    if (err instanceof KundunError && err.code === 'config_not_found') {
      throw new KundunError(
        'not_initialized',
        `Kundun is not initialized in ${projectRoot}. Run \`kundun init\` first.`,
      );
    }
    throw err;
  }

  const { config, kundunDir, databasePathAbs } = loaded;

  // A resolved config without a database file means init has not finished.
  if (!existsSync(databasePathAbs)) {
    throw new KundunError(
      'not_initialized',
      `Kundun database not found at ${databasePathAbs}. Run \`kundun init\` first.`,
    );
  }

  const kdb = openDatabase(databasePathAbs);

  try {
    // Apply any pending migrations, then mirror the authoritative version (D2).
    runMigrations(kdb.db, kdb.hasFts5);

    const meta = new MetaRepository(kdb);
    meta.setSchemaVersion(LATEST_SCHEMA_VERSION);

    const logger = createLogger({ logDir: join(kundunDir, 'logs') }).child('kundun');

    const repos: Repositories = {
      meta,
      run: new RunRepository(kdb),
      file: new FileRepository(kdb),
      chunk: new ChunkRepository(kdb),
      symbol: new SymbolRepository(kdb),
      memory: new MemoryRepository(kdb),
      task: new TaskRepository(kdb),
    };

    return {
      config,
      projectRoot: loaded.projectRoot,
      kundunDir,
      kdb,
      logger,
      repos,
      close(): void {
        kdb.close();
      },
    };
  } catch (err) {
    // Never leak the open handle if wiring fails after the DB was opened.
    kdb.close();
    throw err;
  }
}

// --- Thin engine/provider builders (wire deps from a ready context) ---

/** Build the project scanner from a context. */
export function buildScanner(ctx: AppContext): ProjectScanner {
  return createProjectScanner({
    kdb: ctx.kdb,
    config: ctx.config,
    projectRoot: ctx.projectRoot,
    fileRepo: ctx.repos.file,
    runRepo: ctx.repos.run,
    logger: ctx.logger,
  });
}

/** Build the file indexer from a context. */
export function buildIndexer(ctx: AppContext): Indexer {
  return createIndexer({
    kdb: ctx.kdb,
    config: ctx.config,
    projectRoot: ctx.projectRoot,
    fileRepo: ctx.repos.file,
    chunkRepo: ctx.repos.chunk,
    symbolRepo: ctx.repos.symbol,
    logger: ctx.logger,
  });
}

/** Build the memory engine from a context (search path keyed off hasFts5, D1). */
export function buildMemoryEngine(ctx: AppContext): MemoryEngine {
  return createMemoryEngine({
    memoryRepo: ctx.repos.memory,
    hasFts5: ctx.kdb.hasFts5,
    logger: ctx.logger,
  });
}

/** Build the task engine from a context. */
export function buildTaskEngine(ctx: AppContext): TaskEngine {
  return createTaskEngine({
    taskRepo: ctx.repos.task,
  });
}

/** Build the cleanup engine from a context. */
export function buildCleanupEngine(ctx: AppContext): CleanupEngine {
  return createCleanupEngine({
    kdb: ctx.kdb,
    config: ctx.config,
    kundunDir: ctx.kundunDir,
    fileRepo: ctx.repos.file,
    chunkRepo: ctx.repos.chunk,
    symbolRepo: ctx.repos.symbol,
    memoryRepo: ctx.repos.memory,
    taskRepo: ctx.repos.task,
    runRepo: ctx.repos.run,
    logger: ctx.logger,
  });
}

/** Build the code-search provider from a context (FTS5 vs LIKE picked by D1). */
export function buildSearchProvider(ctx: AppContext): SearchProvider {
  return createSearchProvider(ctx.kdb, ctx.repos.chunk);
}
