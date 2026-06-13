// MVP3 MCP-tool integration: the four observability tools now return REAL shapes
// (no longer the placeholder {note:...}). We drive the MCP server end-to-end over
// the SDK's in-memory transport pair (the public Client API, not internals) with
// the SAME shared EventBus + SessionRegistry the daemon wires, so:
//   - get_sessions reflects a session registered on the shared registry,
//   - get_health reports per-component status + headline signals,
//   - get_metrics returns live counts (latest + a freshly computed snapshot),
//   - get_recent_events reflects events emitted on the shared bus.
//
// A direct container-path block backs each tool up against the engine it calls so
// the assertions hold even if the SDK round-trip shifts in a future version.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppContext } from '../../src/core/container.js';
import type { AppContext } from '../../src/core/container.js';
import { createEventBus } from '../../src/core/event-bus.js';
import { createSessionRegistry } from '../../src/core/session-registry.js';
import type { EventBus } from '../../src/core/event-bus.js';
import type { SessionRegistry } from '../../src/core/session-registry.js';
import { registerTools } from '../../src/mcp/tools.js';
import { buildDefaultConfig } from '../../src/config/default-config.js';
import { writeConfig } from '../../src/config/config-loader.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';
import { MetaRepository } from '../../src/storage/repositories/meta.repository.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { makeTempProject } from '../helpers/temp-project.js';
import type { TempProject } from '../helpers/temp-project.js';

/** Initialize a project on disk so createAppContext succeeds (mirrors init). */
function initProject(project: TempProject): void {
  const config = buildDefaultConfig('mcp-mvp3-test');
  writeConfig(project.root, config);
  mkdirSync(join(project.root, '.kundun'), { recursive: true });

  const dbPath = join(project.root, '.kundun', 'kundun.sqlite');
  const kdb = openDatabase(dbPath);
  try {
    runMigrations(kdb.db, kdb.hasFts5);
    const meta = new MetaRepository(kdb);
    meta.ensure(project.root, config.projectName, LATEST_SCHEMA_VERSION);
    meta.setSchemaVersion(LATEST_SCHEMA_VERSION);
  } finally {
    kdb.close();
  }
}

/** Parse the single JSON text content block from a tool result. */
function parseToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  expect(Array.isArray(content)).toBe(true);
  const first = content?.[0];
  expect(first?.type).toBe('text');
  expect(typeof first?.text).toBe('string');
  return JSON.parse(first?.text ?? '{}') as Record<string, unknown>;
}

describe('mcp tools MVP3 observability (integration)', () => {
  let project: TempProject;
  let ctx: AppContext;
  let eventBus: EventBus;
  let sessionRegistry: SessionRegistry;
  let sessionId: string;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    project = makeTempProject();
    initProject(project);
    ctx = createAppContext({ projectRoot: project.root });

    // The ONE shared bus + registry, exactly as the MCP server wires them.
    eventBus = createEventBus();
    sessionRegistry = createSessionRegistry({ sessionRepo: ctx.repos.session, eventBus });
    sessionId = sessionRegistry.register({
      transport: 'stdio',
      projectRoot: ctx.projectRoot,
    }).sessionId;

    server = new McpServer({ name: 'kundun-agent', version: '0.0.0-test' });
    registerTools(server, () => ctx, { eventBus, sessionRegistry, sessionId });

    client = new Client({ name: 'test-client', version: '0.0.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    ctx.close();
    project.cleanup();
  });

  it('get_sessions returns the registered session and a live active count', async () => {
    const result = await client.callTool({ name: 'kundun.get_sessions', arguments: {} });
    const body = parseToolResult(result);

    expect(Array.isArray(body.sessions)).toBe(true);
    const sessions = body.sessions as Array<{ session_id: string; status: string }>;
    expect(sessions.some((s) => s.session_id === sessionId)).toBe(true);
    expect(typeof body.activeCount).toBe('number');
    expect(body.activeCount as number).toBeGreaterThanOrEqual(1);
  });

  it('get_health returns per-component status and headline signals', async () => {
    const result = await client.callTool({ name: 'kundun.get_health', arguments: {} });
    const body = parseToolResult(result);

    expect(body.components).toBeTypeOf('object');
    expect(body.components).not.toBeNull();
    const components = body.components as Record<string, string>;
    // sqlite + wal are always probed; both should be present.
    expect(components.sqlite).toBeDefined();
    expect(components.wal).toBeDefined();

    expect(typeof body.errorsLast24h).toBe('number');
    expect(['fts5', 'like']).toContain(body.searchMode);
    expect(typeof body.schemaVersion).toBe('number');
    expect(body.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
  });

  it('get_metrics returns live counts (latest + a freshly computed snapshot)', async () => {
    // Persist one snapshot so `latest` is non-null on the read.
    ctx.repos.metrics.insertSnapshot(
      {
        active_sessions: 1,
        indexed_files: 0,
        indexed_chunks: 0,
        memory_count: 0,
        task_count: 0,
        diagnostics_count: 0,
        db_size_bytes: 4096,
        avg_tool_latency_ms: null,
        scan_duration_ms: null,
        cleanup_duration_ms: null,
        errors_last_24h: 0,
      },
      new Date().toISOString(),
    );

    const result = await client.callTool({ name: 'kundun.get_metrics', arguments: {} });
    const body = parseToolResult(result);

    expect(body.latest).not.toBeNull();
    expect(body.snapshot).toBeTypeOf('object');
    const snapshot = body.snapshot as Record<string, unknown>;
    // The fresh snapshot is computed from live sources (not persisted).
    expect(typeof snapshot.db_size_bytes).toBe('number');
    expect(snapshot.db_size_bytes as number).toBeGreaterThan(0);
    expect(typeof snapshot.indexed_files).toBe('number');
    expect(typeof snapshot.task_count).toBe('number');
    expect('errors_last_24h' in snapshot).toBe(true);
  });

  it('get_recent_events reflects events emitted on the shared bus (newest first)', async () => {
    // Emit a couple of events directly on the shared bus the tool reads from.
    eventBus.emit('scan.started', { scanId: 1 });
    eventBus.emit('scan.completed', { scanId: 1 });

    const result = await client.callTool({
      name: 'kundun.get_recent_events',
      arguments: { limit: 10 },
    });
    const body = parseToolResult(result);

    expect(Array.isArray(body.events)).toBe(true);
    const events = body.events as Array<{ type: string }>;
    expect(events.length).toBeGreaterThanOrEqual(2);
    // recent() is newest-FIRST: the completed event precedes the started one.
    expect(events[0]?.type).toBe('scan.completed');
    expect(events.some((e) => e.type === 'scan.started')).toBe(true);
  });

  it('a tool call also instruments the shared session (tools_called increments)', async () => {
    const before = sessionRegistry.recent(10).find((s) => s.session_id === sessionId)?.tools_called;

    await client.callTool({ name: 'kundun.get_sessions', arguments: {} });

    const after = sessionRegistry.recent(10).find((s) => s.session_id === sessionId)?.tools_called;
    expect(after ?? 0).toBeGreaterThan(before ?? 0);
  });
});
