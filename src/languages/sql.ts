// SQL symbol extractor. Heuristic, regex-only, line-by-line scanning.
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
    language: 'sql',
    start_line: startLine,
    end_line: null,
    signature,
    parent_symbol: null,
    created_at: '',
  };
}

/** Strip surrounding quoting/brackets and trailing parens from an object name. */
function cleanName(raw: string): string {
  let name = raw.trim();
  // Drop a trailing `(` left over from e.g. `CREATE TABLE foo(`.
  const parenIdx = name.indexOf('(');
  if (parenIdx >= 0) {
    name = name.slice(0, parenIdx).trim();
  }
  // Remove common identifier quoting: "x", `x`, [x].
  name = name.replace(/^["`[]/, '').replace(/["`\]]$/, '');
  return name;
}

/**
 * Extract symbols from SQL source. Heuristic regex scan; never throws.
 * Object name capture is permissive: optional schema prefix, optional IF NOT
 * EXISTS, and various quoting styles are tolerated.
 */
export function extractSqlSymbols(content: string, fileId: number): NewSymbolRow[] {
  try {
    const symbols: NewSymbolRow[] = [];
    const lines = content.split(/\r?\n/);

    // Capture the (possibly qualified/quoted) object name after the keyword.
    const namePart = '([A-Za-z_"`[][\\w."`\\][]*)';
    const ifNotExists = '(?:IF\\s+NOT\\s+EXISTS\\s+)?';
    const orReplace = '(?:OR\\s+REPLACE\\s+)?';
    const tempMod = '(?:TEMP(?:ORARY)?\\s+|GLOBAL\\s+|LOCAL\\s+)?';
    const uniqueMod = '(?:UNIQUE\\s+)?';

    const tableRe = new RegExp(
      `^\\s*CREATE\\s+${orReplace}${tempMod}TABLE\\s+${ifNotExists}${namePart}`,
      'i',
    );
    const viewRe = new RegExp(
      `^\\s*CREATE\\s+${orReplace}${tempMod}(?:MATERIALIZED\\s+)?VIEW\\s+${ifNotExists}${namePart}`,
      'i',
    );
    const indexRe = new RegExp(
      `^\\s*CREATE\\s+${orReplace}${uniqueMod}INDEX\\s+${ifNotExists}${namePart}`,
      'i',
    );
    const procRe = new RegExp(
      `^\\s*CREATE\\s+${orReplace}PROC(?:EDURE)?\\s+${ifNotExists}${namePart}`,
      'i',
    );
    const funcRe = new RegExp(
      `^\\s*CREATE\\s+${orReplace}FUNCTION\\s+${ifNotExists}${namePart}`,
      'i',
    );
    const triggerRe = new RegExp(
      `^\\s*CREATE\\s+${orReplace}TRIGGER\\s+${ifNotExists}${namePart}`,
      'i',
    );

    // Order matters: VIEW/INDEX/PROC/FUNCTION/TRIGGER before the generic checks.
    const rules: Array<{ re: RegExp; kind: string }> = [
      { re: tableRe, kind: 'table' },
      { re: viewRe, kind: 'view' },
      { re: indexRe, kind: 'index' },
      { re: procRe, kind: 'procedure' },
      { re: funcRe, kind: 'function' },
      { re: triggerRe, kind: 'trigger' },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) {
        continue;
      }
      const lineNo = i + 1;
      const sig = signatureOf(line);

      for (const { re, kind } of rules) {
        const m = re.exec(line);
        if (m?.[1] !== undefined) {
          const name = cleanName(m[1]);
          if (name.length > 0) {
            symbols.push(makeSymbol(fileId, name, kind, lineNo, sig));
          }
          break;
        }
      }
    }

    return symbols;
  } catch {
    return [];
  }
}
