import { describe, expect, it, vi } from "vitest";
import { consumeItem } from "../../../src/skills/items/consumeItem.js";
import type { SkillContext } from "../../../src/skills/types.js";

function makeContext(bot: unknown, aborted = false): SkillContext {
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

describe("consumeItem", () => {
  it("is an operator inventory action with no undo claim", () => {
    expect(consumeItem.policy).toEqual({
      minimumRole: "operator",
      effect: "inventory",
      reversible: false,
      mission: "public",
    });
  });

  it("equips and consumes one exact registered food item, then verifies its delta", async () => {
    let apples = 2;
    let food = 10;
    const apple = { name: "apple", type: 260, count: apples, slot: 12 };
    const bot = {
      registry: {
        itemsByName: { apple: { id: 260 } },
        foodsByName: { apple: { foodPoints: 4, saturation: 2.4 } },
      },
      inventory: { items: () => apples ? [{ ...apple, count: apples }] : [] },
      get food() { return food; },
      equip: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn(async () => {
        apples -= 1;
        food += 4;
      }),
    };

    const result = await consumeItem.run({ item: "Apple" }, makeContext(bot));

    expect(bot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: "apple", slot: 12 }), "hand");
    expect(bot.consume).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      data: { item: "apple", consumed: 1, before: 2, after: 1, foodBefore: 10, foodAfter: 14 },
    });
  });

  it("rejects a known non-food item before equipping it", async () => {
    const equip = vi.fn();
    const consume = vi.fn();
    const result = await consumeItem.run(
      { item: "stone" },
      makeContext({
        registry: {
          itemsByName: { stone: { id: 1 } },
          foodsByName: { apple: { foodPoints: 4 } },
        },
        inventory: { items: () => [{ name: "stone", type: 1, count: 1 }] },
        equip,
        consume,
      }),
    );

    expect(equip).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
      recoverable: false,
      details: { item: "stone" },
    });
  });

  it("accepts verified food progress without relying on total inventory, including a replacement container", async () => {
    let honey = 1;
    let glassBottles = 0;
    let food = 18;
    const bot = {
      registry: {
        itemsByName: { honey_bottle: { id: 849 } },
        foodsByName: { honey_bottle: { foodPoints: 6, saturation: 1.2 } },
      },
      inventory: {
        items: () => [
          ...(honey ? [{ name: "honey_bottle", type: 849, count: honey, slot: 8 }] : []),
          ...(glassBottles ? [{ name: "glass_bottle", type: 374, count: glassBottles, slot: 8 }] : []),
        ],
      },
      get food() { return food; },
      equip: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn(async () => {
        honey -= 1;
        glassBottles += 1;
        food += 2;
      }),
    };

    const result = await consumeItem.run({ item: "honey_bottle" }, makeContext(bot));

    expect(result).toMatchObject({
      ok: true,
      data: { item: "honey_bottle", consumed: 1, before: 1, after: 0, foodBefore: 18, foodAfter: 20 },
    });
  });

  it("permits consumption when food registry metadata is unavailable, but still verifies an item delta", async () => {
    let bread = 1;
    const bot = {
      registry: { itemsByName: { bread: { id: 297 } } },
      inventory: { items: () => bread ? [{ name: "bread", type: 297, count: bread, slot: 8 }] : [] },
      food: 10,
      equip: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn(async () => { bread -= 1; }),
    };

    const result = await consumeItem.run({ item: "bread" }, makeContext(bot));

    expect(result).toMatchObject({ ok: true, data: { item: "bread", consumed: 1, before: 1, after: 0 } });
  });

  it("fails instead of claiming consumption when neither item nor food changed", async () => {
    const bot = {
      registry: {
        itemsByName: { apple: { id: 260 } },
        foodsByName: { apple: { foodPoints: 4 } },
      },
      inventory: { items: () => [{ name: "apple", type: 260, count: 1, slot: 8 }] },
      food: 10,
      equip: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue(undefined),
    };

    const result = await consumeItem.run({ item: "apple" }, makeContext(bot));

    expect(result).toMatchObject({
      ok: false,
      code: "STALE_STATE",
      details: { item: "apple", before: 1, after: 1, consumed: 0, foodBefore: 10, foodAfter: 10 },
    });
  });

  it("does not equip or consume after cancellation", async () => {
    const equip = vi.fn();
    const consume = vi.fn();
    const result = await consumeItem.run(
      { item: "apple" },
      makeContext({
        registry: {
          itemsByName: { apple: { id: 260 } },
          foodsByName: { apple: { foodPoints: 4 } },
        },
        inventory: { items: () => [{ name: "apple", type: 260, count: 1, slot: 8 }] },
        equip,
        consume,
      }, true),
    );

    expect(equip).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED", recoverable: true });
  });
});
