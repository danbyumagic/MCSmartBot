import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import {
  ensureReachableBlock,
  ensurePlacementReach,
  findPlacementReference,
  floorBlockPosition,
} from "../../src/world/reach.js";

const { pathfindTo } = vi.hoisted(() => ({ pathfindTo: vi.fn() }));

vi.mock("../../src/skills/pathfinder.js", () => ({
  goals: {
    GoalNear: class GoalNear {
      constructor(
        public readonly x: number,
        public readonly y: number,
        public readonly z: number,
        public readonly range: number,
      ) {}
    },
  },
  pathfindTo,
}));

function block(name: string, position: Vec3, boundingBox: "block" | "empty" = "block") {
  return {
    name,
    position,
    boundingBox,
    diggable: name !== "bedrock",
    stateId: 1,
    getProperties: () => ({}),
  };
}

function botFor(
  world: Map<string, ReturnType<typeof block> | null>,
  position = new Vec3(0.2, 64, 0.8),
) {
  const key = (value: Vec3) => `${value.x},${value.y},${value.z}`;
  return {
    entity: { position },
    blockAt: vi.fn((value: Vec3) => world.has(key(value))
      ? world.get(key(value))!
      : block("air", value, "empty")),
    canSeeBlock: vi.fn(() => true),
  };
}

