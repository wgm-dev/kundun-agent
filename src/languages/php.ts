// PHP symbol extractor. Heuristic, regex-only, line-by-line scanning.
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
    language: 'php',
    start_line: startLine,
    end_line: null,
    signature,
    parent_symbol: null,
    created_at: '',
  };
}

/**
 * Extract symbols from PHP source. Heuristic regex scan; never throws.
 */
export function extractPhpSymbols(content: string, fileId: number): NewSymbolRow[] {
  try {
    const symbols: NewSymbolRow[] = [];
    const lines = content.split(/\r?\n/);

    const classRe = /^\s*(?:abstract\s+|final\s+)*class\s+([A-Za-z_\x80-\xff][\w\x80-\xff]*)/;
    const interfaceRe = /^\s*interface\s+([A-Za-z_\x80-\xff][\w\x80-\xff]*)/;
    const traitRe = /^\s*trait\s+([A-Za-z_\x80-\xff][\w\x80-\xff]*)/;
    const enumRe = /^\s*enum\s+([A-Za-z_\x80-\xff][\w\x80-\xff]*)/;
    // Methods: visibility/static/abstract/final modifiers then `function name`.
    const methodRe =
      /^\s*(?:abstract\s+|final\s+|public\s+|private\s+|protected\s+|static\s+)+function\s+&?\s*([A-Za-z_\x80-\xff][\w\x80-\xff]*)\s*\(/;
    // Plain (free) function: `function name(` with no leading visibility modifier.
    const functionRe = /^\s*function\s+&?\s*([A-Za-z_\x80-\xff][\w\x80-\xff]*)\s*\(/;
    // const NAME = ...  (class const or define-style const keyword)
    const constRe =
      /^\s*(?:public\s+|private\s+|protected\s+)?const\s+([A-Za-z_\x80-\xff][\w\x80-\xff]*)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) {
        continue;
      }
      const lineNo = i + 1;
      const sig = signatureOf(line);

      const classM = classRe.exec(line);
      if (classM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, classM[1], 'class', lineNo, sig));
        continue;
      }
      const ifaceM = interfaceRe.exec(line);
      if (ifaceM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, ifaceM[1], 'interface', lineNo, sig));
        continue;
      }
      const traitM = traitRe.exec(line);
      if (traitM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, traitM[1], 'trait', lineNo, sig));
        continue;
      }
      const enumM = enumRe.exec(line);
      if (enumM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, enumM[1], 'enum', lineNo, sig));
        continue;
      }
      const methodM = methodRe.exec(line);
      if (methodM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, methodM[1], 'method', lineNo, sig));
        continue;
      }
      const fnM = functionRe.exec(line);
      if (fnM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, fnM[1], 'function', lineNo, sig));
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
