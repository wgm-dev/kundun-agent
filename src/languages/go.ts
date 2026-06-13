// Go symbol extractor. Heuristic, regex-only, line-by-line scanning.
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
    language: 'go',
    start_line: startLine,
    end_line: null,
    signature,
    parent_symbol: null,
    created_at: '',
  };
}

/**
 * Extract symbols from Go source. Heuristic regex scan; never throws.
 */
export function extractGoSymbols(content: string, fileId: number): NewSymbolRow[] {
  try {
    const symbols: NewSymbolRow[] = [];
    const lines = content.split(/\r?\n/);

    // Method: `func (recv T) Name(` — receiver present, capture method name.
    const methodRe = /^\s*func\s+\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/;
    // Plain function: `func Name(` — no receiver.
    const funcRe = /^\s*func\s+([A-Za-z_]\w*)\s*\(/;
    // `type Name struct` / `type Name interface` (with optional generics `[T any]`).
    const typeStructRe = /^\s*type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+struct\b/;
    const typeIfaceRe = /^\s*type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+interface\b/;
    // Other type declarations (alias / named type): `type Name ...`.
    const typeOtherRe = /^\s*type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+\S/;
    // Package-level single var/const: `var Name ...` / `const Name ...`.
    const varRe = /^\s*var\s+([A-Za-z_]\w*)\b/;
    const constRe = /^\s*const\s+([A-Za-z_]\w*)\b/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) {
        continue;
      }
      const lineNo = i + 1;
      const sig = signatureOf(line);

      const methodM = methodRe.exec(line);
      if (methodM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, methodM[1], 'method', lineNo, sig));
        continue;
      }
      const funcM = funcRe.exec(line);
      if (funcM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, funcM[1], 'func', lineNo, sig));
        continue;
      }
      const structM = typeStructRe.exec(line);
      if (structM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, structM[1], 'struct', lineNo, sig));
        continue;
      }
      const ifaceM = typeIfaceRe.exec(line);
      if (ifaceM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, ifaceM[1], 'interface', lineNo, sig));
        continue;
      }
      const typeM = typeOtherRe.exec(line);
      if (typeM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, typeM[1], 'type', lineNo, sig));
        continue;
      }
      const varM = varRe.exec(line);
      if (varM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, varM[1], 'var', lineNo, sig));
        continue;
      }
      const constM = constRe.exec(line);
      if (constM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, constM[1], 'const', lineNo, sig));
        continue;
      }
    }

    return symbols;
  } catch {
    return [];
  }
}
