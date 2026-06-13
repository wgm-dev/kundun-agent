// `kundun symbol <name>` — look up extracted symbols by exact name (default) or
// by name prefix (--prefix), with optional language/kind filters. Prints
// `relativePath:line  kind  name  signature`.

import type { Command } from 'commander';
import pc from 'picocolors';

import { createAppContext } from '../../core/container.js';
import type {
  SymbolHit,
  SymbolLookupOptions,
} from '../../storage/repositories/symbol.repository.js';
import {
  dim,
  getGlobalOptions,
  parsePositiveInt,
  printJson,
  printLine,
  reportError,
} from '../shared.js';

/** Options accepted by the symbol command. */
interface SymbolCmdOptions {
  language?: string;
  kind?: string;
  limit?: string;
  prefix?: boolean;
}

/** Default number of results when --limit is omitted. */
const DEFAULT_LIMIT = 50;

/** Register `kundun symbol` on the program. */
export function registerSymbolCommand(program: Command): void {
  program
    .command('symbol')
    .description('Find symbols by name')
    .argument('<name>', 'symbol name (or prefix with --prefix)')
    .option('--language <language>', 'restrict to a language')
    .option('--kind <kind>', 'restrict to a symbol kind (e.g. function, class)')
    .option('--limit <n>', 'maximum number of results')
    .option('--prefix', 'match symbols whose name starts with <name>', false)
    .action((name: string, options: SymbolCmdOptions, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        const limit = parsePositiveInt(options.limit, '--limit') ?? DEFAULT_LIMIT;
        ctx = createAppContext({ projectRoot });
        runSymbol(ctx, name, options, limit, json);
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** Execute the symbol lookup and render results. */
function runSymbol(
  ctx: ReturnType<typeof createAppContext>,
  name: string,
  options: SymbolCmdOptions,
  limit: number,
  json: boolean,
): void {
  const lookupOpts: SymbolLookupOptions = { limit };
  if (options.language !== undefined) {
    lookupOpts.language = options.language;
  }
  if (options.kind !== undefined) {
    lookupOpts.kind = options.kind;
  }

  const usePrefix = options.prefix ?? false;
  const hits: SymbolHit[] = usePrefix
    ? ctx.repos.symbol.findByPrefix(name, lookupOpts)
    : ctx.repos.symbol.findByName(name, lookupOpts);

  if (json) {
    printJson({
      ok: true,
      name,
      prefix: usePrefix,
      count: hits.length,
      results: hits.map((h) => ({
        id: h.id,
        name: h.name,
        kind: h.kind,
        language: h.language,
        relativePath: h.relative_path,
        startLine: h.start_line,
        endLine: h.end_line,
        signature: h.signature,
        parentSymbol: h.parent_symbol,
      })),
    });
    return;
  }

  if (hits.length === 0) {
    const how = usePrefix ? 'prefix' : 'name';
    printLine(pc.yellow(`No symbols found by ${how} "${name}".`));
    return;
  }

  for (const h of hits) {
    const line = h.start_line ?? '?';
    const header = `${pc.cyan(h.relative_path)}:${pc.green(String(line))}`;
    const kind = pc.magenta(h.kind);
    printLine(`${header}  ${kind}  ${pc.bold(h.name)}`);
    if (h.signature !== null && h.signature.length > 0) {
      printLine(`  ${dim(h.signature)}`);
    }
  }
  printLine();
  printLine(dim(`${hits.length} symbol(s)`));
}
