// `kundun cleanup [--dry-run]` — apply the retention policy. A dry run reports
// what WOULD be removed and writes nothing (D7); a real run performs the
// deletions and records a cleanup_runs row.

import type { Command } from 'commander';
import pc from 'picocolors';

import { buildCleanupEngine, createAppContext } from '../../core/container.js';
import { getGlobalOptions, printJson, printLine, reportError, sectionHeader } from '../shared.js';

/** Options accepted by the cleanup command. */
interface CleanupOptions {
  dryRun?: boolean;
}

/** Register `kundun cleanup` on the program. */
export function registerCleanupCommand(program: Command): void {
  program
    .command('cleanup')
    .description('Apply the retention policy (use --dry-run to preview)')
    .option('--dry-run', 'report what would be removed without changing anything', false)
    .action((options: CleanupOptions, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        ctx = createAppContext({ projectRoot });
        runCleanup(ctx, options, json);
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** Execute cleanup and render the result. */
function runCleanup(
  ctx: ReturnType<typeof createAppContext>,
  options: CleanupOptions,
  json: boolean,
): void {
  const dryRun = options.dryRun ?? false;
  const engine = buildCleanupEngine(ctx);
  const result = engine.run({ dryRun });

  if (json) {
    printJson({
      ok: true,
      dryRun: result.dryRun,
      removedChunks: result.removedChunks,
      removedFiles: result.removedFiles,
      removedSymbols: result.removedSymbols,
      removedMemories: result.removedMemories,
      archivedTasks: result.archivedTasks,
      removedLogs: result.removedLogs,
      vacuumExecuted: result.vacuumExecuted,
      durationMs: result.durationMs,
      cleanupRunId: result.cleanupRunId ?? null,
    });
    return;
  }

  // "would remove" vs "removed" wording is explicit per the dry-run flag.
  const verb = result.dryRun ? 'Would remove' : 'Removed';
  const title = result.dryRun ? 'Cleanup (dry run)' : 'Cleanup complete';
  printLine(sectionHeader(title));
  printLine(`  ${verb} files:     ${result.removedFiles}`);
  printLine(`  ${verb} chunks:    ${result.removedChunks}`);
  printLine(`  ${verb} symbols:   ${result.removedSymbols}`);
  printLine(`  ${verb} memories:  ${result.removedMemories}`);
  printLine(`  Archived tasks:    ${result.archivedTasks}`);
  printLine(`  ${verb} log files: ${result.removedLogs}`);

  if (result.dryRun) {
    printLine();
    printLine(pc.yellow('Dry run: nothing was changed. Re-run without --dry-run to apply.'));
  } else {
    printLine(`  Vacuum executed:   ${result.vacuumExecuted ? pc.green('yes') : 'no'}`);
  }
}
