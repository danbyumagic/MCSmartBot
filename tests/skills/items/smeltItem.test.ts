import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";

vi.mock("mineflayer-pathfinder", () => {
  class FakeMovements {
    allowFreeMotion = false;
    canOpenDoors = false;
    allowParkour = true;
    allowEntityDetection = true;
    canDig = true;
    constructor(_bot: unknown) {}
  }
  class FakeGoalNear {
    constructor(
      public x: number,
      public y: number,
      public z: number,
      public range: number,
    ) {}
  }
  return {
    default: {
      goals: { GoalNear: FakeGoalNear },
      Movements: FakeMovements,
      pathfinder: vi.fn(),
    },
  };
});

import { smeltItem } from "../../../src/skills/items/smeltItem.js";
import type { SkillContext } from "../../../src/skills/types.js";

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

function baseBot(items: Array<{ name: string; count: number }>) {
  return {
    registry: {
      itemsByName: {
        raw_iron: { id: 100 },
        iron_ingot: { id: 101 },
        coal: { id: 102 },
      },
      blocksByName: { furnace: { id: 61 } },
    },
    inventory: { items: () => items },
  };
}

describe("smeltItem", () => {
  it("defaults to coal and a 16 block furnace search", () => {
    expect(smeltItem.params.parse({
      input: "raw_iron", output: "iron_ingot", quantity: 8,
    })).toEqual({
      input: "raw_iron", output: "iron_ingot", quantity: 8,
      fuel: "coal", furnaceRadius: 16,
    });
  });

  it("reports missing input as recoverable NO_MATERIAL", async () => {
    const result = await smeltItem.run(
      { input: "raw_iron", output: "iron_ingot", quantity: 8, fuel: "coal", furnaceRadius: 16 },
      makeCtx(baseBot([{ name: "raw_iron", count: 2 }, { name: "coal", count: 1 }])),
    );
    expect(result).toMatchObject({ ok: false, code: "NO_MATERIAL", recoverable: true });
  });

  it("reports insufficient fuel separately", async () => {
    const result = await smeltItem.run(
      { input: "raw_iron", output: "iron_ingot", quantity: 9, fuel: "coal", furnaceRadius: 16 },
      makeCtx(baseBot([{ name: "raw_iron", count: 9 }, { name: "coal", count: 1 }])),
    );
    expect(result).toMatchObject({ ok: false, code: "NO_FUEL", recoverable: true });
  });

  it("loads a nearby furnace, inserts supplies, and collects output", async () => {
    const furnace = Object.assign(new EventEmitter(), {
      putInput: vi.fn().mockResolvedValue(undefined),
      putFuel: vi.fn().mockResolvedValue(undefined),
      outputItem: vi.fn().mockReturnValue({ type: 101, count: 4 }),
      takeOutput: vi.fn().mockResolvedValue({ type: 101, count: 4 }),
      close: vi.fn(),
    });
    const position = new Vec3(1, 2, 3);
    const block = { name: "furnace", position };
    const bot = Object.assign(baseBot([
      { name: "raw_iron", count: 4 },
      { name: "coal", count: 1 },
    ]), {
      findBlock: vi.fn().mockReturnValue(block),
      blockAt: vi.fn().mockReturnValue(block),
      pathfinder: {
        goto: vi.fn().mockResolvedValue(undefined),
        setGoal: vi.fn(),
        setMovements: vi.fn(),
        bestHarvestTool: vi.fn(),
      },
      openFurnace: vi.fn().mockResolvedValue(furnace),
    });

    const result = await smeltItem.run(
      { input: "raw_iron", output: "iron_ingot", quantity: 4, fuel: "coal", furnaceRadius: 16 },
      makeCtx(bot),
    );

    expect(result).toMatchObject({ ok: true });
    expect(furnace.putInput).toHaveBeenCalledWith(100, null, 4);
    expect(furnace.putFuel).toHaveBeenCalledWith(102, null, 1);
    expect(furnace.takeOutput).toHaveBeenCalledOnce();
    expect(furnace.close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, data: { smelted: 4 } });
  });
});
