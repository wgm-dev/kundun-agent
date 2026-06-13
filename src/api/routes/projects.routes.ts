// GET /projects (public). The local server is single-project, so this returns a
// one-element list describing the project the daemon is bound to. The shape is a
// list to leave room for a multi-project desktop view later.

import { jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';

/** Build the GET /projects route. */
export function buildProjectsRoutes(rc: RouteContext): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/projects',
      policy: 'public',
      handler: (_req, res) => {
        const { config, projectRoot } = rc.ctx;
        jsonOk(res, 200, [{ projectName: config.projectName, projectRoot }]);
      },
    },
  ];
}
