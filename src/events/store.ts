import type { EventSeverity, WorldEvent } from "../bus/index.js";
import type { DB } from "../memory/db.js";

export const EVENT_SEVERITIES = ["info", "warning", "critical"] as const;

export interface EventLogRow extends WorldEvent {
  id: number;
  ts: number;
  notified: boolean;
}

export interface NotificationRuleRow {
  eventType: string;
  minSeverity: EventSeverity;
  enabled: boolean;
  tsUpdated: number;
}

const RANK: Record<EventSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function recordEvent(
  db: DB,
  event: WorldEvent,
  now = Date.now(),
): EventLogRow {
  const result = db.prepare(
    `INSERT INTO event_log
       (ts, event_type, severity, summary, details_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    now,
    event.type,
    event.severity,
    event.summary,
    JSON.stringify(event.details ?? {}),
  );
  return getEvent(db, Number(result.lastInsertRowid))!;
}

export function markEventNotified(db: DB, id: number): void {
  db.prepare("UPDATE event_log SET notified = 1 WHERE id = ?").run(id);
}

export function getRecentEvents(
  db: DB,
  input: {
    eventType?: string;
    minSeverity?: EventSeverity;
    limit?: number;
  } = {},
): EventLogRow[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (input.eventType) {
    clauses.push("event_type = ?");
    args.push(input.eventType);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT id, ts, event_type, severity, summary, details_json, notified
     FROM event_log ${where}
     ORDER BY ts DESC, id DESC
     LIMIT 500`,
  ).all(...args) as EventDbRow[];
  const minRank = input.minSeverity ? RANK[input.minSeverity] : 0;
  return rows
    .filter((row) => RANK[row.severity] >= minRank)
    .slice(0, input.limit ?? 50)
    .map(mapEvent);
}

export function setNotificationRule(
  db: DB,
  input: {
    eventType: string;
    minSeverity: EventSeverity;
    enabled: boolean;
  },
  now = Date.now(),
): NotificationRuleRow {
  db.prepare(
    `INSERT INTO notification_rules
       (event_type, min_severity, enabled, ts_updated)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_type) DO UPDATE SET
       min_severity = excluded.min_severity,
       enabled = excluded.enabled,
       ts_updated = excluded.ts_updated`,
  ).run(input.eventType, input.minSeverity, input.enabled ? 1 : 0, now);
  return getNotificationRule(db, input.eventType)!;
}

export function getNotificationRule(
  db: DB,
  eventType: string,
): NotificationRuleRow | undefined {
  const row = db.prepare(
    `SELECT event_type, min_severity, enabled, ts_updated
     FROM notification_rules WHERE event_type = ?`,
  ).get(eventType) as RuleDbRow | undefined;
  return row ? mapRule(row) : undefined;
}

export function listNotificationRules(db: DB): NotificationRuleRow[] {
  return (db.prepare(
    `SELECT event_type, min_severity, enabled, ts_updated
     FROM notification_rules ORDER BY event_type`,
  ).all() as RuleDbRow[]).map(mapRule);
}

export function shouldNotify(db: DB, event: WorldEvent): boolean {
  const rule = getNotificationRule(db, event.type) ?? getNotificationRule(db, "*");
  return Boolean(rule?.enabled && RANK[event.severity] >= RANK[rule.minSeverity]);
}

function getEvent(db: DB, id: number): EventLogRow | undefined {
  const row = db.prepare(
    `SELECT id, ts, event_type, severity, summary, details_json, notified
     FROM event_log WHERE id = ?`,
  ).get(id) as EventDbRow | undefined;
  return row ? mapEvent(row) : undefined;
}

interface EventDbRow {
  id: number;
  ts: number;
  event_type: string;
  severity: EventSeverity;
  summary: string;
  details_json: string;
  notified: number;
}

function mapEvent(row: EventDbRow): EventLogRow {
  return {
    id: row.id,
    ts: row.ts,
    type: row.event_type,
    severity: row.severity,
    summary: row.summary,
    details: JSON.parse(row.details_json) as Record<string, unknown>,
    notified: row.notified === 1,
  };
}

interface RuleDbRow {
  event_type: string;
  min_severity: EventSeverity;
  enabled: number;
  ts_updated: number;
}

function mapRule(row: RuleDbRow): NotificationRuleRow {
  return {
    eventType: row.event_type,
    minSeverity: row.min_severity,
    enabled: row.enabled === 1,
    tsUpdated: row.ts_updated,
  };
}
