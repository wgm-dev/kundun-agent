// POST /diagnostics (TOKEN-required). Runs the heuristic diagnostics engine over
// the project, or a single requested path/language. The engine NEVER executes
// project code and sandboxes any supplied path inside the project root
// (resolveWithinRoot), so a malicious `path` cannot escape — this route does not
// re-implement that guard, it relies on the engine's contract.

import { createDiagnosticsEngine } from '../../core/diagnostics-engine.js';
import type { RunDiagnosticsOptions } from '../../core/diagnostics-engine.js';
import { KundunError } from '../../utils/errors.js';
import { jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';

/** Shape of the optional JSON body for POST /diagnostics. */
interface DiagnosticsBody {
  path?: string;
  language?: string;
}

/** Narrow the parsed (unknown) request body to the accepted diagnostics options. */
function parseDiagnosticsBody(body: unknown): RunDiagnosticsOptions {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new KundunError('invalid_argument', 'Request body must be a JSON object.');
  }
  const { path, language } = body as DiagnosticsBody;
  if (path !== undefined && typeof path !== 'string') {
    throw new KundunError('invalid_argument', 'Field "path" must be a string.');
  }
  if (language !== undefined && typeof language !== 'string') {
    throw new KundunError('invalid_argument', 'Field "language" must be a string.');
  }
  const opts: RunDiagnosticsOptions = {};
  if (path !== undefined) {
    opts.path = path;
  }
  if (language !== undefined) {
    opts.language = language;
  }
  return opts;
}

/** Build the POST /diagnostics route. */
export function buildDiagnosticsRoutes(rc: RouteContext): RouteDef[] {
  return [
    {
      method: 'POST',
      path: '/diagnostics',
      policy: 'token',
      handler: (req, res) => {
        const opts = parseDiagnosticsBody((req as { body?: unknown }).body);
        const engine = createDiagnosticsEngine({ ctx: rc.ctx });
        rc.eventBus.emit('diagnostics.started', { ...opts });
        const result = engine.run(opts);
        rc.eventBus.emit('diagnostics.completed', { findings: result.findings });
        jsonOk(res, 200, result);
      },
    },
  ];
}
