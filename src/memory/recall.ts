import type { DB } from "./db.js";

export type RecallKind = "fact" | "location";

export interface RecallHit {
  kind: RecallKind;
  ref_id: number;
  topic: string;
  text: string;
}

function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export function recall(db: DB, query: string, limit: number): RecallHit[] {
  const ftsQuery = sanitizeFtsQuery(query);
  const rows = db
    .prepare(
      "SELECT kind, ref_id, topic, text FROM memory_search WHERE memory_search MATCH ? " +
        "ORDER BY rank LIMIT ?",
    )
    .all(ftsQuery, limit) as RecallHit[];
  return rows;
}
