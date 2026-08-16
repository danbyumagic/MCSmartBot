import type { DB } from "./db.js";
import type { SkillErrorCode } from "../skills/types.js";

export type SkillRunStatus = "running" | "ok" | "failed" | "cancelled" | "disconnected";

export interface SkillRunStart {
  skill: string;
  params: Record<string, unknown>;
}

export interface SkillRunFinish {
  status: Exclude<SkillRunStatus, "running">;
  summary?: string;
  data?: Record<string, unknown>;
  errorCode?: SkillErrorCode;
  recoverable?: boolean;
  details?: Record<string, unknown>;
}

export interface SkillRunRow {
  id: number;
  ts_start: number;
  ts_end: number | null;
  skill: string;
  params: Record<string, unknown>;
  status: SkillRunStatus;
  summary: string | null;
  data: Record<string, unknown> | null;
  errorCode: SkillErrorCode | null;
  recoverable: boolean | null;
  details: Record<string, unknown> | null;
}

export function startSkillRun(db: DB, input: SkillRunStart): number {
  const ts = Date.now();
  const res = db
    .prepare("INSERT INTO skill_runs (ts_start, skill, params_json, status) VALUES (?, ?, ?, 'running')")
    .run(ts, input.skill, JSON.stringify(input.params));
  return Number(res.lastInsertRowid);
}

export function finishSkillRun(db: DB, id: number, end: SkillRunFinish): void {
  const ts = Date.now();
  db.prepare(
    "UPDATE skill_runs SET ts_end = ?, status = ?, summary = ?, data_json = ?, error_code = ?, recoverable = ?, details_json = ? WHERE id = ?",
  ).run(
    ts,
    end.status,
    end.summary ?? null,
    end.data ? JSON.stringify(end.data) : null,
    end.errorCode ?? null,
    end.recoverable === undefined ? null : Number(end.recoverable),
    end.details ? JSON.stringify(end.details) : null,
    id,
  );
}

/**
 * Finalize runs that belonged to a process which exited before recording a
 * terminal outcome. A live process can only own runs created after startup, so
 * every pre-existing `running` row is safe to classify as disconnected.
 */
export function reconcileInterruptedSkillRuns(
  db: DB,
  now = Date.now(),
): number {
  const details = JSON.stringify({ reason: "process_restart" });
  const result = db.prepare(
    `UPDATE skill_runs
     SET ts_end = ?,
         status = 'disconnected',
         summary = COALESCE(summary, 'interrupted by prior process exit'),
         error_code = COALESCE(error_code, 'INTERRUPTED'),
         recoverable = COALESCE(recoverable, 1),
         details_json = COALESCE(details_json, ?)
     WHERE status = 'running'`,
  ).run(now, details);
  return result.changes;
}

export function getRecentSkillRuns(db: DB, limit: number): SkillRunRow[] {
  const rows = db
    .prepare(
      "SELECT id, ts_start, ts_end, skill, params_json, status, summary, data_json, error_code, recoverable, details_json FROM (" +
        "  SELECT id, ts_start, ts_end, skill, params_json, status, summary, data_json, error_code, recoverable, details_json " +
        "  FROM skill_runs ORDER BY ts_start DESC, id DESC LIMIT ?" +
        ") ORDER BY ts_start ASC, id ASC",
    )
    .all(limit) as Array<{
      id: number;
      ts_start: number;
      ts_end: number | null;
      skill: string;
      params_json: string;
      status: SkillRunStatus;
      summary: string | null;
      data_json: string | null;
      error_code: SkillErrorCode | null;
      recoverable: number | null;
      details_json: string | null;
    }>;

  return rows.map((r) => ({
    id: r.id,
    ts_start: r.ts_start,
    ts_end: r.ts_end,
    skill: r.skill,
    params: JSON.parse(r.params_json) as Record<string, unknown>,
    status: r.status,
    summary: r.summary,
    data: r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : null,
    errorCode: r.error_code,
    recoverable: r.recoverable === null ? null : r.recoverable === 1,
    details: r.details_json ? (JSON.parse(r.details_json) as Record<string, unknown>) : null,
  }));
}
