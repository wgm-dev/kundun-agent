// Local HTTP API route table (README §MVP3). This module defines the shared
// route-handler contract used by the local server and aggregates every route
// module into the ordered table the server matches against.
//
// Auth model (locked): GET routes are PUBLIC except GET /logs (token-required);
// every POST route and the WS upgrade require the token. The per-route `policy`
// here only governs Bearer-token verification; the loopback-host check runs in
// the server BEFORE this policy is consulted.
//
// better-sqlite3 is synchronous, but the HTTP server is async, so a handler may
// return either void (sync) or a Promise<void>. Handlers MUST NOT throw the raw
// token or stack into a response — the server maps thrown KundunErrors to status
// codes and the helpers below never serialize a stack.

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AppContext } from '../../core/container.js';
import type { EventBus } from '../../core/event-bus.js';
import type { HealthMonitor } from '../../core/health-monitor.js';
import type { MetricsEngine } from '../../core/metrics-engine.js';
import type { SessionRegistry } from '../../core/session-registry.js';
import type { Logger } from '../../utils/logger.js';

import { buildHealthRoutes } from './health.routes.js';
import { buildSessionsRoutes } from './sessions.routes.js';
import { buildMetricsRoutes } from './metrics.routes.js';
import { buildProjectsRoutes } from './projects.routes.js';
import { buildLogsRoutes } from './logs.routes.js';
import { buildScanRoutes } from './scan.routes.js';
import { buildCleanupRoutes } from './cleanup.routes.js';
import { buildDiagnosticsRoutes } from './diagnostics.routes.js';
import { buildMcpRoutes } from './mcp.routes.js';
import { createOperationLock } from './operation-lock.js';

/**
 * Everything a route handler may read. The same instance is shared across every
 * request for the life of the server; the engines/registry are the process
 * singletons minted at daemon startup (see container.createProcessRuntime).
 */
export interface RouteContext {
  ctx: AppContext;
  eventBus: EventBus;
  sessionRegistry: SessionRegistry;
  healthMonitor: HealthMonitor;
  metricsEngine: MetricsEngine;
  logger: Logger;
  /**
   * Optional in-process reload hook installed ONLY when the server runs under a
   * daemon. POST /mcp/restart invokes it to trigger an in-process reload (re-read
   * config, reset timers, emit a health event) — NOT a re-exec. When absent the
   * server is not under a daemon and the route reports {restarted:false,
   * reason:'no daemon running'} as a non-error.
   */
  requestReload?: () => void;
}

/** Whether a matched route requires a verified Bearer token before its handler. */
export type RoutePolicy = 'public' | 'token';

/** The HTTP methods the local API serves. */
export type RouteMethod = 'GET' | 'POST';

/**
 * A single route handler. `req`/`res` are the raw Node objects; `route` is the
 * matched definition (handy for logging); `rc` is the shared route context. For
 * POST routes the parsed JSON body is attached by the server as `req.body`
 * (typed `unknown` — handlers narrow it themselves).
 */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  route: RouteDef,
  rc: RouteContext,
) => Promise<void> | void;

/** A route definition entry in the table. */
export interface RouteDef {
  method: RouteMethod;
  path: string;
  policy: RoutePolicy;
  handler: RouteHandler;
}

/**
 * Write a JSON success body. Sets `Content-Type: application/json` and serializes
 * the value as-is; callers are responsible for never placing a secret (e.g. the
 * token) into `body`.
 */
export function jsonOk(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * Write a JSON error body of the stable shape `{ error: { code, message } }`. No
 * stack is ever serialized, and the token never appears here. Used by both the
 * route modules and the server's central error mapper.
 */
export function jsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  const payload = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * Aggregate every route module into the ordered route table. The server matches
 * a request by exact (method, path); order is irrelevant for correctness but the
 * grouping mirrors the README's surface (reads first, then the mutating POSTs).
 */
export function buildRoutes(rc: RouteContext): RouteDef[] {
  // ONE shared "operation in progress" guard for the whole server: a running scan
  // and a cleanup must not interleave, so both POST routes acquire this same lock
  // and a concurrent attempt is rejected with 409 (see scan/cleanup routes).
  const operationLock = createOperationLock();

  return [
    ...buildHealthRoutes(rc),
    ...buildSessionsRoutes(rc),
    ...buildMetricsRoutes(rc),
    ...buildProjectsRoutes(rc),
    ...buildLogsRoutes(rc),
    ...buildScanRoutes(rc, operationLock),
    ...buildCleanupRoutes(rc, operationLock),
    ...buildDiagnosticsRoutes(rc),
    ...buildMcpRoutes(rc),
  ];
}
