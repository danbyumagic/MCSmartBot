import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { upsertLocation } from "../../../src/memory/locations.js";
import { chestDeposit } from "../../../src/skills/resources/chestDeposit.js";
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

describe("chestDeposit", () => {
  it("returns ok:false when the named chest location is not set", async () => {
    const skill = chestDeposit(db);
    const result = await skill.run({ chestName: "main", itemFilter: "", keepCount: 0 }, makeCtx({}));
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no.*location.*main|no.*chest/i);
  });

  it("schema defaults", () => {
    const skill = chestDeposit(db);
    expect(skill.params.parse({ chestName: "main" })).toEqual({
      chestName: "main",
      itemFilter: "",
      keepCount: 0,
    });
  });

  it("deposits matching items while preserving the requested reserve", async () => {
    upsertLocation(db, { name: "farm-storage", x: 1, y: 2, z: 3 });
    const deposit = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const block = { name: "chest", position: new Vec3(1, 2, 3) };
    const bot = {
      inventory: {
        items: () => [
          { name: "carrot", count: 5, type: 1, slot: 10 },
          { name: "carrot", count: 15, type: 1, slot: 11 },
          { name: "wheat", count: 4, type: 2, slot: 12 },
        ],
      },
      pathfinder: { goto: vi.fn().mockResolvedValue(undefined), setGoal: vi.fn() },
      blockAt: vi.fn().mockReturnValue(block),
      openContainer: vi.fn().mockResolvedValue({ deposit, close }),
    };

    const result = await chestDeposit(db).run(
      { chestName: "farm-storage", itemFilter: "carrot", keepCount: 8 },
      makeCtx(bot),
    );

    expect(deposit).toHaveBeenCalledTimes(1);
    expect(deposit).toHaveBeenCalledWith(1, null, 12);
    expect(result).toMatchObject({ ok: true, data: { deposited: 12 } });
    expect(close).toHaveBeenCalledOnce();
  });

  it("name and description mention chest deposit", () => {
    const skill = chestDeposit(db);
    expect(skill.name).toBe("chestDeposit");
    expect(skill.description).toMatch(/chest/i);
  });
});
