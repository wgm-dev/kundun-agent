// Builder for a fully-defaulted configuration. Delegates to zod so the default
// values live in exactly one place (config-schema.ts).

import type { KundunConfig } from './config-schema.js';
import { validateConfig } from './config-schema.js';

/**
 * Build a complete configuration from just a project name, letting zod fill
 * every other field with its default value.
 */
export function buildDefaultConfig(projectName: string): KundunConfig {
  return validateConfig({ projectName });
}
