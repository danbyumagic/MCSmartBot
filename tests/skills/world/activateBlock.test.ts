import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import type { SkillContext } from "../../../src/skills/types.js";

const { ensureReachableBlock } = vi.hoisted(() => ({
  ensureReachableBlock: vi.fn(),
}));

vi.mock("../../../src/world/reach.js", () => ({ ensureReachableBlock }));

import { activateBlock } from "../../../src/skills/world/activateBlock.js";

beforeEach(() => {
  ensureReachableBlock.mockReset();
});

function makeBlock(
  name: string,
  x = 4,
  y = 64,
  z = -2,
  stateId = 1,
) {
  return {
    name,
    position: new Vec3(x, y, z),
    stateId,
    boundingBox: name === "air" ? "empty" : "block",
    diggable: true,
    getProperties: () => ({ powered: false }),
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

describe("activateBlock", () => {
  it("is an operator, non-reversible world-change action", () => {
    expect(activateBlock.policy).toEqual({
      minimumRole: "operator",
      effect: "world-change",
      reversible: false,
      mission: "public",
    });
  });

  it("requires finite integer coordinates in supported world bounds", () => {
    expect(() => activateBlock.params.parse({ x: 1.2, y: 64, z: 0 })).toThrow();
    expect(() => activateBlock.params.parse({ x: 1, y: 321, z: 0 })).toThrow();
    expect(activateBlock.params.parse({ x: 1, y: 64, z: -2 })).toEqual({ x: 1, y: 64, z: -2 });
  });

  it("routes, rereads the exact live block, activates it, and returns bounded window information", async () => {
    const initial = makeBlock("lever");
    const reached = makeBlock("lever");
    const live = makeBlock("lever");
    const bot = {
      blockAt: vi.fn()
        .mockReturnValueOnce(initial)
        .mockReturnValueOnce(live),
      activateBlock: vi.fn().mockResolvedValue(undefined),
      currentWindow: {
        type: "minecraft:generic_9x3",
        title: "Supplies",
        slots: Array(27).fill(null),
      },
    };
    ensureReachableBlock.mockResolvedValue({
      ok: true,
      target: { x: 4, y: 64, z: -2 },
      block: reached,
      pathfound: true,
    });

    const result = await activateBlock.run({ x: 4, y: 64, z: -2 }, makeContext(bot));

    expect(ensureReachableBlock).toHaveBeenCalledWith(
      bot,
      { x: 4, y: 64, z: -2 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(bot.activateBlock).toHaveBeenCalledWith(live);
    expect(result).toMatchObject({
      ok: true,
      data: {
        target: { x: 4, y: 64, z: -2 },
        block: { name: "lever", position: { x: 4, y: 64, z: -2 } },
        window: { type: "minecraft:generic_9x3", title: "Supplies", slotCount: 27 },
        pathfound: true,
      },
    });
  });

  it("rejects a target that changed while routing before it can be activated", async () => {
    const initial = makeBlock("lever");
    const changed = makeBlock("stone", 4, 64, -2, 2);
    const activate = vi.fn();
    const bot = {
      blockAt: vi.fn().mockReturnValue(initial),
      activateBlock: activate,
      currentWindow: null,
    };
    ensureReachableBlock.mockResolvedValue({
      ok: true,
      target: { x: 4, y: 64, z: -2 },
      block: changed,
      pathfound: true,
    });

    const result = await activateBlock.run({ x: 4, y: 64, z: -2 }, makeContext(bot));

    expect(activate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      code: "STALE_STATE",
      details: { target: { x: 4, y: 64, z: -2 } },
    });
  });

  it("returns a recoverable unavailable-world result without routing", async () => {
    const bot = {
      blockAt: vi.fn().mockReturnValue(null),
      activateBlock: vi.fn(),
    };

    const result = await activateBlock.run({ x: 4, y: 64, z: -2 }, makeContext(bot));

    expect(ensureReachableBlock).not.toHaveBeenCalled();
    expect(bot.activateBlock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "WORLD_UNAVAILABLE", recoverable: true });
  });

  it("maps Mineflayer activation errors to a technical server failure", async () => {
    const initial = makeBlock("oak_door");
    const live = makeBlock("oak_door");
    const bot = {
      blockAt: vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(live),
      activateBlock: vi.fn().mockRejectedValue(new Error("server denied interaction")),
      currentWindow: null,
    };
    ensureReachableBlock.mockResolvedValue({
      ok: true,
      target: { x: 4, y: 64, z: -2 },
      block: makeBlock("oak_door"),
      pathfound: false,
    });

    const result = await activateBlock.run({ x: 4, y: 64, z: -2 }, makeContext(bot));

    expect(result).toMatchObject({
      ok: false,
      code: "SERVER_REJECTED",
      recoverable: true,
      details: { message: "server denied interaction" },
    });
  });

  it("does not inspect or activate after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const bot = { blockAt: vi.fn(), activateBlock: vi.fn() };

    const result = await activateBlock.run({ x: 4, y: 64, z: -2 }, makeContext(bot, controller));

    expect(bot.blockAt).not.toHaveBeenCalled();
    expect(bot.activateBlock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED", recoverable: true });
  });
});
