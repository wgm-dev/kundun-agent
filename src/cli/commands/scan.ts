// `kundun scan` — walk the project tree, reconcile the files table, then index
// new and changed files (chunks + symbols). Updates the scan_runs row with the
// real indexed count and stamps project_meta.last_scan_at.

import type { Command } from 'commander';
import pc from 'picocolors';

import { buildIndexer, buildScanner, createAppContext } from '../../core/container.js';
import { nowIso } from '../../utils/time.js';
import { getGlobalOptions, printJson, printLine, reportError, sectionHeader } from '../shared.js';

/** Options accepted by the scan command. */
interface ScanOptions {
  force?: boolean;
}

/** Register `kundun scan` on the program. */
export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Scan the project and index new/changed files')
    .option('--force', 'reindex all tracked files even if unchanged', false)
    .action((options: ScanOptions, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        ctx = createAppContext({ projectRoot });
      } catch (err) {
        reportError(err);
        return;
      }
      try {
        runScan(ctx, options, json);
      } catch (err) {
        reportError(err);
      } finally {
        ctx.close();
      }
    });
}

/** Core scan + index logic. */
function runScan(
  ctx: ReturnType<typeof createAppContext>,
  options: ScanOptions,
  json: boolean,
): void {
  const force = options.force ?? false;
  const startedAtIso = nowIso();

  const scanner = buildScanner(ctx);
  const scanResult = scanner.scan({ force });

  // Index new + changed files. (Sensitive/binary files are re-guarded inside.)
  const toIndex = [...scanResult.newFiles, ...scanResult.changedFiles];
  const indexer = buildIndexer(ctx);
  const indexResult = indexer.indexFiles(toIndex);

  // Refresh the scan_runs row with the real indexed count now that indexing ran.
  ctx.repos.run.finishScan(scanResult.scanId, {
    filesScanned: scanResult.filesScanned,
    filesIndexed: indexResult.indexed,
    filesSkipped: scanResult.skippedFiles.length,
    errorsCount: scanResult.errors.length + indexResult.errors,
    status: 'completed',
    startedAtIso,
  });

  ctx.repos.meta.touchScanned(nowIso());

  if (json) {
    printJson({
      ok: true,
      scanId: scanResult.scanId,
      force,
      filesScanned: scanResult.filesScanned,
      new: scanResult.newFiles.length,
      changed: scanResult.changedFiles.length,
      removed: scanResult.removedFiles.length,
      skipped: scanResult.skippedFiles.length,
      indexed: indexResult.indexed,
      indexSkipped: indexResult.skipped,
      errors: scanResult.errors.length + indexResult.errors,
    });
    return;
  }

  printLine(sectionHeader('Scan complete'));
  printLine(`  scanned:   ${scanResult.filesScanned}`);
  printLine(`  new:       ${scanResult.newFiles.length}`);
  printLine(`  changed:   ${scanResult.changedFiles.length}`);
  printLine(`  removed:   ${scanResult.removedFiles.length}`);
  printLine(`  skipped:   ${scanResult.skippedFiles.length}`);
  printLine(`  indexed:   ${pc.green(String(indexResult.indexed))}`);

  const totalErrors = scanResult.errors.length + indexResult.errors;
  if (totalErrors > 0) {
    printLine(`  errors:    ${pc.red(String(totalErrors))}`);
    for (const e of scanResult.errors.slice(0, 5)) {
      printLine(`    - ${e.path}: ${e.error}`);
    }
  }
}
