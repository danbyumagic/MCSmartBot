import { describe, expect, it, vi } from "vitest";
import { tossItem } from "../../../src/skills/items/tossItem.js";
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

describe("tossItem", () => {
  it("is an owner-only, non-reversible destructive action", () => {
    expect(tossItem.policy).toEqual({
      minimumRole: "owner",
      effect: "destructive",
      reversible: false,
      mission: "public",
    });
  });

  it("tosses an exact named item count and verifies the inventory delta", async () => {
    let ironIngots = 5;
    const bot = {
      registry: { itemsByName: { iron_ingot: { id: 265 } } },
      inventory: {
        items: () => [
          { name: "iron_ingot", type: 265, count: ironIngots },
          { name: "iron_nugget", type: 452, count: 12 },
        ],
      },
      toss: vi.fn(async (type: number, metadata: number | null, count: number | null) => {
        expect(type).toBe(265);
        expect(metadata).toBeNull();
        expect(count).toBe(3);
        ironIngots -= 3;
      }),
    };

    const result = await tossItem.run(
      { item: "Iron_Ingot", count: 3 },
      makeContext(bot),
    );

    expect(bot.toss).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      data: { item: "iron_ingot", tossed: 3, before: 5, after: 2 },
    });
  });

  it("does not accept a partial name or attempt a toss when the exact item is absent", async () => {
    const toss = vi.fn();
    const result = await tossItem.run(
      { item: "iron", count: 1 },
      makeContext({
        registry: { itemsByName: { iron: { id: 1 } } },
        inventory: { items: () => [{ name: "iron_ingot", type: 265, count: 5 }] },
        toss,
      }),
    );

    expect(toss).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      recoverable: true,
      details: { item: "iron", available: 0, requested: 1 },
    });
  });

  it("fails instead of claiming success when the server leaves inventory unchanged", async () => {
    const bot = {
      registry: { itemsByName: { iron_ingot: { id: 265 } } },
      inventory: { items: () => [{ name: "iron_ingot", type: 265, count: 5 }] },
      toss: vi.fn().mockResolvedValue(undefined),
    };

    const result = await tossItem.run(
      { item: "iron_ingot", count: 3 },
      makeContext(bot),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "STALE_STATE",
      details: { item: "iron_ingot", requested: 3, before: 5, after: 5, tossed: 0 },
    });
  });

  it("does not toss after cancellation", async () => {
    const toss = vi.fn();
    const result = await tossItem.run(
      { item: "iron_ingot", count: 1 },
      makeContext({
        registry: { itemsByName: { iron_ingot: { id: 265 } } },
        inventory: { items: () => [{ name: "iron_ingot", type: 265, count: 1 }] },
        toss,
      }, true),
    );

    expect(toss).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED", recoverable: true });
  });
});
