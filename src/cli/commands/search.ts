// `kundun search <query>` — full-text (or LIKE-fallback) search over indexed
// code chunks. Prints `relativePath:startLine` headers with a snippet, plus a
// footer showing the active search backend.

import type { Command } from 'commander';
import pc from 'picocolors';

import { buildSearchProvider, createAppContext } from '../../core/container.js';
import type { SearchCodeOptions } from '../../core/search-provider.js';
import {
  dim,
  getGlobalOptions,
  parsePositiveInt,
  printJson,
  printLine,
  reportError,
} from '../shared.js';

/** Options accepted by the search command. */
interface SearchCmdOptions {
  language?: string;
  limit?: string;
}

/** Default number of results when --limit is omitted. */
const DEFAULT_LIMIT = 20;

/** Register `kundun search` on the program. */
export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Search indexed code chunks')
    .argument('<query>', 'text to search for')
    .option('--language <language>', 'restrict results to a language')
    .option('--limit <n>', 'maximum number of results')
    .action((query: string, options: SearchCmdOptions, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        const limit = parsePositiveInt(options.limit, '--limit') ?? DEFAULT_LIMIT;
        ctx = createAppContext({ projectRoot });
        runSearch(ctx, query, options, limit, json);
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** Execute the search and render results. */
function runSearch(
  ctx: ReturnType<typeof createAppContext>,
  query: string,
  options: SearchCmdOptions,
  limit: number,
  json: boolean,
): void {
  const provider = buildSearchProvider(ctx);

  const searchOpts: SearchCodeOptions = { limit };
  if (options.language !== undefined) {
    searchOpts.language = options.language;
  }

  const results = provider.searchCode(query, searchOpts);

  if (json) {
    printJson({
      ok: true,
      query,
      mode: provider.mode,
      count: results.length,
      results: results.map((r) => ({
        relativePath: r.relativePath,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        snippet: r.snippet,
      })),
    });
    return;
  }

  if (results.length === 0) {
    printLine(pc.yellow(`No results for "${query}".`));
    printLine(dim(`search mode: ${provider.mode}`));
    return;
  }

  for (const r of results) {
    printLine(`${pc.cyan(r.relativePath)}:${pc.green(String(r.startLine))}`);
    const snippet = r.snippet.trim();
    if (snippet.length > 0) {
      printLine(`  ${snippet}`);
    }
  }
  printLine();
  printLine(dim(`${results.length} result(s) — search mode: ${provider.mode}`));
}
