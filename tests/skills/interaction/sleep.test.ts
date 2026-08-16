import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import type { SkillContext } from "../../../src/skills/types.js";

const { ensureReachableBlock } = vi.hoisted(() => ({
  ensureReachableBlock: vi.fn(),
}));

vi.mock("../../../src/world/reach.js", () => ({ ensureReachableBlock }));

import { sleep } from "../../../src/skills/interaction/sleep.js";

beforeEach(() => {
  ensureReachableBlock.mockReset();
});

function makeBlock(name: string, x = 3, y = 64, z = 7, stateId = 1) {
  return {
    name,
    position: new Vec3(x, y, z),
    stateId,
    boundingBox: "block",
    diggable: true,
    getProperties: () => ({ part: "foot" }),
  };
}

function makeContext(bot: unknown, controller = new AbortController()): SkillContext {
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

describe("sleep", () => {
  it("is an operator, non-reversible world-change action", () => {
    expect(sleep.policy).toEqual({
      minimumRole: "operator",
      effect: "world-change",
      reversible: false,
      mission: "public",
    });
  });

  it("accepts either a complete exact bed position or bounded nearest-bed lookup", () => {
    expect(sleep.params.parse({})).toEqual({ searchRadius: 16 });
    expect(sleep.params.parse({ bed: { x: 3, y: 64, z: 7 }, searchRadius: 8 })).toEqual({
      bed: { x: 3, y: 64, z: 7 },
      searchRadius: 8,
    });
    expect(() => sleep.params.parse({ bed: { x: 3, y: 64 } })).toThrow();
    expect(() => sleep.params.parse({ searchRadius: 33 })).toThrow();
  });

  it("reaches, rereads, and sleeps in an exact live bed", async () => {
    const initial = makeBlock("red_bed");
    const reached = makeBlock("red_bed");
    const live = makeBlock("red_bed");
    const bot = {
      isSleeping: false,
      blockAt: vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(live),
      sleep: vi.fn().mockResolvedValue(undefined),
    };
    ensureReachableBlock.mockResolvedValue({
      ok: true,
      target: { x: 3, y: 64, z: 7 },
      block: reached,
      pathfound: true,
    });

    const result = await sleep.run({ bed: { x: 3, y: 64, z: 7 }, searchRadius: 16 }, makeContext(bot));

    expect(ensureReachableBlock).toHaveBeenCalledWith(
      bot,
      { x: 3, y: 64, z: 7 },
      expect.objectContaining({ signal: expect.any(AbortSignal), reach: 2 }),
    );
    expect(bot.sleep).toHaveBeenCalledWith(live);
    expect(result).toMatchObject({
      ok: true,
      data: {
        bed: { x: 3, y: 64, z: 7 },
        selection: "exact",
        block: { name: "red_bed" },
        pathfound: true,
      },
    });
  });

  it("uses a bounded nearest-bed lookup when exact coordinates are omitted", async () => {
    const found = makeBlock("blue_bed", -1, 65, 2);
    const bot = {
      isSleeping: false,
      findBlock: vi.fn((options) => {
        expect(options.maxDistance).toBe(16);
        expect(options.matching(makeBlock("blue_bed"))).toBe(true);
        expect(options.matching(makeBlock("stone"))).toBe(false);
        return found;
      }),
      blockAt: vi.fn().mockReturnValue(makeBlock("blue_bed", -1, 65, 2)),
      sleep: vi.fn().mockResolvedValue(undefined),
    };
    ensureReachableBlock.mockResolvedValue({
      ok: true,
      target: { x: -1, y: 65, z: 2 },
      block: makeBlock("blue_bed", -1, 65, 2),
      pathfound: false,
    });

    const result = await sleep.run({ searchRadius: 16 }, makeContext(bot));

    expect(bot.findBlock).toHaveBeenCalledOnce();
    expect(bot.sleep).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      data: { bed: { x: -1, y: 65, z: 2 }, selection: "nearest", pathfound: false },
    });
  });

  it("returns a recoverable target-unavailable result when no bounded bed exists", async () => {
    const bot = {
      isSleeping: false,
      findBlock: vi.fn().mockReturnValue(null),
      blockAt: vi.fn(),
      sleep: vi.fn(),
    };

    const result = await sleep.run({ searchRadius: 8 }, makeContext(bot));

    expect(bot.blockAt).not.toHaveBeenCalled();
    expect(bot.sleep).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      code: "TARGET_UNAVAILABLE",
      recoverable: true,
      details: { searchRadius: 8 },
    });
  });

  it("refuses to sleep when the selected bed changed while routing", async () => {
    const initial = makeBlock("white_bed");
    const bot = {
      isSleeping: false,
      blockAt: vi.fn().mockReturnValue(initial),
      sleep: vi.fn(),
    };
    ensureReachableBlock.mockResolvedValue({
      ok: true,
      target: { x: 3, y: 64, z: 7 },
      block: makeBlock("stone", 3, 64, 7, 2),
      pathfound: true,
    });

    const result = await sleep.run({ bed: { x: 3, y: 64, z: 7 }, searchRadius: 16 }, makeContext(bot));

    expect(bot.sleep).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
  });

  it("maps server sleep failures to a technical result", async () => {
    const initial = makeBlock("white_bed");
    const live = makeBlock("white_bed");
    const bot = {
      isSleeping: false,
      blockAt: vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(live),
      sleep: vi.fn().mockRejectedValue(new Error("there are monsters nearby")),
    };
    ensureReachableBlock.mockResolvedValue({
      ok: true,
      target: { x: 3, y: 64, z: 7 },
      block: makeBlock("white_bed"),
      pathfound: false,
    });

    const result = await sleep.run({ bed: { x: 3, y: 64, z: 7 }, searchRadius: 16 }, makeContext(bot));

    expect(result).toMatchObject({
      ok: false,
      code: "SERVER_REJECTED",
      recoverable: true,
      details: { message: "there are monsters nearby" },
    });
  });

  it("is idempotent when Mineflayer already reports the bot sleeping", async () => {
    const bot = { isSleeping: true, findBlock: vi.fn(), blockAt: vi.fn(), sleep: vi.fn() };

    const result = await sleep.run({ searchRadius: 16 }, makeContext(bot));

    expect(bot.findBlock).not.toHaveBeenCalled();
    expect(bot.sleep).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, data: { alreadySleeping: true } });
  });
});
