// POST /scan (TOKEN-required). Runs a project scan followed by indexing of the
// new/changed files. Scans and cleanups are mutually exclusive: this route shares
// the server's single operation lock with /cleanup and returns 409 when an
// operation is already in flight.
//
// The handler is synchronous work wrapped in a route handler — better-sqlite3 is
// synchronous, so the scan/index run to completion inline. The lock is released
// in a finally block so a thrown error never leaves the server wedged.

import { buildIndexer, buildScanner } from '../../core/container.js';
import { KundunError } from '../../utils/errors.js';
import { jsonError, jsonOk } from './index.js';
import type { RouteContext, RouteDef } from './index.js';
import type { OperationLock } from './operation-lock.js';

/** Shape of the optional JSON body for POST /scan. */
interface ScanBody {
  force?: boolean;
}

/** Narrow the parsed (unknown) request body to the accepted scan options. */
function parseScanBody(body: unknown): { force?: boolean } {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new KundunError('invalid_argument', 'Request body must be a JSON object.');
  }
  const force = (body as ScanBody).force;
  if (force !== undefined && typeof force !== 'boolean') {
    throw new KundunError('invalid_argument', 'Field "force" must be a boolean.');
  }
  return force === undefined ? {} : { force };
}

/** Build the POST /scan route, sharing `operationLock` with /cleanup. */
export function buildScanRoutes(rc: RouteContext, operationLock: OperationLock): RouteDef[] {
  return [
    {
      method: 'POST',
      path: '/scan',
      policy: 'token',
      handler: (req, res) => {
        const opts = parseScanBody((req as { body?: unknown }).body);

        if (!operationLock.tryAcquire('scan')) {
          jsonError(
            res,
            409,
            'operation_in_progress',
            `Cannot start scan: a '${operationLock.current() ?? 'unknown'}' operation is already running.`,
          );
          return;
        }

        try {
          const scanner = buildScanner(rc.ctx);
          const indexer = buildIndexer(rc.ctx);

          rc.eventBus.emit('scan.started', {});
          const scan = scanner.scan(opts);
          const toIndex = [...scan.newFiles, ...scan.changedFiles];
          const indexResult = indexer.indexFiles(toIndex);
          rc.eventBus.emit('scan.completed', { scanId: scan.scanId });

          jsonOk(res, 200, {
            scanId: scan.scanId,
            filesScanned: scan.filesScanned,
            filesIndexed: indexResult.indexed,
            filesSkipped: scan.skippedFiles.length + indexResult.skipped,
            removed: scan.removedFiles.length,
            errors: scan.errors.length + indexResult.errors,
          });
        } finally {
          operationLock.release();
        }
      },
    },
  ];
}
