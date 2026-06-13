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
import { DiagnosticRepository } from '../storage/repositories/diagnostic.repository.js';
import type { MemorySearchOptions } from '../storage/repositories/memory.repository.js';
import type { UpdateTaskPatch } from '../core/task-engine.js';
import type { SymbolRow } from '../storage/types.js';
import { resolveWithinRoot } from '../utils/path-safety.js';
import { basename } from 'node:path';

/** Dependencies injected into the tool registrations. */
export interface RegisterToolsDeps {
  /** Optional in-memory event bus. When present, tools may expose its history. */
  eventBus?: EventBus;
}

/** Wrap an arbitrary JSON-serializable value into a single text content block. */
function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Wrap an error message into an `isError` text result. */
function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Narrow an unknown caught value to a human-readable message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a synchronous tool body, converting any thrown error into an `isError`
 * result so a failing handler never escapes to the SDK as an unhandled throw.
 */
function guard(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (err) {
    return errorResult(errorMessage(err));
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
 * Best-effort resolution of the database file path for health reporting. The
 * configured path is usually relative to the project root; resolve it inside the
 * root, falling back to the raw configured value if resolution fails.
 */
function resolveDbPath(ctx: AppContext): string {
  try {
    return resolveWithinRoot(ctx.projectRoot, ctx.config.databasePath);
  } catch {
    return ctx.config.databasePath;
  }
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
  const { eventBus } = deps;

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
    (args) =>
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
    (args) =>
      guard(() => {
        const ctx = getCtx();
        const search = buildSearchProvider(ctx);
        const limit = args.limit ?? 20;
        const opts = args.language === undefined ? { limit } : { limit, language: args.language };
        const results = search.searchCode(args.query, opts);
        return jsonResult({ mode: search.mode, results });
      }),
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
    (args) =>
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
        const memoryEngine = buildMemoryEngine(ctx);
        const base = basename(args.path);
        let memories = memoryEngine.search({ query: base, limit: 10 });
        if (memories.length === 0 && base !== args.path) {
          memories = memoryEngine.search({ query: args.path, limit: 10 });
        }

        // Related tasks: best-effort search by file path.
        const taskEngine = buildTaskEngine(ctx);
        const tasks = taskEngine.search(args.path, 10);

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
    (args) =>
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
    (args) =>
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
    (args) =>
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
    (args) =>
      guard(() => {
        const ctx = getCtx();
        const memoryEngine = buildMemoryEngine(ctx);
        const rows =
          args.limit === undefined
            ? memoryEngine.listImportant()
            : memoryEngine.listImportant(args.limit);
        return jsonResult({ memories: rows });
      }),
  );

  // --- kundun.create_task --------------------------------------------------
  server.registerTool(
    'kundun.create_task',
    {
      title: 'Create task',
      description: 'Create a new task and return its id.',
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        priority: z.string().optional(),
        relatedFiles: z.array(z.string()).optional(),
      },
    },
    (args) =>
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
  );

  // --- kundun.next_task ----------------------------------------------------
  server.registerTool(
    'kundun.next_task',
    {
      title: 'Next task',
      description: 'Return the single most actionable pending task, or null when none.',
      inputSchema: {},
    },
    () =>
      guard(() => {
        const ctx = getCtx();
        const taskEngine = buildTaskEngine(ctx);
        const task = taskEngine.next();
        return jsonResult({ task: task ?? null });
      }),
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
    (args) =>
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
    (args) =>
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
    (args) =>
      guard(() => {
        const ctx = getCtx();
        const cleanup = buildCleanupEngine(ctx);
        const result = cleanup.run(args.dryRun === undefined ? {} : { dryRun: args.dryRun });
        if (args.dryRun !== true) {
          eventBus?.emit('cleanup.completed', { removedFiles: result.removedFiles });
        }
        return jsonResult(result);
      }),
  );

  // --- kundun.project_summary ----------------------------------------------
  server.registerTool(
    'kundun.project_summary',
    {
      title: 'Project summary',
      description: 'Return a read-only summary of the project (languages, counts, tasks, etc.).',
      inputSchema: {},
    },
    () =>
      guard(() => {
        const ctx = getCtx();
        return jsonResult(buildProjectSummary(ctx));
      }),
  );

  // --- kundun.get_sessions -------------------------------------------------
  server.registerTool(
    'kundun.get_sessions',
    {
      title: 'Get sessions',
      description: 'Session registry (MVP3). Not available yet; returns an empty list.',
      inputSchema: {},
    },
    () => guard(() => jsonResult({ sessions: [], note: 'session registry not available yet' })),
  );

  // --- kundun.get_health ---------------------------------------------------
  server.registerTool(
    'kundun.get_health',
    {
      title: 'Get health',
      description: 'Minimal computed health snapshot (schema, search mode, last scan, db, files).',
      inputSchema: {},
    },
    () =>
      guard(() => {
        const ctx = getCtx();
        const lastScan = ctx.repos.run.lastScan();
        return jsonResult({
          schemaOk: true,
          searchMode: ctx.kdb.hasFts5 ? 'fts5' : 'like',
          lastScan: lastScan?.status ?? null,
          dbPath: resolveDbPath(ctx),
          fileCount: ctx.repos.file.countActive(),
        });
      }),
  );

  // --- kundun.get_metrics --------------------------------------------------
  server.registerTool(
    'kundun.get_metrics',
    {
      title: 'Get metrics',
      description: 'Minimal computed metrics from row counts and last scan/cleanup durations.',
      inputSchema: {},
    },
    () =>
      guard(() => {
        const ctx = getCtx();
        const diagnosticRepo = new DiagnosticRepository(ctx.kdb);
        const lastScan = ctx.repos.run.lastScan();
        const lastCleanup = ctx.repos.run.lastCleanup();
        const tasksTotal = ctx.kdb.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as
          | { n: number }
          | undefined;
        return jsonResult({
          counts: {
            files: ctx.repos.file.countActive(),
            chunks: ctx.repos.chunk.countAll(),
            symbols: ctx.repos.symbol.countAll(),
            memories: ctx.repos.memory.countAll(),
            tasks: tasksTotal?.n ?? 0,
            diagnostics: diagnosticRepo.countAll(),
          },
          lastScanDurationMs: lastScan?.duration_ms ?? null,
          lastCleanupDurationMs: lastCleanup?.duration_ms ?? null,
          note: 'metrics_snapshots table not in MVP2; metrics are computed on demand',
        });
      }),
  );

  // --- kundun.get_recent_events --------------------------------------------
  server.registerTool(
    'kundun.get_recent_events',
    {
      title: 'Get recent events',
      description: 'Recent events from the in-memory bus, when a ring buffer is retained.',
      inputSchema: {},
    },
    () =>
      guard(() => {
        // The MVP2 EventBus does not retain history (no ring buffer), so there is
        // nothing to expose yet.
        return jsonResult({ events: [], note: 'event history not retained' });
      }),
  );

  // --- kundun.restart_daemon -----------------------------------------------
  server.registerTool(
    'kundun.restart_daemon',
    {
      title: 'Restart daemon',
      description:
        'Restart the background daemon. Guarded by config.allowRestartFromMcp; no daemon exists in MVP2.',
      inputSchema: {},
    },
    () =>
      guard(() => {
        const ctx = getCtx();
        if (!ctx.config.allowRestartFromMcp) {
          return errorResult('restart from MCP is disabled (allowRestartFromMcp=false)');
        }
        return jsonResult({ restarted: false, note: 'no daemon is running in MVP2' });
      }),
  );
}
