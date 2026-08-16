import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { appendFact, getFactsByTopic, getRecentFacts } from "../../src/memory/facts.js";

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

describe("facts", () => {
  it("appends and reads back by topic", () => {
    appendFact(db, { topic: "iron", text: "the south vein is exhausted", source: "chat" });
    appendFact(db, { topic: "preferences", text: "owner prefers cobble walls", source: "chat" });
    const iron = getFactsByTopic(db, "iron");
    expect(iron.map((r) => r.text)).toEqual(["the south vein is exhausted"]);
    const prefs = getFactsByTopic(db, "preferences");
    expect(prefs).toHaveLength(1);
  });

  it("getRecentFacts returns the N most recent regardless of topic, newest last", () => {
    for (let i = 0; i < 4; i++) {
      appendFact(db, { topic: `t${i}`, text: `fact ${i}`, source: "chat" });
    }
    const out = getRecentFacts(db, 2);
    expect(out.map((r) => r.text)).toEqual(["fact 2", "fact 3"]);
  });

  it("topic lookup is case-sensitive (matches the schema)", () => {
    appendFact(db, { topic: "Iron", text: "a", source: "chat" });
    expect(getFactsByTopic(db, "iron")).toHaveLength(0);
    expect(getFactsByTopic(db, "Iron")).toHaveLength(1);
  });
});
