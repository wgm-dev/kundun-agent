// POST /cleanup (TOKEN-required). Runs the retention cleanup engine, optionally as
// a dry run. Shares the server's single operation lock with /scan so the two
// mutating operations never interleave; a concurrent attempt returns 409.
//
// A dry run writes nothing (D7) but still holds the lock for the duration of the
// candidate gathering. The lock is released in finally so a thrown error never
// leaves the server wedged.

import { buildCleanupEngine } from '../../core/container.js';
import { KundunError } from '../../utils/errors.js';
import { jsonError, jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';
import type { OperationLock } from './operation-lock.js';

/** Shape of the optional JSON body for POST /cleanup. */
interface CleanupBody {
  dryRun?: boolean;
}

/** Narrow the parsed (unknown) request body to the accepted cleanup options. */
function parseCleanupBody(body: unknown): { dryRun?: boolean } {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new KundunError('invalid_argument', 'Request body must be a JSON object.');
  }
  const dryRun = (body as CleanupBody).dryRun;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new KundunError('invalid_argument', 'Field "dryRun" must be a boolean.');
  }
  return dryRun === undefined ? {} : { dryRun };
}

/** Build the POST /cleanup route, sharing `operationLock` with /scan. */
export function buildCleanupRoutes(rc: RouteContext, operationLock: OperationLock): RouteDef[] {
  return [
    {
      method: 'POST',
      path: '/cleanup',
      policy: 'token',
      handler: (req, res) => {
        const opts = parseCleanupBody((req as { body?: unknown }).body);

        if (!operationLock.tryAcquire('cleanup')) {
          jsonError(
            res,
            409,
            'operation_in_progress',
            `Cannot start cleanup: a '${operationLock.current() ?? 'unknown'}' operation is already running.`,
          );
          return;
        }

        try {
          const cleanup = buildCleanupEngine(rc.ctx);
          rc.eventBus.emit('cleanup.started', {});
          const result = cleanup.run(opts);
          if (opts.dryRun !== true) {
            rc.eventBus.emit('cleanup.completed', { removedFiles: result.removedFiles });
          }
          jsonOk(res, 200, result);
        } finally {
          operationLock.release();
        }
      },
    },
  ];
}
