import { describe, it, expect, vi } from "vitest";
import { pickupNearby } from "../../../src/skills/resources/pickupNearby.js";
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

describe("pickupNearby", () => {
  it("accepts default radius and no filter", () => {
    expect(pickupNearby.params.parse({})).toEqual({ radius: 16 });
  });

  it("rejects radius over 64", () => {
    expect(() => pickupNearby.params.parse({ radius: 100 })).toThrow();
  });

  it("accepts an optional filter substring", () => {
    expect(pickupNearby.params.parse({ filter: "iron" })).toEqual({ radius: 16, filter: "iron" });
  });

  it("returns ok:true with 'no drops' when nothing is in range", async () => {
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      entities: {},
    };
    const result = await pickupNearby.run({ radius: 16 }, makeCtx(bot));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/no drops/i);
  });
});
