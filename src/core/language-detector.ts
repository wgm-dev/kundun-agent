// Language detection by file extension. Maps known source extensions to one of
// the SUPPORTED LANGUAGES and exposes helpers for enable/disable checks against
// the project config. Pure functions only; no I/O.

import type { SupportedLanguage } from '../storage/types.js';

/**
 * Extension (with leading dot, lowercase) -> supported language.
 * `.c` is mapped to `cpp` for MVP1 (acceptable simplification).
 */
export const LANGUAGE_BY_EXT: Record<string, SupportedLanguage> = {
  '.php': 'php',
  '.go': 'go',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.h': 'cpp',
  '.c++': 'cpp',
  '.c': 'cpp',
  '.sql': 'sql',
};

/** All languages the indexer understands, in a stable order. */
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  'php',
  'go',
  'typescript',
  'javascript',
  'csharp',
  'cpp',
  'sql',
];

/**
 * Extract the lowercased extension (with leading dot) from a file path.
 * Returns null when the basename has no dot or ends with a dot.
 * Only the final segment is considered (handles both `/` and `\` separators).
 */
function extensionOf(filePath: string): string | null {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const dot = base.lastIndexOf('.');
  // No dot, or dot is the first/last char of the basename -> no usable extension.
  if (dot <= 0 || dot === base.length - 1) {
    return null;
  }
  return base.slice(dot).toLowerCase();
}

/**
 * Detect the source language of a file by its extension.
 * Returns null for unknown / unsupported extensions.
 */
export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = extensionOf(filePath);
  if (ext === null) {
    return null;
  }
  return LANGUAGE_BY_EXT[ext] ?? null;
}

/**
 * Whether a language is enabled in the project config `languages` map.
 * `null` (undetected) is never enabled.
 */
export function isLanguageEnabled(
  language: SupportedLanguage | null,
  languages: Record<SupportedLanguage, boolean>,
): boolean {
  if (language === null) {
    return false;
  }
  return languages[language] === true;
}
