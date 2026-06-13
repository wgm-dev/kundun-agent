// POST /mcp/restart (TOKEN-required). Triggers an in-process daemon reload
// (re-read config, reset timers, emit a health event) — NOT a re-exec.
//
// Policy (locked):
// - The token is verified by the server before this handler (policy 'token').
// - config.allowRestartFromMcp gates the route: when false the route returns 403
//   (the HTTP counterpart of the disabled restart_daemon MCP tool).
// - When enabled but the server is NOT running under a daemon (no reload hook
//   installed on the route context), return {restarted:false, reason:'no daemon
//   running'} as a NON-error 200.
// - When enabled AND under a daemon, invoke the in-process reload hook and return
//   {restarted:true}.

import { KundunError } from '../../utils/errors.js';
import { jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';

/** Build the POST /mcp/restart route. */
export function buildMcpRoutes(rc: RouteContext): RouteDef[] {
  return [
    {
      method: 'POST',
      path: '/mcp/restart',
      policy: 'token',
      handler: (_req, res) => {
        if (!rc.ctx.config.allowRestartFromMcp) {
          // Disabled by config: 403 (the HTTP route's locked behavior).
          throw new KundunError(
            'forbidden',
            'Restart from MCP is disabled (config.allowRestartFromMcp = false).',
          );
        }

        // Enabled but no daemon owns this server: nothing to reload.
        if (rc.requestReload === undefined) {
          jsonOk(res, 200, { restarted: false, reason: 'no daemon running' });
          return;
        }

        // Enabled and under a daemon: trigger the in-process reload.
        rc.requestReload();
        jsonOk(res, 200, { restarted: true });
      },
    },
  ];
}
