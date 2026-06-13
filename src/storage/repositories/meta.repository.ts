// Repository for the single-row `project_meta` table. Holds project identity and
// the human-readable schema_version mirror (D2). All timestamps come from
// utils/time.ts. better-sqlite3 is synchronous: no async/await here.

import type { Statement } from 'better-sqlite3';
import type { KundunDb, ProjectMetaRow } from '../types.js';
import { nowIso } from '../../utils/time.js';

/**
 * Reads and writes the lone `project_meta` row.
 *
 * `project_meta.schema_version` is only a human-readable MIRROR of the
 * authoritative `_migrations` table (D2); callers update it via
 * {@link MetaRepository.setSchemaVersion} after running migrations.
 */
export class MetaRepository {
  private readonly selectStmt: Statement;
  private readonly insertStmt: Statement;
  private readonly touchScannedStmt: Statement;
  private readonly setSchemaVersionStmt: Statement;
  private readonly setUpdatedAtStmt: Statement;

  constructor(kdb: KundunDb) {
    const { db } = kdb;

    // Single-row table: always read the first row by ascending id.
    this.selectStmt = db.prepare('SELECT * FROM project_meta ORDER BY id ASC LIMIT 1');

    this.insertStmt = db.prepare(
      `INSERT INTO project_meta
         (project_root, project_name, created_at, updated_at, last_scan_at, schema_version)
       VALUES
         (@projectRoot, @projectName, @createdAt, @updatedAt, NULL, @schemaVersion)`,
    );

    this.touchScannedStmt = db.prepare(
      'UPDATE project_meta SET last_scan_at = @iso, updated_at = @iso',
    );

    this.setSchemaVersionStmt = db.prepare(
      'UPDATE project_meta SET schema_version = @version, updated_at = @updatedAt',
    );

    this.setUpdatedAtStmt = db.prepare('UPDATE project_meta SET updated_at = @iso');
  }

  /**
   * Return the existing row, or INSERT one and return it. On insert,
   * created_at and updated_at share the same `nowIso()` value.
   */
  ensure(projectRoot: string, projectName: string, schemaVersion: number): ProjectMetaRow {
    const existing = this.get();
    if (existing !== undefined) {
      return existing;
    }

    const now = nowIso();
    this.insertStmt.run({
      projectRoot,
      projectName,
      createdAt: now,
      updatedAt: now,
      schemaVersion,
    });

    const created = this.get();
    if (created === undefined) {
      // Should be unreachable: we just inserted a row in this connection.
      throw new Error('project_meta row missing immediately after insert');
    }
    return created;
  }

  /** Return the single project_meta row, or undefined when none exists yet. */
  get(): ProjectMetaRow | undefined {
    return this.selectStmt.get() as ProjectMetaRow | undefined;
  }

  /** Record the latest scan time; also bumps updated_at to the same instant. */
  touchScanned(iso: string): void {
    this.touchScannedStmt.run({ iso });
  }

  /** Mirror the authoritative schema version into project_meta (D2). */
  setSchemaVersion(version: number): void {
    this.setSchemaVersionStmt.run({ version, updatedAt: nowIso() });
  }

  /** Set updated_at explicitly. */
  setUpdatedAt(iso: string): void {
    this.setUpdatedAtStmt.run({ iso });
  }
}
