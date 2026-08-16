import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { equipBestTool } from "../../../src/skills/items/equipBestTool.js";
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

describe("equipBestTool", () => {
  it("returns NO_BLOCK_FOUND when no target block is visible", async () => {
    const bot = {
      registry: { blocksByName: { stone: { id: 1 } } },
      findBlock: vi.fn().mockReturnValue(null),
    };
    const result = await equipBestTool.run(
      { block: "stone", searchRadius: 16 },
      makeCtx(bot),
    );
    expect(result).toMatchObject({ ok: false, code: "NO_BLOCK_FOUND", recoverable: true });
  });

  it("returns NO_TOOL when pathfinder finds no suitable carried tool", async () => {
    const target = { name: "stone", position: new Vec3(1, 2, 3) };
    const bot = {
      registry: { blocksByName: { stone: { id: 1 } } },
      findBlock: vi.fn().mockReturnValue(target),
      blockAt: vi.fn().mockReturnValue(target),
      pathfinder: { bestHarvestTool: vi.fn().mockReturnValue(null) },
    };
    const result = await equipBestTool.run(
      { block: "stone", searchRadius: 16 },
      makeCtx(bot),
    );
    expect(result).toMatchObject({ ok: false, code: "NO_TOOL", recoverable: true });
  });

  it("equips the best tool selected by pathfinder", async () => {
    const target = { name: "stone", position: new Vec3(1, 2, 3) };
    const tool = { name: "diamond_pickaxe" };
    const bot = {
      registry: { blocksByName: { stone: { id: 1 } } },
      findBlock: vi.fn().mockReturnValue(target),
      blockAt: vi.fn().mockReturnValue(target),
      pathfinder: { bestHarvestTool: vi.fn().mockReturnValue(tool) },
      equip: vi.fn().mockResolvedValue(undefined),
    };
    const result = await equipBestTool.run(
      { block: "stone", searchRadius: 16 },
      makeCtx(bot),
    );
    expect(bot.equip).toHaveBeenCalledWith(tool, "hand");
    expect(result).toMatchObject({ ok: true, data: { tool: "diamond_pickaxe", block: "stone" } });
  });
});
