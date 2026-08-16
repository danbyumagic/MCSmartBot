import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import minecraftData from "minecraft-data";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { upsertFarm } from "../../../src/farming/store.js";
import { harvestFarm } from "../../../src/skills/farming/harvestFarm.js";
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

describe("harvestFarm", () => {
  it("harvests only mature crops inside bounds and replants each one", async () => {
    upsertFarm(db, {
      name: "wheat",
      minX: 0, minY: 65, minZ: 0,
      maxX: 1, maxY: 65, maxZ: 0,
      crop: "wheat",
      seedReserve: 4,
    });
    const registry = minecraftData("1.21.1");
    const counts = { wheat_seeds: 10, wheat: 0 };
    const inventoryItems = () => [
      ...(counts.wheat_seeds > 0 ? [{
        name: "wheat_seeds",
        type: registry.itemsByName.wheat_seeds.id,
        count: counts.wheat_seeds,
      }] : []),
      ...(counts.wheat > 0 ? [{
        name: "wheat",
        type: registry.itemsByName.wheat.id,
        count: counts.wheat,
      }] : []),
    ];
    const mature = {
      name: "wheat",
      position: new Vec3(0, 65, 0),
      metadata: 7,
      getProperties: () => ({ age: 7 }),
    };
    const immature = {
      name: "wheat",
      position: new Vec3(1, 65, 0),
      metadata: 3,
      getProperties: () => ({ age: 3 }),
    };
    const outside = {
      name: "wheat",
      position: new Vec3(2, 65, 0),
      metadata: 7,
      getProperties: () => ({ age: 7 }),
    };
    const soil = (position: Vec3) => ({ name: "farmland", position });
    const collect = vi.fn(async (block: typeof mature) => {
      if (block === mature) {
        counts.wheat += 3;
        counts.wheat_seeds += 2;
      }
    });
    const placeBlock = vi.fn(async () => { counts.wheat_seeds--; });
    const bot = {
      registry,
      game: { dimension: "overworld" },
      inventory: { items: inventoryItems },
      pathfinder: { setMovements: vi.fn() },
      blockAt: vi.fn((position: Vec3) => {
        if (position.equals(mature.position)) return mature;
        if (position.equals(immature.position)) return immature;
        if (position.equals(outside.position)) return outside;
        if (position.y === 64) return soil(position);
        return null;
      }),
      collectBlock: { collect },
      equip: vi.fn().mockResolvedValue(undefined),
      placeBlock,
    };
    const result = await harvestFarm(db).run({ farmName: "wheat" }, makeCtx(bot));
    expect(result).toMatchObject({
      ok: true,
      data: { mature: 1, harvested: 1, replanted: 1, collected: 3 },
    });
    expect(collect).toHaveBeenCalledOnce();
    expect(collect).toHaveBeenCalledWith(mature);
    expect(collect).not.toHaveBeenCalledWith(outside);
    expect(placeBlock).toHaveBeenCalledOnce();
  });

  it("does not destroy a mature crop when no replanting seed is available", async () => {
    upsertFarm(db, {
      name: "wheat",
      minX: 0, minY: 65, minZ: 0,
      maxX: 0, maxY: 65, maxZ: 0,
      crop: "wheat",
    });
    const crop = {
      name: "wheat",
      position: new Vec3(0, 65, 0),
      metadata: 7,
      getProperties: () => ({ age: 7 }),
    };
    const collect = vi.fn();
    const bot = {
      game: { dimension: "overworld" },
      inventory: { items: () => [] },
      blockAt: vi.fn().mockReturnValue(crop),
      collectBlock: { collect },
    };
    const result = await harvestFarm(db).run({ farmName: "wheat" }, makeCtx(bot));
    expect(result).toMatchObject({ ok: false, code: "NO_MATERIAL" });
    expect(collect).not.toHaveBeenCalled();
  });

  it("rejects execution from the wrong dimension", async () => {
    upsertFarm(db, {
      name: "wart",
      dimension: "the_nether",
      minX: 0, minY: 65, minZ: 0,
      maxX: 1, maxY: 65, maxZ: 1,
      crop: "nether_wart",
    });
    const result = await harvestFarm(db).run(
      { farmName: "wart" },
      makeCtx({ game: { dimension: "overworld" } }),
    );
    expect(result).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
  });
});
