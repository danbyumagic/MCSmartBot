import { describe, it, expect, vi } from "vitest";
import { mineUntil } from "../../../src/skills/resources/mineUntil.js";
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

describe("mineUntil (param + lookup behavior)", () => {
  it("rejects negative or zero quantity via the schema", () => {
    expect(() => mineUntil.params.parse({ block: "iron_ore", quantity: 0 })).toThrow();
    expect(() => mineUntil.params.parse({ block: "iron_ore", quantity: -5 })).toThrow();
  });

  it("rejects quantity over 256 via the schema", () => {
    expect(() => mineUntil.params.parse({ block: "iron_ore", quantity: 999 })).toThrow();
  });

  it("accepts a valid set with default searchRadius", () => {
    expect(mineUntil.params.parse({ block: "iron_ore", quantity: 16 })).toEqual({
      block: "iron_ore",
      quantity: 16,
      searchRadius: 64,
    });
  });

  it("returns ok:true immediately if the bot already has the target quantity", async () => {
    const bot = {
      inventory: { items: () => [{ name: "iron_ore", count: 32 }] },
      registry: { blocksByName: { iron_ore: { id: 73 } } },
      findBlock: vi.fn(),
    };
    const result = await mineUntil.run({ block: "iron_ore", quantity: 16, searchRadius: 64 }, makeCtx(bot));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/already have/i);
  });

  it("can count a block's actual dropped item", async () => {
    const bot = {
      inventory: { items: () => [{ name: "raw_iron", count: 12 }] },
      registry: {
        blocksByName: { iron_ore: { id: 15 } },
        itemsByName: { raw_iron: { id: 100 } },
      },
      findBlock: vi.fn(),
    };
    const result = await mineUntil.run({
      block: "iron_ore",
      resultItem: "raw_iron",
      quantity: 12,
      searchRadius: 64,
    }, makeCtx(bot));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/raw_iron/);
  });

  it("returns ok:false when the block name is unknown to the registry", async () => {
    const bot = {
      inventory: { items: () => [] },
      registry: { blocksByName: { iron_ore: { id: 73 } } },
      findBlock: vi.fn(),
    };
    const result = await mineUntil.run({ block: "unobtanium", quantity: 1, searchRadius: 32 }, makeCtx(bot));
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/unknown block/i);
  });

  it("returns ok:false when no matching block can be found within radius", async () => {
    const bot = {
      inventory: { items: () => [] },
      registry: { blocksByName: { iron_ore: { id: 73 } } },
      findBlock: vi.fn().mockReturnValue(null),
      collectBlock: { collect: vi.fn() },
    };
    const result = await mineUntil.run({ block: "iron_ore", quantity: 16, searchRadius: 32 }, makeCtx(bot));
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no .* within/i);
  });

  it("returns an actionable INVENTORY_FULL preflight failure", async () => {
    const slots = Array.from({ length: 45 }, (_, slot) =>
      slot >= 9 ? { name: `filler_${slot}`, count: 64 } : null);
    const bot = {
      inventory: {
        items: () => slots.slice(9).filter(Boolean),
        slots,
        inventoryStart: 9,
        inventoryEnd: 45,
      },
      registry: {
        blocksByName: { iron_ore: { id: 73 } },
        itemsByName: { raw_iron: { id: 100, stackSize: 64 } },
      },
      findBlock: vi.fn(),
    };
    const result = await mineUntil.run({
      block: "iron_ore",
      resultItem: "raw_iron",
      quantity: 16,
      searchRadius: 32,
    }, makeCtx(bot));

    expect(result).toMatchObject({
      ok: false,
      code: "INVENTORY_FULL",
      recoverable: true,
      details: {
        availableSpace: 0,
        freeSlots: 0,
        guidance: expect.stringContaining("deposit"),
      },
    });
    expect(bot.findBlock).not.toHaveBeenCalled();
  });
});
