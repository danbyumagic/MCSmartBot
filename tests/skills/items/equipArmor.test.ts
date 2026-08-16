import { describe, expect, it, vi } from "vitest";
import { equipArmor } from "../../../src/skills/items/equipArmor.js";
import type { SkillContext } from "../../../src/skills/types.js";

function item(name: string, slot: number) {
  return { name, slot };
}

function makeCtx(input: {
  carried?: Array<{ name: string; slot: number }>;
  worn?: Partial<Record<"head" | "torso" | "legs" | "feet", { name: string; slot: number }>>;
  equip?: ReturnType<typeof vi.fn>;
}): SkillContext {
  const slotIds = { head: 5, torso: 6, legs: 7, feet: 8 };
  const slots: Array<{ name: string; slot: number } | null> = Array(46).fill(null);
  for (const [destination, worn] of Object.entries(input.worn ?? {})) {
    slots[slotIds[destination as keyof typeof slotIds]] = worn;
  }
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: {
      inventory: {
        items: () => input.carried ?? [],
        slots,
      },
      getEquipmentDestSlot: (destination: keyof typeof slotIds) => slotIds[destination],
      equip: input.equip ?? vi.fn().mockResolvedValue(undefined),
    } as unknown as SkillContext["bot"],
    signal: new AbortController().signal,
    log,
    reportProgress: vi.fn(),
  };
}

describe("equipArmor", () => {
  it("equips carried boots into the feet slot", async () => {
    const equip = vi.fn().mockResolvedValue(undefined);
    const boots = item("iron_boots", 12);
    const ctx = makeCtx({ carried: [boots], equip });

    const result = await equipArmor.run({ slot: "feet" }, ctx);

    expect(equip).toHaveBeenCalledWith(boots, "feet");
    expect(result).toMatchObject({
      ok: true,
      data: { equipped: ["feet:iron_boots"] },
    });
  });

  it("chooses stronger armor and never replaces stronger worn armor", async () => {
    const equip = vi.fn().mockResolvedValue(undefined);
    const diamondChestplate = item("diamond_chestplate", 13);
    const ironChestplate = item("iron_chestplate", 14);
    const ctx = makeCtx({
      carried: [ironChestplate, diamondChestplate, item("iron_helmet", 15)],
      worn: { head: item("netherite_helmet", 5) },
      equip,
    });

    const result = await equipArmor.run({ slot: "all" }, ctx);

    expect(equip).toHaveBeenCalledTimes(1);
    expect(equip).toHaveBeenCalledWith(diamondChestplate, "torso");
    expect(result).toMatchObject({
      ok: true,
      data: {
        equipped: ["torso:diamond_chestplate"],
        retained: ["head:netherite_helmet"],
        missing: ["legs", "feet"],
      },
    });
  });

  it("reports when no armor is available", async () => {
    const ctx = makeCtx({ carried: [item("iron_pickaxe", 12)] });

    const result = await equipArmor.run({ slot: "all" }, ctx);

    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      recoverable: true,
    });
  });

  it("returns a recoverable failure when Mineflayer cannot equip an item", async () => {
    const equip = vi.fn().mockRejectedValue(new Error("inventory transaction rejected"));
    const ctx = makeCtx({ carried: [item("iron_boots", 12)], equip });

    const result = await equipArmor.run({ slot: "feet" }, ctx);

    expect(result).toMatchObject({
      ok: false,
      code: "UNKNOWN",
      recoverable: true,
      details: { destination: "feet", item: "iron_boots" },
    });
  });
});
