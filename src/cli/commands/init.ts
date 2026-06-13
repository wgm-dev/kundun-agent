// `kundun init` — bootstrap a project: write the config file, create the
// .kundun directory tree (D6: no runtime token in MVP1), open/create the
// database, run migrations, and seed the project_meta row. Does NOT use
// createAppContext because the database may not exist yet.

import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Command } from 'commander';
import pc from 'picocolors';

import { buildDefaultConfig } from '../../config/default-config.js';
import { configExists, loadConfig, writeConfig } from '../../config/config-loader.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../../storage/migrations.js';
import { MetaRepository } from '../../storage/repositories/meta.repository.js';
import { openDatabase } from '../../storage/sqlite.js';
import { getGlobalOptions, printJson, printLine, reportError } from '../shared.js';

/** Subdirectories created under .kundun (D6: NO runtime/token file in MVP1). */
const KUNDUN_SUBDIRS = ['cache', 'logs', 'snapshots', 'runtime'] as const;

/** Options accepted by the init command. */
interface InitOptions {
  name?: string;
  force?: boolean;
}

/** Register `kundun init` on the program. */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Kundun in the current project (config + database)')
    .option('--name <name>', 'project name (defaults to the directory name)')
    .option('--force', 'reinitialize even if a config already exists', false)
    .action((options: InitOptions, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      try {
        runInit(projectRoot, options, json);
      } catch (err) {
        reportError(err);
      }
    });
}

/** Core init logic, separated for clarity (no async: better-sqlite3 is sync). */
function runInit(projectRoot: string, options: InitOptions, json: boolean): void {
  const force = options.force ?? false;

  // Already initialized and not forcing: report and stop.
  if (configExists(projectRoot) && !force) {
    if (json) {
      printJson({ ok: true, alreadyInitialized: true, projectRoot });
    } else {
      printLine(pc.yellow('Kundun is already initialized in this project.'));
      printLine(`Use ${pc.cyan('kundun init --force')} to reinitialize.`);
    }
    return;
  }

  const projectName = options.name ?? basename(projectRoot);

  // Write the config first so loadConfig can resolve the database path.
  const config = buildDefaultConfig(projectName);
  writeConfig(projectRoot, config);

  // Resolve the now-written config to get the absolute database / .kundun paths.
  const loaded = loadConfig(projectRoot);
  const { kundunDir, databasePathAbs } = loaded;

  // Create the .kundun directory tree (D6).
  mkdirSync(kundunDir, { recursive: true });
  for (const sub of KUNDUN_SUBDIRS) {
    mkdirSync(join(kundunDir, sub), { recursive: true });
  }

  // Open/create the database, migrate, and seed project_meta.
  const kdb = openDatabase(databasePathAbs);
  try {
    runMigrations(kdb.db, kdb.hasFts5);
    const meta = new MetaRepository(kdb);
    meta.ensure(loaded.projectRoot, projectName, LATEST_SCHEMA_VERSION);
    meta.setSchemaVersion(LATEST_SCHEMA_VERSION);
  } finally {
    kdb.close();
  }

  if (json) {
    printJson({
      ok: true,
      alreadyInitialized: false,
      projectRoot: loaded.projectRoot,
      projectName,
      configPath: loaded.configPath,
      kundunDir,
      databasePath: databasePathAbs,
      schemaVersion: LATEST_SCHEMA_VERSION,
      hasFts5: kdb.hasFts5,
    });
    return;
  }

  printLine(pc.green(`Initialized Kundun project "${projectName}".`));
  printLine(`  config:    ${loaded.configPath}`);
  printLine(`  database:  ${databasePathAbs}`);
  printLine(`  .kundun:   ${kundunDir}`);
  for (const sub of KUNDUN_SUBDIRS) {
    printLine(`    - ${join(kundunDir, sub)}`);
  }
  printLine();
  printLine(`Search backend: ${kdb.hasFts5 ? pc.green('FTS5') : pc.yellow('LIKE fallback')}`);
  printLine(`Next: run ${pc.cyan('kundun scan')} to index your code.`);
}
