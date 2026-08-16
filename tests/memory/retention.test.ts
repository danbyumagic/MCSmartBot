import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { pruneOldRecords } from "../../src/memory/retention.js";

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

describe("pruneOldRecords", () => {
  it("deletes conversations older than the retention window", () => {
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60 * 1000;
    const fresh = now - 1 * 24 * 60 * 60 * 1000;
    db.prepare("INSERT INTO conversations (ts, speaker, text, channel) VALUES (?, ?, ?, ?)").run(old, "a", "old", "chat");
    db.prepare("INSERT INTO conversations (ts, speaker, text, channel) VALUES (?, ?, ?, ?)").run(fresh, "a", "new", "chat");

    pruneOldRecords(db, { now });

    const rows = db.prepare("SELECT text FROM conversations").all() as { text: string }[];
    expect(rows.map((r) => r.text)).toEqual(["new"]);
  });

  it("deletes skill_runs older than the retention window", () => {
    const now = Date.now();
    const old = now - 8 * 24 * 60 * 60 * 1000;
    const fresh = now - 6 * 24 * 60 * 60 * 1000;
    db.prepare("INSERT INTO skill_runs (ts_start, skill, params_json, status) VALUES (?, ?, ?, 'ok')").run(old, "x", "{}");
    db.prepare("INSERT INTO skill_runs (ts_start, skill, params_json, status) VALUES (?, ?, ?, 'ok')").run(fresh, "y", "{}");

    pruneOldRecords(db, { now });

    const rows = db.prepare("SELECT skill FROM skill_runs").all() as { skill: string }[];
    expect(rows.map((r) => r.skill)).toEqual(["y"]);
  });

  it("deletes event log entries older than 30 days", () => {
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60 * 1000;
    const fresh = now - 29 * 24 * 60 * 60 * 1000;
    const insert = db.prepare(
      `INSERT INTO event_log (ts, event_type, severity, summary)
       VALUES (?, 'test', 'info', ?)`,
    );
    insert.run(old, "old event");
    insert.run(fresh, "new event");
    pruneOldRecords(db, { now });
    const rows = db.prepare("SELECT summary FROM event_log").all() as { summary: string }[];
    expect(rows.map((row) => row.summary)).toEqual(["new event"]);
  });

  it("does not touch facts, locations, or goals", () => {
    const now = Date.now();
    const oldTs = now - 365 * 24 * 60 * 60 * 1000;
    db.prepare("INSERT INTO facts (ts, topic, text, source) VALUES (?, ?, ?, ?)").run(oldTs, "x", "old fact", "chat");
    db.prepare("INSERT INTO locations (ts, name, x, y, z) VALUES (?, ?, ?, ?, ?)").run(oldTs, "ancient", 0, 64, 0);
    db.prepare("INSERT INTO goals (ts, text, status, created_by) VALUES (?, ?, 'done', 'owner')").run(oldTs, "old goal");

    pruneOldRecords(db, { now });

    expect((db.prepare("SELECT COUNT(*) as c FROM facts").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) as c FROM locations").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) as c FROM goals").get() as { c: number }).c).toBe(1);
  });
});
