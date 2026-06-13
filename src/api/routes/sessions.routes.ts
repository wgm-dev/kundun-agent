// GET /sessions (public). Returns the most recent sessions from the shared
// in-process session registry plus the live active count. Reads only; never
// mutates session state.

import { jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';

/** How many recent sessions to surface on the listing. */
const RECENT_LIMIT = 100;

/** Build the GET /sessions route. */
export function buildSessionsRoutes(rc: RouteContext): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/sessions',
      policy: 'public',
      handler: (_req, res) => {
        const sessions = rc.sessionRegistry.recent(RECENT_LIMIT);
        const activeCount = rc.sessionRegistry.activeCount();
        jsonOk(res, 200, { sessions, activeCount });
      },
    },
  ];
}
