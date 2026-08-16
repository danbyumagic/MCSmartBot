import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  finishSkillRun,
  getRecentSkillRuns,
  reconcileInterruptedSkillRuns,
  startSkillRun,
} from "../../src/memory/skillRuns.js";

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

describe("skillRuns", () => {
  it("startSkillRun inserts a row in 'running' state", () => {
    const id = startSkillRun(db, { skill: "gotoCoords", params: { x: 1, y: 2, z: 3 } });
    const runs = getRecentSkillRuns(db, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(id);
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.skill).toBe("gotoCoords");
    expect(runs[0]?.params).toEqual({ x: 1, y: 2, z: 3 });
    expect(runs[0]?.ts_end).toBeNull();
  });

  it("finishSkillRun stamps end time, status, summary, and parsed data", () => {
    const id = startSkillRun(db, { skill: "x", params: {} });
    finishSkillRun(db, id, { status: "ok", summary: "done", data: { mined: 4 } });
    const run = getRecentSkillRuns(db, 1)[0]!;
    expect(run.status).toBe("ok");
    expect(run.summary).toBe("done");
    expect(run.data).toEqual({ mined: 4 });
    expect(run.ts_end).toBeGreaterThan(0);
  });

  it("persists structured failure outcomes", () => {
    const id = startSkillRun(db, { skill: "gotoCoords", params: { x: 1 } });
    finishSkillRun(db, id, {
      status: "failed",
      summary: "no route",
      errorCode: "NO_PATH",
      recoverable: true,
      details: { target: { x: 1, y: 2, z: 3 } },
    });
    const run = getRecentSkillRuns(db, 1)[0]!;
    expect(run.errorCode).toBe("NO_PATH");
    expect(run.recoverable).toBe(true);
    expect(run.details).toEqual({ target: { x: 1, y: 2, z: 3 } });
  });

  it("getRecentSkillRuns returns N newest in chronological order", () => {
    for (const s of ["a", "b", "c", "d"]) startSkillRun(db, { skill: s, params: {} });
    const runs = getRecentSkillRuns(db, 2);
    expect(runs.map((r) => r.skill)).toEqual(["c", "d"]);
  });

  it("reconciles only runs interrupted by a prior process", () => {
    const completedId = startSkillRun(db, { skill: "completed", params: {} });
    finishSkillRun(db, completedId, { status: "ok", summary: "done" });
    const interruptedId = startSkillRun(db, { skill: "interrupted", params: {} });

    expect(reconcileInterruptedSkillRuns(db, 12_345)).toBe(1);

    const runs = getRecentSkillRuns(db, 10);
    const completed = runs.find((run) => run.id === completedId)!;
    const interrupted = runs.find((run) => run.id === interruptedId)!;
    expect(completed.status).toBe("ok");
    expect(interrupted).toMatchObject({
      status: "disconnected",
      ts_end: 12_345,
      summary: "interrupted by prior process exit",
      errorCode: "INTERRUPTED",
      recoverable: true,
      details: { reason: "process_restart" },
    });
  });
});
