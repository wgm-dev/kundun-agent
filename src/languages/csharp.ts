// C# symbol extractor. Heuristic, regex-only, line-by-line scanning.
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
    language: 'csharp',
    start_line: startLine,
    end_line: null,
    signature,
    parent_symbol: null,
    created_at: '',
  };
}

/** Common leading modifiers for C# type/member declarations. */
const MODS =
  '(?:public\\s+|private\\s+|protected\\s+|internal\\s+|static\\s+|sealed\\s+|abstract\\s+|partial\\s+|virtual\\s+|override\\s+|async\\s+|readonly\\s+|new\\s+|extern\\s+|unsafe\\s+)*';

/**
 * Extract symbols from C# source. Heuristic regex scan; never throws.
 */
export function extractCsharpSymbols(content: string, fileId: number): NewSymbolRow[] {
  try {
    const symbols: NewSymbolRow[] = [];
    const lines = content.split(/\r?\n/);

    // `namespace Foo.Bar` (file-scoped or block).
    const namespaceRe = /^\s*namespace\s+([A-Za-z_][\w.]*)/;
    const classRe = new RegExp(`^\\s*${MODS}class\\s+([A-Za-z_]\\w*)`);
    const interfaceRe = new RegExp(`^\\s*${MODS}interface\\s+([A-Za-z_]\\w*)`);
    const structRe = new RegExp(`^\\s*${MODS}struct\\s+([A-Za-z_]\\w*)`);
    const enumRe = new RegExp(`^\\s*${MODS}enum\\s+([A-Za-z_]\\w*)`);
    // record / record class / record struct.
    const recordRe = new RegExp(`^\\s*${MODS}record\\s+(?:class\\s+|struct\\s+)?([A-Za-z_]\\w*)`);
    // Rough method: modifiers + returnType + Name(...) — return type token then
    // the method name and an opening paren. Generic return types tolerated.
    const methodRe = new RegExp(
      `^\\s*${MODS}[A-Za-z_][\\w.<>,\\[\\]?]*\\s+([A-Za-z_]\\w*)\\s*(?:<[^>]*>)?\\s*\\(`,
    );
    const methodKeywords = new Set([
      'if',
      'for',
      'while',
      'switch',
      'catch',
      'return',
      'foreach',
      'using',
      'lock',
      'fixed',
      'do',
    ]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) {
        continue;
      }
      const lineNo = i + 1;
      const sig = signatureOf(line);

      const nsM = namespaceRe.exec(line);
      if (nsM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, nsM[1], 'namespace', lineNo, sig));
        continue;
      }
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
      const recordM = recordRe.exec(line);
      if (recordM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, recordM[1], 'record', lineNo, sig));
        continue;
      }
      const structM = structRe.exec(line);
      if (structM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, structM[1], 'struct', lineNo, sig));
        continue;
      }
      const enumM = enumRe.exec(line);
      if (enumM?.[1] !== undefined) {
        symbols.push(makeSymbol(fileId, enumM[1], 'enum', lineNo, sig));
        continue;
      }
      const methodM = methodRe.exec(line);
      if (methodM?.[1] !== undefined && !methodKeywords.has(methodM[1])) {
        symbols.push(makeSymbol(fileId, methodM[1], 'method', lineNo, sig));
        continue;
      }
    }

    return symbols;
  } catch {
    return [];
  }
}
