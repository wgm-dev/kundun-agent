// TypeScript symbol extractor. Heuristic, regex-only, line-by-line scanning.
// Conforms to the extractor contract documented in ./index.ts — pure, total
// (never throws; returns [] on any error), no I/O, never executes code.
//
// This module also hosts the shared JS/TS scanning core (`extractJsLikeSymbols`)
// that javascript.ts reuses, since TS is a superset of JS for these heuristics.

import type { NewSymbolRow, SupportedLanguage } from '../storage/types.js';

/** Max length of a captured signature, to avoid storing huge lines. */
const SIGNATURE_CAP = 200;

/** Trim a source line and cap it to a reasonable signature length. */
function signatureOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > SIGNATURE_CAP ? trimmed.slice(0, SIGNATURE_CAP) : trimmed;
}

/** Build a NewSymbolRow with the fixed fields the contract mandates. */
function makeSymbol(
  fileId: number,
  name: string,
  kind: string,
  language: SupportedLanguage,
  startLine: number,
  signature: string,
): NewSymbolRow {
  return {
    file_id: fileId,
    name,
    kind,
    language,
    start_line: startLine,
    end_line: null,
    signature,
    parent_symbol: null,
    // created_at is overwritten by the SymbolRepository on insert (see index.ts).
    created_at: '',
  };
}

/**
 * Shared JS/TS heuristic scanner. `tsOnly` enables TS-specific kinds
 * (interface, enum, type alias) so plain JavaScript does not falsely match them.
 */
export function extractJsLikeSymbols(
  content: string,
  fileId: number,
  language: SupportedLanguage,
  tsOnly: boolean,
): NewSymbolRow[] {
  try {
    const symbols: NewSymbolRow[] = [];
    const lines = content.split(/\r?\n/);

    // Reusable patterns. `export` / `default` / `abstract` prefixes tolerated.
    const classRe = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
    const interfaceRe = /^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/;
    const enumRe = /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
    const typeAliasRe = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/;
    const functionRe =
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
    // const/let/var Name = (...) => ...  OR  = async (...) => ...  OR  = function ...
    const arrowRe =
      /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
    const assignedFnRe =
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/;
    // Rough method: `name(...) {` or `name(...): Type {`, optionally with
    // visibility / static / async modifiers. Skip control-flow keywords.
    const methodRe =
      /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+|get\s+|set\s+|override\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]+)?\{/;
    const controlKeywords = new Set([
      'if',
      'for',
      'while',
      'switch',
      'catch',
      'return',
      'function',
      'do',
      'else',
      'await',
      'typeof',
    ]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) {
        continue;
      }
      const lineNo = i + 1;
      const sig = signatureOf(line);

      const classM = classRe.exec(line);
      if (classM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, classM[1], 'class', language, lineNo, sig));
        continue;
      }

      if (tsOnly) {
        const ifaceM = interfaceRe.exec(line);
        if (ifaceM?.[1] !== undefined) {
          symbols.push(makeSymbol(fileId, ifaceM[1], 'interface', language, lineNo, sig));
          continue;
        }
        const enumM = enumRe.exec(line);
        if (enumM?.[1] !== undefined) {
          symbols.push(makeSymbol(fileId, enumM[1], 'enum', language, lineNo, sig));
          continue;
        }
        const typeM = typeAliasRe.exec(line);
        if (typeM?.[1] !== undefined) {
          symbols.push(makeSymbol(fileId, typeM[1], 'type', language, lineNo, sig));
          continue;
        }
      }

      const fnM = functionRe.exec(line);
      if (fnM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, fnM[1], 'function', language, lineNo, sig));
        continue;
      }

      const arrowM = arrowRe.exec(line);
      if (arrowM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, arrowM[1], 'function', language, lineNo, sig));
        continue;
      }

      const assignedM = assignedFnRe.exec(line);
      if (assignedM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, assignedM[1], 'function', language, lineNo, sig));
        continue;
      }

      const methodM = methodRe.exec(line);
      if (methodM?.[1] !== undefined && !controlKeywords.has(methodM[1])) {
        symbols.push(makeSymbol(fileId, methodM[1], 'method', language, lineNo, sig));
        continue;
      }
    }

    return symbols;
  } catch {
    return [];
  }
}

/**
 * Extract symbols from TypeScript source. Heuristic regex scan; never throws.
 */
export function extractTypescriptSymbols(content: string, fileId: number): NewSymbolRow[] {
  return extractJsLikeSymbols(content, fileId, 'typescript', true);
}
