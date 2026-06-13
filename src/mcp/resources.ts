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
import { createHealthMonitor } from '../core/health-monitor.js';
import { DiagnosticRepository } from '../storage/repositories/diagnostic.repository.js';

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

/** How many recent persisted metrics snapshots the metrics resource surfaces. */
const METRICS_RECENT_LIMIT = 50;

/** How many recent sessions the sessions resource surfaces. */
const SESSIONS_RECENT_LIMIT = 100;

/**
 * Real component health report shared with the `get_health` tool. Built from the
 * shared {@link createHealthMonitor} as a pure read (record:false): per-component
 * status, errors in the last 24h, search mode, schema version. A resource has no
 * access to the in-process session registry, so `avgToolLatencyMs` is reported as
 * null here (the tool path, which does hold the registry, fills it in).
 */
export function buildHealthSnapshot(ctx: AppContext): Record<string, unknown> {
  const monitor = createHealthMonitor({ ctx, healthRepo: ctx.repos.health });
  return monitor.check() as unknown as Record<string, unknown>;
}

/**
 * Real metrics payload shared with the `get_metrics` tool: the latest persisted
 * metrics snapshot plus a short window of recent snapshots, read straight from the
 * MetricsRepository. Resources do not take a fresh snapshot (that is the daemon
 * timer's job and requires the live registry); they surface what is persisted.
 */
export function buildMetricsSnapshot(ctx: AppContext): Record<string, unknown> {
  const latest = ctx.repos.metrics.latest() ?? null;
  const recent = ctx.repos.metrics.recent(METRICS_RECENT_LIMIT);
  return { latest, recent };
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
    description: 'Recent MCP/desktop sessions plus the current active count.',
    // Read persisted session rows directly: a resource has no handle on the
    // in-process registry, but every session is mirrored to the sessions table.
    load: (ctx) => ({
      sessions: ctx.repos.session.listRecent(SESSIONS_RECENT_LIMIT),
      activeCount: ctx.repos.session.activeCount(),
    }),
  },
  {
    name: 'project-health',
    uri: 'kundun://project/health',
    title: 'Health',
    description: 'Current component health report (status, errors_24h, search mode, schema).',
    load: (ctx) => buildHealthSnapshot(ctx),
  },
  {
    name: 'project-metrics',
    uri: 'kundun://project/metrics',
    title: 'Metrics',
    description: 'Latest persisted metrics snapshot plus a window of recent snapshots.',
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
