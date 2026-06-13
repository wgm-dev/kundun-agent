// Local HTTP/WebSocket API server (README §MVP3). A loopback-only control plane
// for the desktop app and tooling: it serves the read routes (health, sessions,
// metrics, projects, logs) and the mutating POST routes (scan, cleanup,
// diagnostics, mcp/restart), and upgrades `/events` to a WebSocket event stream.
//
// SECURITY MODEL (locked):
// - Bind: the resolved host MUST be a loopback literal (127.0.0.1 or ::1); the
//   server THROWS before listen on anything else (never 0.0.0.0).
// - enforceLoopbackHost runs for every HTTP request AND the WS upgrade, BEFORE
//   auth: the Host header host must be loopback, and any present Origin must be
//   loopback too.
// - GET routes are public except GET /logs (token); every POST route and the WS
//   upgrade require the Bearer token (the WS upgrade also accepts ?token=).
// - Bodies are capped at 64KB (413 on overflow) and parsed as JSON (400 on bad
//   JSON). KundunError codes map to status codes; a stack or the token is NEVER
//   serialized into a response or a log line.
//
// node:http is async (this server), but every DB call inside a handler stays
// synchronous (better-sqlite3). Handlers may still return a Promise<void>.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { enforceLoopbackHost, parseBearer, parseWsToken } from './auth.js';
import type { TokenStore } from './auth.js';
import { createWsEventHub } from './ws-events.js';
import type { WsEventHub } from './ws-events.js';
import { buildRoutes, jsonError } from './routes/index.js';
import type { RouteContext, RouteDef } from './routes/index.js';
import { KundunError } from '../utils/errors.js';
import type { KundunErrorCode } from '../utils/errors.js';
import type { AppContext } from '../core/container.js';
import type { EventBus } from '../core/event-bus.js';
import type { HealthMonitor } from '../core/health-monitor.js';
import type { MetricsEngine } from '../core/metrics-engine.js';
import type { SessionRegistry } from '../core/session-registry.js';
import type { Logger } from '../utils/logger.js';

/** Maximum accepted request body size, in bytes (D: 64KB -> 413 on overflow). */
const MAX_BODY_BYTES = 64 * 1024;

/** The loopback literals the server is allowed to bind to. */
const ALLOWED_BIND_HOSTS = new Set(['127.0.0.1', '::1']);

/** The WebSocket upgrade path. */
const WS_PATH = '/events';

/** Dependencies for {@link createLocalServer}: the route-context fields + wiring. */
export interface CreateLocalServerDeps {
  ctx: AppContext;
  eventBus: EventBus;
  sessionRegistry: SessionRegistry;
  healthMonitor: HealthMonitor;
  metricsEngine: MetricsEngine;
  logger: Logger;
  /** Token store for Bearer/WS-token verification. */
  tokenStore: TokenStore;
  /** Bind host; defaults to 127.0.0.1. Must resolve to a loopback literal. */
  host?: string;
  /** Bind port; tests pass 0 and read the resolved port from start(). */
  port: number;
  /**
   * Optional in-process reload hook (installed by the daemon). Threaded into the
   * route context for POST /mcp/restart. Omitted when not under a daemon.
   */
  requestReload?: () => void;
}

/** The address a started server is listening on. */
export interface LocalServerAddress {
  host: string;
  port: number;
  url: string;
}

/** Public surface of the local server. */
export interface LocalServer {
  /** Bind and begin serving; resolves with the resolved address. */
  start(): Promise<LocalServerAddress>;
  /** Stop the WS hub and the HTTP server; resolves once fully closed. */
  stop(): Promise<void>;
}

/** Map a KundunError code to an HTTP status (per locked decisions). */
function statusForCode(code: KundunErrorCode): number {
  switch (code) {
    case 'invalid_argument':
    case 'config_invalid':
    case 'config_parse':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
    case 'not_initialized':
    case 'config_not_found':
      return 404;
    case 'payload_too_large':
      return 413;
    case 'storage_locked':
      return 503;
    case 'path_traversal_blocked':
    case 'symlink_escape':
      return 400;
    default:
      return 500;
  }
}

