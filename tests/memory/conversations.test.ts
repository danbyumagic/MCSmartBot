import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { appendConversation, getRecentConversations } from "../../src/memory/conversations.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("conversations", () => {
  it("appends and retrieves in chronological order", () => {
    appendConversation(db, { speaker: "alice", text: "hi", channel: "chat" });
    appendConversation(db, { speaker: "bot", text: "hello", channel: "chat" });
    const rows = getRecentConversations(db, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.speaker).toBe("alice");
    expect(rows[1]!.text).toBe("hello");
  });

  it("respects the limit and returns most recent N in chronological order", () => {
    for (let i = 0; i < 5; i++) {
      appendConversation(db, { speaker: "alice", text: `m${i}`, channel: "chat" });
    }
    const rows = getRecentConversations(db, 3);
    expect(rows.map((r) => r.text)).toEqual(["m2", "m3", "m4"]);
  });
});
