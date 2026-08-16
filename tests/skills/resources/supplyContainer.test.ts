import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import minecraftData from "minecraft-data";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { getContainerItems } from "../../../src/memory/containers.js";
import { upsertLocation } from "../../../src/memory/locations.js";
import { supplyContainer } from "../../../src/skills/resources/supplyContainer.js";
import type { SkillContext } from "../../../src/skills/types.js";

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
  upsertLocation(db, { name: "base", x: 0, y: 64, z: 0 });
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

describe("supplyContainer", () => {
  it("returns immediately when live container stock already meets the target", async () => {
    const chest = { name: "chest", position: new Vec3(0, 64, 0) };
    const container = {
      containerItems: () => [{ name: "iron_ingot", type: 265, metadata: 0, count: 64 }],
      close: vi.fn(),
    };
    const bot = {
      registry: { itemsByName: { iron_ingot: { id: 265 } } },
      inventory: { items: () => [] },
      pathfinder: { goto: vi.fn().mockResolvedValue(undefined), setGoal: vi.fn() },
      blockAt: vi.fn().mockReturnValue(chest),
      openContainer: vi.fn().mockResolvedValue(container),
    };
    const result = await supplyContainer(db).run({
      chestName: "base", item: "iron_ingot", quantity: 64, searchRadius: 64,
    }, makeCtx(bot));
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, data: { stored: 64, target: 64 },
    });
  });

  it("mines raw iron and fuel, smelts, deposits, and verifies 64 ingots end to end", async () => {
    const registry = minecraftData("1.21.1");
    const positions = {
      chest: new Vec3(0, 64, 0),
      furnace: new Vec3(2, 64, 0),
      iron: new Vec3(10, 60, 0),
      coal: new Vec3(12, 60, 0),
    };
    const blocks = {
      chest: { name: "chest", position: positions.chest },
      furnace: { name: "furnace", position: positions.furnace },
      iron: { name: "iron_ore", position: positions.iron },
      coal: { name: "coal_ore", position: positions.coal },
    };
    const counts: Record<string, number> = {
      diamond_pickaxe: 1,
      raw_iron: 0,
      coal: 0,
      iron_ingot: 0,
    };
    const itemIds: Record<string, number> = Object.fromEntries(
      ["diamond_pickaxe", "raw_iron", "coal", "iron_ingot"]
        .map((name) => [name, registry.itemsByName[name]!.id]),
    );
    const inventoryItems = () => Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count, type: itemIds[name], metadata: 0 }));

    let storedIngots = 0;
    const container = {
      containerItems: () => storedIngots > 0
        ? [{ name: "iron_ingot", type: itemIds.iron_ingot, metadata: 0, count: storedIngots }]
        : [],
      deposit: vi.fn(async (type: number, _metadata: number, count: number) => {
        if (type === itemIds.iron_ingot) {
          counts.iron_ingot -= count;
          storedIngots += count;
        }
      }),
      close: vi.fn(),
    };

    let furnaceInput = 0;
    let furnaceOutput = 0;
    const furnace = Object.assign(new EventEmitter(), {
      putInput: vi.fn(async (_type: number, _metadata: number, count: number) => {
        counts.raw_iron -= count;
        furnaceInput = count;
      }),
      putFuel: vi.fn(async (_type: number, _metadata: number, count: number) => {
        counts.coal -= count;
        furnaceOutput = furnaceInput;
      }),
      outputItem: vi.fn(() =>
        furnaceOutput > 0 ? { type: itemIds.iron_ingot, count: furnaceOutput } : null,
      ),
      takeOutput: vi.fn(async () => {
        const count = furnaceOutput;
        furnaceOutput = 0;
        counts.iron_ingot += count;
        return { type: itemIds.iron_ingot, count };
      }),
      close: vi.fn(),
    });

    const bot = {
      registry,
      inventory: { items: inventoryItems },
      pathfinder: {
        goto: vi.fn().mockResolvedValue(undefined),
        setGoal: vi.fn(),
        setMovements: vi.fn(),
        bestHarvestTool: vi.fn(() => inventoryItems().find((item) => item.name === "diamond_pickaxe")),
      },
      findBlock: vi.fn(({ matching }: { matching: number[] }) => {
        if (matching[0] === registry.blocksByName.iron_ore.id) return blocks.iron;
        if (matching[0] === registry.blocksByName.coal_ore.id) return blocks.coal;
        if (matching[0] === registry.blocksByName.furnace.id) return blocks.furnace;
        return null;
      }),
      blockAt: vi.fn((position: Vec3) => {
        if (position.equals(positions.chest)) return blocks.chest;
        if (position.equals(positions.furnace)) return blocks.furnace;
        if (position.equals(positions.iron)) return blocks.iron;
        if (position.equals(positions.coal)) return blocks.coal;
        return null;
      }),
      openContainer: vi.fn().mockResolvedValue(container),
      openFurnace: vi.fn().mockResolvedValue(furnace),
      equip: vi.fn().mockResolvedValue(undefined),
      collectBlock: {
        collect: vi.fn(async (block: { name: string }) => {
          if (block.name === "iron_ore") counts.raw_iron += 64;
          if (block.name === "coal_ore") counts.coal += 8;
        }),
      },
    };

    const result = await supplyContainer(db).run({
      chestName: "base",
      item: "iron_ingot",
      quantity: 64,
      searchRadius: 64,
    }, makeCtx(bot));

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, data: { stored: 64, target: 64 },
    });
    expect(storedIngots).toBe(64);
    expect(furnace.putInput).toHaveBeenCalledWith(itemIds.raw_iron, null, 64);
    expect(furnace.putFuel).toHaveBeenCalledWith(itemIds.coal, null, 8);
    expect(container.deposit).toHaveBeenCalledWith(itemIds.iron_ingot, null, 64);
    expect(getContainerItems(db, "base")).toEqual([
      { item: "iron_ingot", itemType: itemIds.iron_ingot, metadata: 0, count: 64 },
    ]);
  });
});
