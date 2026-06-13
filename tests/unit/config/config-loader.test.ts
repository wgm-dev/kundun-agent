// Unit tests for configuration building, validation, and load/write round-trip.
// File I/O runs against a real temp project directory.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDefaultConfig } from '../../../src/config/default-config.js';
import { validateConfig } from '../../../src/config/config-schema.js';
import { loadConfig, writeConfig, configExists } from '../../../src/config/config-loader.js';
import { KundunError } from '../../../src/utils/errors.js';

const tempDirs: string[] = [];

function makeProjectDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kundun-cfg-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('buildDefaultConfig', () => {
  it('fills every field with its default given only a project name', () => {
    const config = buildDefaultConfig('demo-project');
    expect(config.projectName).toBe('demo-project');
    expect(config.databasePath).toBe('.kundun/kundun.sqlite');
    expect(config.maxFileSizeKb).toBe(512);
    expect(config.scanBinaryFiles).toBe(false);
    expect(config.include).toContain('src');
    expect(config.exclude).toContain('node_modules');
    expect(config.autoScan.enabled).toBe(false);
    expect(config.cleanup.vacuumAfterCleanup).toBe(true);
    expect(config.desktop.localApiPort).toBe(37373);
    expect(config.languages.typescript).toBe(true);
  });
});

describe('validateConfig', () => {
  it('accepts a minimal object and applies defaults', () => {
    const config = validateConfig({ projectName: 'min' });
    expect(config.projectName).toBe('min');
    expect(config.maxFileSizeKb).toBe(512);
  });

  it('rejects a missing projectName', () => {
    expect(() => validateConfig({})).toThrow(KundunError);
    try {
      validateConfig({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as KundunError).code).toBe('config_invalid');
    }
  });

  it('rejects a wrongly-typed field', () => {
    expect(() => validateConfig({ projectName: 'x', maxFileSizeKb: 'huge' })).toThrow(KundunError);
    expect(() => validateConfig({ projectName: 'x', include: 'src' })).toThrow(KundunError);
    expect(() => validateConfig({ projectName: 123 })).toThrow(KundunError);
  });
});

describe('loadConfig / writeConfig round-trip', () => {
  it('writes a config and loads it back with defaults resolved', () => {
    const root = makeProjectDir();
    expect(configExists(root)).toBe(false);

    const config = buildDefaultConfig('round-trip');
    writeConfig(root, config);
    expect(configExists(root)).toBe(true);

    const loaded = loadConfig(root);
    expect(loaded.config.projectName).toBe('round-trip');
    expect(loaded.projectRoot).toBe(root);
    // databasePath resolves within the root to a forward-slash absolute path.
    expect(loaded.databasePathAbs.endsWith('.kundun/kundun.sqlite')).toBe(true);
    expect(loaded.databasePathAbs.includes('\\')).toBe(false);
    expect(loaded.kundunDir.endsWith('.kundun')).toBe(true);
    expect(loaded.configPath.endsWith('kundun.config.json')).toBe(true);
  });

  it('throws config_not_found when no config file exists', () => {
    const root = makeProjectDir();
    expect(() => loadConfig(root)).toThrow(KundunError);
    try {
      loadConfig(root);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KundunError);
      expect((err as KundunError).code).toBe('config_not_found');
    }
  });

  it('throws config_parse on malformed JSON', () => {
    const root = makeProjectDir();
    // Write broken JSON straight to the canonical config path, bypassing the
    // serializer in writeConfig.
    const configPath = path.join(root, 'kundun.config.json');
    writeFileSync(configPath, '{ not valid json', 'utf8');
    try {
      loadConfig(root);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as KundunError).code).toBe('config_parse');
    }
  });
});
