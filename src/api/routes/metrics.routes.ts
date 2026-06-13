// GET /metrics (public). Returns the latest persisted metrics snapshot plus a
// short window of recent snapshots, read directly from the MetricsRepository on
// the shared context. This route does NOT take a fresh snapshot (that is the
// metrics engine's job, driven by the daemon timer) — it only surfaces what has
// already been recorded.

import { jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';

/** How many recent snapshots to include alongside the latest one. */
const RECENT_LIMIT = 50;

/** Build the GET /metrics route. */
export function buildMetricsRoutes(rc: RouteContext): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/metrics',
      policy: 'public',
      handler: (_req, res) => {
        const metricsRepo = rc.ctx.repos.metrics;
        const latest = metricsRepo.latest() ?? null;
        const recent = metricsRepo.recent(RECENT_LIMIT);
        jsonOk(res, 200, { latest, recent });
      },
    },
  ];
}
