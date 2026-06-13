// HealthMonitor tests: components are 'ok' on a healthy WAL database; the shared
// errorsLast24h helper counts error/critical health_events plus scan_runs'
// errors_count inside the 24h window (both seeded, clock injected); and check({
// record: true }) writes a health_event when a component is degraded/down.
//
// createHealthMonitor only reads ctx.kdb and ctx.repos.run, so the test builds a
// minimal structural AppContext rather than a full createAppContext wiring.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHealthMonitor, errorsLast24h } from '../../../src/core/health-monitor.js';
import type { AppContext } from '../../../src/core/container.js';
import { HealthRepository } from '../../../src/storage/repositories/health.repository.js';
import { RunRepository } from '../../../src/storage/repositories/run.repository.js';
import { createTestDb, type TestDb } from '../../helpers/test-db.js';
import { nowIso, addDays } from '../../../src/utils/time.js';

/**
 * Insert a finished scan_run with a given started_at and errors_count directly,
 * since RunRepository.startScan/finishScan stamp their own wall-clock times.
 */
function seedScanRun(t: TestDb, startedAt: string, errorsCount: number): void {
  t.kdb.db
    .prepare(
      `INSERT INTO scan_runs
         (started_at, finished_at, files_scanned, files_indexed, files_skipped,
          errors_count, duration_ms, status)
       VALUES (?, ?, 0, 0, 0, ?, 0, 'completed')`,
    )
    .run(startedAt, startedAt, errorsCount);
}

/** Build a minimal AppContext exposing just the fields the monitor reads. */
function makeCtx(t: TestDb): AppContext {
  return {
    kdb: t.kdb,
    repos: { run: new RunRepository(t.kdb) },
  } as unknown as AppContext;
}

describe('errorsLast24h (shared helper)', () => {
  let t: TestDb;
  let healthRepo: HealthRepository;
  let runRepo: RunRepository;

  beforeEach(() => {
    t = createTestDb();
    healthRepo = new HealthRepository(t.kdb);
    runRepo = new RunRepository(t.kdb);
  });

  afterEach(() => {
    t.cleanup();
  });

  it('counts error/critical health_events AND scan_runs.errors_count inside the 24h window', () => {
    const now = '2026-06-13T12:00:00.000Z';
    const inWindow = '2026-06-13T06:00:00.000Z'; // 6h ago
    const outOfWindow = addDays(now, -2); // 48h ago

    // Health events: error + critical inside window count; info ignored; old excluded.
    healthRepo.record({ source: 'scanner', severity: 'error', message: 'e1' }, inWindow);
    healthRepo.record({ source: 'indexer', severity: 'critical', message: 'c1' }, inWindow);
    healthRepo.record({ source: 'scanner', severity: 'info', message: 'i1' }, inWindow);
    healthRepo.record({ source: 'scanner', severity: 'error', message: 'old' }, outOfWindow);

    // Scan runs: errors summed inside window; zero-error and out-of-window excluded.
    seedScanRun(t, inWindow, 3);
    seedScanRun(t, inWindow, 0);
    seedScanRun(t, outOfWindow, 99);

    // 1 error + 1 critical (events) + 3 (scan errors in window) = 5.
    expect(errorsLast24h({ healthRepo, runRepo }, now)).toBe(5);
  });

  it('returns 0 when nothing falls in the window', () => {
    const now = '2026-06-13T12:00:00.000Z';
    healthRepo.record({ source: 'scanner', severity: 'error', message: 'old' }, addDays(now, -3));
    seedScanRun(t, addDays(now, -3), 10);
    expect(errorsLast24h({ healthRepo, runRepo }, now)).toBe(0);
  });
});

describe('HealthMonitor.check', () => {
  let t: TestDb;
  let healthRepo: HealthRepository;

  beforeEach(() => {
    t = createTestDb();
    healthRepo = new HealthRepository(t.kdb);
  });

  afterEach(() => {
    t.cleanup();
  });

  it('reports all components ok on a healthy WAL database', () => {
    const ctx = makeCtx(t);
    const monitor = createHealthMonitor({ ctx, healthRepo, now: () => '2026-06-13T12:00:00.000Z' });

    const report = monitor.check();
    expect(report.components['sqlite']).toBe('ok');
    expect(report.components['wal']).toBe('ok'); // createTestDb opens with WAL
    for (const source of ['scanner', 'indexer', 'cleanup', 'memory', 'task', 'diagnostics']) {
      expect(report.components[source]).toBe('ok');
    }
    expect(report.searchMode).toBe('fts5');
    expect(report.schemaVersion).toBe(5);
    expect(report.errorsLast24h).toBe(0);
    expect(report.avgToolLatencyMs).toBeNull();
    expect(report.generatedAt).toBe('2026-06-13T12:00:00.000Z');
  });

  it('marks a component degraded from a recent error health_event and down from a critical one', () => {
    // worstRecentSeverityBySource uses the real wall clock for its 1-day window,
    // so seed at nowIso() to guarantee the events are inside that window.
    const iso = nowIso();
    healthRepo.record({ source: 'scanner', severity: 'error', message: 'scan failed' }, iso);
    healthRepo.record({ source: 'indexer', severity: 'critical', message: 'index down' }, iso);

    const ctx = makeCtx(t);
    const monitor = createHealthMonitor({ ctx, healthRepo, now: () => iso });

    const report = monitor.check();
    expect(report.components['scanner']).toBe('degraded');
    expect(report.components['indexer']).toBe('down');
  });

  it('check({ record: true }) writes a health_event for each degraded/down component', () => {
    const iso = nowIso();
    healthRepo.record({ source: 'scanner', severity: 'error', message: 'scan failed' }, iso);

    const ctx = makeCtx(t);
    const monitor = createHealthMonitor({ ctx, healthRepo, now: () => iso });

    const before = healthRepo.recentEvents(100, { source: 'health-monitor' }).length;
    monitor.check({ record: true });
    const after = healthRepo.recentEvents(100, { source: 'health-monitor' });

    expect(after.length).toBeGreaterThan(before);
    // The degraded scanner should produce a 'warning' health-monitor event.
    const warnings = after.filter((e) => e.severity === 'warning');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((e) => e.message.includes('scanner'))).toBe(true);
  });

  it('check() without record:true writes no health-monitor events even when degraded', () => {
    const iso = nowIso();
    healthRepo.record({ source: 'scanner', severity: 'error', message: 'scan failed' }, iso);

    const ctx = makeCtx(t);
    const monitor = createHealthMonitor({ ctx, healthRepo, now: () => iso });

    monitor.check(); // record defaults to false
    expect(healthRepo.recentEvents(100, { source: 'health-monitor' })).toHaveLength(0);
  });

  it('feeds avgToolLatencyMs from an injected session registry', () => {
    const ctx = makeCtx(t);
    const monitor = createHealthMonitor({
      ctx,
      healthRepo,
      sessionRegistry: { averageToolLatencyMs: () => 42 },
      now: () => '2026-06-13T12:00:00.000Z',
    });
    expect(monitor.check().avgToolLatencyMs).toBe(42);
  });
});
