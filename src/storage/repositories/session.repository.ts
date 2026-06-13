// Repository for the `sessions` table (migration v5). Tracks connected MCP /
// desktop clients across their lifecycle. better-sqlite3 is synchronous: no
// async/await here. All timestamps come from utils/time.ts (caller may pass an
// explicit `iso` so an engine's single `now()` is used consistently).

import type { Statement } from 'better-sqlite3';
import type { KundunDb, SessionRow, SessionStatus } from '../types.js';
import { nowIso } from '../../utils/time.js';

/** Input accepted by {@link SessionRepository.register}. */
export interface RegisterSessionInput {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  transport?: string;
  projectRoot?: string;
  processId?: number;
  metadataJson?: string;
}

/** Result of {@link SessionRepository.markStaleIdle}. */
export interface MarkStaleResult {
  idled: number;
  disconnected: number;
}

export class SessionRepository {
  private readonly registerStmt: Statement;
  private readonly selectIdStmt: Statement;
  private readonly heartbeatStmt: Statement;
  private readonly incrementToolCallStmt: Statement;
  private readonly incrementErrorStmt: Statement;
  private readonly setCurrentOperationStmt: Statement;
  private readonly endStmt: Statement;
  private readonly listActiveStmt: Statement;
  private readonly listRecentStmt: Statement;
  private readonly activeCountStmt: Statement;
  private readonly markIdleStmt: Statement;
  private readonly markDisconnectedStmt: Statement;
  private readonly getBySessionIdStmt: Statement;

  constructor(kdb: KundunDb) {
    const { db } = kdb;

    // Upsert: a re-registering client (same session_id) is reactivated. We do not
    // trust lastInsertRowid on the UPDATE path, so id is resolved by a follow-up
    // SELECT (see register()).
    this.registerStmt = db.prepare(
      `INSERT INTO sessions
         (session_id, client_name, client_version, transport, project_root,
          process_id, started_at, last_activity_at, status, metadata_json)
       VALUES
         (@sessionId, @clientName, @clientVersion, @transport, @projectRoot,
          @processId, @iso, @iso, 'active', @metadataJson)
       ON CONFLICT(session_id) DO UPDATE SET
         status = 'active',
         last_activity_at = @iso,
         ended_at = NULL,
         client_name = COALESCE(@clientName, sessions.client_name),
         client_version = COALESCE(@clientVersion, sessions.client_version),
         transport = COALESCE(@transport, sessions.transport),
         project_root = COALESCE(@projectRoot, sessions.project_root),
         process_id = COALESCE(@processId, sessions.process_id),
         metadata_json = COALESCE(@metadataJson, sessions.metadata_json)`,
    );

    this.selectIdStmt = db.prepare('SELECT id FROM sessions WHERE session_id = ?');

    // A heartbeat keeps a session 'active' (and revives an idle/disconnected one).
    // It does not resurrect a session that was explicitly ended (status set via
    // end()): those are filtered out so a closed session stays closed.
    this.heartbeatStmt = db.prepare(
      `UPDATE sessions
         SET last_activity_at = @iso,
             status = 'active'
       WHERE session_id = @sessionId
         AND status IN ('active', 'idle', 'disconnected')`,
    );

    this.incrementToolCallStmt = db.prepare(
      `UPDATE sessions
         SET tools_called = tools_called + 1,
             last_activity_at = @iso,
             status = 'active'
       WHERE session_id = @sessionId`,
    );

    this.incrementErrorStmt = db.prepare(
      `UPDATE sessions
         SET errors_count = errors_count + 1,
             last_activity_at = @iso,
             status = 'active'
       WHERE session_id = @sessionId`,
    );

    this.setCurrentOperationStmt = db.prepare(
      `UPDATE sessions
         SET current_operation = @op,
             last_activity_at = @iso
       WHERE session_id = @sessionId`,
    );

    this.endStmt = db.prepare(
      `UPDATE sessions
         SET status = @status,
             ended_at = @iso,
             last_activity_at = @iso,
             current_operation = NULL
       WHERE session_id = @sessionId`,
    );

    this.listActiveStmt = db.prepare(
      "SELECT * FROM sessions WHERE status = 'active' ORDER BY last_activity_at DESC",
    );

    this.listRecentStmt = db.prepare(
      'SELECT * FROM sessions ORDER BY started_at DESC LIMIT @limit',
    );

    this.activeCountStmt = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'active'");

    // Active rows that have gone quiet past the idle cutoff become 'idle'.
    this.markIdleStmt = db.prepare(
      `UPDATE sessions
         SET status = 'idle'
       WHERE status = 'active' AND last_activity_at IS NOT NULL
         AND last_activity_at < @idleCutoff`,
    );

    // Idle rows that have gone quiet past the disconnect cutoff become
    // 'disconnected'. Run AFTER markIdle so newly-idled rows are also eligible.
    this.markDisconnectedStmt = db.prepare(
      `UPDATE sessions
         SET status = 'disconnected'
       WHERE status = 'idle' AND last_activity_at IS NOT NULL
         AND last_activity_at < @disconnectCutoff`,
    );

    this.getBySessionIdStmt = db.prepare('SELECT * FROM sessions WHERE session_id = ?');
  }

