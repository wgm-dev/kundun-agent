// `kundun summary` — print a minimal read-only project overview (D8):
// languages, important files/memories, task status, last scan/cleanup, counts,
// the active search mode, and static suggested commands.

import type { Command } from 'commander';
import pc from 'picocolors';

import { createAppContext } from '../../core/container.js';
import { buildProjectSummary } from '../../core/project-summary.js';
import type { ProjectSummary } from '../../core/project-summary.js';
import {
  dim,
  getGlobalOptions,
  printJson,
  printLine,
  reportError,
  sectionHeader,
} from '../shared.js';

/** Register `kundun summary` on the program. */
export function registerSummaryCommand(program: Command): void {
  program
    .command('summary')
    .description('Show a read-only project overview')
    .action((_options: unknown, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        ctx = createAppContext({ projectRoot });
        const summary = buildProjectSummary(ctx);
        if (json) {
          printJson({ ok: true, summary });
        } else {
          renderSummary(summary);
        }
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** Render the summary as readable sections. */
function renderSummary(s: ProjectSummary): void {
  printLine(`${pc.bold(s.projectName)}  ${dim(s.projectRoot)}`);
  printLine();

  printLine(sectionHeader('Languages'));
  if (s.languages.length === 0) {
    printLine(`  ${dim('(none indexed yet)')}`);
  } else {
    for (const l of s.languages) {
      printLine(`  ${l.language.padEnd(12)} ${l.files}`);
    }
  }
  printLine();

  printLine(sectionHeader('Important files'));
  if (s.importantFiles.length === 0) {
    printLine(`  ${dim('(none)')}`);
  } else {
    for (const f of s.importantFiles) {
      printLine(`  ${dim(`[${f.importance}]`)} ${f.relativePath}`);
    }
  }
  printLine();

  printLine(sectionHeader('Important memories'));
  if (s.importantMemories.length === 0) {
    printLine(`  ${dim('(none)')}`);
  } else {
    for (const m of s.importantMemories) {
      printLine(
        `  ${pc.cyan(`#${m.id}`)} ${pc.magenta(m.type)} ${m.title} ${dim(`[${m.importance}]`)}`,
      );
    }
  }
  printLine();

  printLine(sectionHeader('Tasks'));
  printLine(`  open: ${s.openTasks}`);
  if (s.nextTask === null) {
    printLine(`  next: ${dim('(none)')}`);
  } else {
    printLine(
      `  next: ${pc.cyan(`#${s.nextTask.id}`)} ${pc.magenta(s.nextTask.priority)} ${s.nextTask.title}`,
    );
  }
  printLine();

  printLine(sectionHeader('Activity'));
  printLine(`  last scan:    ${formatRun(s.lastScan.at, s.lastScan.status)}`);
  printLine(`  last cleanup: ${formatRun(s.lastCleanup.at, s.lastCleanup.status)}`);
  printLine();

  printLine(sectionHeader('Counts'));
  printLine(
    `  files ${s.counts.files}  chunks ${s.counts.chunks}  symbols ${s.counts.symbols}  ` +
      `memories ${s.counts.memories}  tasks ${s.counts.tasks}`,
  );
  printLine(`  search mode: ${s.searchMode}`);
  printLine();

  printLine(sectionHeader('Suggested commands'));
  for (const cmd of s.suggestedCommands) {
    printLine(`  ${pc.cyan(cmd)}`);
  }
}

/** Format a last-run line, handling the never-run case. */
function formatRun(at: string | null, status: string | null): string {
  if (at === null) {
    return dim('(never)');
  }
  return `${at}${status !== null ? ` ${dim(`(${status})`)}` : ''}`;
}
