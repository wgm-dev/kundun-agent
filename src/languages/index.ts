// Symbol-extractor registry. Maps each SupportedLanguage to a pure extractor
// function that turns file content into NewSymbolRow[]. The indexer looks up an
// extractor via getExtractor(language) and calls it inside a try/catch so a
// throwing extractor degrades to "no symbols" rather than failing the file.
//
// EXTRACTOR CONTRACT (for the Engines/language layer that implements these):
//   Each module src/languages/<lang>.ts MUST export a named function
//     export function extract<Lang>Symbols(content: string, fileId: number): NewSymbolRow[]
//   where <Lang> is the PascalCase language name. The function:
//     - is PURE (no I/O, no DB access) and MUST NOT throw on malformed input;
//       return [] when it cannot parse;
//     - sets file_id = fileId on every row;
//     - leaves created_at to the SymbolRepository (the repo stamps a single
//       consistent timestamp per batch), so created_at here is best-effort and
//       will be overwritten on insert — extractors may set it to '' or nowIso();
//     - emits 1-based inclusive start_line/end_line (or null when unknown).
//   Concrete export names, by language:
//     php        -> extractPhpSymbols
//     go         -> extractGoSymbols
//     typescript -> extractTypescriptSymbols
//     javascript -> extractJavascriptSymbols
//     csharp     -> extractCsharpSymbols
//     cpp        -> extractCppSymbols
//     sql        -> extractSqlSymbols

import type { NewSymbolRow, SupportedLanguage } from '../storage/types.js';

import { extractPhpSymbols } from './php.js';
import { extractGoSymbols } from './go.js';
import { extractTypescriptSymbols } from './typescript.js';
import { extractJavascriptSymbols } from './javascript.js';
import { extractCsharpSymbols } from './csharp.js';
import { extractCppSymbols } from './cpp.js';
import { extractSqlSymbols } from './sql.js';

/** A symbol extractor: pure, total (never throws), no I/O. */
export type SymbolExtractor = (content: string, fileId: number) => NewSymbolRow[];

/**
 * The extractor registry. One entry per SupportedLanguage. Consumed by the
 * indexer through {@link getExtractor}; do not call entries directly without
 * the try/catch guard the indexer applies.
 */
export const EXTRACTORS: Record<SupportedLanguage, SymbolExtractor> = {
  php: extractPhpSymbols,
  go: extractGoSymbols,
  typescript: extractTypescriptSymbols,
  javascript: extractJavascriptSymbols,
  csharp: extractCsharpSymbols,
  cpp: extractCppSymbols,
  sql: extractSqlSymbols,
};

/**
 * Look up the extractor for a language. Returns undefined for an unknown or
 * null language so callers can cheaply skip symbol extraction.
 */
export function getExtractor(language: SupportedLanguage | null): SymbolExtractor | undefined {
  if (language === null) {
    return undefined;
  }
  return EXTRACTORS[language];
}
