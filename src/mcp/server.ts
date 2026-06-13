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
import { createSessionRegistry } from '../core/session-registry.js';
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

  // PROCESS-SINGLETON: construct exactly one EventBus and one SessionRegistry for
  // this MCP process (see container.ts ProcessRuntime contract). Both are stateful
  // — the bus holds the history ring, the registry holds the tool-latency ring —
  // so they MUST be shared by the tool layer for the duration of the process.
  const eventBus = createEventBus();
  const sessionRegistry = createSessionRegistry({ sessionRepo: ctx.repos.session, eventBus });

  const server = new McpServer({ name: 'kundun-agent', version: VERSION });

  // One session id per MCP process, generated up front by the registry and reused
  // for every tool call and for shutdown. We register the base row now (the
  // registry mints the id); the client's name/version are not known until the
  // `initialized` notification arrives, so we enrich the same row there.
  const { sessionId } = sessionRegistry.register({
    transport: 'stdio',
    projectRoot: ctx.projectRoot,
    processId: process.pid,
  });

  // When the client finishes initializing, enrich the existing session row with the
  // now-known client name/version. We upsert directly through the repository (whose
  // register() is keyed on session_id via ON CONFLICT) so the SAME row is updated
  // rather than minting a fresh id — the registry's own register() would generate a
  // new UUID and create a second row.
  server.server.oninitialized = (): void => {
    const info = server.server.getClientVersion?.();
    const input: {
      sessionId: string;
      transport: string;
      projectRoot: string;
      processId: number;
      clientName?: string;
      clientVersion?: string;
    } = {
      sessionId,
      transport: 'stdio',
      projectRoot: ctx.projectRoot,
      processId: process.pid,
    };
    if (info?.name !== undefined) {
      input.clientName = info.name;
    }
    if (info?.version !== undefined) {
      input.clientVersion = info.version;
    }
    ctx.repos.session.register(input);
  };

  // Lazy accessor: tools/resources always read the single shared context.
  const getCtx = (): AppContext => ctx;

  registerTools(server, getCtx, { eventBus, sessionRegistry, sessionId });
  registerResources(server, getCtx);

  // Guard so SIGINT/SIGTERM and the transport-close hook never double-close.
  let closed = false;
  const shutdown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      // Mark this session closed before tearing down the shared context so the row
      // reflects a clean shutdown. Never let an end() failure block shutdown.
      sessionRegistry.end(sessionId, 'closed');
    } catch {
      // Ending the session must never block a clean shutdown.
    }
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
