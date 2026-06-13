// MCP resources for Kundun-Agent (README §19). Registers the eight static
// `kundun://project/*` resources on an McpServer. Each resource is read-only and
// returns a single JSON `application/json` content block built from the wired
// AppContext supplied lazily by `getCtx()`.
//
// Resources cannot easily signal an error to the client (there is no `isError`
// flag like tool results have), so every handler wraps its work in try/catch and,
// on failure, embeds the message as `{ error: string }` in the JSON payload.
//
// better-sqlite3 is synchronous, so the read callbacks do no real async work; they
// are declared `async` only because the SDK's ReadResourceCallback signature is
// promise-returning, and the JSON is produced synchronously inside them.

import type { McpServer, ResourceMetadata } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import type { AppContext } from '../core/container.js';
import { buildMemoryEngine, buildTaskEngine } from '../core/container.js';
import { buildProjectSummary } from '../core/project-summary.js';
import { DiagnosticRepository } from '../storage/repositories/diagnostic.repository.js';
import { nowIso } from '../utils/time.js';

/** Common MIME type for every Kundun resource payload. */
const JSON_MIME = 'application/json';

/** A single resource definition wired below. */
interface ResourceDef {
  name: string;
  uri: string;
  title: string;
  description: string;
  /** Produce the JSON-serializable payload for this resource. */
  load(ctx: AppContext): unknown;
}

/**
 * Minimal health object shared with the `get_health` tool. Derived only from
 * MVP1/MVP2 data (engine availability is static in headless mode; real
 * health/metrics telemetry arrives in MVP3). Kept as a plain object so the tool
 * layer can reuse the exact same shape.
 */
export function buildHealthSnapshot(ctx: AppContext): Record<string, unknown> {
  const lastScan = ctx.repos.run.lastScan();
  const lastCleanup = ctx.repos.run.lastCleanup();
  return {
    status: 'ok',
    checkedAt: nowIso(),
    database: {
      open: true,
      walEnabled: true,
      fts5: ctx.kdb.hasFts5,
    },
    engines: {
      scanner: 'ready',
      indexer: 'ready',
      search: ctx.kdb.hasFts5 ? 'fts5' : 'like',
      memory: 'ready',
      task: 'ready',
      diagnostics: ctx.config.enableDiagnostics ? 'ready' : 'disabled',
      cleanup: ctx.config.enableAutoCleanup ? 'ready' : 'disabled',
    },
    lastScan: {
      at: lastScan?.started_at ?? null,
      status: lastScan?.status ?? null,
    },
    lastCleanup: {
      at: lastCleanup?.started_at ?? null,
      status: lastCleanup?.status ?? null,
    },
    note: 'health telemetry is minimal until MVP3',
  };
}

/**
 * Minimal metrics object shared with the `get_metrics` tool. Computes current
 * counts and the last scan/cleanup durations on demand; persisted
 * metrics_snapshots are an MVP3 concern. Same shape returned by `get_metrics`.
 */
export function buildMetricsSnapshot(ctx: AppContext): Record<string, unknown> {
  const lastScan = ctx.repos.run.lastScan();
  const lastCleanup = ctx.repos.run.lastCleanup();
  const diagnosticRepo = new DiagnosticRepository(ctx.kdb);
  return {
    capturedAt: nowIso(),
    indexedFiles: ctx.repos.file.countActive(),
    indexedChunks: ctx.repos.chunk.countAll(),
    symbols: ctx.repos.symbol.countAll(),
    memories: ctx.repos.memory.countAll(),
    openTasks: ctx.repos.task.countOpen(),
    diagnostics: diagnosticRepo.countAll(),
    diagnosticsBySeverity: diagnosticRepo.countBySeverity(),
    searchMode: ctx.kdb.hasFts5 ? 'fts5' : 'like',
    scanDurationMs: lastScan?.duration_ms ?? null,
    cleanupDurationMs: lastCleanup?.duration_ms ?? null,
    note: 'metrics snapshots are not persisted until MVP3',
  };
}

/** The eight resource definitions, in README §19 order. */
const RESOURCE_DEFS: readonly ResourceDef[] = [
  {
    name: 'project-summary',
    uri: 'kundun://project/summary',
    title: 'Project summary',
    description: 'High-level project overview: languages, important files, tasks, last runs.',
    load: (ctx) => buildProjectSummary(ctx),
  },
  {
    name: 'project-memories',
    uri: 'kundun://project/memories',
    title: 'Important memories',
    description: 'Most important non-archived project memories.',
    load: (ctx) => ({ memories: buildMemoryEngine(ctx).listImportant(50) }),
  },
  {
    name: 'project-tasks',
    uri: 'kundun://project/tasks',
    title: 'Tasks',
    description: 'Project tasks across all statuses.',
    load: (ctx) => ({ tasks: buildTaskEngine(ctx).list({ limit: 200 }) }),
  },
  {
    name: 'project-diagnostics',
    uri: 'kundun://project/diagnostics',
    title: 'Diagnostics',
    description: 'Heuristic diagnostic findings, most severe first.',
    load: (ctx) => ({ diagnostics: new DiagnosticRepository(ctx.kdb).list({ limit: 200 }) }),
  },
  {
    name: 'project-recent-changes',
    uri: 'kundun://project/recent-changes',
    title: 'Recent changes',
    description: 'Recent scan runs (best-effort; per-file change lists arrive later).',
    load: (ctx) => ({ recentScans: ctx.repos.run.recentScans(10) }),
  },
  {
    name: 'project-sessions',
    uri: 'kundun://project/sessions',
    title: 'Sessions',
    description: 'Active and recent MCP sessions (not available until MVP3).',
    load: () => ({ sessions: [], note: 'not available until MVP3' }),
  },
  {
    name: 'project-health',
    uri: 'kundun://project/health',
    title: 'Health',
    description: 'Current minimal health status of the local engines and database.',
    load: (ctx) => buildHealthSnapshot(ctx),
  },
  {
    name: 'project-metrics',
    uri: 'kundun://project/metrics',
    title: 'Metrics',
    description: 'Current minimal metrics: counts and last run durations.',
    load: (ctx) => buildMetricsSnapshot(ctx),
  },
];

/**
 * Register the eight static `kundun://project/*` resources on `server`.
 * `getCtx` is invoked per request so each read sees the live AppContext.
 */
export function registerResources(server: McpServer, getCtx: () => AppContext): void {
  for (const def of RESOURCE_DEFS) {
    const metadata: ResourceMetadata = {
      title: def.title,
      description: def.description,
      mimeType: JSON_MIME,
    };

    server.registerResource(def.name, def.uri, metadata, (uri): ReadResourceResult => {
      let payload: unknown;
      try {
        payload = def.load(getCtx());
      } catch (err) {
        payload = { error: err instanceof Error ? err.message : String(err) };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: JSON_MIME,
            text: JSON.stringify(payload),
          },
        ],
      };
    });
  }
}
