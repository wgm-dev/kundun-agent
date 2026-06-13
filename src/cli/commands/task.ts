// `kundun task` — create / next / update / list tasks via the task engine.
// Subcommands:
//   task create --title <s> [--description <s>] [--priority p] [--files a,b]
//   task next
//   task update <id> [--status s] [--priority p] [--title s] [--description s]
//   task list   [--status s] [--limit n]

import type { Command } from 'commander';
import pc from 'picocolors';

import { buildTaskEngine, createAppContext } from '../../core/container.js';
import type { CreateTaskInput, ListTasksOptions, UpdateTaskPatch } from '../../core/task-engine.js';
import type { TaskRow } from '../../storage/types.js';
import { parseStringArray } from '../../utils/json.js';
import {
  dim,
  getGlobalOptions,
  parseCommaList,
  parsePositiveInt,
  printJson,
  printLine,
  reportError,
} from '../shared.js';

/** Options for `task create`. */
interface TaskCreateOptions {
  title?: string;
  description?: string;
  priority?: string;
  files?: string;
}

/** Options for `task update`. */
interface TaskUpdateOptions {
  status?: string;
  priority?: string;
  title?: string;
  description?: string;
}

/** Options for `task list`. */
interface TaskListCmdOptions {
  status?: string;
  limit?: string;
}

/** Register `kundun task` and its subcommands on the program. */
export function registerTaskCommand(program: Command): void {
  const task = program.command('task').description('Manage project tasks');

  task
    .command('create')
    .description('Create a task')
    .requiredOption('--title <title>', 'task title')
    .option('--description <description>', 'task description')
    .option('--priority <priority>', 'low|medium|high|critical')
    .option('--files <a,b>', 'comma-separated related file paths')
    .action((options: TaskCreateOptions, command: Command) => {
      withTaskEngine(command, (engine, json) => runCreate(engine, options, json));
    });

  task
    .command('next')
    .description('Show the next actionable task')
    .action((_options: unknown, command: Command) => {
      withTaskEngine(command, (engine, json) => runNext(engine, json));
    });

  task
    .command('update')
    .description('Update a task')
    .argument('<id>', 'task id')
    .option('--status <status>', 'pending|in_progress|blocked|completed|archived')
    .option('--priority <priority>', 'low|medium|high|critical')
    .option('--title <title>', 'new title')
    .option('--description <description>', 'new description')
    .action((idArg: string, options: TaskUpdateOptions, command: Command) => {
      withTaskEngine(command, (engine, json) => runUpdate(engine, idArg, options, json));
    });

  task
    .command('list')
    .description('List tasks')
    .option('--status <status>', 'filter by status')
    .option('--limit <n>', 'maximum number of tasks')
    .action((options: TaskListCmdOptions, command: Command) => {
      withTaskEngine(command, (engine, json) => runList(engine, options, json));
    });
}

/** Open a context, build the task engine, run `fn`, and always close. */
function withTaskEngine(
  command: Command,
  fn: (engine: ReturnType<typeof buildTaskEngine>, json: boolean) => void,
): void {
  const { projectRoot, json } = getGlobalOptions(command);
  let ctx;
  try {
    ctx = createAppContext({ projectRoot });
    fn(buildTaskEngine(ctx), json);
  } catch (err) {
    reportError(err);
  } finally {
    ctx?.close();
  }
}

/** Handle `task create`. */
function runCreate(
  engine: ReturnType<typeof buildTaskEngine>,
  options: TaskCreateOptions,
  json: boolean,
): void {
  const input: CreateTaskInput = { title: options.title ?? '' };
  if (options.description !== undefined) {
    input.description = options.description;
  }
  if (options.priority !== undefined) {
    input.priority = options.priority;
  }
  const files = parseCommaList(options.files);
  if (files !== undefined) {
    input.relatedFiles = files;
  }

  const id = engine.create(input);

  if (json) {
    printJson({ ok: true, id });
    return;
  }
  printLine(pc.green(`Task #${id} created.`));
}

/** Handle `task next`. */
function runNext(engine: ReturnType<typeof buildTaskEngine>, json: boolean): void {
  const next = engine.next();

  if (json) {
    printJson({ ok: true, task: next === undefined ? null : taskToJson(next) });
    return;
  }

  if (next === undefined) {
    printLine(pc.yellow('No actionable task right now.'));
    return;
  }
  printTaskLine(next);
}

/** Handle `task update <id>`. */
function runUpdate(
  engine: ReturnType<typeof buildTaskEngine>,
  idArg: string,
  options: TaskUpdateOptions,
  json: boolean,
): void {
  const id = parsePositiveInt(idArg, 'task id');
  if (id === undefined) {
    throw new Error('A task id is required.');
  }

  const patch: UpdateTaskPatch = {};
  if (options.status !== undefined) {
    patch.status = options.status;
  }
  if (options.priority !== undefined) {
    patch.priority = options.priority;
  }
  if (options.title !== undefined) {
    patch.title = options.title;
  }
  if (options.description !== undefined) {
    patch.description = options.description;
  }

  engine.update(id, patch);

  if (json) {
    printJson({ ok: true, id });
    return;
  }
  printLine(pc.green(`Task #${id} updated.`));
}

/** Handle `task list`. */
function runList(
  engine: ReturnType<typeof buildTaskEngine>,
  options: TaskListCmdOptions,
  json: boolean,
): void {
  const listOpts: ListTasksOptions = {};
  if (options.status !== undefined) {
    listOpts.status = options.status;
  }
  const limit = parsePositiveInt(options.limit, '--limit');
  if (limit !== undefined) {
    listOpts.limit = limit;
  }

  const rows = engine.list(listOpts);

  if (json) {
    printJson({ ok: true, count: rows.length, tasks: rows.map(taskToJson) });
    return;
  }

  if (rows.length === 0) {
    printLine(pc.yellow('No tasks found.'));
    return;
  }
  for (const t of rows) {
    printTaskLine(t);
  }
  printLine();
  printLine(dim(`${rows.length} task(s)`));
}

/** Color a status token for human output. */
function colorStatus(status: string): string {
  switch (status) {
    case 'completed':
      return pc.green(status);
    case 'in_progress':
      return pc.cyan(status);
    case 'blocked':
      return pc.red(status);
    case 'archived':
      return pc.dim(status);
    default:
      return pc.yellow(status);
  }
}

/** Print a single task as a human-readable line. */
function printTaskLine(t: TaskRow): void {
  printLine(
    `${pc.cyan(`#${t.id}`)} ${colorStatus(t.status)} ${pc.magenta(t.priority)} ${pc.bold(t.title)}`,
  );
  if (t.description !== null && t.description.length > 0) {
    printLine(`  ${dim(t.description)}`);
  }
}

/** Project a task row into a stable JSON shape. */
function taskToJson(t: TaskRow): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    relatedFiles: parseStringArray(t.related_files),
    relatedMemories: parseStringArray(t.related_memories),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    completedAt: t.completed_at,
  };
}
