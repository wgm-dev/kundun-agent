// Bind-address + loopback-host enforcement (locked decisions):
// - createLocalServer().start() THROWS before listen when the bind host is not a
//   loopback literal (e.g. '0.0.0.0') — the server never binds 0.0.0.0.
// - With host '127.0.0.1' the server starts and serves.
// - enforceLoopbackHost runs BEFORE auth for every request: a request whose Host
//   header is a non-loopback host is rejected with 403 (even on a public route).

import { afterEach, describe, expect, it } from 'vitest';

import { startTestApi } from '../../helpers/local-api.js';
import type { TestApi } from '../../helpers/local-api.js';
import { httpGet, rawHttpGet } from '../../helpers/http-client.js';
import { KundunError } from '../../../src/utils/errors.js';

describe('local API bind address + loopback host (integration)', () => {
  // Each test owns its harness so a failed start never leaks into the next.
  let api: TestApi | undefined;

  afterEach(async () => {
    if (api !== undefined) {
      await api.close();
      api = undefined;
    }
  });

  it("start() THROWS before listen for a non-loopback bind host ('0.0.0.0')", async () => {
    await expect(startTestApi({ host: '0.0.0.0' })).rejects.toBeInstanceOf(KundunError);
  });

  it("start() succeeds for the loopback host '127.0.0.1'", async () => {
    api = await startTestApi({ host: '127.0.0.1' });
    expect(api.host).toBe('127.0.0.1');
    expect(api.port).toBeGreaterThan(0);

    const res = await httpGet(`${api.url}/health`);
    expect(res.status).toBe(200);
  });

  it('a request with a non-loopback Host header is rejected with 403', async () => {
    api = await startTestApi({ host: '127.0.0.1' });

    // The TCP connection is still to 127.0.0.1, but we forge a non-loopback Host
    // header (fetch/undici refuses to override Host, so this goes via node:http).
    // enforceLoopbackHost runs before routing/auth, so even the public /health
    // route is refused with 403.
    const res = await rawHttpGet(`${api.url}/health`, { hostHeader: 'evil.example.com' });
    expect(res.status).toBe(403);
  });
});
