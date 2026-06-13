// C/C++ symbol extractor. Heuristic, regex-only, line-by-line scanning.
// Conforms to the extractor contract in ./index.ts — pure, total (never throws;
// returns [] on error), no I/O, never executes code.

import type { NewSymbolRow } from '../storage/types.js';

const SIGNATURE_CAP = 200;

function signatureOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > SIGNATURE_CAP ? trimmed.slice(0, SIGNATURE_CAP) : trimmed;
}

function makeSymbol(
  fileId: number,
  name: string,
  kind: string,
  startLine: number,
  signature: string,
): NewSymbolRow {
  return {
    file_id: fileId,
    name,
    kind,
    language: 'cpp',
    start_line: startLine,
    end_line: null,
    signature,
    parent_symbol: null,
    created_at: '',
  };
}

/**
 * Extract symbols from C/C++ source. Heuristic regex scan; never throws.
 */
export function extractCppSymbols(content: string, fileId: number): NewSymbolRow[] {
  try {
    const symbols: NewSymbolRow[] = [];
    const lines = content.split(/\r?\n/);

    // `#define MACRO` (object-like or function-like).
    const defineRe = /^\s*#\s*define\s+([A-Za-z_]\w*)/;
    // `class Name`, `struct Name`, `namespace Name` (allow trailing `final`, `:`).
    const classRe = /^\s*(?:template\s*<[^>]*>\s*)?class\s+([A-Za-z_]\w*)\b/;
    const structRe = /^\s*(?:template\s*<[^>]*>\s*)?struct\s+([A-Za-z_]\w*)\b/;
    const namespaceRe = /^\s*namespace\s+([A-Za-z_]\w*)/;
    // Rough function definition: `<returnType> name(...)` possibly ending in `{`
    // on the same line. We require a type token before the name to reduce noise,
    // capture the (possibly qualified) name's final identifier, and skip control
    // keywords. Best-effort; false positives acceptable per Phase 5 acceptance.
    const funcRe =
      /^\s*(?:[A-Za-z_][\w:<>,*&\s]*?\s[*&]?\s*)([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{?\s*$/;
    const controlKeywords = new Set([
      'if',
      'for',
      'while',
      'switch',
      'catch',
      'return',
      'sizeof',
      'do',
      'else',
    ]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) {
        continue;
      }
      const lineNo = i + 1;
      const sig = signatureOf(line);

      const defM = defineRe.exec(line);
      if (defM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, defM[1], 'macro', lineNo, sig));
        continue;
      }
      const classM = classRe.exec(line);
      if (classM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, classM[1], 'class', lineNo, sig));
        continue;
      }
      const structM = structRe.exec(line);
      if (structM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, structM[1], 'struct', lineNo, sig));
        continue;
      }
      const nsM = namespaceRe.exec(line);
      if (nsM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, nsM[1], 'namespace', lineNo, sig));
        continue;
      }
      const funcM = funcRe.exec(line);
      if (funcM?.[1] !== undefined) {
        // Take the trailing identifier if the name is qualified (A::B -> B).
        const parts = funcM[1].split('::');
        const name = parts[parts.length - 1];
        if (name !== undefined && name.length > 0 && !controlKeywords.has(name)) {
          symbols.push(makeSymbol(fileId, name, 'function', lineNo, sig));
          continue;
        }
      }
    }

    return symbols;
  } catch {
    return [];
  }
}
