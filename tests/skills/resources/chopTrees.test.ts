import { describe, it, expect, vi } from "vitest";
import { chopTrees } from "../../../src/skills/resources/chopTrees.js";
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

describe("chopTrees", () => {
  it("rejects logType that isn't a recognized vanilla log", () => {
    expect(() => chopTrees.params.parse({ logType: "iron_ore", count: 1 })).toThrow();
  });

  it("accepts a valid logType + defaults", () => {
    expect(chopTrees.params.parse({ logType: "oak_log", count: 2 })).toEqual({
      logType: "oak_log",
      count: 2,
      searchRadius: 64,
    });
  });

  it("returns ok:false when no log of the type is found in range", async () => {
    const bot = {
      inventory: { items: () => [] },
      registry: { blocksByName: { oak_log: { id: 17 } } },
      findBlock: vi.fn().mockReturnValue(null),
      collectBlock: { collect: vi.fn() },
    };
    const result = await chopTrees.run({ logType: "oak_log", count: 1, searchRadius: 32 }, makeCtx(bot));
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no .* within/i);
  });
});
