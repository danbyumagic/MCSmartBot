import type { DB } from "./db.js";

export type Channel = "chat" | "cli";

export interface ConversationInput {
  speaker: string;
  text: string;
  channel: Channel;
}

export interface ConversationRow {
  id: number;
  ts: number;
  speaker: string;
  text: string;
  channel: Channel;
}

export function appendConversation(db: DB, input: ConversationInput): ConversationRow {
  const ts = Date.now();
  const res = db
    .prepare("INSERT INTO conversations (ts, speaker, text, channel) VALUES (?, ?, ?, ?)")
    .run(ts, input.speaker, input.text, input.channel);
  return { id: Number(res.lastInsertRowid), ts, ...input };
}

export function getRecentConversations(db: DB, limit: number): ConversationRow[] {
  const rows = db
    .prepare(
      "SELECT id, ts, speaker, text, channel FROM (" +
        "  SELECT id, ts, speaker, text, channel FROM conversations ORDER BY ts DESC, id DESC LIMIT ?" +
        ") sub ORDER BY ts ASC, id ASC",
    )
    .all(limit) as ConversationRow[];
  return rows;
}
