import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { appendFact } from "../../src/memory/facts.js";
import { upsertLocation } from "../../src/memory/locations.js";
import { recall } from "../../src/memory/recall.js";

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

describe("recall", () => {
  it("returns matching facts with topic and text", () => {
    appendFact(db, { topic: "iron", text: "south vein is exhausted", source: "chat" });
    const hits = recall(db, "south", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("fact");
    expect(hits[0]?.topic).toBe("iron");
    expect(hits[0]?.text).toMatch(/south/);
  });

  it("returns matching locations including notes", () => {
    upsertLocation(db, { name: "base", x: 0, y: 64, z: 0, notes: "near the river" });
    const hits = recall(db, "river", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("location");
    expect(hits[0]?.topic).toBe("base");
  });

  it("respects the limit", () => {
    for (let i = 0; i < 5; i++) {
      appendFact(db, { topic: "diamond", text: `note ${i} about diamonds`, source: "chat" });
    }
    expect(recall(db, "diamonds", 2)).toHaveLength(2);
  });

  it("returns an empty array on no matches", () => {
    expect(recall(db, "nope", 5)).toEqual([]);
  });

  it("ignores malformed FTS queries gracefully", () => {
    appendFact(db, { topic: "x", text: "anything", source: "chat" });
    expect(() => recall(db, "any\"thing", 5)).not.toThrow();
  });
});
