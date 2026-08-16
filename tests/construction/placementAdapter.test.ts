import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { placeBuildPlacement } from "../../src/construction/placementAdapter.js";

type Cell = { name: string; properties?: Record<string, string | boolean | number> };

function positionKey(position: Vec3): string {
  return `${position.x},${position.y},${position.z}`;
}

function cardinalForYaw(yaw: number): "north" | "south" | "east" | "west" {
  if (Math.abs(yaw) < 0.001) return "north";
  if (Math.abs(yaw + Math.PI / 2) < 0.001) return "east";
  if (Math.abs(Math.abs(yaw) - Math.PI) < 0.001) return "south";
  return "west";
}

function mutableStatefulWorld(initial: Record<string, Cell>) {
  const world = new Map(Object.entries(initial));
  let held = "";
  let yaw = 0;
  const blockAt = vi.fn((position: Vec3) => {
    const cell = world.get(positionKey(position)) ?? { name: "air" };
    return {
      name: cell.name,
      position: position.floored(),
      stateId: cell.name === "air" ? 0 : 1,
      boundingBox: cell.name === "air" ? "empty" : "block",
      diggable: cell.name !== "bedrock",
      getProperties: () => ({ ...cell.properties }),
    };
  });
  const bot = {
    entity: { position: new Vec3(0, 64, -2) },
    registry: {
      itemsByName: {
        oak_stairs: { id: 1 },
        oak_door: { id: 2 },
        stone: { id: 3 },
      },
      blocksByName: {
        oak_stairs: {
          states: [
            { name: "facing", values: ["north", "south", "east", "west"] },
            { name: "half", values: ["top", "bottom"] },
            { name: "shape", values: ["straight", "inner_left", "inner_right"] },
          ],
        },
        oak_door: {
          states: [
            { name: "facing", values: ["north", "south", "east", "west"] },
            { name: "half", values: ["lower", "upper"] },
          ],
        },
        stone: { states: [] },
      },
    },
    inventory: {
      items: () => [
        { name: "oak_stairs", type: 1, count: 8 },
        { name: "oak_door", type: 2, count: 8 },
        { name: "stone", type: 3, count: 8 },
      ],
    },
    blockAt,
    canSeeBlock: vi.fn(() => true),
    equip: vi.fn(async (item: { name: string }) => { held = item.name; }),
    look: vi.fn(async (nextYaw: number) => { yaw = nextYaw; }),
    placeBlock: vi.fn(async (reference: { position: Vec3 }, face: Vec3) => {
      world.set(positionKey(reference.position.plus(face)), { name: held });
    }),
    _placeBlockWithOptions: vi.fn(async (
      reference: { position: Vec3 },
      face: Vec3,
      options: { half?: "top" | "bottom"; forceLook?: boolean | "ignore" },
    ) => {
      world.set(positionKey(reference.position.plus(face)), {
        name: held,
        properties: {
          facing: cardinalForYaw(yaw),
          half: options.half ?? "bottom",
          shape: "straight",
        },
      });
    }),
    dig: vi.fn(async () => {}),
  };
  return { bot, world, blockAt };
}

