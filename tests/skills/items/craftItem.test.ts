import { describe, expect, it, vi } from "vitest";
import { craftItem } from "../../../src/skills/items/craftItem.js";
import type { SkillContext } from "../../../src/skills/types.js";

function makeCtx(bot: unknown, aborted = false): SkillContext {
  const controller = new AbortController();
  if (aborted) controller.abort();
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: bot as SkillContext["bot"],
    signal: controller.signal,
    log,
    reportProgress: vi.fn(),
  };
}

describe("craftItem", () => {
  it("validates and supplies the crafting-table radius default", () => {
    expect(craftItem.params.parse({ item: "stick", quantity: 4 })).toEqual({
      item: "stick", quantity: 4, craftingTableRadius: 16,
    });
  });

  it("returns INVALID_PARAMS for an unknown item", async () => {
    const bot = { registry: { itemsByName: {} }, inventory: { items: () => [] } };
    const result = await craftItem.run(
      { item: "unobtanium", quantity: 1, craftingTableRadius: 16 },
      makeCtx(bot),
    );
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS", recoverable: false });
  });

  it("crafts enough recipe batches to reach the requested total", async () => {
    let sticks = 1;
    const recipe = { result: { count: 4 } };
    const bot = {
      registry: { itemsByName: { stick: { id: 280 } }, blocksByName: {} },
      inventory: { items: () => sticks ? [{ name: "stick", count: sticks }] : [] },
      recipesFor: vi.fn().mockReturnValue([recipe]),
      craft: vi.fn(async (_recipe, count) => { sticks += count * 4; }),
    };
    const result = await craftItem.run(
      { item: "stick", quantity: 9, craftingTableRadius: 16 },
      makeCtx(bot),
    );
    expect(bot.craft).toHaveBeenCalledWith(recipe, 2, undefined);
    expect(result).toMatchObject({ ok: true, data: { total: 9, crafted: 8 } });
  });

  it("waits for delayed server inventory updates before verifying the target", async () => {
    let sticks = 1;
    const recipe = { result: { count: 4 } };
    const bot = {
      registry: { itemsByName: { stick: { id: 280 } }, blocksByName: {} },
      inventory: { items: () => sticks ? [{ name: "stick", count: sticks }] : [] },
      recipesFor: vi.fn().mockReturnValue([recipe]),
      craft: vi.fn(async () => {
        setTimeout(() => {
          sticks = 9;
        }, 20);
      }),
    };

    const result = await craftItem.run(
      { item: "stick", quantity: 9, craftingTableRadius: 16 },
      makeCtx(bot),
    );

    expect(result).toMatchObject({ ok: true, data: { total: 9, crafted: 8 } });
  });

  it("returns recoverable NO_MATERIAL when no usable recipe exists", async () => {
    const bot = {
      registry: {
        itemsByName: { iron_pickaxe: { id: 257 } },
        blocksByName: { crafting_table: { id: 58 } },
      },
      inventory: { items: () => [] },
      recipesFor: vi.fn().mockReturnValue([]),
      findBlock: vi.fn().mockReturnValue(null),
    };
    const result = await craftItem.run(
      { item: "iron_pickaxe", quantity: 1, craftingTableRadius: 16 },
      makeCtx(bot),
    );
    expect(result).toMatchObject({ ok: false, code: "NO_MATERIAL", recoverable: true });
  });

  it("reports exact missing recipe ingredients", async () => {
    const recipe = {
      result: { count: 1 },
      requiresTable: true,
      delta: [
        { id: 5, count: -3 },
        { id: 280, count: -2 },
        { id: 257, count: 1 },
      ],
    };
    const bot = {
      registry: {
        itemsByName: { iron_pickaxe: { id: 257, stackSize: 1 } },
        items: {
          5: { name: "oak_planks" },
          280: { name: "stick" },
        },
        blocksByName: { crafting_table: { id: 58 } },
      },
      inventory: {
        items: () => [{ name: "oak_planks", type: 5, count: 1 }],
      },
      recipesFor: vi.fn().mockReturnValue([]),
      recipesAll: vi.fn().mockReturnValue([recipe]),
      findBlock: vi.fn().mockReturnValue(null),
    };

    const result = await craftItem.run(
      { item: "iron_pickaxe", quantity: 1, craftingTableRadius: 16 },
      makeCtx(bot),
    );

    expect(result.summary).toMatch(/missing 2 oak_planks, 2 stick/);
    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      details: {
        recipeRequiresTable: true,
        craftingTableFound: false,
        missingMaterials: [
          { item: "oak_planks", required: 3, have: 1, missing: 2 },
          { item: "stick", required: 2, have: 0, missing: 2 },
        ],
      },
    });
  });

  it("returns INTERRUPTED before attempting a craft", async () => {
    const bot = {
      registry: { itemsByName: { stick: { id: 280 } } },
      inventory: { items: () => [] },
    };
    const result = await craftItem.run(
      { item: "stick", quantity: 1, craftingTableRadius: 16 },
      makeCtx(bot, true),
    );
    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED" });
  });
});
