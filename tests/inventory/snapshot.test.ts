import { describe, expect, it } from "vitest";
import {
  checkInventoryRequirements,
  createInventorySnapshot,
  estimateInventorySpace,
  formatInventoryContext,
} from "../../src/inventory/snapshot.js";

function makeBot(partial: Record<string, unknown>) {
  return partial as Parameters<typeof createInventorySnapshot>[0];
}

describe("inventory snapshot", () => {
  it("captures carried items, capacity, equipment, durability, and enchantments", () => {
    const slots = Array.from({ length: 46 }, () => null) as Array<Record<string, unknown> | null>;
    slots[10] = { name: "oak_planks", count: 32, slot: 10 };
    slots[36] = {
      name: "diamond_pickaxe",
      count: 1,
      slot: 36,
      maxDurability: 1561,
      durabilityUsed: 1500,
      enchants: [{ name: "efficiency", lvl: 4 }],
    };
    slots[5] = {
      name: "iron_helmet",
      count: 1,
      slot: 5,
      maxDurability: 165,
      durabilityUsed: 10,
    };
    slots[45] = { name: "shield", count: 1, slot: 45 };
    const carried = [slots[10]!, slots[36]!];
    const bot = makeBot({
      inventory: {
        items: () => carried,
        slots,
        inventoryStart: 9,
        inventoryEnd: 45,
      },
      heldItem: slots[36],
      getEquipmentDestSlot: (destination: string) => ({
        head: 5,
        torso: 6,
        legs: 7,
        feet: 8,
        "off-hand": 45,
      })[destination],
    });

    const snapshot = createInventorySnapshot(bot);

    expect(snapshot.available).toBe(true);
    expect(snapshot.capacity).toBe(36);
    expect(snapshot.usedSlots).toBe(2);
    expect(snapshot.freeSlots).toBe(34);
    expect(snapshot.totals).toEqual([
      { name: "oak_planks", count: 32 },
      { name: "diamond_pickaxe", count: 1 },
    ]);
    expect(snapshot.hotbar[0]?.name).toBe("diamond_pickaxe");
    expect(snapshot.held?.enchantments).toEqual([{ name: "efficiency", level: 4 }]);
    expect(snapshot.equipment.head?.name).toBe("iron_helmet");
    expect(snapshot.equipment.offHand?.name).toBe("shield");
    expect(snapshot.nearBreaking.map((item) => item.name)).toContain("diamond_pickaxe");
    expect(formatInventoryContext(snapshot)).toMatch(/34 free/);
    expect(formatInventoryContext(snapshot)).toMatch(/head:1 iron_helmet/);
  });

  it("reports exact material shortages case-insensitively", () => {
    const bot = makeBot({
      inventory: {
        items: () => [
          { name: "oak_planks", count: 20 },
          { name: "oak_planks", count: 12 },
          { name: "torch", count: 4 },
        ],
      },
    });
    const snapshot = createInventorySnapshot(bot);

    expect(checkInventoryRequirements(snapshot, [
      { item: "OAK_PLANKS", quantity: 40 },
      { item: "torch", quantity: 4 },
    ])).toEqual([
      {
        item: "oak_planks",
        quantity: 40,
        have: 32,
        missing: 8,
        satisfied: false,
      },
      {
        item: "torch",
        quantity: 4,
        have: 4,
        missing: 0,
        satisfied: true,
      },
    ]);
  });

  it("degrades safely before inventory is available", () => {
    const snapshot = createInventorySnapshot(makeBot({}));
    expect(snapshot.available).toBe(false);
    expect(snapshot.carried).toEqual([]);
    expect(formatInventoryContext(snapshot)).toMatch(/unavailable/);
  });

  it("estimates capacity from partial stacks and empty slots", () => {
    const slots = Array.from({ length: 45 }, () => null) as Array<Record<string, unknown> | null>;
    for (let slot = 9; slot < 45; slot++) {
      slots[slot] = { name: `filler_${slot}`, count: 64 };
    }
    slots[10] = { name: "cobblestone", count: 60, stackSize: 64 };
    const bot = makeBot({
      inventory: {
        items: () => slots.slice(9, 45).filter(Boolean),
        slots,
        inventoryStart: 9,
        inventoryEnd: 45,
      },
      registry: { itemsByName: { cobblestone: { stackSize: 64 } } },
    });

    expect(estimateInventorySpace(bot, "cobblestone")).toBe(4);
    expect(estimateInventorySpace(bot, "torch")).toBe(0);
  });
});