describe("stateful BuildOps placement adapter", () => {
  it("uses a preferred viable side reference and journals/verifies the requested stair state", async () => {
    // The only support is west of the target, so its clicked face is east.
    const { bot, world } = mutableStatefulWorld({ "-1,64,0": { name: "stone" } });
    const planned = vi.fn();
    const applied = vi.fn();

    const result = await placeBuildPlacement(bot as never, {
      position: { x: 0, y: 64, z: 0 },
      item: "oak_stairs",
      hint: { facing: "east", half: "top" },
      signal: new AbortController().signal,
      hooks: { planned, applied },
    });

    expect(result).toMatchObject({
      ok: true,
      after: { name: "oak_stairs", properties: { facing: "east", half: "top" } },
      reference: { direction: "east", position: { x: -1, y: 64, z: 0 } },
    });
    expect(bot.look).toHaveBeenCalledWith(-Math.PI / 2, 0);
    expect(bot._placeBlockWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ position: expect.objectContaining({ x: -1, y: 64, z: 0 }) }),
      expect.objectContaining({ x: 1, y: 0, z: 0 }),
      { half: "top", forceLook: "ignore" },
    );
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(planned).toHaveBeenCalledWith(expect.objectContaining({
      intended: { name: "oak_stairs", properties: { facing: "east", half: "top" } },
    }));
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      intended: expect.objectContaining({
        properties: expect.objectContaining({ facing: "east", half: "top" }),
      }),
    }));
    expect(world.get("0,64,0")).toEqual(expect.objectContaining({ name: "oak_stairs" }));
  });

  it("rejects a same-name but wrong-state placement and journals the observed conflict", async () => {
    const { bot, world } = mutableStatefulWorld({ "-1,64,0": { name: "stone" } });
    const planned = vi.fn();
    const applied = vi.fn();
    const conflicted = vi.fn();
    const failed = vi.fn();
    bot._placeBlockWithOptions.mockImplementation(async (reference: { position: Vec3 }, face: Vec3) => {
      world.set(positionKey(reference.position.plus(face)), {
        name: "oak_stairs",
        properties: { facing: "west", half: "top", shape: "straight" },
      });
    });

    const result = await placeBuildPlacement(bot as never, {
      position: { x: 0, y: 64, z: 0 },
      item: "oak_stairs",
      hint: { facing: "east", half: "top" },
      signal: new AbortController().signal,
      hooks: { planned, applied, conflicted, failed },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "STALE_STATE",
      details: { intended: { name: "oak_stairs", properties: { facing: "east", half: "top" } } },
    });
    expect(planned).toHaveBeenCalledOnce();
    expect(applied).not.toHaveBeenCalled();
    expect(conflicted).toHaveBeenCalledWith(expect.objectContaining({
      code: "STALE_STATE",
      after: expect.objectContaining({
        properties: expect.objectContaining({ facing: "west", half: "top" }),
      }),
    }));
    expect(failed).not.toHaveBeenCalled();
    expect(world.get("0,64,0")).toEqual(expect.objectContaining({
      properties: expect.objectContaining({ facing: "west", half: "top" }),
    }));
  });

  it("fails closed before equip or mutation for a door or another unsupported hinted item", async () => {
    const { bot } = mutableStatefulWorld({ "-1,64,0": { name: "stone" } });

    const result = await placeBuildPlacement(bot as never, {
      position: { x: 0, y: 64, z: 0 },
      item: "oak_door",
      hint: { facing: "north", half: "bottom" },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_STATE", recoverable: false });
    expect(bot.equip).not.toHaveBeenCalled();
    expect(bot._placeBlockWithOptions).not.toHaveBeenCalled();
  });

  it("requires a viable side reference when a requested half depends on click height", async () => {
    const { bot } = mutableStatefulWorld({ "0,63,0": { name: "stone" } });

    const result = await placeBuildPlacement(bot as never, {
      position: { x: 0, y: 64, z: 0 },
      item: "oak_stairs",
      hint: { facing: "north", half: "bottom" },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
    expect(bot._placeBlockWithOptions).not.toHaveBeenCalled();
  });

  it("rejects a target that becomes stale during the controlled look before planning a stateful click", async () => {
    const { bot, world } = mutableStatefulWorld({ "-1,64,0": { name: "stone" } });
    bot.look.mockImplementation(async () => {
      world.set("0,64,0", { name: "dirt" });
    });
    const planned = vi.fn();

    const result = await placeBuildPlacement(bot as never, {
      position: { x: 0, y: 64, z: 0 },
      item: "oak_stairs",
      hint: { facing: "east", half: "bottom" },
      signal: new AbortController().signal,
      hooks: { planned },
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(planned).not.toHaveBeenCalled();
    expect(bot._placeBlockWithOptions).not.toHaveBeenCalled();
    expect(world.get("0,64,0")).toEqual({ name: "dirt" });
  });

  it("stops after cancellation during the controlled look before it can click", async () => {
    const controller = new AbortController();
    const { bot } = mutableStatefulWorld({ "-1,64,0": { name: "stone" } });
    let finishLook!: () => void;
    bot.look.mockImplementation(() => new Promise<void>((resolve) => { finishLook = resolve; }));
    const planned = vi.fn();

    const pending = placeBuildPlacement(bot as never, {
      position: { x: 0, y: 64, z: 0 },
      item: "oak_stairs",
      hint: { facing: "east", half: "bottom" },
      signal: controller.signal,
      hooks: { planned },
    });

    await vi.waitFor(() => expect(bot.look).toHaveBeenCalledOnce());
    controller.abort();
    const result = await pending;
    finishLook();
    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED" });
    expect(planned).not.toHaveBeenCalled();
    expect(bot._placeBlockWithOptions).not.toHaveBeenCalled();
  });

  it("leaves an unhinted ordinary placement on the public Mineflayer path", async () => {
    const { bot } = mutableStatefulWorld({ "0,63,0": { name: "stone" } });

    const result = await placeBuildPlacement(bot as never, {
      position: { x: 0, y: 64, z: 0 },
      item: "stone",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: true, after: { name: "stone" } });
    expect(bot.placeBlock).toHaveBeenCalledOnce();
    expect(bot._placeBlockWithOptions).not.toHaveBeenCalled();
  });
});
