import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { setGoal, clearOpenGoal, getOpenGoal, listGoals } from "../../src/memory/goals.js";

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

describe("goals", () => {
  it("setGoal inserts a new open goal", () => {
    const row = setGoal(db, { text: "keep me supplied with iron", createdBy: "owner" });
    expect(row.status).toBe("open");
    expect(getOpenGoal(db)?.text).toMatch(/iron/);
  });

  it("setGoal marks the prior open goal as done and inserts the new open one", () => {
    const first = setGoal(db, { text: "first", createdBy: "owner" });
    const second = setGoal(db, { text: "second", createdBy: "owner" });
    const all = listGoals(db);
    const byId = new Map(all.map((g) => [g.id, g]));
    expect(byId.get(first.id)?.status).toBe("done");
    expect(byId.get(second.id)?.status).toBe("open");
    expect(getOpenGoal(db)?.id).toBe(second.id);
  });

  it("clearOpenGoal cancels the open goal and returns it", () => {
    const goal = setGoal(db, { text: "x", createdBy: "owner" });
    const cleared = clearOpenGoal(db);
    expect(cleared?.id).toBe(goal.id);
    expect(getOpenGoal(db)).toBeUndefined();
    expect(listGoals(db).find((g) => g.id === goal.id)?.status).toBe("cancelled");
  });

  it("clearOpenGoal is a no-op when nothing is open", () => {
    expect(clearOpenGoal(db)).toBeUndefined();
  });
});
