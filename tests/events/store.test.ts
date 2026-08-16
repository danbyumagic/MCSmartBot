import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getRecentEvents,
  listNotificationRules,
  markEventNotified,
  recordEvent,
  setNotificationRule,
  shouldNotify,
} from "../../src/events/store.js";
import { openDatabase, type DB } from "../../src/memory/db.js";

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

describe("event store", () => {
  it("records filterable events and notification state", () => {
    recordEvent(db, {
      type: "player_join", severity: "info", summary: "bob joined",
      details: { username: "bob" },
    }, 100);
    const failed = recordEvent(db, {
      type: "task_failed", severity: "warning", summary: "task failed",
    }, 200);
    markEventNotified(db, failed.id);
    expect(getRecentEvents(db, {
      minSeverity: "warning",
    })).toMatchObject([{
      type: "task_failed",
      notified: true,
    }]);
    expect(getRecentEvents(db, { eventType: "player_join" })).toHaveLength(1);
  });

  it("uses exact notification rules before the wildcard fallback", () => {
    expect(shouldNotify(db, {
      type: "task_failed", severity: "warning", summary: "failed",
    })).toBe(true);
    expect(shouldNotify(db, {
      type: "player_join", severity: "info", summary: "joined",
    })).toBe(false);
    setNotificationRule(db, {
      eventType: "player_join", minSeverity: "info", enabled: true,
    }, 100);
    expect(shouldNotify(db, {
      type: "player_join", severity: "info", summary: "joined",
    })).toBe(true);
    expect(listNotificationRules(db).map((rule) => rule.eventType))
      .toEqual(["*", "player_join"]);
  });
});
