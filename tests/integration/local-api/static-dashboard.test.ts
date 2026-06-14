// Static dashboard serving (README §MVP3 web dashboard). The local API serves the
// bundled "Kundun Control Center" UI shell as PUBLIC static files, sandboxed to the
// packaged `dashboard/` dir, only after every API route misses and only for
// GET/HEAD. These tests assert the happy path (index, app.js, style.css), the
// sandbox (path-traversal attempts 404 and leak nothing outside the dir), the
// miss case (unknown asset 404s), that the API data routes still win over static,
// and that a wrong method on a static path never serves the file.
//
// Determinism note: in the test environment the source is NOT built, so
// createLocalServer's auto-resolution (relative to the compiled module) cannot
// find the dashboard dir. We pass the repo's real `dashboard/` via startTestApi's
// `dashboardDir` passthrough so static serving is enabled deterministically.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestApi } from '../../helpers/local-api.js';
import type { TestApi } from '../../helpers/local-api.js';
import { httpGet, httpPost } from '../../helpers/http-client.js';

// Resolve the repo's real dashboard dir from this test file's location:
// tests/integration/local-api/ -> ../../../dashboard.
const DASHBOARD_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'dashboard',
);

describe('local API static dashboard (integration)', () => {
  let api: TestApi;

  beforeEach(async () => {
    api = await startTestApi({ dashboardDir: DASHBOARD_DIR });
  });

  afterEach(async () => {
    // Guard: a failed start in beforeEach would leave api undefined.
    if (api !== undefined) {
      await api.close();
    }
  });

  it("GET / serves index.html (200, text/html, contains the 'Kundun' marker)", async () => {
    const res = await httpGet(`${api.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/^text\/html/);
    // A known marker from index.html — the app shell title.
    expect(res.text).toContain('Kundun');
    expect(res.text).toContain('Kundun Control Center');
  });

  it('GET /index.html serves the same shell directly', async () => {
    const res = await httpGet(`${api.url}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/^text\/html/);
    expect(res.text).toContain('Kundun Control Center');
  });

  it('GET /app.js serves the script with a javascript content-type', async () => {
    const res = await httpGet(`${api.url}/app.js`);
    expect(res.status).toBe(200);
    // Accept the common spellings: text/javascript or application/javascript.
    expect(res.headers['content-type'] ?? '').toMatch(/javascript/);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('GET /style.css serves the stylesheet as text/css', async () => {
    const res = await httpGet(`${api.url}/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/^text\/css/);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('a parent-traversal path (GET /../package.json) 404s and leaks nothing', async () => {
    const res = await httpGet(`${api.url}/../package.json`);
    expect(res.status).toBe(404);
    // The body must NOT be package.json content from outside the dashboard dir.
    expect(res.text).not.toContain('"kundun-agent"');
    expect(res.text).not.toContain('"dependencies"');
  });

  it('an encoded-traversal path (GET /..%2f..%2fpackage.json) 404s and leaks nothing', async () => {
    const res = await httpGet(`${api.url}/..%2f..%2fpackage.json`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('"kundun-agent"');
    expect(res.text).not.toContain('"dependencies"');
  });

  it('an encoded-dotdot path (GET /%2e%2e/secret) 404s and leaks nothing', async () => {
    const res = await httpGet(`${api.url}/%2e%2e/secret`);
    expect(res.status).toBe(404);
    // Nothing outside the dashboard dir should ever surface.
    expect(res.text).not.toContain('"dependencies"');
  });

  it('a deep traversal toward a known source file (GET /../src/api/local-server.ts) 404s and leaks nothing', async () => {
    const res = await httpGet(`${api.url}/../src/api/local-server.ts`);
    expect(res.status).toBe(404);
    // A unique string from the source file — proves the file was never read out.
    expect(res.text).not.toContain('createLocalServer');
    expect(res.text).not.toContain('enforceLoopbackHost');
  });

  it('an unknown static path (GET /nope.html) returns 404', async () => {
    const res = await httpGet(`${api.url}/nope.html`);
    expect(res.status).toBe(404);
    // It must not fall back to index.html for arbitrary unknown paths.
    expect(res.text).not.toContain('Kundun Control Center');
  });

  it('the API routes still win over static serving (GET /health is JSON, not HTML)', async () => {
    const res = await httpGet(`${api.url}/health`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/^application\/json/);

    const body = res.json as Record<string, unknown>;
    expect(body).toBeTypeOf('object');
    expect(body.components).toBeTypeOf('object');
    expect(typeof body.schemaVersion).toBe('number');
    // Definitely not the HTML shell.
    expect(res.text).not.toContain('<!doctype html>');
  });

  it('POST / (wrong method on a static path) does NOT serve the index file', async () => {
    const res = await httpPost(`${api.url}/`, { body: {} });
    // Static serving is GET/HEAD only; a POST must never return the HTML shell.
    expect(res.status).not.toBe(200);
    expect(res.text).not.toContain('Kundun Control Center');
  });
});
