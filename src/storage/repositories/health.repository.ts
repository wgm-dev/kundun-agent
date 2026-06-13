// Repository for the `health_events` table (migration v5). Records health /
// incident events emitted by the daemon and engines. better-sqlite3 is
// synchronous: no async/await here. All timestamps come from utils/time.ts.

import type { Statement } from 'better-sqlite3';
import type { HealthEventRow, KundunDb } from '../types.js';
import { nowIso } from '../../utils/time.js';

/** Input accepted by {@link HealthRepository.record}. */
export interface RecordHealthInput {
  source: string;
  severity: string;
  message: string;
  detailsJson?: string;
}

/** Filters accepted by {@link HealthRepository.recentEvents}. */
export interface RecentEventsOptions {
  severity?: string;
  source?: string;
}

export class HealthRepository {
  private readonly kdb: KundunDb;
  private readonly recordStmt: Statement;
  private readonly countSinceStmt: Statement;
  private readonly deleteOlderThanStmt: Statement;

  constructor(kdb: KundunDb) {
    this.kdb = kdb;
    const { db } = kdb;

    this.recordStmt = db.prepare(
      `INSERT INTO health_events (source, severity, message, details_json, created_at)
       VALUES (@source, @severity, @message, @detailsJson, @createdAt)`,
    );

    this.countSinceStmt = db.prepare(
      'SELECT COUNT(*) AS c FROM health_events WHERE created_at >= @iso',
    );

    this.deleteOlderThanStmt = db.prepare('DELETE FROM health_events WHERE created_at < @iso');
  }

  /** Insert a health event; returns the new id. */
  record(input: RecordHealthInput, iso: string = nowIso()): number {
    const info = this.recordStmt.run({
      source: input.source,
      severity: input.severity,
      message: input.message,
      detailsJson: input.detailsJson ?? null,
      createdAt: iso,
    });
    return Number(info.lastInsertRowid);
  }

  /**
   * Up to `limit` most recent events (created_at desc), optionally filtered by
   * severity and/or source. Built dynamically so unused filters are omitted.
   */
  recentEvents(limit: number, opts: RecentEventsOptions = {}): HealthEventRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit };

    if (opts.severity != null && opts.severity.length > 0) {
      params['severity'] = opts.severity;
      where.push('severity = @severity');
    }
    if (opts.source != null && opts.source.length > 0) {
      params['source'] = opts.source;
      where.push('source = @source');
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT *
      FROM health_events
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT @limit`;
    return this.kdb.db.prepare(sql).all(params) as HealthEventRow[];
  }

  /** Count of events recorded at or after `iso`. */
  countSince(iso: string): number {
    const row = this.countSinceStmt.get({ iso }) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** Delete events older than `iso`; returns the number of rows removed. */
  deleteOlderThan(iso: string): number {
    return this.deleteOlderThanStmt.run({ iso }).changes;
  }
}
