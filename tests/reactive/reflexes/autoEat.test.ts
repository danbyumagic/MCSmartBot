import { describe, it, expect } from "vitest";
import { isEdible, findEdible, autoEat } from "../../../src/reactive/reflexes/autoEat.js";

function fakeItem(name: string): { name: string } {
  return { name };
}

describe("autoEat helpers", () => {
  it("isEdible recognizes common foods", () => {
    expect(isEdible(fakeItem("bread") as unknown as Parameters<typeof isEdible>[0])).toBe(true);
    expect(isEdible(fakeItem("cooked_porkchop") as unknown as Parameters<typeof isEdible>[0])).toBe(true);
    expect(isEdible(fakeItem("sweet_berries") as unknown as Parameters<typeof isEdible>[0])).toBe(true);
  });

  it("isEdible rejects non-foods", () => {
    expect(isEdible(fakeItem("iron_ingot") as unknown as Parameters<typeof isEdible>[0])).toBe(false);
    expect(isEdible(fakeItem("diamond") as unknown as Parameters<typeof isEdible>[0])).toBe(false);
    expect(isEdible(null)).toBe(false);
  });

  it("findEdible scans inventory for the first edible item", () => {
    const bot = {
      inventory: {
        items: () => [fakeItem("iron_ingot"), fakeItem("bread"), fakeItem("diamond")],
      },
    } as unknown as Parameters<typeof findEdible>[0];
    expect(findEdible(bot)?.name).toBe("bread");
  });

  it("check() is false when food is above threshold", () => {
    const reflex = autoEat({ foodThreshold: 14 });
    const bot = {
      food: 20,
      inventory: { items: () => [fakeItem("bread")] },
    } as unknown as Parameters<typeof reflex.check>[0];
    expect(reflex.check(bot)).toBe(false);
  });

  it("check() is true when food is low AND edible item is present", () => {
    const reflex = autoEat({ foodThreshold: 14 });
    const bot = {
      food: 10,
      inventory: { items: () => [fakeItem("bread")] },
    } as unknown as Parameters<typeof reflex.check>[0];
    expect(reflex.check(bot)).toBe(true);
  });

  it("check() is false when food is low but no edible item is in inventory", () => {
    const reflex = autoEat({ foodThreshold: 14 });
    const bot = {
      food: 10,
      inventory: { items: () => [fakeItem("iron_ingot")] },
    } as unknown as Parameters<typeof reflex.check>[0];
    expect(reflex.check(bot)).toBe(false);
  });
});