describe("block reach and placement references", () => {
  it("floors coordinate input once before all world access", () => {
    const world = new Map<string, ReturnType<typeof block> | null>([
      ["3,63,-2", block("stone", new Vec3(3, 63, -2))],
    ]);
    const bot = botFor(world);

    const reference = findPlacementReference(bot as never, { x: 3.9, y: 64.2, z: -1.1 });

    expect(floorBlockPosition({ x: 3.9, y: 64.2, z: -1.1 })).toEqual({ x: 3, y: 64, z: -2 });
    expect(reference).toMatchObject({
      position: { x: 3, y: 63, z: -2 },
      face: "up",
      snapshot: { name: "stone" },
    });
    expect(bot.blockAt).toHaveBeenCalledWith(expect.objectContaining({ x: 3, y: 63, z: -2 }));
  });

  it("uses the construction face order and ignores empty adjacent blocks", () => {
    const world = new Map<string, ReturnType<typeof block> | null>([
      ["1,63,1", block("air", new Vec3(1, 63, 1), "empty")],
      ["2,64,1", block("stone", new Vec3(2, 64, 1))],
      ["0,64,1", block("dirt", new Vec3(0, 64, 1))],
    ]);
    const bot = botFor(world);

    const reference = findPlacementReference(bot as never, { x: 1, y: 64, z: 1 });

    expect(reference).toMatchObject({
      position: { x: 2, y: 64, z: 1 },
      face: "west",
    });
  });

  it("honors required faces while preferring a deterministic viable stateful reference", () => {
    const world = new Map<string, ReturnType<typeof block> | null>([
      ["1,63,1", block("stone", new Vec3(1, 63, 1))],
      ["2,64,1", block("dirt", new Vec3(2, 64, 1))],
      ["1,64,2", block("cobblestone", new Vec3(1, 64, 2))],
    ]);
    const bot = botFor(world);

    const reference = findPlacementReference(bot as never, { x: 1, y: 64, z: 1 }, {
      requiredFaces: ["west", "north"],
      preferredFaces: ["north"],
    });

    expect(reference).toMatchObject({
      position: { x: 1, y: 64, z: 2 },
      face: "north",
    });
  });

  it("rejects a placement target at the bot feet or head", async () => {
    const bot = botFor(new Map());
    const controller = new AbortController();

    const atFeet = await ensurePlacementReach(bot as never, { x: 0.9, y: 64.7, z: 0.1 }, {
      signal: controller.signal,
    });
    const atHead = await ensurePlacementReach(bot as never, { x: 0, y: 65, z: 0 }, {
      signal: controller.signal,
    });

    expect(atFeet).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
    expect(atHead).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
    expect(bot.blockAt).not.toHaveBeenCalled();
  });

  it("pathfinds only when the selected reference cannot currently be reached", async () => {
    pathfindTo.mockReset().mockResolvedValue(undefined);
    const world = new Map<string, ReturnType<typeof block> | null>([
      ["5,63,0", block("stone", new Vec3(5, 63, 0))],
      ["3,63,0", block("stone", new Vec3(3, 63, 0))],
    ]);
    const bot = botFor(world, new Vec3(0, 64, 0));
    const controller = new AbortController();

    const result = await ensurePlacementReach(bot as never, { x: 5, y: 64, z: 0 }, {
      signal: controller.signal,
      reach: 4,
    });

    expect(result).toMatchObject({ ok: true, pathfound: true, reference: { face: "up" } });
    expect(pathfindTo).toHaveBeenCalledOnce();
    expect(pathfindTo.mock.calls[0]?.[1]).toMatchObject({ x: 5, y: 64, z: 0, range: 4 });

    pathfindTo.mockClear();
    const nearby = await ensurePlacementReach(bot as never, { x: 3, y: 64, z: 0 }, {
      signal: controller.signal,
      reach: 4,
    });
    expect(nearby).toMatchObject({ ok: true, pathfound: false });
    expect(pathfindTo).not.toHaveBeenCalled();
  });

  it("provides a generic refreshed reachable block for non-placement actions", async () => {
    const world = new Map<string, ReturnType<typeof block> | null>([
      ["7,64,0", block("stone", new Vec3(7, 64, 0))],
    ]);
    pathfindTo.mockReset().mockImplementation(async () => {
      world.set("7,64,0", block("deepslate", new Vec3(7, 64, 0)));
    });
    const bot = botFor(world, new Vec3(0, 64, 0));

    const result = await ensureReachableBlock(bot as never, { x: 7, y: 64, z: 0 }, {
      signal: new AbortController().signal,
      reach: 4,
    });

    expect(result).toMatchObject({
      ok: true,
      target: { x: 7, y: 64, z: 0 },
      block: { name: "deepslate" },
      pathfound: true,
    });
    expect(pathfindTo).toHaveBeenCalledOnce();
    expect(pathfindTo.mock.calls[0]?.[1]).toMatchObject({ x: 7, y: 64, z: 0, range: 4 });
  });

  it("returns structured failures for unavailable world, missing support, path failure, and abort", async () => {
    const controller = new AbortController();
    const unavailable = botFor(new Map([["1,64,0", null]]));
    const unloaded = await ensurePlacementReach(unavailable as never, { x: 1, y: 64, z: 0 }, {
      signal: controller.signal,
    });
    expect(unloaded).toMatchObject({ ok: false, code: "WORLD_UNAVAILABLE" });

    const missingNeighbor = botFor(new Map([
      ["1,64,0", block("air", new Vec3(1, 64, 0), "empty")],
      ["1,63,0", null],
    ]));
    const unavailableSupport = await ensurePlacementReach(
      missingNeighbor as never,
      { x: 1, y: 64, z: 0 },
      { signal: controller.signal },
    );
    expect(unavailableSupport).toMatchObject({ ok: false, code: "WORLD_UNAVAILABLE" });

    const noSupport = botFor(new Map());
    const missing = await ensurePlacementReach(noSupport as never, { x: 1, y: 64, z: 0 }, {
      signal: controller.signal,
    });
    expect(missing).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });

    pathfindTo.mockReset().mockRejectedValue(new Error("no path"));
    const far = botFor(new Map([["5,63,0", block("stone", new Vec3(5, 63, 0))]]));
    const noPath = await ensurePlacementReach(far as never, { x: 5, y: 64, z: 0 }, {
      signal: controller.signal,
      reach: 4,
    });
    expect(noPath).toMatchObject({ ok: false, code: "NO_PATH" });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const aborted = await ensurePlacementReach(far as never, { x: 5, y: 64, z: 0 }, {
      signal: alreadyAborted.signal,
    });
    expect(aborted).toMatchObject({ ok: false, code: "INTERRUPTED" });
  });

  it("checks the abort signal again after pathfinding and refreshes the reference", async () => {
    const controller = new AbortController();
    pathfindTo.mockReset().mockImplementation(async () => {
      controller.abort();
    });
    const bot = botFor(new Map([["5,63,0", block("stone", new Vec3(5, 63, 0))]]));

    const result = await ensurePlacementReach(bot as never, { x: 5, y: 64, z: 0 }, {
      signal: controller.signal,
      reach: 4,
    });

    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED" });
  });
});
