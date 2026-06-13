// GET /projects (TOKEN-required). Returns a one-element list describing the
// project the daemon is bound to. It exposes the absolute projectRoot, so it is
// gated behind the token rather than public — an unauthenticated caller must not
// learn the host filesystem layout / username. Legitimate clients (the desktop
// app) always carry the token. The shape is a list to leave room for a
// multi-project view later.

import { jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';

/** Build the GET /projects route. */
export function buildProjectsRoutes(rc: RouteContext): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/projects',
      policy: 'token',
      handler: (_req, res) => {
        const { config, projectRoot } = rc.ctx;
        jsonOk(res, 200, [{ projectName: config.projectName, projectRoot }]);
      },
    },
  ];
}
