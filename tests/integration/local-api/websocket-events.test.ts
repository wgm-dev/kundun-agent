// WebSocket event-stream integration tests (locked decisions):
// - The WS upgrade requires the token via ?token=; a valid token completes the
//   handshake and the client then receives events broadcast from the server's
//   shared event bus.
// - Connecting WITHOUT a token is rejected: the upgrade socket is destroyed, so
//   the client never reaches 'open' (it emits 'error'/'close' instead).
//
// Every wait is guarded by a timeout so a hang fails fast instead of stalling the
// suite. The 'ws' client is used directly here (the server uses ws under the hood
// in noServer mode).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { startTestApi } from '../../helpers/local-api.js';
import type { TestApi } from '../../helpers/local-api.js';
import type { EventPayload } from '../../../src/core/event-bus.js';

/** Build the ws:// URL for the /events endpoint with an optional ?token=. */
function wsUrl(api: TestApi, token?: string): string {
  const base = `ws://${api.host}:${api.port}/events`;
  return token === undefined ? base : `${base}?token=${encodeURIComponent(token)}`;
}

/** Decode a ws RawData frame (Buffer | ArrayBuffer | Buffer[]) to a UTF-8 string. */
function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}

/** Reject after `ms` unless `promise` settles first (keeps tests from hanging). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms waiting for ${label}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Resolve once the socket fires 'open'; reject on 'error'/'close' first. */
function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('error', (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    ws.once('close', () => {
      reject(new Error('socket closed before open'));
    });
  });
}

describe('local API websocket events (integration)', () => {
  let api: TestApi;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    api = await startTestApi();
  });

  afterEach(async () => {
    for (const ws of sockets) {
      try {
        ws.terminate();
      } catch {
        // Best-effort: a socket may already be closed.
      }
    }
    sockets.length = 0;
    await api.close();
  });

  it('a client WITH a valid ?token= receives events emitted on the server bus', async () => {
    const token = api.tokenStore.getToken();
    const ws = new WebSocket(wsUrl(api, token));
    sockets.push(ws);

    await withTimeout(waitForOpen(ws), 3000, 'ws open');

    // After open, the next message we wait for is the one we emit below. (The hub
    // backfills recent history on connect; this fresh bus has none yet.)
    const received = withTimeout(
      new Promise<EventPayload>((resolve, reject) => {
        ws.on('message', (data: WebSocket.RawData) => {
          try {
            resolve(JSON.parse(rawDataToString(data)) as EventPayload);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }),
      3000,
      'ws message',
    );

    api.eventBus.emit('scan.started', { scanId: 123 });

    const event = await received;
    expect(event.type).toBe('scan.started');
    expect(event.data).toEqual({ scanId: 123 });
  });

  it('a client WITHOUT a token is rejected (handshake fails, never opens)', async () => {
    const ws = new WebSocket(wsUrl(api));
    sockets.push(ws);

    // The server destroys the upgrade socket before the handshake completes, so
    // 'open' must never fire — we expect an 'error' or 'close' instead.
    await expect(withTimeout(waitForOpen(ws), 3000, 'ws open (should fail)')).rejects.toThrow();
  });

  it('a client with a WRONG token is rejected (handshake fails)', async () => {
    const wrong = `${api.tokenStore.getToken()}tampered`;
    const ws = new WebSocket(wsUrl(api, wrong));
    sockets.push(ws);

    await expect(withTimeout(waitForOpen(ws), 3000, 'ws open (should fail)')).rejects.toThrow();
  });
});
