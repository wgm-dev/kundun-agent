// Route-table + body-limit + config-gating integration tests (locked decisions):
// - Unknown path -> 404.
// - Known path, wrong method -> 405.
// - POST /scan body over 64KB -> 413.
// - POST /mcp/restart with config.allowRestartFromMcp=false -> 403.
// - GET /health and GET /metrics return sane JSON shapes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestApi } from '../../helpers/local-api.js';
import type { TestApi } from '../../helpers/local-api.js';
import { httpGet, httpPost } from '../../helpers/http-client.js';

describe('local API routes + limits (integration)', () => {
  let api: TestApi;

  beforeEach(async () => {
    // allowRestartFromMcp defaults to false; make it explicit for the 403 case.
    api = await startTestApi({ config: { allowRestartFromMcp: false } });
  });

  afterEach(async () => {
    await api.close();
  });

  it('an unknown path returns 404', async () => {
    const res = await httpGet(`${api.url}/no/such/route`);
    expect(res.status).toBe(404);
  });

  it('a known path with the wrong method returns 405', async () => {
    // /health is a GET route; POSTing to it is a known-path/wrong-method case.
    const res = await httpPost(`${api.url}/health`, { body: {} });
    expect(res.status).toBe(405);
  });

  it('POST /scan with a body over 64KB returns 413', async () => {
    const token = api.tokenStore.getToken();
    // Build a JSON body whose serialized size exceeds the 64KB cap.
    const big = 'x'.repeat(70 * 1024);
    const res = await httpPost(`${api.url}/scan`, { token, body: { force: false, pad: big } });
    expect(res.status).toBe(413);
  });

  it('POST /mcp/restart with allowRestartFromMcp=false returns 403', async () => {
    const token = api.tokenStore.getToken();
    const res = await httpPost(`${api.url}/mcp/restart`, { token, body: {} });
    expect(res.status).toBe(403);
  });

  it('GET /health returns a sane JSON shape', async () => {
    const res = await httpGet(`${api.url}/health`);
    expect(res.status).toBe(200);

    const body = res.json as Record<string, unknown>;
    expect(body).toBeTypeOf('object');
    expect(body.components).toBeTypeOf('object');
    expect(body.components).not.toBeNull();
    expect(typeof body.errorsLast24h).toBe('number');
    expect(['fts5', 'like']).toContain(body.searchMode);
    expect(typeof body.schemaVersion).toBe('number');
    expect(typeof body.generatedAt).toBe('string');
  });

  it('GET /metrics returns a sane JSON shape', async () => {
    const res = await httpGet(`${api.url}/metrics`);
    expect(res.status).toBe(200);

    const body = res.json as Record<string, unknown>;
    expect(body).toBeTypeOf('object');
    // No snapshot has been persisted yet, so `latest` is null and `recent` is [].
    expect('latest' in body).toBe(true);
    expect(Array.isArray(body.recent)).toBe(true);

    // Persist one snapshot via the same repo the server reads from, then assert
    // /metrics surfaces it (the route reads MetricsRepository.latest()/recent()).
    const id = api.ctx.repos.metrics.insertSnapshot(
      {
        active_sessions: 0,
        indexed_files: 0,
        indexed_chunks: 0,
        memory_count: 0,
        task_count: 0,
        diagnostics_count: 0,
        db_size_bytes: 4096,
        avg_tool_latency_ms: null,
        scan_duration_ms: null,
        cleanup_duration_ms: null,
        errors_last_24h: 0,
      },
      new Date().toISOString(),
    );
    expect(id).toBeGreaterThan(0);

    const after = await httpGet(`${api.url}/metrics`);
    const afterBody = after.json as { latest: Record<string, unknown> | null; recent: unknown[] };
    expect(afterBody.latest).not.toBeNull();
    expect(typeof afterBody.latest?.db_size_bytes).toBe('number');
    expect(afterBody.recent.length).toBeGreaterThan(0);
  });
});
