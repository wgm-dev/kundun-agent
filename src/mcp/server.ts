// MCP server entry for Kundun-Agent (README §18/§19). Wires the tool and
// resource registrations onto an McpServer and serves them over stdio so the
// tool can be added to Claude Code via `kundun mcp`.
//
// CRITICAL: MCP stdio uses stdout for the JSON-RPC protocol. Nothing in the tool
// path may write to stdout — our logger writes to stderr (good) and we never
// console.log here. Writing to stdout would corrupt the protocol stream.
//
// The AppContext is created ONCE and shared (better-sqlite3 is synchronous, so a
// single handle serves every tool/resource call). Both registrations receive a
// `getCtx` accessor returning that single context.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createAppContext } from '../core/container.js';
import type { AppContext } from '../core/container.js';
import { createEventBus } from '../core/event-bus.js';
import { VERSION } from '../index.js';

import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

/** Options for {@link startMcpServer}. */
export interface StartMcpServerOptions {
  projectRoot: string;
}

/**
 * Start the Kundun-Agent MCP server over stdio.
 *
 * Creates the shared AppContext once (rethrowing `not_initialized` so the CLI can
 * print the init hint), wires tools and resources, then connects a stdio
 * transport. The returned promise resolves once `connect` completes; the process
 * is kept alive by the transport. SIGINT/SIGTERM and transport close trigger a
 * clean `ctx.close()` followed by `process.exit(0)`.
 */
export async function startMcpServer(opts: StartMcpServerOptions): Promise<void> {
  // Create the shared context once. If the project is not initialized this throws
  // KundunError('not_initialized'); we let it propagate so the CLI prints the hint.
  const ctx: AppContext = createAppContext({ projectRoot: opts.projectRoot });

  const eventBus = createEventBus();

  const server = new McpServer({ name: 'kundun-agent', version: VERSION });

  // Lazy accessor: tools/resources always read the single shared context.
  const getCtx = (): AppContext => ctx;

  registerTools(server, getCtx, { eventBus });
  registerResources(server, getCtx);

  // Guard so SIGINT/SIGTERM and the transport-close hook never double-close.
  let closed = false;
  const shutdown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      ctx.close();
    } catch {
      // Closing the database must never block a clean shutdown.
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  // When the client disconnects (stdin EOF), tear down the shared context.
  transport.onclose = shutdown;

  try {
    await server.connect(transport);
  } catch (err) {
    // Never leak the open context if connecting fails; rethrow for the CLI.
    ctx.close();
    throw err;
  }
}
