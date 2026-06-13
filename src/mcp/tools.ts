// MCP tool registration (README §18). Registers all 18 Kundun tools on an
// McpServer using the official MCP TypeScript SDK (^1.29) plus zod.
//
// Each tool's `inputSchema` is a RAW ZOD SHAPE object (a plain `{ field: zod }`
// map), NOT a `z.object(...)` wrapper — the SDK wraps it internally. Every
// handler runs SYNCHRONOUSLY against the shared AppContext (better-sqlite3 is
// synchronous) and returns its result as a single JSON text content block. Each
// handler body is wrapped in try/catch and converts any thrown error into an
// `isError` result so a failing tool never crashes the server.
//
// The context is shared: `getCtx()` returns the single AppContext created once by
// server.ts. We never create or close a context here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  buildCleanupEngine,
  buildIndexer,
  buildMemoryEngine,
  buildScanner,
  buildSearchProvider,
  buildTaskEngine,
} from '../core/container.js';
import type { AppContext } from '../core/container.js';
import { buildProjectSummary } from '../core/project-summary.js';
import { createDiagnosticsEngine } from '../core/diagnostics-engine.js';
import type { RunDiagnosticsOptions } from '../core/diagnostics-engine.js';
import type { EventBus } from '../core/event-bus.js';
import { createHealthMonitor, errorsLast24h } from '../core/health-monitor.js';
import type { SessionRegistry } from '../core/session-registry.js';
import { DiagnosticRepository } from '../storage/repositories/diagnostic.repository.js';
import { KundunError } from '../utils/errors.js';
import type { MemorySearchOptions } from '../storage/repositories/memory.repository.js';
import type { UpdateTaskPatch } from '../core/task-engine.js';
import type { SymbolRow } from '../storage/types.js';
import { nowIso } from '../utils/time.js';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';

/** Dependencies injected into the tool registrations. */
export interface RegisterToolsDeps {
  /** Optional in-memory event bus. When present, tools may expose its history. */
  eventBus?: EventBus;
  /**
   * Optional process-shared session registry. When present, every tool call is
   * instrumented against the current session (operation label, tool-call count,
   * latency sample, error count). Omitted in isolated tests.
   */
  sessionRegistry?: SessionRegistry;
  /** The session id minted for this MCP process; required to instrument calls. */
  sessionId?: string;
}

/** Wrap an arbitrary JSON-serializable value into a single text content block. */
function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/**
 * Wrap an error into an `isError` result whose body is ALSO JSON, so a consumer
 * can `JSON.parse(content[0].text)` uniformly for both success and error
 * results. A `code` is included (stable KundunError code, or 'error').
 */
function errorResult(message: string, code = 'error'): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  };
}

/** Narrow an unknown caught value to a human-readable message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stable error code for a caught value (KundunError code when available). */
function errorCode(err: unknown): string {
  return err instanceof KundunError ? err.code : 'error';
}

/**
 * Run a synchronous tool body, converting any thrown error into an `isError`
 * result so a failing handler never escapes to the SDK as an unhandled throw.
 */
function guard(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (err) {
    return errorResult(errorMessage(err), errorCode(err));
  }
}

/**
 * Query symbols for a single file directly (the SymbolRepository exposes only
 * name/prefix lookups, not a by-file accessor). Read-only SELECT, ordered by
 * source position for stable output.
 */
function symbolsForFile(ctx: AppContext, fileId: number): SymbolRow[] {
  const rows = ctx.kdb.db
    .prepare(
      `SELECT * FROM symbols
         WHERE file_id = ?
         ORDER BY start_line ASC, name ASC`,
    )
    .all(fileId);
  return rows as SymbolRow[];
}

/**
 * Live database size as page_count * page_size on the OPEN connection (the locked
 * definition for metrics db_size_bytes). Reflects WAL-pending pages, unlike a
 * file-size stat which lags until the next checkpoint.
 */
