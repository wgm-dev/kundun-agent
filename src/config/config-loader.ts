// Loading, locating, and persisting the Kundun project configuration file.
// All filesystem access goes through node:fs synchronously; path resolution of
// the database location is sandboxed within the project root via path-safety.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { KundunError } from '../utils/errors.js';
import { resolveWithinRoot } from '../utils/path-safety.js';
import type { KundunConfig } from './config-schema.js';
import { validateConfig } from './config-schema.js';

/** Canonical name of the config file at the project root. */
export const CONFIG_FILENAME = 'kundun.config.json';

/** Result of successfully loading and resolving a configuration. */
export interface LoadedConfig {
  config: KundunConfig;
  projectRoot: string;
  configPath: string;
  kundunDir: string;
  databasePathAbs: string;
}

/** Absolute path to the config file for a given project root. */
function configPathFor(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_FILENAME);
}

/** True if a config file exists at the project root. */
export function configExists(projectRoot: string): boolean {
  return existsSync(configPathFor(projectRoot));
}

/**
 * Load and fully resolve the configuration for a project root.
 * - Throws KundunError('config_not_found') if the file is missing.
 * - Throws KundunError('config_parse') if the file is not valid JSON.
 * - Throws KundunError('config_invalid') if it fails schema validation.
 * The database path is resolved within the project root (path-traversal safe),
 * and kundunDir is the directory containing the database file.
 */
export function loadConfig(projectRoot: string): LoadedConfig {
  const configPath = configPathFor(projectRoot);

  if (!existsSync(configPath)) {
    throw new KundunError(
      'config_not_found',
      `Kundun config not found: ${configPath}. Run \`kundun init\` first.`,
    );
  }

  const rawText = readFileSync(configPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new KundunError('config_parse', `Failed to parse ${configPath}: ${detail}`);
  }

  const config = validateConfig(parsed);

  // Resolve the database path within the project root. resolveWithinRoot
  // returns a forward-slash absolute path and rejects traversal/symlink escape.
  const databasePathAbs = resolveWithinRoot(projectRoot, config.databasePath);

  // kundunDir is the directory holding the database file; fall back to the
  // conventional <root>/.kundun if the database somehow resolves to the root.
  const dbDir = path.posix.dirname(databasePathAbs);
  const kundunDir = dbDir === databasePathAbs ? resolveWithinRoot(projectRoot, '.kundun') : dbDir;

  return { config, projectRoot, configPath, kundunDir, databasePathAbs };
}

/**
 * Write a configuration to the project root as pretty-printed JSON (2 spaces).
 */
export function writeConfig(projectRoot: string, config: KundunConfig): void {
  const configPath = configPathFor(projectRoot);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
