import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import { queryWorldObservations } from "../../../src/exploration/store.js";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { surveyArea } from "../../../src/skills/exploration/surveyArea.js";
import type { SkillContext } from "../../../src/skills/types.js";

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

function makeCtx(bot: unknown): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: bot as SkillContext["bot"],
    signal: new AbortController().signal,
    log,
    reportProgress: vi.fn(),
  };
}

describe("surveyArea", () => {
  it("records bounded resource hazard container and landmark observations", async () => {
    const blocks = new Map([
      ["1,64,0", "diamond_ore"],
      ["2,64,0", "lava"],
      ["3,64,0", "chest"],
    ]);
    const bot = {
      game: { dimension: "overworld" },
      registry: {
        blocksByName: {
          diamond_ore: { id: 1 },
          lava: { id: 2 },
          chest: { id: 3 },
        },
      },
      pathfinder: { goto: vi.fn().mockResolvedValue(undefined), setGoal: vi.fn() },
      findBlocks: vi.fn().mockReturnValue([
        new Vec3(1, 64, 0),
        new Vec3(2, 64, 0),
        new Vec3(3, 64, 0),
      ]),
      blockAt: (position: Vec3) => ({
        name: blocks.get(`${position.x},${position.y},${position.z}`) ?? "air",
        position,
      }),
    };
    const result = await surveyArea(db).run({
      dimension: "overworld",
      centerX: 0, centerY: 64, centerZ: 0,
      radius: 16,
      label: "north_mine",
    }, makeCtx(bot));
    expect(result).toMatchObject({ ok: true, data: { observationCount: 4 } });
    expect(bot.findBlocks).toHaveBeenCalledWith(expect.objectContaining({
      maxDistance: 16,
      count: 256,
    }));
    expect(queryWorldObservations(db, {}).map((row) => [row.kind, row.name]))
      .toEqual(expect.arrayContaining([
        ["resource", "diamond_ore"],
        ["hazard", "lava"],
        ["container", "chest"],
        ["landmark", "north_mine"],
      ]));
  });

  it("does not travel when the survey dimension is wrong", async () => {
    const goto = vi.fn();
    const result = await surveyArea(db).run({
      dimension: "the_nether",
      centerX: 0, centerY: 64, centerZ: 0,
      radius: 16,
      label: undefined,
    }, makeCtx({
      game: { dimension: "overworld" },
      pathfinder: { goto, setGoal: vi.fn() },
    }));
    expect(result).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
    expect(goto).not.toHaveBeenCalled();
  });
});
