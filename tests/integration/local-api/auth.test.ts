// Auth-model integration tests for the local API (locked decisions):
// - GET /health is PUBLIC (no token needed).
// - GET /logs is token-required: 401 without, 200 with the valid token.
// - POST /scan is token-required: 401 without, 200 with the valid token.
// - A wrong token is rejected (401) on a token-required route.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestApi } from '../../helpers/local-api.js';
import type { TestApi } from '../../helpers/local-api.js';
import { httpGet, httpPost } from '../../helpers/http-client.js';

describe('local API auth model (integration)', () => {
  let api: TestApi;

  beforeEach(async () => {
    api = await startTestApi();
  });

  afterEach(async () => {
    await api.close();
  });

  it('GET /health works WITHOUT a token (public route)', async () => {
    const res = await httpGet(`${api.url}/health`);
    expect(res.status).toBe(200);
    expect(res.json).toBeTypeOf('object');
    expect(res.json).not.toBeNull();
  });

  it('GET /logs WITHOUT a token returns 401', async () => {
    const res = await httpGet(`${api.url}/logs`);
    expect(res.status).toBe(401);
  });

  it('GET /logs WITH the valid token returns 200', async () => {
    const token = api.tokenStore.getToken();
    const res = await httpGet(`${api.url}/logs`, { token });
    expect(res.status).toBe(200);
    expect(res.json).toBeTypeOf('object');
  });

  it('POST /scan WITHOUT a token returns 401', async () => {
    const res = await httpPost(`${api.url}/scan`, { body: {} });
    expect(res.status).toBe(401);
  });

  it('POST /scan WITH the valid token returns 200', async () => {
    const token = api.tokenStore.getToken();
    const res = await httpPost(`${api.url}/scan`, { token, body: {} });
    expect(res.status).toBe(200);
    expect(res.json).toBeTypeOf('object');
    expect(res.json).not.toBeNull();
  });

  it('a wrong token is rejected with 401 on a token-required route', async () => {
    const wrong = `${api.tokenStore.getToken()}tampered`;
    const logs = await httpGet(`${api.url}/logs`, { token: wrong });
    expect(logs.status).toBe(401);

    const scan = await httpPost(`${api.url}/scan`, { token: wrong, body: {} });
    expect(scan.status).toBe(401);
  });
});
