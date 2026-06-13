import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppContext, buildIndexer, buildScanner } from '../../../src/core/container.js';
import type { AppContext } from '../../../src/core/container.js';
import { createDiagnosticsEngine } from '../../../src/core/diagnostics-engine.js';
import {
  RULES_BY_LANGUAGE,
  sqlRules,
  typescriptRules,
} from '../../../src/core/diagnostics/rules.js';
import { buildDefaultConfig } from '../../../src/config/default-config.js';
import { writeConfig } from '../../../src/config/config-loader.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../../../src/storage/migrations.js';
import { MetaRepository } from '../../../src/storage/repositories/meta.repository.js';
import { DiagnosticRepository } from '../../../src/storage/repositories/diagnostic.repository.js';
import { openDatabase } from '../../../src/storage/sqlite.js';
import { makeTempProject } from '../../helpers/temp-project.js';
import type { TempProject } from '../../helpers/temp-project.js';

// A .ts file with an explicit `any`, placed under src/ so the default `include`
// globs pick it up during the scan.
const TS_REL = 'src/sample.ts';
const TS_CONTENT = [
  'export function f(): void {',
  '  const x: any = 1;',
  '  void x;',
  '}',
  '',
].join('\n');

// A .sql file under database/ (also a default-included dir) with a SELECT * and a
// DELETE FROM with no WHERE clause.
const SQL_REL = 'database/sample.sql';
const SQL_CONTENT = ['SELECT * FROM t;', 'DELETE FROM t;', ''].join('\n');

/**
 * Initialize a Kundun project on disk the same way `kundun init` does (write
 * config, create the .kundun tree, open the DB, migrate, seed project_meta), so
 * createAppContext succeeds. Returns nothing; the caller then opens the context.
 */
function initProject(project: TempProject): void {
  const config = buildDefaultConfig('diagnostics-test');
  writeConfig(project.root, config);

  // The default databasePath is .kundun/kundun.sqlite; ensure the dir exists.
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

describe('rules (pure functions)', () => {
  it('typescriptRules flags an explicit `: any`', () => {
    const lines = ['const x: any = 1;'];
    const findings = typescriptRules(lines.join('\n'), lines);
    expect(findings.some((f) => f.code === 'ts/explicit-any')).toBe(true);
  });

  it('sqlRules flags `SELECT *`', () => {
    const lines = ['SELECT * FROM t;'];
    const findings = sqlRules(lines.join('\n'), lines);
    expect(findings.some((f) => f.code === 'sql/select-star')).toBe(true);
  });

  it('sqlRules flags a DELETE with no WHERE clause', () => {
    const lines = ['DELETE FROM t;'];
    const findings = sqlRules(lines.join('\n'), lines);
    expect(findings.some((f) => f.code === 'sql/missing-where')).toBe(true);
  });

  it('RULES_BY_LANGUAGE exposes typescript and sql rule sets', () => {
    expect(RULES_BY_LANGUAGE.typescript).toBe(typescriptRules);
    expect(RULES_BY_LANGUAGE.sql).toBe(sqlRules);
  });
});

describe('DiagnosticsEngine', () => {
  let project: TempProject;
  let ctx: AppContext;

  beforeEach(() => {
    project = makeTempProject();
    project.writeFile(TS_REL, TS_CONTENT);
    project.writeFile(SQL_REL, SQL_CONTENT);
    initProject(project);
    ctx = createAppContext({ projectRoot: project.root });

    // Scan + index first so the files exist as rows the engine can iterate.
    const scanner = buildScanner(ctx);
    const indexer = buildIndexer(ctx);
    const scan = scanner.scan();
    indexer.indexFiles([...scan.newFiles, ...scan.changedFiles]);
  });

  afterEach(() => {
    ctx.close();
    project.cleanup();
  });

  it('produces findings and persists diagnostic rows', () => {
    const engine = createDiagnosticsEngine({ ctx });
    const result = engine.run();

    expect(result.findings).toBeGreaterThan(0);
    expect(result.filesAnalyzed).toBeGreaterThan(0);

    // Rows were written to the diagnostics table.
    const repo = new DiagnosticRepository(ctx.kdb);
    const rows = repo.list();
    expect(rows.length).toBeGreaterThan(0);

    // The expected heuristic codes are present among the persisted rows.
    const codes = new Set(rows.map((r) => r.code));
    expect(codes.has('ts/explicit-any')).toBe(true);
    expect(codes.has('sql/select-star')).toBe(true);
    expect(codes.has('sql/missing-where')).toBe(true);
  });

  it('respects a language filter (only the requested language is analyzed)', () => {
    const engine = createDiagnosticsEngine({ ctx });
    const result = engine.run({ language: 'sql' });

    expect(result.findings).toBeGreaterThan(0);

    const repo = new DiagnosticRepository(ctx.kdb);
    const rows = repo.list();
    // Only SQL diagnostics should have been written.
    expect(rows.every((r) => r.language === 'sql')).toBe(true);
    expect(rows.some((r) => r.code === 'sql/select-star')).toBe(true);
  });

  it('returns zeros and writes nothing when diagnostics are disabled', () => {
    // Toggle the config flag on the live context; the engine reads it per run.
    ctx.config.enableDiagnostics = false;

    const engine = createDiagnosticsEngine({ ctx });
    const result = engine.run();

    expect(result.findings).toBe(0);
    expect(result.filesAnalyzed).toBe(0);
    expect(result.bySeverity).toEqual({ info: 0, warning: 0, error: 0, critical: 0 });
    expect(result.note).toBeDefined();

    const repo = new DiagnosticRepository(ctx.kdb);
    expect(repo.countAll()).toBe(0);
  });
});
