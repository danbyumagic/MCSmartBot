import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { upsertLocation } from "../../../src/memory/locations.js";
import { returnToBase } from "../../../src/skills/navigation/returnToBase.js";
import type { SkillContext } from "../../../src/skills/types.js";
import * as pathfinder from "../../../src/skills/pathfinder.js";

vi.mock("../../../src/skills/pathfinder.js", () => ({
  pathfindTo: vi.fn(),
  pathfindingFailureDetails: vi.fn(() => ({})),
  isFlightEnabled: vi.fn(() => false),
  setFlightEnabled: vi.fn(),
  goals: {
    GoalNear: class {
      constructor(public x: number, public y: number, public z: number, public range: number) {}
    },
  },
}));

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

function makeCtx(): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: {} as SkillContext["bot"],
    signal: new AbortController().signal,
    log,
    reportProgress: vi.fn(),
  };
}

describe("returnToBase", () => {
  it("returns a failed result when no 'base' location is set", async () => {
    const ctx = makeCtx();
    const result = await returnToBase(db).run({ range: 1 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no.*base|base.*not.*set/i);
  });

  it("accepts schema with default range", () => {
    expect(returnToBase(db).params.parse({})).toEqual({ range: 1 });
  });

  it("preserves the skill name and a description that mentions base", () => {
    const skill = returnToBase(db);
    expect(skill.name).toBe("returnToBase");
    expect(skill.description).toMatch(/base/i);
  });

  it("returns ok:false on cancellation when signal is pre-aborted", async () => {
    upsertLocation(db, { name: "base", x: 100, y: 70, z: -200 });
    const ctx = makeCtx();
    const aborted = new AbortController();
    aborted.abort();
    vi.mocked(pathfinder.pathfindTo).mockRejectedValueOnce(new Error("aborted"));
    const result = await returnToBase(db).run({ range: 1 }, { ...ctx, signal: aborted.signal });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/cancel/i);
  });
});
