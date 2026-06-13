// Health monitor (README §health-monitor). Produces a cheap, on-demand snapshot
// of the daemon's component health and a couple of headline metrics. It reads
// only cheap signals — open-database PRAGMAs and recent health_events — and never
// runs an expensive `PRAGMA quick_check` / `integrity_check` on a normal call.
//
// This module also exports the SHARED `errorsLast24h` helper used by BOTH the
// health monitor and the metrics engine, so the two surfaces always agree on the
// "errors in the last 24h" figure (recorded error/critical health_events in the
// window + the summed errors_count of scan_runs that started in the window).
//
// better-sqlite3 is synchronous: nothing here is async.

import type { AppContext } from './container.js';
import type { EventBus } from './event-bus.js';
import type { HealthRepository } from '../storage/repositories/health.repository.js';
import type { RunRepository } from '../storage/repositories/run.repository.js';
import type { KundunDb } from '../storage/types.js';
import { getCurrentVersion } from '../storage/migrations.js';
import { addDays, nowIso } from '../utils/time.js';

/** A component's coarse health state. */
export type ComponentStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/** The health-event sources mapped to engine components. */
const COMPONENT_SOURCES = [
  'scanner',
  'indexer',
  'cleanup',
  'memory',
  'task',
  'diagnostics',
] as const;

/** A component name backed by a health-event `source`. */
type ComponentSource = (typeof COMPONENT_SOURCES)[number];

/**
 * The read-only health report surfaced by the local API / desktop. `components`
 * maps each tracked component to a coarse status; the remaining fields are cheap
 * headline signals computed from the live connection and recent health_events.
 */
export interface HealthReport {
  components: Record<string, ComponentStatus>;
  errorsLast24h: number;
  avgToolLatencyMs: number | null;
  searchMode: 'fts5' | 'like';
  schemaVersion: number;
  generatedAt: string;
}

/** Options accepted by {@link HealthMonitor.check}. */
export interface CheckOptions {
  /**
   * When true, persist a health_event and emit a bus event for every component
   * that is degraded/down. Defaults to false (a pure read).
   */
  record?: boolean;
}

/** The public health-monitor surface. */
export interface HealthMonitor {
  check(opts?: CheckOptions): HealthReport;
}

/**
 * Minimal structural view of a session registry. Optional dependency: when
 * present, its `averageToolLatencyMs()` feeds the report's `avgToolLatencyMs`.
 * The concrete SessionRegistry exposes `avgToolLatencyMs()`; the container's
 * buildHealthMonitor bridges that into this method name. Kept structural to
 * avoid an import cycle.
 */
export interface SessionRegistryLike {
  averageToolLatencyMs?(): number | null;
}

/** Dependencies for the shared {@link errorsLast24h} helper. */
export interface ErrorsLast24hDeps {
  healthRepo: HealthRepository;
  runRepo: RunRepository;
}

/**
 * Errors observed in the 24h window ending at `now`:
 *   - recorded health_events with severity in (error, critical), plus
 *   - the summed errors_count of scan_runs that STARTED in the window.
 *
 * This is the ONE shared definition used by both the health monitor and the
 * metrics engine so the two surfaces never disagree. The scan figure sums each
 * matching run's errors_count (runs with errors_count = 0 contribute nothing).
 */
export function errorsLast24h(deps: ErrorsLast24hDeps, now: string = nowIso()): number {
  const windowStart = addDays(now, -1);

  // Severity-filtered health events in the window. countSince has no severity
  // filter, so use recentEvents (which does) and count error/critical rows whose
  // created_at falls inside the window. recentEvents is newest-first; we stop as
  // soon as a row predates the window.
  const healthEvents =
    countEventsInWindow(deps.healthRepo, 'error', windowStart) +
    countEventsInWindow(deps.healthRepo, 'critical', windowStart);

  const scanErrors = sumScanErrorsSince(deps.runRepo, windowStart);

  return healthEvents + scanErrors;
}

/**
 * Count health_events of a single severity whose created_at is at/after
 * `windowStart`. recentEvents returns newest-first, so iteration short-circuits
 * at the first out-of-window row.
 */
