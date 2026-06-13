// GET /health (public). Returns the on-demand health report from the shared
// health monitor. This is a pure read — `check()` with no options never records
// a health_event or emits onto the bus.

import { jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';

/** Build the GET /health route. */
export function buildHealthRoutes(rc: RouteContext): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/health',
      policy: 'public',
      handler: (_req, res) => {
        const report = rc.healthMonitor.check();
        jsonOk(res, 200, report);
      },
    },
  ];
}
