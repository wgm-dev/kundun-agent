// `kundun mcp` — start the MCP server over stdio so the tool can be added to
// Claude Code. The stdio JSON-RPC protocol OWNS stdout, so this command must
// never write to stdout: every diagnostic (errors, the init hint) goes to
// stderr, and a failure sets a non-zero exit code.

import process from 'node:process';

import type { Command } from 'commander';
import pc from 'picocolors';

import { startMcpServer } from '../../mcp/server.js';
import { isKundunError } from '../../utils/errors.js';

/** Register `kundun mcp` on the program. */
export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Start the MCP server over stdio')
    .action(async (_options: unknown, command: Command) => {
      // Read globals directly; stdout must stay clean for the protocol, so we do
      // not use the shared printers here.
      const opts = command.optsWithGlobals<{ projectRoot?: string }>();
      const projectRoot = opts.projectRoot ?? process.cwd();
      try {
        await startMcpServer({ projectRoot });
      } catch (err) {
        reportMcpError(err);
      }
    });
}

/**
 * Report an MCP startup failure to STDERR (never stdout) and fail the process.
 * Gives the `kundun init` hint for the not_initialized case.
 */
function reportMcpError(err: unknown): void {
  if (isKundunError(err) && err.code === 'not_initialized') {
    process.stderr.write(`${pc.red(err.message)}\n`);
    process.stderr.write(`${pc.yellow('Hint:')} run \`kundun init\` to set up this project.\n`);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${pc.red('Error:')} ${message}\n`);
  }
  process.exitCode = 1;
}
