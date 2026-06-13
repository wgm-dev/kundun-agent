// JavaScript symbol extractor. Reuses the shared JS/TS heuristic core from
// typescript.ts with TS-only kinds disabled. Conforms to the extractor contract
// in ./index.ts — pure, total (never throws; returns [] on error), no I/O.

import type { NewSymbolRow } from '../storage/types.js';

import { extractJsLikeSymbols } from './typescript.js';

/**
 * Extract symbols from JavaScript source. Heuristic regex scan; never throws.
 * TS-only kinds (interface/enum/type alias) are not matched.
 */
export function extractJavascriptSymbols(content: string, fileId: number): NewSymbolRow[] {
  return extractJsLikeSymbols(content, fileId, 'javascript', false);
}