function countEventsInWindow(
  healthRepo: HealthRepository,
  severity: 'error' | 'critical',
  windowStart: string,
): number {
  const events = healthRepo.recentEvents(Number.MAX_SAFE_INTEGER, { severity });
  let count = 0;
  for (const e of events) {
    if (e.created_at < windowStart) {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * Sum the errors_count of scan_runs that started at/after `windowStart`.
 * RunRepository exposes no aggregate method, so we read recent scans (newest
 * first) and accumulate until a run predates the window.
 */
function sumScanErrorsSince(runRepo: RunRepository, windowStart: string): number {
  const rows = runRepo.recentScans(Number.MAX_SAFE_INTEGER);
  let total = 0;
  for (const row of rows) {
    if (row.started_at < windowStart) {
      break;
    }
    total += row.errors_count;
  }
  return total;
}

/** Dependencies for {@link createHealthMonitor}. */
export interface CreateHealthMonitorDeps {
  /** Full app context; `kdb`, `repos.health` and `repos.run` are read from it. */
  ctx: AppContext;
  /** Optional session registry; feeds avg tool latency when present. */
  sessionRegistry?: SessionRegistryLike;
  /** Health-events repository (also reachable via ctx.repos.health). */
  healthRepo: HealthRepository;
  /** Timestamp source; defaults to {@link nowIso}. */
  now?: () => string;
  /** Optional event bus for health.warning / health.error emissions. */
  eventBus?: EventBus;
}

/**
 * Build a {@link HealthMonitor} over a wired {@link AppContext}.
 *
 * `check()` reads only cheap signals: whether the connection is open and in WAL
 * mode (one PRAGMA each), the live schema version, the search backend, and the
 * most-recent health_event per component. It never runs `PRAGMA quick_check`.
 */
export function createHealthMonitor(deps: CreateHealthMonitorDeps): HealthMonitor {
  const { ctx, sessionRegistry, healthRepo, eventBus } = deps;
  const now = deps.now ?? nowIso;
  const kdb = ctx.kdb;
  const runRepo = ctx.repos.run;

  return {
    check(opts: CheckOptions = {}): HealthReport {
      const generatedAt = now();
      const record = opts.record === true;

      const components: Record<string, ComponentStatus> = {
        sqlite: probeSqlite(kdb),
        wal: probeWal(kdb),
      };

      // Engine components: ok unless a recent error/critical health_event from
      // that source exists. We scan the most-recent events per source once.
      const worstBySource = worstRecentSeverityBySource(healthRepo);
      for (const source of COMPONENT_SOURCES) {
        components[source] = componentStatusFromSeverity(worstBySource.get(source));
      }

      const avgToolLatencyMs = sessionRegistry?.averageToolLatencyMs?.() ?? null;

      const report: HealthReport = {
        components,
        errorsLast24h: errorsLast24h({ healthRepo, runRepo }, generatedAt),
        avgToolLatencyMs,
        searchMode: kdb.hasFts5 ? 'fts5' : 'like',
        schemaVersion: getCurrentVersion(kdb.db),
        generatedAt,
      };

      if (record) {
        recordDegradations(report, { healthRepo, eventBus, iso: generatedAt });
      }

      return report;
    },
  };
}

/**
 * Cheap SQLite liveness probe: the connection is open and a trivial PRAGMA
 * succeeds. We read `journal_mode` (which also backs the WAL probe) rather than
 * running an integrity/quick check. Any throw means the connection is down.
 */
function probeSqlite(kdb: KundunDb): ComponentStatus {
  try {
    if (!kdb.db.open) {
      return 'down';
    }
    // A cheap, always-available PRAGMA. Throws if the connection is unusable.
    kdb.db.pragma('journal_mode');
    return 'ok';
  } catch {
    return 'down';
  }
}

/** WAL probe: `journal_mode == wal` is ok; anything else is degraded. */
function probeWal(kdb: KundunDb): ComponentStatus {
  try {
    const mode = kdb.db.pragma('journal_mode', { simple: true });
    return typeof mode === 'string' && mode.toLowerCase() === 'wal' ? 'ok' : 'degraded';
  } catch {
    return 'down';
  }
}

/** How recent a health_event must be to influence a component's status. */
const COMPONENT_WINDOW_DAYS = 1;

/**
 * For each component source, the worst severity seen among its recent
 * health_events inside the component window (error/critical only matter). Sources
 * with no recent error/critical event are absent from the map.
 */
function worstRecentSeverityBySource(
  healthRepo: HealthRepository,
): Map<ComponentSource, 'error' | 'critical'> {
  const windowStart = addDays(nowIso(), -COMPONENT_WINDOW_DAYS);
  const worst = new Map<ComponentSource, 'error' | 'critical'>();

  for (const source of COMPONENT_SOURCES) {
    // Only the most recent handful per source matter; cap the scan cheaply.
    const events = healthRepo.recentEvents(16, { source });
    for (const e of events) {
      if (e.created_at < windowStart) {
        break; // recentEvents is newest-first; older rows cannot qualify.
      }
      if (e.severity === 'critical') {
        worst.set(source, 'critical');
        break; // critical is the worst; no need to look further for this source.
      }
      if (e.severity === 'error' && !worst.has(source)) {
        worst.set(source, 'error');
      }
    }
  }

  return worst;
}

/** Map a component's worst recent severity to its status. */
function componentStatusFromSeverity(severity: 'error' | 'critical' | undefined): ComponentStatus {
  if (severity === 'critical') {
    return 'down';
  }
  if (severity === 'error') {
    return 'degraded';
  }
  return 'ok';
}

/** Context for persisting/emitting a degraded report (record:true path). */
interface RecordContext {
  healthRepo: HealthRepository;
  eventBus?: EventBus | undefined;
  iso: string;
}

/**
 * Persist a health_event and emit a bus event for every component that is
 * degraded or down. A 'down' component records a critical event and emits
 * `health.error`; a 'degraded' component records a warning and emits
 * `health.warning`. Pure-`ok` reports record nothing.
 */
function recordDegradations(report: HealthReport, ctx: RecordContext): void {
  for (const [component, status] of Object.entries(report.components)) {
    if (status !== 'degraded' && status !== 'down') {
      continue;
    }

    const isDown = status === 'down';
    const severity = isDown ? 'critical' : 'warning';
    const message = `Component '${component}' is ${status}`;

    ctx.healthRepo.record(
      {
        source: 'health-monitor',
        severity,
        message,
        detailsJson: JSON.stringify({ component, status }),
      },
      ctx.iso,
    );

    ctx.eventBus?.emit(isDown ? 'health.error' : 'health.warning', {
      component,
      status,
    });
  }
}