function liveDbSizeBytes(ctx: AppContext): number {
  const pageCount = ctx.kdb.db.pragma('page_count', { simple: true }) as number;
  const pageSize = ctx.kdb.db.pragma('page_size', { simple: true }) as number;
  return pageCount * pageSize;
}

/** Total number of rows in the tasks table (not just open tasks). */
function totalTaskCount(ctx: AppContext): number {
  const row = ctx.kdb.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/**
 * Register all 18 Kundun MCP tools on `server`. Handlers obtain the shared
 * context via `getCtx()` and perform their work synchronously.
 */
export function registerTools(
  server: McpServer,
  getCtx: () => AppContext,
  deps: RegisterToolsDeps,
): void {
  const { eventBus, sessionRegistry, sessionId } = deps;

  /**
   * Wrap a tool handler so EVERY invocation is instrumented against the shared
   * session registry: set the current-operation label, time the body with a
   * monotonic clock, and on completion record either a tool call (with its latency)
   * or an error, then clear the operation. This is the SINGLE point where tool
   * latency is measured — engines must NOT time themselves. A failing call is
   * detected via the `isError` flag that {@link guard} stamps on error results
   * (guard never throws), so recording is correct without re-running the body.
   *
   * Generic over the handler's argument tuple so it transparently wraps both
   * `(args) => ...` and `() => ...` handlers without touching their bodies. When no
   * registry/sessionId is wired (isolated tests), the handler runs unchanged.
   */
  function instrument<A extends unknown[]>(
    name: string,
    handler: (...args: A) => CallToolResult,
  ): (...args: A) => CallToolResult {
    return (...args: A): CallToolResult => {
      if (sessionRegistry === undefined || sessionId === undefined) {
        return handler(...args);
      }
      sessionRegistry.setOperation(sessionId, name);
      const start = performance.now();
      let result: CallToolResult;
      try {
        result = handler(...args);
      } finally {
        sessionRegistry.setOperation(sessionId, null);
      }
      const elapsedMs = performance.now() - start;
      if (result.isError === true) {
        sessionRegistry.recordError(sessionId);
      } else {
        sessionRegistry.recordToolCall(sessionId, elapsedMs);
      }
      return result;
    };
  }

  // --- kundun.scan_project -------------------------------------------------
  server.registerTool(
    'kundun.scan_project',
    {
      title: 'Scan project',
      description:
        'Scan the project tree and index new/changed files. Returns scan and index counts.',
      inputSchema: {
        rootPath: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    instrument('kundun.scan_project', (args) =>
      guard(() => {
        const ctx = getCtx();
        const scanner = buildScanner(ctx);
        const indexer = buildIndexer(ctx);

        const scan = scanner.scan(args.force === undefined ? {} : { force: args.force });
        const toIndex = [...scan.newFiles, ...scan.changedFiles];
        const indexResult = indexer.indexFiles(toIndex);

        return jsonResult({
          scanId: scan.scanId,
          filesScanned: scan.filesScanned,
          filesIndexed: indexResult.indexed,
          filesSkipped: scan.skippedFiles.length + indexResult.skipped,
          removed: scan.removedFiles.length,
          errors: scan.errors.length + indexResult.errors,
        });
      }),
    ),
  );

  // --- kundun.search_code --------------------------------------------------
  server.registerTool(
    'kundun.search_code',
    {
      title: 'Search code',
      description: 'Full-text (or LIKE fallback) search over indexed code chunks.',
      inputSchema: {
        query: z.string(),
        language: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    instrument('kundun.search_code', (args) =>
      guard(() => {
        const ctx = getCtx();
        const search = buildSearchProvider(ctx);
        const limit = args.limit ?? 20;
        const opts = args.language === undefined ? { limit } : { limit, language: args.language };
        const results = search.searchCode(args.query, opts);
        return jsonResult({ mode: search.mode, results });
      }),
    ),
  );

  // --- kundun.get_file_context ---------------------------------------------
  server.registerTool(
    'kundun.get_file_context',
    {
      title: 'Get file context',
      description:
        'Aggregate everything Kundun knows about a file: row, chunks, symbols, related memories, related tasks, and diagnostics.',
      inputSchema: {
        path: z.string(),
      },
    },
    instrument('kundun.get_file_context', (args) =>
      guard(() => {
        const ctx = getCtx();
        const file = ctx.repos.file.getByRelativePath(args.path);
        if (file === undefined) {
          return errorResult(
            `File "${args.path}" is not tracked. Run kundun.scan_project first to index it.`,
          );
        }

        const chunks = ctx.repos.chunk.getByFile(file.id);
        const symbols = symbolsForFile(ctx, file.id);

        // Related memories: best-effort search by file basename, then path.
        // Wrapped so a search-path failure degrades to [] rather than failing
        // the whole context tool (defense in depth alongside FTS sanitization).
        const memoryEngine = buildMemoryEngine(ctx);
        const base = basename(args.path);
        let memories: ReturnType<typeof memoryEngine.search> = [];
        try {
          memories = memoryEngine.search({ query: base, limit: 10 });
          if (memories.length === 0 && base !== args.path) {
            memories = memoryEngine.search({ query: args.path, limit: 10 });
          }
        } catch {
          memories = [];
        }

        // Related tasks: best-effort search by file path.
        const taskEngine = buildTaskEngine(ctx);
        let tasks: ReturnType<typeof taskEngine.search> = [];
        try {
          tasks = taskEngine.search(args.path, 10);
        } catch {
          tasks = [];
        }

        // Diagnostics for this file.
        const diagnosticRepo = new DiagnosticRepository(ctx.kdb);
        const diagnostics = diagnosticRepo.list({ fileId: file.id });

        return jsonResult({
          file,
          chunks,
          symbols,
          relatedMemories: memories,
          relatedTasks: tasks,
          diagnostics,
        });
      }),
    ),
  );

  // --- kundun.find_symbol --------------------------------------------------
  server.registerTool(
    'kundun.find_symbol',
    {
      title: 'Find symbol',
      description:
        'Find symbols by exact name, falling back to a prefix match when no exact hit exists.',
      inputSchema: {
        name: z.string(),
        language: z.string().optional(),
        kind: z.string().optional(),
      },
    },
    instrument('kundun.find_symbol', (args) =>
      guard(() => {
        const ctx = getCtx();
        const opts: { language?: string; kind?: string } = {};
        if (args.language !== undefined) {
          opts.language = args.language;
        }
        if (args.kind !== undefined) {
          opts.kind = args.kind;
        }
        let hits = ctx.repos.symbol.findByName(args.name, opts);
        if (hits.length === 0) {
          hits = ctx.repos.symbol.findByPrefix(args.name, opts);
        }
        return jsonResult({ hits });
      }),
    ),
  );

  // --- kundun.add_memory ---------------------------------------------------
  server.registerTool(
    'kundun.add_memory',
    {
      title: 'Add memory',
      description: 'Store a new memory entry and return its id.',
      inputSchema: {
        type: z.string(),
        title: z.string(),
        content: z.string(),
        tags: z.array(z.string()).optional(),
        importanceScore: z.number().optional(),
        confidence: z.number().optional(),
      },
    },
    instrument('kundun.add_memory', (args) =>
      guard(() => {
        const ctx = getCtx();
        const memoryEngine = buildMemoryEngine(ctx);
        const input: {
          type: string;
          title: string;
          content: string;
          tags?: string[];
          importanceScore?: number;
          confidence?: number;
        } = { type: args.type, title: args.title, content: args.content };
        if (args.tags !== undefined) {
          input.tags = args.tags;
        }
        if (args.importanceScore !== undefined) {
          input.importanceScore = args.importanceScore;
        }
        if (args.confidence !== undefined) {
          input.confidence = args.confidence;
        }
        const id = memoryEngine.add(input);
        eventBus?.emit('memory.created', { id });
        return jsonResult({ id });
      }),
    ),
  );

  // --- kundun.search_memory ------------------------------------------------
  server.registerTool(
    'kundun.search_memory',
    {
      title: 'Search memory',
      description: 'Search stored memories by query, type, and/or tags.',
      inputSchema: {
        query: z.string().optional(),
        type: z.string().optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().optional(),
      },
    },
    instrument('kundun.search_memory', (args) =>
      guard(() => {
        const ctx = getCtx();
        const memoryEngine = buildMemoryEngine(ctx);
        const opts: MemorySearchOptions = {};
        if (args.query !== undefined) {
          opts.query = args.query;
        }
        if (args.type !== undefined) {
          opts.type = args.type;
        }
        if (args.tags !== undefined) {
          opts.tags = args.tags;
        }
        if (args.limit !== undefined) {
          opts.limit = args.limit;
        }
        const rows = memoryEngine.search(opts);
        return jsonResult({ memories: rows });
      }),
    ),
  );

  // --- kundun.list_important_memories --------------------------------------
  server.registerTool(
    'kundun.list_important_memories',
    {
      title: 'List important memories',
      description: 'List the most important (non-archived) memories.',
      inputSchema: {
        limit: z.number().optional(),
      },
    },
    instrument('kundun.list_important_memories', (args) =>
      guard(() => {
        const ctx = getCtx();
        const memoryEngine = buildMemoryEngine(ctx);
        const rows =
          args.limit === undefined
            ? memoryEngine.listImportant()
            : memoryEngine.listImportant(args.limit);
        return jsonResult({ memories: rows });
      }),
    ),
  );

  // --- kundun.create_task --------------------------------------------------
  server.registerTool(
    'kundun.create_task',
    {
      title: 'Create task',
      description: 'Create a new task and return its id.',
      inputSchema: {
        title: z.string().min(1, 'title must not be empty'),
        description: z.string().optional(),
        priority: z.string().optional(),
        relatedFiles: z.array(z.string()).optional(),
      },
    },
    instrument('kundun.create_task', (args) =>
      guard(() => {
        const ctx = getCtx();
        const taskEngine = buildTaskEngine(ctx);
        const input: {
          title: string;
          description?: string;
          priority?: string;
          relatedFiles?: string[];
        } = { title: args.title };
        if (args.description !== undefined) {
          input.description = args.description;
        }
        if (args.priority !== undefined) {
          input.priority = args.priority;
        }
        if (args.relatedFiles !== undefined) {
          input.relatedFiles = args.relatedFiles;
        }
        const id = taskEngine.create(input);
        eventBus?.emit('task.created', { id });
        return jsonResult({ id });
      }),
    ),
  );

  // --- kundun.next_task ----------------------------------------------------
  server.registerTool(
    'kundun.next_task',
    {
      title: 'Next task',
      description: 'Return the single most actionable pending task, or null when none.',
      inputSchema: {},
    },
    instrument('kundun.next_task', () =>
      guard(() => {
        const ctx = getCtx();
        const taskEngine = buildTaskEngine(ctx);
        const task = taskEngine.next();
        return jsonResult({ task: task ?? null });
      }),
    ),
  );

  // --- kundun.update_task --------------------------------------------------
  server.registerTool(
    'kundun.update_task',
    {
      title: 'Update task',
      description: 'Update a task by id (title, description, status, priority).',
      inputSchema: {
        taskId: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
      },
    },
    instrument('kundun.update_task', (args) =>
      guard(() => {
        const ctx = getCtx();
        const taskEngine = buildTaskEngine(ctx);
        const patch: UpdateTaskPatch = {};
        if (args.title !== undefined) {
          patch.title = args.title;
        }
        if (args.description !== undefined) {
          patch.description = args.description;
        }
        if (args.status !== undefined) {
          patch.status = args.status;
        }
        if (args.priority !== undefined) {
          patch.priority = args.priority;
        }
        taskEngine.update(args.taskId, patch);
        eventBus?.emit('task.updated', { id: args.taskId });
        return jsonResult({ taskId: args.taskId, updated: true });
      }),
    ),
  );

  // --- kundun.run_diagnostics ----------------------------------------------
  server.registerTool(
    'kundun.run_diagnostics',
    {
      title: 'Run diagnostics',
      description: 'Run heuristic diagnostics over the project (or a single path/language).',
      inputSchema: {
        path: z.string().optional(),
        language: z.string().optional(),
      },
    },
    instrument('kundun.run_diagnostics', (args) =>
      guard(() => {
        const ctx = getCtx();
        const engine = createDiagnosticsEngine({ ctx });
        const opts: RunDiagnosticsOptions = {};
        if (args.path !== undefined) {
          opts.path = args.path;
        }
        if (args.language !== undefined) {
          opts.language = args.language;
        }
        eventBus?.emit('diagnostics.started', { ...opts });
        const result = engine.run(opts);
        eventBus?.emit('diagnostics.completed', { findings: result.findings });
        return jsonResult(result);
      }),
    ),
  );

  // --- kundun.cleanup ------------------------------------------------------
  server.registerTool(
    'kundun.cleanup',
    {
      title: 'Cleanup',
      description: 'Run retention cleanup. Use dryRun to compute candidates without mutating.',
      inputSchema: {
        dryRun: z.boolean().optional(),
      },
    },
    instrument('kundun.cleanup', (args) =>
      guard(() => {
        const ctx = getCtx();
        const cleanup = buildCleanupEngine(ctx);
        const result = cleanup.run(args.dryRun === undefined ? {} : { dryRun: args.dryRun });
        if (args.dryRun !== true) {
          eventBus?.emit('cleanup.completed', { removedFiles: result.removedFiles });
        }
        return jsonResult(result);
      }),
    ),
  );

  // --- kundun.project_summary ----------------------------------------------
  server.registerTool(
    'kundun.project_summary',
    {
      title: 'Project summary',
      description: 'Return a read-only summary of the project (languages, counts, tasks, etc.).',
      inputSchema: {},
    },
    instrument('kundun.project_summary', () =>
      guard(() => {
        const ctx = getCtx();
        return jsonResult(buildProjectSummary(ctx));
      }),
    ),
  );

  // --- kundun.get_sessions -------------------------------------------------
  server.registerTool(
    'kundun.get_sessions',
    {
      title: 'Get sessions',
      description: 'List recent MCP/desktop sessions plus the live active count.',
      inputSchema: {},
    },
    instrument('kundun.get_sessions', () =>
      guard(() => {
        if (sessionRegistry === undefined) {
          // No process-shared registry wired (isolated test / one-shot): nothing to
          // report. We never construct a fresh registry here — its tool-latency ring
          // and active count are only meaningful on the process singleton.
          return jsonResult({ sessions: [], activeCount: 0 });
        }
        return jsonResult({
          sessions: sessionRegistry.recent(50),
          activeCount: sessionRegistry.activeCount(),
        });
      }),
    ),
  );

  // --- kundun.get_health ---------------------------------------------------
  server.registerTool(
    'kundun.get_health',
    {
      title: 'Get health',
      description:
        'Component health report: per-component status, errors in the last 24h, avg tool latency, search mode, schema version.',
      inputSchema: {},
    },
    instrument('kundun.get_health', () =>
      guard(() => {
        const ctx = getCtx();
        // Pure read (record:false): never persist a health_event on a read. The
        // monitor expects averageToolLatencyMs(); the registry exposes
        // avgToolLatencyMs(), so bridge the method name when a registry is wired.
        const monitor = createHealthMonitor({
          ctx,
          healthRepo: ctx.repos.health,
          ...(sessionRegistry === undefined
            ? {}
            : {
                sessionRegistry: {
                  averageToolLatencyMs: (): number | null => sessionRegistry.avgToolLatencyMs(),
                },
              }),
          ...(eventBus === undefined ? {} : { eventBus }),
        });
        return jsonResult(monitor.check());
      }),
    ),
  );

  // --- kundun.get_metrics --------------------------------------------------
  server.registerTool(
    'kundun.get_metrics',
    {
      title: 'Get metrics',
      description:
        'Return the latest persisted metrics snapshot plus a freshly computed snapshot (the read itself does not persist a new row).',
      inputSchema: {},
    },
    instrument('kundun.get_metrics', () =>
      guard(() => {
        const ctx = getCtx();
        const iso = nowIso();
        const diagnosticRepo = new DiagnosticRepository(ctx.kdb);

        // Latest persisted snapshot (the daemon timer is what writes these rows).
        const latest = ctx.repos.metrics.latest() ?? null;

        // Fresh snapshot computed on demand WITHOUT persisting it. Uses the same
        // sources as the metrics engine: live PRAGMA db size, the SHARED 24h error
        // helper, and the process registry for active_sessions / avg tool latency
        // (null when no registry is wired). Shaped like a NewMetricsSnapshotRow.
        const fresh = {
          created_at: iso,
          active_sessions: sessionRegistry?.activeCount() ?? 0,
          indexed_files: ctx.repos.file.countActive(),
          indexed_chunks: ctx.repos.chunk.countAll(),
          memory_count: ctx.repos.memory.countAll(),
          task_count: totalTaskCount(ctx),
          diagnostics_count: diagnosticRepo.countAll(),
          db_size_bytes: liveDbSizeBytes(ctx),
          avg_tool_latency_ms: sessionRegistry?.avgToolLatencyMs() ?? null,
          scan_duration_ms: ctx.repos.run.lastScan()?.duration_ms ?? null,
          cleanup_duration_ms: ctx.repos.run.lastCleanup()?.duration_ms ?? null,
          errors_last_24h: errorsLast24h(
            { healthRepo: ctx.repos.health, runRepo: ctx.repos.run },
            iso,
          ),
        };

        return jsonResult({ latest, snapshot: fresh });
      }),
    ),
  );

  // --- kundun.get_recent_events --------------------------------------------
  server.registerTool(
    'kundun.get_recent_events',
    {
      title: 'Get recent events',
      description: 'Most recent events from the in-memory event bus, newest first.',
      inputSchema: {
        limit: z.number().optional(),
      },
    },
    instrument('kundun.get_recent_events', (args) =>
      guard(() => {
        const limit = args.limit ?? 50;
        // recent() is newest-FIRST. When no bus is wired (isolated test), there is
        // no retained history to surface.
        const events = eventBus?.recent(limit) ?? [];
        return jsonResult({ events });
      }),
    ),
  );

  // --- kundun.restart_daemon -----------------------------------------------
  server.registerTool(
    'kundun.restart_daemon',
    {
      title: 'Restart daemon',
      description:
        'Request an in-process daemon reload. Guarded by config.allowRestartFromMcp; both the disabled and no-daemon cases are NON-error results.',
      inputSchema: {},
    },
    instrument('kundun.restart_daemon', () =>
      guard(() => {
        const ctx = getCtx();
        // Disabled by config: NON-error result with an explanatory note (locked).
        // This is NOT an isError result — the call succeeded, it simply declined.
        if (!ctx.config.allowRestartFromMcp) {
          return jsonResult({
            restarted: false,
            note: 'Restart from MCP is disabled (config.allowRestartFromMcp = false).',
          });
        }
        // Enabled, but the MCP server (a stdio process) is not the daemon and owns
        // no reload hook, so there is nothing to restart from here (locked, non-error).
        return jsonResult({ restarted: false, reason: 'no daemon running' });
      }),
    ),
  );
}