/** Extract the path portion of a request URL (defaults to '/'). */
function requestPath(url: string | undefined): string {
  if (url === undefined || url.length === 0) {
    return '/';
  }
  // Provide a dummy base so a path-only URL parses; query/hash are dropped.
  try {
    return new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

/**
 * Create the local API server. Construction wires the WS hub and the route table
 * but binds NOTHING — call {@link LocalServer.start} to listen.
 */
export function createLocalServer(deps: CreateLocalServerDeps): LocalServer {
  const host = deps.host ?? '127.0.0.1';
  const log = deps.logger.child('local-server');

  const rc: RouteContext = {
    ctx: deps.ctx,
    eventBus: deps.eventBus,
    sessionRegistry: deps.sessionRegistry,
    healthMonitor: deps.healthMonitor,
    metricsEngine: deps.metricsEngine,
    logger: deps.logger,
    ...(deps.requestReload === undefined ? {} : { requestReload: deps.requestReload }),
  };

  const routes: RouteDef[] = buildRoutes(rc);
  const wsHub: WsEventHub = createWsEventHub({ eventBus: deps.eventBus, logger: deps.logger });

  // The port enforced by enforceLoopbackHost is the REAL bound port, captured
  // after 'listening' (tests pass 0). Until then it mirrors the requested port.
  let boundPort = deps.port;
  let httpServer: Server | undefined;

  /** Log a single request outcome (never the token; never a body). */
  function logRequest(method: string, path: string, status: number, authed: boolean): void {
    log.info('request', { method, path, status, authed });
  }

  /** Find a route by exact method+path, distinguishing unknown vs wrong-method. */
  function matchRoute(method: string, path: string): { route?: RouteDef; pathKnown: boolean } {
    let pathKnown = false;
    for (const route of routes) {
      if (route.path === path) {
        pathKnown = true;
        if (route.method === method) {
          return { route, pathKnown: true };
        }
      }
    }
    return { pathKnown };
  }

  /** Read the request body with a hard 64KB cap (throws payload_too_large). */
  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const onData = (chunk: Buffer): void => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          settled = true;
          cleanup();
          // Drain remaining data so the socket can be reused/closed cleanly.
          req.resume();
          reject(new KundunError('payload_too_large', 'Request body exceeds 64KB limit.'));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Buffer.concat(chunks));
      };
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    });
  }

  /** Parse a JSON body buffer; empty body -> undefined; bad JSON -> 400. */
  function parseJsonBody(buf: Buffer): unknown {
    if (buf.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw new KundunError('invalid_argument', 'Request body is not valid JSON.');
    }
  }

  /** The async core of the HTTP request pipeline (errors mapped by the caller). */
  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<{ status: number; authed: boolean }> {
    const method = req.method ?? 'GET';

    // 1) Loopback enforcement (Host + any Origin), BEFORE auth.
    if (!enforceLoopbackHost(req, boundPort)) {
      throw new KundunError('forbidden', 'Request must originate from loopback.');
    }

    // 2) Route match: unknown path -> 404; known path, wrong method -> 405.
    // The KundunErrorCode union has no 405 mapping, so the wrong-method case
    // writes the 405 response directly here rather than throwing a KundunError
    // (a thrown 'invalid_argument' would map to 400).
    const { route, pathKnown } = matchRoute(method, path);
    if (route === undefined) {
      if (pathKnown) {
        jsonError(res, 405, 'method_not_allowed', `Method ${method} not allowed for ${path}.`);
        return { status: 405, authed: false };
      }
      throw new KundunError('not_found', `No route for ${path}.`);
    }

    // 3) Token policy: verify Bearer for token-required routes (401 on fail).
    let authed = false;
    if (route.policy === 'token') {
      const presented = parseBearer(req.headers['authorization']);
      if (!deps.tokenStore.verify(presented)) {
        throw new KundunError('unauthorized', 'Missing or invalid bearer token.');
      }
      authed = true;
    }

    // 4) For POST, read (capped) + parse the JSON body and attach to the request.
    if (method === 'POST') {
      const buf = await readBody(req);
      (req as { body?: unknown }).body = parseJsonBody(buf);
    }

    // 5) Run the handler. It writes the response (status set by the handler).
    await route.handler(req, res, route, rc);
    return { status: res.statusCode, authed };
  }

  /** Top-level HTTP request handler: dispatch, map errors, and log the outcome. */
  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    const path = requestPath(req.url);

    // A real WebSocket upgrade fires the 'upgrade' event and never reaches this
    // request handler, so any GET that lands here for the WS path is a plain
    // (non-upgrade) request: answer 426 Upgrade Required.
    if (path === WS_PATH && method === 'GET') {
      if (!res.headersSent) {
        jsonError(res, 426, 'upgrade_required', 'Use a WebSocket upgrade for /events.');
      }
      logRequest(method, path, 426, false);
      return;
    }

    void dispatch(req, res, path)
      .then(({ status, authed }) => {
        logRequest(method, path, status, authed);
      })
      .catch((err: unknown) => {
        const { status, code, message } = mapError(err);
        if (!res.headersSent) {
          jsonError(res, status, code, message);
        } else {
          res.end();
        }
        logRequest(method, path, status, false);
      });
  }

  /** Handle the HTTP 'upgrade' event: only `/events`, loopback + token gated. */
  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = requestPath(req.url);

    if (path !== WS_PATH) {
      socket.destroy();
      return;
    }

    // Loopback enforcement BEFORE auth (same as HTTP routes).
    if (!enforceLoopbackHost(req, boundPort)) {
      socket.destroy();
      return;
    }

    // The WS upgrade requires the token via ?token= OR an Authorization bearer.
    const presented = parseWsToken(req.url) ?? parseBearer(req.headers['authorization']);
    if (!deps.tokenStore.verify(presented)) {
      socket.destroy();
      return;
    }

    wsHub.handleUpgrade(req, socket, head);
    log.info('ws upgrade', { path, authed: true });
  }

  function start(): Promise<LocalServerAddress> {
    // Validate the bind host is a loopback literal BEFORE listening. Never bind
    // to 0.0.0.0 or any non-loopback address.
    if (!ALLOWED_BIND_HOSTS.has(host)) {
      throw new KundunError(
        'invalid_argument',
        `Refusing to bind local API to non-loopback host '${host}'.`,
      );
    }

    return new Promise<LocalServerAddress>((resolve, reject) => {
      const server = createServer(onRequest);
      httpServer = server;
      server.on('upgrade', onUpgrade);

      const onListenError = (err: Error): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onListenError);
        const address = server.address();
        const resolvedPort =
          address !== null && typeof address === 'object' ? address.port : deps.port;
        boundPort = resolvedPort;
        const url = `http://${host}:${resolvedPort}`;
        log.info('local api listening', { host, port: resolvedPort });
        resolve({ host, port: resolvedPort, url });
      };

      server.once('error', onListenError);
      server.once('listening', onListening);
      server.listen(deps.port, host);
    });
  }

  function stop(): Promise<void> {
    // Tear down all WS clients first so the HTTP server has no open upgrades.
    wsHub.closeAll();

    const server = httpServer;
    if (server === undefined) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      server.close((err) => {
        httpServer = undefined;
        if (err !== undefined && err !== null) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  return { start, stop };
}

/** Map any thrown value to a response status + stable code + safe message. */
function mapError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof KundunError) {
    return { status: statusForCode(err.code), code: err.code, message: err.message };
  }
  // Unknown errors: never leak internals. A generic 500 with no stack/message.
  return { status: 500, code: 'internal_error', message: 'Internal server error.' };
}
