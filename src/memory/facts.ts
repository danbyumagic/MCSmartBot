import type { DB } from "./db.js";

export type FactSource = "chat" | "observation" | "cli";

export interface FactInput {
  topic: string;
  text: string;
  source: FactSource;
}

export interface FactRow {
  id: number;
  ts: number;
  topic: string;
  text: string;
  source: FactSource;
}

export function appendFact(db: DB, input: FactInput): FactRow {
  const ts = Date.now();
  const res = db
    .prepare("INSERT INTO facts (ts, topic, text, source) VALUES (?, ?, ?, ?)")
    .run(ts, input.topic, input.text, input.source);
  return { id: Number(res.lastInsertRowid), ts, ...input };
}

export function getFactsByTopic(db: DB, topic: string): FactRow[] {
  return db
    .prepare("SELECT id, ts, topic, text, source FROM facts WHERE topic = ? ORDER BY ts ASC, id ASC")
    .all(topic) as FactRow[];
}

export function getRecentFacts(db: DB, limit: number): FactRow[] {
  return db
    .prepare(
      "SELECT id, ts, topic, text, source FROM (" +
        "  SELECT id, ts, topic, text, source FROM facts ORDER BY ts DESC, id DESC LIMIT ?" +
        ") ORDER BY ts ASC, id ASC",
    )
    .all(limit) as FactRow[];
}
