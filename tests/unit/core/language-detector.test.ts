import { describe, expect, it } from 'vitest';

import {
  LANGUAGE_BY_EXT,
  detectLanguage,
  isLanguageEnabled,
  SUPPORTED_LANGUAGES,
} from '../../../src/core/language-detector.js';
import type { SupportedLanguage } from '../../../src/storage/types.js';

describe('detectLanguage', () => {
  it('maps each known extension to the expected language', () => {
    const cases: Array<[string, SupportedLanguage]> = [
      ['app/Http/Controller.php', 'php'],
      ['cmd/main.go', 'go'],
      ['src/index.ts', 'typescript'],
      ['src/component.tsx', 'typescript'],
      ['src/types.mts', 'typescript'],
      ['src/types.cts', 'typescript'],
      ['src/index.js', 'javascript'],
      ['src/widget.jsx', 'javascript'],
      ['src/loader.mjs', 'javascript'],
      ['src/loader.cjs', 'javascript'],
      ['Program.cs', 'csharp'],
      ['engine.cpp', 'cpp'],
      ['engine.cc', 'cpp'],
      ['engine.cxx', 'cpp'],
      ['engine.hpp', 'cpp'],
      ['engine.hh', 'cpp'],
      ['engine.h', 'cpp'],
      ['engine.c++', 'cpp'],
      ['legacy.c', 'cpp'],
      ['schema.sql', 'sql'],
    ];
    for (const [path, expected] of cases) {
      expect(detectLanguage(path)).toBe(expected);
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(detectLanguage('SRC/INDEX.TS')).toBe('typescript');
    expect(detectLanguage('Schema.SQL')).toBe('sql');
  });

  it('handles both forward and backslash separators', () => {
    expect(detectLanguage('src\\nested\\file.go')).toBe('go');
    expect(detectLanguage('C:/proj/src/file.php')).toBe('php');
  });

  it('returns null for unknown extensions', () => {
    expect(detectLanguage('README.md')).toBeNull();
    expect(detectLanguage('image.png')).toBeNull();
    expect(detectLanguage('data.json')).toBeNull();
    expect(detectLanguage('style.css')).toBeNull();
  });

  it('returns null when there is no usable extension', () => {
    expect(detectLanguage('Makefile')).toBeNull();
    expect(detectLanguage('.gitignore')).toBeNull(); // dot is first char of basename
    expect(detectLanguage('archive.')).toBeNull(); // trailing dot
    expect(detectLanguage('noext')).toBeNull();
  });

  it('every mapped extension resolves to a supported language', () => {
    for (const lang of Object.values(LANGUAGE_BY_EXT)) {
      expect(SUPPORTED_LANGUAGES).toContain(lang);
    }
  });
});

describe('isLanguageEnabled', () => {
  const allEnabled: Record<SupportedLanguage, boolean> = {
    php: true,
    go: true,
    typescript: true,
    javascript: true,
    csharp: true,
    cpp: true,
    sql: true,
  };

  it('is true when the language toggle is true', () => {
    expect(isLanguageEnabled('typescript', allEnabled)).toBe(true);
  });

  it('is false when the language toggle is false', () => {
    const map = { ...allEnabled, go: false };
    expect(isLanguageEnabled('go', map)).toBe(false);
  });

  it('is false for a null (undetected) language', () => {
    expect(isLanguageEnabled(null, allEnabled)).toBe(false);
  });
});
