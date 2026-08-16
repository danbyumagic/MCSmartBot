import type { DB } from "./db.js";

export const CONVERSATIONS_RETENTION_DAYS = 30;
export const SKILL_RUNS_RETENTION_DAYS = 7;
export const EVENT_LOG_RETENTION_DAYS = 30;

export interface PruneOptions {
  now?: number;
}

export function pruneOldRecords(db: DB, opts: PruneOptions = {}): void {
  const now = opts.now ?? Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const conversationsCutoff = now - CONVERSATIONS_RETENTION_DAYS * dayMs;
  const skillRunsCutoff = now - SKILL_RUNS_RETENTION_DAYS * dayMs;
  const eventLogCutoff = now - EVENT_LOG_RETENTION_DAYS * dayMs;
  db.transaction(() => {
    db.prepare("DELETE FROM conversations WHERE ts < ?").run(conversationsCutoff);
    db.prepare("DELETE FROM skill_runs WHERE ts_start < ?").run(skillRunsCutoff);
    db.prepare("DELETE FROM event_log WHERE ts < ?").run(eventLogCutoff);
  })();
}
