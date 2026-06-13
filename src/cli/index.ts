// Kundun CLI entry point. Registers every command on a single commander program,
// exposes the global --project-root / --json options, and runs the parser with a
// top-level catch that routes failures to stderr with a non-zero exit code.

import process from 'node:process';

import { Command } from 'commander';

import { VERSION } from '../index.js';
import { registerInitCommand } from './commands/init.js';
import { registerScanCommand } from './commands/scan.js';
import { registerSearchCommand } from './commands/search.js';
import { registerSymbolCommand } from './commands/symbol.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerTaskCommand } from './commands/task.js';
import { registerCleanupCommand } from './commands/cleanup.js';
import { registerSummaryCommand } from './commands/summary.js';
import { registerDiagnosticsCommand } from './commands/diagnostics.js';
import { registerMcpCommand } from './commands/mcp.js';

const program = new Command();

program
  .name('kundun')
  .description('Local-first MCP memory and codebase intelligence agent')
  .version(VERSION)
  .option('--project-root <path>', 'project root directory (defaults to cwd)')
  .option('--json', 'emit machine-readable JSON to stdout', false);

// Register all commands (init counts as one; memory/task add subcommands).
registerInitCommand(program);
registerScanCommand(program);
registerSearchCommand(program);
registerSymbolCommand(program);
registerMemoryCommand(program);
registerTaskCommand(program);
registerCleanupCommand(program);
registerSummaryCommand(program);
registerDiagnosticsCommand(program);
registerMcpCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
