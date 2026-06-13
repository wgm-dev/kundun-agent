import { symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProjectScanner } from '../../src/core/project-scanner.js';
import { createIndexer } from '../../src/core/indexer.js';
import { buildDefaultConfig } from '../../src/config/default-config.js';
import type { KundunConfig } from '../../src/config/config-schema.js';
import { FileRepository } from '../../src/storage/repositories/file.repository.js';
import { ChunkRepository } from '../../src/storage/repositories/chunk.repository.js';
import { SymbolRepository } from '../../src/storage/repositories/symbol.repository.js';
import { RunRepository } from '../../src/storage/repositories/run.repository.js';
import type { KundunDb } from '../../src/storage/types.js';
import { makeTestDb } from '../helpers/db.js';
import { makeTempProject } from '../helpers/temp-project.js';
import type { TempProject } from '../helpers/temp-project.js';
import { makeSilentLogger } from '../helpers/logger.js';

const SECRET = 'SUPER_SECRET_API_KEY_a1b2c3d4e5f6';
const TS_REL = 'src/example.ts';
const TS_CONTENT = [
  'export function greet(name: string): string {',
  '  return `hello ${name}`;',
  '}',
  '',
].join('\n');

interface Harness {
  kdb: KundunDb;
  project: TempProject;
  config: KundunConfig;
  fileRepo: FileRepository;
  chunkRepo: ChunkRepository;
  scanner: ReturnType<typeof createProjectScanner>;
  indexer: ReturnType<typeof createIndexer>;
}

function buildHarness(project: TempProject): Harness {
  const kdb = makeTestDb();
  const config = buildDefaultConfig('scanner-test');
  const logger = makeSilentLogger();

  const fileRepo = new FileRepository(kdb);
  const chunkRepo = new ChunkRepository(kdb);
  const symbolRepo = new SymbolRepository(kdb);
  const runRepo = new RunRepository(kdb);

  const scanner = createProjectScanner({
    kdb,
    config,
    projectRoot: project.root,
    fileRepo,
    runRepo,
    logger,
  });

  const indexer = createIndexer({
    kdb,
    config,
    projectRoot: project.root,
    fileRepo,
    chunkRepo,
    symbolRepo,
    logger,
  });

  return { kdb, project, config, fileRepo, chunkRepo, scanner, indexer };
}

/** Assert the secret string appears in NO chunk content anywhere in the DB. */
function assertNoSecretLeak(kdb: KundunDb): void {
  const rows = kdb.db.prepare('SELECT content FROM file_chunks').all() as Array<{
    content: string;
  }>;
  for (const row of rows) {
    expect(row.content.includes(SECRET)).toBe(false);
  }
}

describe('scanner + indexer (incremental)', () => {
  let project: TempProject;
  let h: Harness;

  beforeEach(() => {
    project = makeTempProject();
    project.writeFile(TS_REL, TS_CONTENT);
    project.writeFile('node_modules/leftpad/index.js', 'module.exports = () => {};');
    project.writeFile('.env', `API_KEY=${SECRET}\n`);
    h = buildHarness(project);
  });

  afterEach(() => {
    h.kdb.close();
    project.cleanup();
  });

  it('indexes the .ts file, excludes node_modules, and skips .env as sensitive', () => {
    const result = h.scanner.scan();
    h.indexer.indexFiles([...result.newFiles, ...result.changedFiles]);

    // .ts file is tracked AND produced at least one chunk.
    const tsRow = h.fileRepo.getByRelativePath(TS_REL);
    expect(tsRow).toBeDefined();
    expect(tsRow?.language).toBe('typescript');
    const tsChunks = tsRow ? h.chunkRepo.getByFile(tsRow.id) : [];
    expect(tsChunks.length).toBeGreaterThan(0);

    // node_modules is excluded outright (never tracked).
    expect(h.fileRepo.getByRelativePath('node_modules/leftpad/index.js')).toBeUndefined();

    // .env is reported as skipped with reason sensitive_file.
    const envSkip = result.skippedFiles.find((s) => s.path === '.env');
    expect(envSkip).toBeDefined();
    expect(envSkip?.reason).toBe('sensitive_file');

    // POSITIVE LEAK ASSERTION: the secret must never reach chunk content.
    assertNoSecretLeak(h.kdb);
  });

  it('does not reindex an unchanged .ts file on re-scan', () => {
    const first = h.scanner.scan();
    h.indexer.indexFiles([...first.newFiles, ...first.changedFiles]);

    const second = h.scanner.scan();
    // Same path, same content, not forced => not changed and not new.
    expect(second.changedFiles).not.toContain(TS_REL);
    expect(second.newFiles).not.toContain(TS_REL);
    expect(second.changedFiles).toHaveLength(0);

    // No secret leak persists either.
    assertNoSecretLeak(h.kdb);
  });

  it('reports a modified .ts file in changedFiles on re-scan', () => {
    const first = h.scanner.scan();
    h.indexer.indexFiles([...first.newFiles, ...first.changedFiles]);

    project.writeFile(TS_REL, `${TS_CONTENT}\n// edited\nexport const X = 1;\n`);

    const second = h.scanner.scan();
    expect(second.changedFiles).toContain(TS_REL);
    expect(second.newFiles).not.toContain(TS_REL);
  });

  it('soft-deletes a removed .ts file and reports it in removedFiles', () => {
    const first = h.scanner.scan();
    h.indexer.indexFiles([...first.newFiles, ...first.changedFiles]);

    project.removeFile(TS_REL);

    const second = h.scanner.scan();
    expect(second.removedFiles).toContain(TS_REL);

    const row = h.fileRepo.getByRelativePath(TS_REL);
    expect(row).toBeDefined();
    expect(row?.is_deleted).toBe(1); // soft-deleted, not hard-deleted
  });

  it('does not follow a directory symlink that escapes the project root', () => {
    // Symlink creation requires privileges on Windows; skip when unavailable.
    let outsideRoot: string;
    try {
      // Point a symlink inside an included dir at the OS temp root (an escape).
      outsideRoot = join(project.root, '..');
      symlinkSync(outsideRoot, join(project.root, 'src', 'escape'), 'dir');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        // Insufficient privilege (typical on Windows) — skip rather than fail.
        return;
      }
      throw err;
    }

    const result = h.scanner.scan();

    // The symlinked entry is recorded as skipped (reason 'symlink'), never walked.
    const symlinkSkip = result.skippedFiles.find((s) => s.path === 'src/escape');
    expect(symlinkSkip).toBeDefined();
    expect(symlinkSkip?.reason).toBe('symlink');

    // Nothing outside the root leaked into the files table via the symlink.
    for (const f of h.fileRepo.listActive()) {
      expect(f.relative_path.startsWith('..')).toBe(false);
    }
  });
});
