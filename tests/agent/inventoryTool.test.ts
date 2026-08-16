import { describe, it, expect } from "vitest";
import { createInventoryTool } from "../../src/agent/inventoryTool.js";

function makeBot(partial: Record<string, unknown>) {
  return partial as unknown as Parameters<typeof createInventoryTool>[0];
}

describe("createInventoryTool", () => {
  // ── all ───────────────────────────────────────────────────────────────────

  it("all summary: 'N unique items, including a, b, c'", async () => {
    const bot = makeBot({
      inventory: {
        items: () => [
          { name: "cobblestone", count: 48 },
          { name: "bread", count: 3 },
          { name: "iron_pickaxe", count: 1 },
        ],
      },
    });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "all", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/3 unique items/);
    expect(result.summary).toMatch(/cobblestone/);
    // should NOT contain counts in terse mode
    expect(result.summary).not.toMatch(/48 cobblestone/);
  });

  it("all summary: empty inventory", async () => {
    const bot = makeBot({ inventory: { items: () => [] } });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "all", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/empty/);
  });

  it("all detail: full list with counts, rolls up duplicates", async () => {
    const bot = makeBot({
      inventory: {
        items: () => [
          { name: "cobblestone", count: 16 },
          { name: "bread", count: 3 },
          { name: "cobblestone", count: 32 },
          { name: "iron_pickaxe", count: 1 },
        ],
      },
    });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "all", detail: true });
    expect(result.summary).toMatch(/inventory:/);
    expect(result.summary).toMatch(/48 cobblestone/);
    expect(result.summary).toMatch(/3 bread/);
    expect(result.summary).toMatch(/1 iron_pickaxe/);
    // Order: cobblestone (48) > bread (3) > iron_pickaxe (1)
    const idxCobble = result.summary.indexOf("cobblestone");
    const idxBread = result.summary.indexOf("bread");
    expect(idxCobble).toBeLessThan(idxBread);
  });

  // ── hotbar ────────────────────────────────────────────────────────────────

  it("hotbar summary: 'hotbar has N items'", async () => {
    const bot = makeBot({
      inventory: {
        items: () => [
          { name: "sword", count: 1 },
          { name: "bread", count: 5 },
          { name: "torch", count: 16 },
        ],
      },
    });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "hotbar", detail: false });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/hotbar has 3 items/);
    expect(result.summary).not.toMatch(/sword/);
  });

  it("hotbar detail: full list", async () => {
    const bot = makeBot({
      inventory: {
        items: () => [
          { name: "sword", count: 1 },
          { name: "bread", count: 5 },
        ],
      },
    });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "hotbar", detail: true });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/hotbar:/);
    expect(result.summary).toMatch(/sword/);
    expect(result.summary).toMatch(/bread/);
  });

  // ── held ─────────────────────────────────────────────────────────────────

  it("returns the held item when view='held' (detail flag ignored)", async () => {
    const bot = makeBot({
      inventory: { items: () => [] },
      heldItem: { name: "iron_sword", count: 1 },
    });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "held", detail: false });
    expect(result.summary).toMatch(/held: 1 iron_sword/);
  });

  it("reports 'held: nothing' when hand is empty", async () => {
    const bot = makeBot({ inventory: { items: () => [] }, heldItem: null });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "held", detail: false });
    expect(result.summary).toMatch(/held: nothing/);
  });

  it("held detail:true still returns terse held-item line", async () => {
    const bot = makeBot({
      inventory: { items: () => [] },
      heldItem: { name: "diamond_axe", count: 1 },
    });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "held", detail: true });
    expect(result.summary).toMatch(/held: 1 diamond_axe/);
  });

  it("reports armor, offhand, durability, and enchantments", async () => {
    const slots = Array.from({ length: 46 }, () => null) as Array<Record<string, unknown> | null>;
    slots[5] = {
      name: "diamond_helmet",
      count: 1,
      maxDurability: 363,
      durabilityUsed: 63,
      enchants: [{ name: "protection", lvl: 3 }],
    };
    slots[45] = { name: "shield", count: 1 };
    const bot = makeBot({
      inventory: { items: () => [], slots },
      getEquipmentDestSlot: (destination: string) => ({
        head: 5,
        torso: 6,
        legs: 7,
        feet: 8,
        "off-hand": 45,
      })[destination],
    });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "equipment", detail: true });
    expect(result.summary).toMatch(/head:1 diamond_helmet/);
    expect(result.summary).toMatch(/300\/363 durability/);
    expect(result.summary).toMatch(/protection 3/);
    expect(result.summary).toMatch(/offhand:1 shield/);
  });

  it("checks exact requirements and exposes structured shortages", async () => {
    const bot = makeBot({
      inventory: {
        items: () => [
          { name: "oak_planks", count: 32 },
          { name: "torch", count: 8 },
        ],
      },
    });
    const tool = createInventoryTool(bot);
    const result = await tool.handler({
      view: "summary",
      detail: false,
      requirements: [
        { item: "oak_planks", quantity: 48 },
        { item: "torch", quantity: 4 },
      ],
    });
    expect(result.summary).toMatch(/oak_planks: 32\/48, missing 16/);
    expect(result.summary).toMatch(/torch: 8\/4 ready/);
    expect(result.details).toMatchObject({
      ready: false,
      requirements: [
        { item: "oak_planks", missing: 16, satisfied: false },
        { item: "torch", missing: 0, satisfied: true },
      ],
    });
  });

  // ── error ─────────────────────────────────────────────────────────────────

  it("returns ok:false when not yet spawned (inventory undefined)", async () => {
    const bot = makeBot({});
    const tool = createInventoryTool(bot);
    const result = await tool.handler({ view: "all", detail: false });
    expect(result.ok).toBe(false);
  });
});
