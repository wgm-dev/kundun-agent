// `kundun diagnostics [--path <p>] [--language <l>]` — run the heuristic
// diagnostics engine over the tracked files (or one path/language), persist the
// findings, then print a summary (filesAnalyzed, findings, bySeverity) plus a
// short sample of the top findings. Diagnostics are heuristic SUGGESTIONS only.

import type { Command } from 'commander';
import pc from 'picocolors';

import { createAppContext } from '../../core/container.js';
import { createDiagnosticsEngine } from '../../core/diagnostics-engine.js';
import type { RunDiagnosticsOptions } from '../../core/diagnostics-engine.js';
import { DiagnosticRepository } from '../../storage/repositories/diagnostic.repository.js';
import type { DiagnosticRow } from '../../storage/types.js';
import {
  dim,
  getGlobalOptions,
  printJson,
  printLine,
  reportError,
  sectionHeader,
} from '../shared.js';

/** Options accepted by the diagnostics command. */
interface DiagnosticsOptions {
  path?: string;
  language?: string;
}

/** How many findings to list after the summary. */
const SAMPLE_LIMIT = 20;

/** Register `kundun diagnostics` on the program. */
export function registerDiagnosticsCommand(program: Command): void {
  program
    .command('diagnostics')
    .description('Run heuristic diagnostics')
    .option('--path <p>', 'limit diagnostics to a single file path')
    .option('--language <l>', 'limit diagnostics to one language')
    .action((options: DiagnosticsOptions, command: Command) => {
      const { projectRoot, json } = getGlobalOptions(command);
      let ctx;
      try {
        ctx = createAppContext({ projectRoot });
        runDiagnostics(ctx, options, json);
      } catch (err) {
        reportError(err);
      } finally {
        ctx?.close();
      }
    });
}

/** Execute diagnostics and render the result. */
function runDiagnostics(
  ctx: ReturnType<typeof createAppContext>,
  options: DiagnosticsOptions,
  json: boolean,
): void {
  // Build run options without writing undefined into optional keys.
  const runOpts: RunDiagnosticsOptions = {};
  if (options.path !== undefined) {
    runOpts.path = options.path;
  }
  if (options.language !== undefined) {
    runOpts.language = options.language;
  }

  const engine = createDiagnosticsEngine({ ctx });
  const result = engine.run(runOpts);

  const findings = new DiagnosticRepository(ctx.kdb).list({ limit: SAMPLE_LIMIT });

  if (json) {
    printJson({
      ok: true,
      filesAnalyzed: result.filesAnalyzed,
      findings: result.findings,
      bySeverity: result.bySeverity,
      note: result.note ?? null,
      sample: findings.map((d) => ({
        id: d.id,
        severity: d.severity,
        code: d.code,
        message: d.message,
        language: d.language,
        line: d.line,
        column: d.column,
      })),
    });
    return;
  }

  printLine(sectionHeader('Diagnostics'));
  printLine(`  files analyzed: ${result.filesAnalyzed}`);
  printLine(`  findings:       ${result.findings}`);
  printLine(
    `  by severity:    ` +
      `critical ${result.bySeverity.critical ?? 0}  ` +
      `error ${result.bySeverity.error ?? 0}  ` +
      `warning ${result.bySeverity.warning ?? 0}  ` +
      `info ${result.bySeverity.info ?? 0}`,
  );

  if (result.note !== undefined) {
    printLine();
    printLine(pc.yellow(result.note));
    return;
  }

  printLine();
  printLine(sectionHeader('Findings'));
  if (findings.length === 0) {
    printLine(`  ${dim('(none)')}`);
    return;
  }
  for (const d of findings) {
    printLine(`  ${severityLabel(d.severity)} ${formatFinding(d)}`);
  }
}

/** Render one finding as a single readable line. */
function formatFinding(d: DiagnosticRow): string {
  const code = d.code !== null ? pc.cyan(`[${d.code}]`) : '';
  const location = d.line !== null ? dim(`:${d.line}`) : '';
  return `${code}${location ? ` ${location}` : ''} ${d.message}`.trim();
}

/** Colorize a severity tag for terminal output. */
function severityLabel(severity: string): string {
  switch (severity) {
    case 'critical':
      return pc.bgRed(pc.white(' critical '));
    case 'error':
      return pc.red('error');
    case 'warning':
      return pc.yellow('warning');
    default:
      return dim(severity);
  }
}
