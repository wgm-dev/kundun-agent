// `kundun memory` — add / search / list project memories via the memory engine.
// Subcommands:
//   memory add    --type <t> --title <s> --content <s> [--tags a,b]
//                 [--importance <n>] [--source <s>]
//   memory search [query] [--type t] [--tags a,b] [--limit n]
//   memory list   [--limit n]

import type { Command } from 'commander';
import pc from 'picocolors';

import { buildMemoryEngine, createAppContext } from '../../core/container.js';
import type { MemoryAddInput } from '../../core/memory-engine.js';
import type { MemorySearchOptions } from '../../storage/repositories/memory.repository.js';
import type { MemoryRow } from '../../storage/types.js';
import { parseStringArray } from '../../utils/json.js';
import {
  dim,
  getGlobalOptions,
  parseCommaList,
  parseIntInRange,
  parsePositiveInt,
  printJson,
  printLine,
  reportError,
} from '../shared.js';

/** Options for `memory add`. */
interface MemoryAddOptions {
  type?: string;
  title?: string;
  content?: string;
  tags?: string;
  importance?: string;
  source?: string;
}

/** Options for `memory search`. */
interface MemorySearchCmdOptions {
  type?: string;
  tags?: string;
  limit?: string;
}

/** Options for `memory list`. */
interface MemoryListOptions {
  limit?: string;
}

/** Register `kundun memory` and its subcommands on the program. */
export function registerMemoryCommand(program: Command): void {
  const memory = program.command('memory').description('Manage project memories');

  memory
    .command('add')
    .description('Add a memory')
    .requiredOption('--type <type>', 'memory type (e.g. decision, bug, convention)')
    .requiredOption('--title <title>', 'short memory title')
    .requiredOption('--content <content>', 'memory content')
    .option('--tags <a,b>', 'comma-separated tags')
    .option('--importance <n>', 'importance score 0..100')
    .option('--source <source>', 'where this memory came from')
    .action((options: MemoryAddOptions, command: Command) => {
      withMemoryEngine(command, (engine, json) => runAdd(engine, options, json));
    });

  memory
    .command('search')
    .description('Search memories')
    .argument('[query]', 'optional text query')
    .option('--type <type>', 'filter by memory type')
    .option('--tags <a,b>', 'comma-separated tags to match')
    .option('--limit <n>', 'maximum number of results')
    .action((query: string | undefined, options: MemorySearchCmdOptions, command: Command) => {
      withMemoryEngine(command, (engine, json) => runSearch(engine, query, options, json));
    });

  memory
    .command('list')
    .description('List important memories')
    .option('--limit <n>', 'maximum number of memories')
    .action((options: MemoryListOptions, command: Command) => {
      withMemoryEngine(command, (engine, json) => runList(engine, options, json));
    });
}

/** Open a context, build the memory engine, run `fn`, and always close. */
function withMemoryEngine(
  command: Command,
  fn: (engine: ReturnType<typeof buildMemoryEngine>, json: boolean) => void,
): void {
  const { projectRoot, json } = getGlobalOptions(command);
  let ctx;
  try {
    ctx = createAppContext({ projectRoot });
    fn(buildMemoryEngine(ctx), json);
  } catch (err) {
    reportError(err);
  } finally {
    ctx?.close();
  }
}

/** Handle `memory add`. */
function runAdd(
  engine: ReturnType<typeof buildMemoryEngine>,
  options: MemoryAddOptions,
  json: boolean,
): void {
  // requiredOption guarantees presence at runtime; assert for the type system.
  const input: MemoryAddInput = {
    type: options.type ?? '',
    title: options.title ?? '',
    content: options.content ?? '',
  };
  const tags = parseCommaList(options.tags);
  if (tags !== undefined) {
    input.tags = tags;
  }
  if (options.source !== undefined) {
    input.source = options.source;
  }
  const importance = parseIntInRange(options.importance, '--importance', 0, 100);
  if (importance !== undefined) {
    input.importanceScore = importance;
  }

  const id = engine.add(input);

  if (json) {
    printJson({ ok: true, id });
    return;
  }
  printLine(pc.green(`Memory #${id} added.`));
}

/** Handle `memory search`. */
function runSearch(
  engine: ReturnType<typeof buildMemoryEngine>,
  query: string | undefined,
  options: MemorySearchCmdOptions,
  json: boolean,
): void {
  const searchOpts: MemorySearchOptions = {};
  if (query !== undefined && query.length > 0) {
    searchOpts.query = query;
  }
  if (options.type !== undefined) {
    searchOpts.type = options.type;
  }
  const tags = parseCommaList(options.tags);
  if (tags !== undefined) {
    searchOpts.tags = tags;
  }
  const limit = parsePositiveInt(options.limit, '--limit');
  if (limit !== undefined) {
    searchOpts.limit = limit;
  }

  const results = engine.search(searchOpts);
  renderMemories(results, json, 'No memories matched.');
}

/** Handle `memory list`. */
function runList(
  engine: ReturnType<typeof buildMemoryEngine>,
  options: MemoryListOptions,
  json: boolean,
): void {
  const limit = parsePositiveInt(options.limit, '--limit');
  const results = limit === undefined ? engine.listImportant() : engine.listImportant(limit);
  renderMemories(results, json, 'No memories yet.');
}

/** Shared rendering for a list of memory rows. */
function renderMemories(rows: MemoryRow[], json: boolean, emptyMsg: string): void {
  if (json) {
    printJson({
      ok: true,
      count: rows.length,
      memories: rows.map((m) => ({
        id: m.id,
        type: m.type,
        title: m.title,
        content: m.content,
        tags: parseStringArray(m.tags),
        source: m.source,
        importance: m.importance_score,
        confidence: m.confidence,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        lastUsedAt: m.last_used_at,
      })),
    });
    return;
  }

  if (rows.length === 0) {
    printLine(pc.yellow(emptyMsg));
    return;
  }

  for (const m of rows) {
    const tags = parseStringArray(m.tags);
    const tagStr = tags.length > 0 ? `  ${dim(`[${tags.join(', ')}]`)}` : '';
    printLine(
      `${pc.cyan(`#${m.id}`)} ${pc.magenta(m.type)} ${pc.bold(m.title)} ` +
        `${dim(`(importance ${m.importance_score})`)}${tagStr}`,
    );
    const content = m.content.trim();
    if (content.length > 0) {
      printLine(`  ${content}`);
    }
  }
  printLine();
  printLine(dim(`${rows.length} memory(ies)`));
}
