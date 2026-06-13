import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildIndexer,
  buildMemoryEngine,
  buildScanner,
  buildSearchProvider,
  buildTaskEngine,
  createAppContext,
} from '../../src/core/container.js';
import type { AppContext } from '../../src/core/container.js';
import { buildProjectSummary } from '../../src/core/project-summary.js';
import { createEventBus } from '../../src/core/event-bus.js';
import { registerTools } from '../../src/mcp/tools.js';
import { buildDefaultConfig } from '../../src/config/default-config.js';
import { writeConfig } from '../../src/config/config-loader.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';
import { MetaRepository } from '../../src/storage/repositories/meta.repository.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { makeTempProject } from '../helpers/temp-project.js';
import type { TempProject } from '../helpers/temp-project.js';

const TS_REL = 'src/greeter.ts';
const TS_CONTENT = [
  'export function greet(name: string): string {',
  '  return `hello ${name}`;',
  '}',
  '',
].join('\n');

/**
 * Initialize a Kundun project on disk exactly as `kundun init` does so that
 * createAppContext succeeds: write config, create the .kundun tree, open the DB,
 * migrate, and seed project_meta.
 */
function initProject(project: TempProject): void {
  const config = buildDefaultConfig('mcp-tools-test');
  writeConfig(project.root, config);
  mkdirSync(join(project.root, '.kundun'), { recursive: true });

  const dbPath = join(project.root, '.kundun', 'kundun.sqlite');
  const kdb = openDatabase(dbPath);
  try {
    runMigrations(kdb.db, kdb.hasFts5);
    const meta = new MetaRepository(kdb);
    meta.ensure(project.root, config.projectName, LATEST_SCHEMA_VERSION);
    meta.setSchemaVersion(LATEST_SCHEMA_VERSION);
  } finally {
    kdb.close();
  }
}

describe('mcp tools (integration)', () => {
  let project: TempProject;
  let ctx: AppContext;

  beforeEach(() => {
    project = makeTempProject();
    project.writeFile(TS_REL, TS_CONTENT);
    initProject(project);
    ctx = createAppContext({ projectRoot: project.root });
  });

  afterEach(() => {
    ctx.close();
    project.cleanup();
  });

  it('registers all tools on a real McpServer without throwing', () => {
    const server = new McpServer({ name: 'kundun-agent', version: '0.0.0-test' });
    const eventBus = createEventBus();
    expect(() => registerTools(server, () => ctx, { eventBus })).not.toThrow();
  });

  it('scan_project path (buildScanner + buildIndexer) indexes the .ts file', () => {
    // This mirrors exactly what the kundun.scan_project tool handler does.
    const scanner = buildScanner(ctx);
    const indexer = buildIndexer(ctx);

    const scan = scanner.scan();
    const toIndex = [...scan.newFiles, ...scan.changedFiles];
    const indexResult = indexer.indexFiles(toIndex);

    expect(scan.filesScanned).toBeGreaterThan(0);
    expect(toIndex).toContain(TS_REL);
    expect(indexResult.indexed).toBeGreaterThan(0);

    const fileRow = ctx.repos.file.getByRelativePath(TS_REL);
    expect(fileRow).toBeDefined();
    expect(fileRow?.language).toBe('typescript');
  });

  it('project_summary path (buildProjectSummary) returns a sane JSON-serializable summary', () => {
    // Index first so the summary has content to report.
    const scanner = buildScanner(ctx);
    const indexer = buildIndexer(ctx);
    const scan = scanner.scan();
    indexer.indexFiles([...scan.newFiles, ...scan.changedFiles]);

    const summary = buildProjectSummary(ctx);

    // It must be serializable (the tool returns it as a JSON text block).
    expect(() => JSON.stringify(summary)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(summary)) as unknown;
    expect(roundTripped).toBeTypeOf('object');
    expect(roundTripped).not.toBeNull();
  });

  it('search_code path (buildSearchProvider) finds the indexed function', () => {
    const scanner = buildScanner(ctx);
    const indexer = buildIndexer(ctx);
    const scan = scanner.scan();
    indexer.indexFiles([...scan.newFiles, ...scan.changedFiles]);

    const search = buildSearchProvider(ctx);
    expect(['fts5', 'like']).toContain(search.mode);

    const results = search.searchCode('greet', { limit: 20 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.some((r) => r.relativePath === TS_REL)).toBe(true);
  });

  it('add_memory + search_memory path (buildMemoryEngine) round-trips a memory', () => {
    const memoryEngine = buildMemoryEngine(ctx);
    const id = memoryEngine.add({
      type: 'decision',
      title: 'use sqlite',
      content: 'store everything locally in better-sqlite3',
    });
    expect(id).toBeGreaterThan(0);

    const rows = memoryEngine.search({ query: 'sqlite', limit: 10 });
    expect(rows.some((m) => m.id === id)).toBe(true);
  });

  it('create_task + next_task path (buildTaskEngine) returns the created task', () => {
    const taskEngine = buildTaskEngine(ctx);
    const id = taskEngine.create({ title: 'wire the MCP server', priority: 'high' });
    expect(id).toBeGreaterThan(0);

    const next = taskEngine.next();
    expect(next).toBeDefined();
    const fetched = taskEngine.get(id);
    expect(fetched?.title).toBe('wire the MCP server');
  });
});
