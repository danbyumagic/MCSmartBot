import { describe, it, expect } from "vitest";
import { countInInventory } from "../../src/skills/helpers.js";

function makeBot(items: Array<{ name: string; count: number }>) {
  return {
    inventory: { items: () => items },
  } as unknown as Parameters<typeof countInInventory>[0];
}

describe("countInInventory", () => {
  it("returns 0 for an item not in inventory", () => {
    expect(countInInventory(makeBot([]), "iron_ore")).toBe(0);
    expect(countInInventory(makeBot([{ name: "cobblestone", count: 16 }]), "iron_ore")).toBe(0);
  });

  it("sums multiple stacks of the same item", () => {
    expect(
      countInInventory(
        makeBot([
          { name: "iron_ore", count: 16 },
          { name: "iron_ore", count: 32 },
          { name: "cobblestone", count: 8 },
        ]),
        "iron_ore",
      ),
    ).toBe(48);
  });

  it("ignores items with mismatched names", () => {
    expect(
      countInInventory(
        makeBot([
          { name: "iron_ingot", count: 16 },
          { name: "raw_iron", count: 8 },
        ]),
        "iron_ore",
      ),
    ).toBe(0);
  });
});
