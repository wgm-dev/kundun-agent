// Zod schema for the Kundun project configuration file (kundun.config.json).
// Mirrors README §10. Every field has a sensible default so a partial config
// file (even an empty object once projectName is supplied) is accepted and the
// missing keys are filled by zod.

import { z } from 'zod';

import { KundunError } from '../utils/errors.js';

/** Supported source languages. Each maps to a boolean toggle in `languages`. */
const languagesSchema = z
  .object({
    php: z.boolean().default(true),
    go: z.boolean().default(true),
    typescript: z.boolean().default(true),
    javascript: z.boolean().default(true),
    csharp: z.boolean().default(true),
    cpp: z.boolean().default(true),
    sql: z.boolean().default(true),
  })
  .default({});

/** Auto-scan scheduling options. */
const autoScanSchema = z
  .object({
    enabled: z.boolean().default(false),
    intervalMinutes: z.number().default(10),
  })
  .default({});

/** Retention / cleanup policy. All thresholds are in days unless noted. */
const cleanupSchema = z
  .object({
    deleteDeletedFilesAfterDays: z.number().default(7),
    deleteUnusedChunksAfterDays: z.number().default(30),
    deleteLowImportanceMemoriesAfterDays: z.number().default(60),
    archiveCompletedTasksAfterDays: z.number().default(30),
    deleteLogsAfterDays: z.number().default(14),
    vacuumAfterCleanup: z.boolean().default(true),
  })
  .default({});

/** Desktop app / local API options (local API itself is MVP3). */
const desktopSchema = z
  .object({
    enabled: z.boolean().default(true),
    minimizeToTray: z.boolean().default(true),
    startWithWindows: z.boolean().default(false),
    localApiHost: z.string().default('127.0.0.1'),
    localApiPort: z.number().default(37373),
  })
  .default({});

/**
 * Full configuration schema. `projectName` is the only field a user must
 * supply; everything else has a default.
 */
export const configSchema = z.object({
  projectName: z.string(),
  databasePath: z.string().default('.kundun/kundun.sqlite'),
  include: z.array(z.string()).default(['src', 'app', 'database', 'routes', 'config', 'docs']),
  exclude: z
    .array(z.string())
    .default([
      'node_modules',
      'vendor',
      '.git',
      '.next',
      'dist',
      'build',
      'coverage',
      'storage',
      'logs',
      'tmp',
      '.kundun',
    ]),
  maxFileSizeKb: z.number().default(512),
  scanBinaryFiles: z.boolean().default(false),
  enableDiagnostics: z.boolean().default(true),
  enableAutoCleanup: z.boolean().default(true),
  allowRestartFromMcp: z.boolean().default(false),
  autoScan: autoScanSchema,
  cleanup: cleanupSchema,
  desktop: desktopSchema,
  languages: languagesSchema,
});

/** Fully-resolved configuration with all defaults applied. */
export type KundunConfig = z.infer<typeof configSchema>;

/** Format zod issues into a single readable, multi-line message. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Validate raw (parsed JSON) input against the config schema, filling defaults.
 * Throws KundunError('config_invalid') with a readable summary of issues on
 * failure.
 */
export function validateConfig(raw: unknown): KundunConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new KundunError(
      'config_invalid',
      `Invalid Kundun configuration:\n${formatIssues(result.error)}`,
    );
  }
  return result.data;
}
