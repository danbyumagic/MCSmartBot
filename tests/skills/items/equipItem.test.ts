import { describe, expect, it, vi } from "vitest";
import { equipItem } from "../../../src/skills/items/equipItem.js";
import type { SkillContext } from "../../../src/skills/types.js";

function makeContext(
  carried: Array<Record<string, unknown>>,
  equip = vi.fn().mockResolvedValue(undefined),
): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: {
      inventory: { items: () => carried },
      equip,
    } as unknown as SkillContext["bot"],
    signal: new AbortController().signal,
    log,
    reportProgress: vi.fn(),
  };
}

describe("equipItem", () => {
  it("equips an exact carried item to the offhand", async () => {
    const shield = {
      name: "shield",
      slot: 12,
      maxDurability: 336,
      durabilityUsed: 36,
    };
    const equip = vi.fn().mockResolvedValue(undefined);
    const result = await equipItem.run(
      { item: "Shield", destination: "off-hand" },
      makeContext([shield], equip),
    );

    expect(equip).toHaveBeenCalledWith(shield, "off-hand");
    expect(result).toMatchObject({
      ok: true,
      data: {
        item: "shield",
        destination: "off-hand",
        durabilityRemaining: 300,
      },
    });
  });

  it("returns an actionable shortage when the item is not carried", async () => {
    const result = await equipItem.run(
      { item: "shield", destination: "off-hand" },
      makeContext([{ name: "torch", slot: 12 }]),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      recoverable: true,
      details: { item: "shield", available: ["torch"] },
    });
  });
});
