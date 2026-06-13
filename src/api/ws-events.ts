// WebSocket event hub (README §MVP3). This is the ONLY file in the codebase that
// imports the `ws` package; every other layer talks to the hub through the small
// surface returned by `createWsEventHub`.
//
// Lifecycle:
// - A single WebSocketServer is constructed in `noServer: true` mode. The HTTP
//   server owns the upgrade handshake and only calls `handleUpgrade` AFTER the
//   loopback-host and token checks have passed, so the hub never sees an
//   unauthenticated socket.
// - On construction the hub subscribes ONCE to the event bus wildcard and
//   broadcasts every emitted payload to all open clients.
// - A ping/pong heartbeat reaps half-open sockets that stopped responding.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';

import type { EventBus, EventPayload } from '../core/event-bus.js';
import type { Logger } from '../utils/logger.js';

/** Number of recent events replayed to a client right after it connects. */
const BACKFILL_LIMIT = 50;

/** Heartbeat interval: ping every client and reap those that did not pong. */
const HEARTBEAT_MS = 30_000;

/** WebSocket.OPEN readyState literal (avoids importing the value enum). */
const WS_OPEN = 1;

/** Extra per-socket bookkeeping tracked for the heartbeat. */
interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

/** Dependencies required to build the hub. */
export interface WsEventHubDeps {
  eventBus: EventBus;
  logger: Logger;
}

/** Public hub surface consumed by the local HTTP server. */
export interface WsEventHub {
  /**
   * Complete a WebSocket upgrade for an already-authorized request. Callers MUST
   * invoke this ONLY after loopback + token checks pass.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Serialize `payload` and send it to every open client. */
  broadcast(payload: EventPayload): void;
  /** Terminate all clients, stop the heartbeat, and stop the bus subscription. */
  closeAll(): void;
  /** Number of currently tracked clients. */
  clientCount(): number;
}

/**
 * Create the WebSocket event hub. Construction wires the bus subscription and the
 * heartbeat immediately so events emitted before the first client connect are
 * still retained by the bus (and replayed on connect via `recent`).
 */
export function createWsEventHub(deps: WsEventHubDeps): WsEventHub {
  const { eventBus, logger } = deps;
  const log = logger.child('ws-events');

  const wss = new WebSocketServer({ noServer: true });

  /** Serialize an event payload once for all recipients. */
  function serialize(payload: EventPayload): string {
    return JSON.stringify(payload);
  }

  /** Send a pre-serialized message to one client, isolating per-client failures. */
  function sendTo(client: WebSocket, message: string): void {
    if (client.readyState !== WS_OPEN) return;
    try {
      client.send(message);
    } catch (err) {
      // A single failing socket must never abort the broadcast loop.
      log.warn('failed to send to client', { error: String(err) });
    }
  }

  function broadcast(payload: EventPayload): void {
    const message = serialize(payload);
    for (const client of wss.clients) {
      sendTo(client, message);
    }
  }

  // Subscribe ONCE at construction: every bus event fans out to all open clients.
  const unsubscribe = eventBus.on('*', (e) => {
    broadcast(e);
  });

  wss.on('connection', (socket: TrackedSocket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    // Ignore inbound client errors; the heartbeat reaps dead sockets and the
    // 'close' bookkeeping is handled by ws's own client tracking.
    socket.on('error', (err) => {
      log.warn('client socket error', { error: String(err) });
    });

    // Backfill recent history (newest-FIRST) so a fresh client has context.
    const history = eventBus.recent(BACKFILL_LIMIT);
    for (const event of history) {
      sendTo(socket, serialize(event));
    }
  });

  // Heartbeat: terminate sockets that did not answer the previous ping.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const tracked = client as TrackedSocket;
      if (tracked.isAlive === false) {
        tracked.terminate();
        continue;
      }
      tracked.isAlive = false;
      try {
        tracked.ping();
      } catch (err) {
        log.warn('failed to ping client', { error: String(err) });
      }
    }
  }, HEARTBEAT_MS);
  // Do not keep the process alive solely for the heartbeat timer.
  heartbeat.unref();

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  function closeAll(): void {
    clearInterval(heartbeat);
    unsubscribe();
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // Best-effort teardown; a failing terminate must not block the others.
      }
    }
  }

  function clientCount(): number {
    return wss.clients.size;
  }

  return { handleUpgrade, broadcast, closeAll, clientCount };
}