  /**
   * Register (or reactivate) a session by its `sessionId`. Returns the row id,
   * resolved via a follow-up SELECT so it is correct on both the INSERT and the
   * ON CONFLICT UPDATE path.
   */
  register(input: RegisterSessionInput, iso: string = nowIso()): number {
    this.registerStmt.run({
      sessionId: input.sessionId,
      clientName: input.clientName ?? null,
      clientVersion: input.clientVersion ?? null,
      transport: input.transport ?? null,
      projectRoot: input.projectRoot ?? null,
      processId: input.processId ?? null,
      metadataJson: input.metadataJson ?? null,
      iso,
    });
    const row = this.selectIdStmt.get(input.sessionId) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  /** Touch a session's activity, keeping/restoring it 'active'. */
  heartbeat(sessionId: string, iso: string = nowIso()): void {
    this.heartbeatStmt.run({ sessionId, iso });
  }

  /** Increment a session's tool-call counter and mark it active. */
  incrementToolCall(sessionId: string, iso: string = nowIso()): void {
    this.incrementToolCallStmt.run({ sessionId, iso });
  }

  /** Increment a session's error counter and mark it active. */
  incrementError(sessionId: string, iso: string = nowIso()): void {
    this.incrementErrorStmt.run({ sessionId, iso });
  }

  /** Set (or clear, with null) the session's current operation label. */
  setCurrentOperation(sessionId: string, op: string | null, iso: string = nowIso()): void {
    this.setCurrentOperationStmt.run({ sessionId, op, iso });
  }

  /** End a session with the given terminal status (default 'closed'). */
  end(sessionId: string, status: SessionStatus = 'closed', iso: string = nowIso()): void {
    this.endStmt.run({ sessionId, status, iso });
  }

  /** All currently-active sessions, most recently active first. */
  listActive(): SessionRow[] {
    return this.listActiveStmt.all() as SessionRow[];
  }

  /** Up to `limit` most recently started sessions, newest first. */
  listRecent(limit: number): SessionRow[] {
    return this.listRecentStmt.all({ limit }) as SessionRow[];
  }

  /** Count of currently-active sessions. */
  activeCount(): number {
    const row = this.activeCountStmt.get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * Demote stale sessions in two ordered steps: active rows quiet since before
   * `idleCutoffIso` -> 'idle'; idle rows quiet since before `disconnectCutoffIso`
   * -> 'disconnected'. Returns how many rows each step changed.
   */
  markStaleIdle(
    idleCutoffIso: string,
    disconnectCutoffIso: string,
    _iso: string = nowIso(),
  ): MarkStaleResult {
    const idled = this.markIdleStmt.run({ idleCutoff: idleCutoffIso }).changes;
    const disconnected = this.markDisconnectedStmt.run({
      disconnectCutoff: disconnectCutoffIso,
    }).changes;
    return { idled, disconnected };
  }

  /** Fetch a session by its `session_id`, or undefined when not found. */
  getBySessionId(sessionId: string): SessionRow | undefined {
    return this.getBySessionIdStmt.get(sessionId) as SessionRow | undefined;
  }
}
