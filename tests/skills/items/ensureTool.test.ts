import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { ensureTool } from "../../../src/skills/items/ensureTool.js";
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

describe("ensureTool", () => {
  it("uses an existing suitable tool without crafting", async () => {
    const block = { name: "stone", position: new Vec3(1, 2, 3) };
    const tool = { name: "iron_pickaxe" };
    const bot = {
      registry: { blocksByName: { stone: { id: 1 } }, itemsByName: {} },
      findBlock: vi.fn().mockReturnValue(block),
      blockAt: vi.fn().mockReturnValue(block),
      pathfinder: { bestHarvestTool: vi.fn().mockReturnValue(tool) },
      equip: vi.fn().mockResolvedValue(undefined),
      craft: vi.fn(),
    };
    const result = await ensureTool.run(
      { block: "stone", searchRadius: 16, craftingTableRadius: 16 },
      makeCtx(bot),
    );
    expect(result.ok).toBe(true);
    expect(bot.equip).toHaveBeenCalledWith(tool, "hand");
    expect(bot.craft).not.toHaveBeenCalled();
  });

  it("crafts and equips an available tool when none is carried", async () => {
    const target = { name: "stone", position: new Vec3(1, 2, 3) };
    const craftedTool = { name: "iron_pickaxe", count: 1 };
    const items: Array<{ name: string; count: number }> = [];
    const recipe = { result: { count: 1 } };
    const bot = {
      registry: {
        blocksByName: { stone: { id: 1 } },
        itemsByName: { iron_pickaxe: { id: 257 } },
      },
      inventory: { items: () => items },
      findBlock: vi.fn().mockReturnValue(target),
      blockAt: vi.fn().mockReturnValue(target),
      pathfinder: {
        bestHarvestTool: vi.fn().mockImplementation(() => items.length ? craftedTool : null),
      },
      recipesFor: vi.fn().mockReturnValue([recipe]),
      craft: vi.fn(async () => { items.push(craftedTool); }),
      equip: vi.fn().mockResolvedValue(undefined),
    };
    const result = await ensureTool.run(
      { block: "stone", searchRadius: 16, craftingTableRadius: 16 },
      makeCtx(bot),
    );
    expect(bot.craft).toHaveBeenCalledWith(recipe, 1, undefined);
    expect(bot.equip).toHaveBeenCalledWith(craftedTool, "hand");
    expect(result).toMatchObject({ ok: true, data: { tool: "iron_pickaxe", crafted: true } });
  });

  it("returns NO_MATERIAL with attempted tools when crafting is impossible", async () => {
    const target = { name: "oak_log", position: new Vec3(1, 2, 3) };
    const bot = {
      registry: {
        blocksByName: { oak_log: { id: 17 }, crafting_table: { id: 58 } },
        itemsByName: { wooden_axe: { id: 271 } },
      },
      inventory: { items: () => [] },
      findBlock: vi.fn(({ matching }) => matching[0] === 17 ? target : null),
      blockAt: vi.fn().mockReturnValue(target),
      pathfinder: { bestHarvestTool: vi.fn().mockReturnValue(null) },
      recipesFor: vi.fn().mockReturnValue([]),
    };
    const result = await ensureTool.run(
      { block: "oak_log", searchRadius: 16, craftingTableRadius: 16 },
      makeCtx(bot),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      details: { toolKind: "axe" },
    });
  });
});
